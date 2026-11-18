// Filter Platform — background service worker (Phase 2)
// Fetches the device policy + blocklist from the Phase 1 API, caches them,
// and builds declarativeNetRequest dynamic rules from the blocklist.
// The API token + device id come from the popup (chrome.storage.local) —
// the real token is NEVER bundled in this extension.

const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const RULE_ID_START = 1000;
const ADS_RULE_ID_START = 5000; // ads/tracker rules live in their own id range

async function getSettings() {
  const s = await chrome.storage.local.get([
    'fpToken', 'fpDeviceId', 'fpCustomerId', 'fpDemoMode'
  ]);
  return {
    token: s.fpToken || '',
    deviceId: s.fpDeviceId || '',
    customerId: s.fpCustomerId || '',
    demoMode: s.fpDemoMode || 'policy' // policy | block | cover | strict
  };
}

async function apiGet(path, token) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error('API ' + res.status + ' on ' + path);
  return res.json();
}

async function fetchPolicyAndBlocklist() {
  const { token, deviceId, customerId } = await getSettings();
  if (!token) throw new Error('No API token saved — open the popup and paste your token + device id.');

  // 1. Find this device (list is filtered by customer when customer_id given)
  let policy = null;
  let device = null;
  try {
    const q = customerId ? ('?customer_id=' + encodeURIComponent(customerId)) : '';
    const devs = await apiGet('/api/v1/devices' + q, token);
    const list = devs.data || [];
    device = list.find(d => d.id === deviceId) || null;
    if (device && device.policy_id) {
      const p = await apiGet('/api/v1/policies/' + device.policy_id, token);
      policy = p.data || p;
    }
  } catch (e) {
    console.warn('[fp] device lookup failed, falling back to default policy:', e.message);
  }
  // 2. Fallback: default policy
  if (!policy) {
    const all = await apiGet('/api/v1/policies', token);
    const list = all.data || [];
    policy = list.find(p => p.is_default) || list[0] || null;
  }
  if (!policy) throw new Error('No policy returned by API.');

  // 3. Blocklist (domains list — always enforced)
  const doms = await apiGet('/api/v1/domains?decision=block&limit=500', token);
  const domains = [...new Set((doms.data || []).map(d => (d.domain || '').toLowerCase().replace(/^www\./, '').trim()).filter(Boolean))];

  // 4. Ads/tracker blocklist (Phase 3) — enforced ONLY when the device
  // policy has filter_ads=true (see buildRules). A failure here must not
  // break the domains sync above, so it degrades to an empty ads list.
  let adDomains = [];
  try {
    const ads = await apiGet('/api/v1/ads/blocklist', token);
    const raw = (ads.data && ads.data.domains) || [];
    adDomains = [...new Set(raw.map(d => (d || '').toLowerCase().replace(/^www\./, '').trim()).filter(Boolean))];
  } catch (e) {
    console.warn('[fp] ads blocklist fetch failed, ads filtering off this sync:', e.message);
  }

  return { policy, domains, adDomains, device };
}

async function buildRules(domains, adDomains, filterAds) {
  // Remove previously installed rules, then install fresh ones.
  // Domain rules: ids 1000+. Ads rules (only when filterAds): ids 5000+.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);
  const rules = [];
  let id = RULE_ID_START;
  // NOTE: resourceTypes must be listed explicitly. Verified 2026-11-18 in
  // Chrome 159: a rule with NO resourceTypes blocked subresources but did
  // NOT block main-frame navigations; with an explicit list (incl.
  // main_frame) the navigation fails with ERR_BLOCKED_BY_CLIENT.
  const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];
  const addFor = (domain, startId) => {
    let n = startId;
    for (const pattern of [`*://${domain}/*`, `*://*.${domain}/*`]) {
      rules.push({
        id: n++,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: pattern, resourceTypes: ALL_TYPES }
      });
    }
    return n;
  };
  for (const domain of domains) id = addFor(domain, id);
  let adsRules = 0;
  if (filterAds) {
    let adsId = ADS_RULE_ID_START;
    for (const domain of adDomains) adsId = addFor(domain, adsId);
    adsRules = adsId - ADS_RULE_ID_START;
  }
  // DNR caps dynamic rules at 5000; our list is far below that.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  return { total: rules.length, ads: adsRules };
}

