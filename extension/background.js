// Filter Platform — background service worker (Phase 2)
// Fetches the device policy + blocklist from the Phase 1 API, caches them,
// and builds declarativeNetRequest dynamic rules from the blocklist.
// The API token + device id come from the popup (chrome.storage.local) —
// the real token is NEVER bundled in this extension.

const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const RULE_ID_START = 1000;

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

  // 3. Blocklist
  const doms = await apiGet('/api/v1/domains?decision=block&limit=500', token);
  const domains = [...new Set((doms.data || []).map(d => (d.domain || '').toLowerCase().replace(/^www\./, '').trim()).filter(Boolean))];

  return { policy, domains, device };
}

async function buildRules(domains) {
  // Remove previously installed rules, then install fresh ones.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);
  const rules = [];
  let id = RULE_ID_START;
  // NOTE: resourceTypes must be listed explicitly. Verified 2026-11-18 in
  // Chrome 159: a rule with NO resourceTypes blocked subresources but did
  // NOT block main-frame navigations; with an explicit list (incl.
  // main_frame) the navigation fails with ERR_BLOCKED_BY_CLIENT.
  const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];
  for (const domain of domains) {
    for (const pattern of [`*://${domain}/*`, `*://*.${domain}/*`]) {
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: pattern, resourceTypes: ALL_TYPES }
      });
    }
  }
  // DNR caps dynamic rules at 5000; our list is far below that.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  return rules.length;
}

async function sync() {
  const started = Date.now();
  try {
    const { policy, domains, device } = await fetchPolicyAndBlocklist();
    const rulesCount = await buildRules(domains);
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
      error: null,
      syncMs: Date.now() - started
    };
    await chrome.storage.local.set({ fpPolicy: policy, fpBlocklist: domains, fpStatus: status });
    console.log('[fp] sync ok:', JSON.stringify(status));
    return status;
  } catch (err) {
    // Offline resilience: if the live fetch fails but we have a cached
    // policy + blocklist, keep filtering from the cache (rules rebuilt).
    const cached = await chrome.storage.local.get(['fpPolicy', 'fpBlocklist']);
    if (cached.fpPolicy && cached.fpBlocklist && cached.fpBlocklist.length) {
      const rulesCount = await buildRules(cached.fpBlocklist).catch(() => 0);
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
      const s = await chrome.storage.local.get(['fpPolicy', 'fpBlocklist', 'fpStatus', 'fpStats', 'fpDemoMode']);
      sendResponse({
        policy: s.fpPolicy || null,
        blocklist: s.fpBlocklist || [],
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