async function sync() {
  const started = Date.now();
  try {
    const { policy, domains, adDomains, device } = await fetchPolicyAndBlocklist();
    const adsEnforced = !!policy.filter_ads;
    const { total: rulesCount, ads: adRulesCount } = await buildRules(domains, adDomains, adsEnforced);
    const status = {
      lastSync: new Date().toISOString(),
      policyFetched: true,
      policyName: policy.name,
      policyId: policy.id,
      block_images: !!policy.block_images,
      cover_images: !!policy.cover_images,
      filter_videos: !!policy.filter_videos,
      filter_ads: !!policy.filter_ads,
      auto_decide_threshold: policy.auto_decide_threshold,
      deviceFound: !!device,
      deviceName: device ? device.name : null,
      blocklistDomains: domains.length,
      rulesCount,
      adBlocklistDomains: adDomains.length,
      adRulesCount,
      adsEnforced,
      error: null,
      syncMs: Date.now() - started
    };
    await chrome.storage.local.set({ fpPolicy: policy, fpBlocklist: domains, fpAdBlocklist: adDomains, fpStatus: status });
    console.log('[fp] sync ok:', JSON.stringify(status));
    return status;
  } catch (err) {
    // Offline resilience: if the live fetch fails but we have a cached
    // policy + blocklist, keep filtering from the cache (rules rebuilt).
    // Ads rules are rebuilt from the cached ads list ONLY when the cached
    // policy has filter_ads=true — same gate as the live path.
    const cached = await chrome.storage.local.get(['fpPolicy', 'fpBlocklist', 'fpAdBlocklist']);
    if (cached.fpPolicy && cached.fpBlocklist && cached.fpBlocklist.length) {
      const adsEnforced = !!cached.fpPolicy.filter_ads;
      const { total: rulesCount, ads: adRulesCount } = await buildRules(cached.fpBlocklist, cached.fpAdBlocklist || [], adsEnforced).catch(() => ({ total: 0, ads: 0 }));
      const status = {
        lastSync: new Date().toISOString(),
        policyFetched: false,
        policyName: cached.fpPolicy.name,
        policyId: cached.fpPolicy.id,
        block_images: !!cached.fpPolicy.block_images,
        cover_images: !!cached.fpPolicy.cover_images,
        filter_videos: !!cached.fpPolicy.filter_videos,
        filter_ads: !!cached.fpPolicy.filter_ads,
        auto_decide_threshold: cached.fpPolicy.auto_decide_threshold,
        blocklistDomains: cached.fpBlocklist.length,
        rulesCount,
        adBlocklistDomains: (cached.fpAdBlocklist || []).length,
        adRulesCount,
        adsEnforced,
        rulesBuiltFromCache: true,
        error: String(err && err.message ? err.message : err),
        syncMs: Date.now() - started
      };
      await chrome.storage.local.set({ fpStatus: status });
      console.warn('[fp] sync failed, rules rebuilt from cache:', JSON.stringify(status));
      return status;
    }
    const status = {
      lastSync: new Date().toISOString(),
      policyFetched: false,
      error: String(err && err.message ? err.message : err),
      syncMs: Date.now() - started
    };
    const prev = await chrome.storage.local.get(['fpStatus']);
    await chrome.storage.local.set({ fpStatus: { ...(prev.fpStatus || {}), ...status } });
    console.warn('[fp] sync failed:', err);
    return status;
  }
}

function resolveMode(policy, demoMode) {
  // demoMode overrides the policy for demo purposes (popup toggle).
  if (demoMode === 'block') return 'block';
  if (demoMode === 'cover') return 'cover';
  if (demoMode === 'strict') return 'strict';
  if (!policy) return 'block'; // safe default when policy unknown
  if (policy.block_images) return 'block';
  if (policy.cover_images) return 'cover';
  return 'allow';
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[fp] installed — open the popup to paste token + device id.');
  chrome.alarms.create('fp-sync', { periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(async () => {
  const { token } = await getSettings();
  if (token) await sync();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'fp-sync') {
    const { token } = await getSettings();
    if (token) await sync();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  // Popup saved a token/device id (or the verify harness seeded storage):
  // re-sync policy + rules automatically, no popup round-trip needed.
  if (area === 'local' && (changes.fpToken || changes.fpDeviceId || changes.fpCustomerId)) {
    sync();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'getState') {
      const s = await chrome.storage.local.get(['fpPolicy', 'fpBlocklist', 'fpAdBlocklist', 'fpStatus', 'fpStats', 'fpDemoMode']);
      sendResponse({
        policy: s.fpPolicy || null,
        blocklist: s.fpBlocklist || [],
        adBlocklist: s.fpAdBlocklist || [],
        adsEnforced: !!(s.fpStatus && s.fpStatus.adsEnforced),
        status: s.fpStatus || null,
        stats: s.fpStats || null,
        demoMode: s.fpDemoMode || 'policy',
        mode: resolveMode(s.fpPolicy || null, s.fpDemoMode || 'policy')
      });
    } else if (msg && msg.type === 'refresh') {
      sendResponse(await sync());
    } else if (msg && msg.type === 'report') {
      // Content script page stats (per-page, merged into totals).
      const prev = (await chrome.storage.local.get(['fpStats'])).fpStats || {
        pages: 0, scanned: 0, human: 0, blocked: 0, covered: 0, uncertain: 0
      };
      const r = msg.stats || {};
      const next = {
        pages: prev.pages + 1,
        scanned: prev.scanned + (r.scanned || 0),
        human: prev.human + (r.human || 0),
        blocked: prev.blocked + (r.blocked || 0),
        covered: prev.covered + (r.covered || 0),
        uncertain: prev.uncertain + (r.uncertain || 0),
        lastPage: msg.url || '',
        lastReport: new Date().toISOString()
      };
      await chrome.storage.local.set({ fpStats: next });
      sendResponse({ ok: true });
    }
  })();
  return true; // async response
});
