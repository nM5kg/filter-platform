// Filter Platform — background service worker (Phase 2)
// Fetches the device policy + blocklist from the Phase 1 API, caches them,
// and builds declarativeNetRequest dynamic rules from the blocklist.
// The API token + device id come from the popup (chrome.storage.local) —
// the real token is NEVER bundled in this extension.

const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const VERSIONS_URL = 'https://filter-platform-dashboard.pages.dev/versions.json';
const UPDATE_CHECK_MINUTES = 360; // every 6 hours

// Update check (v1.2.1): our own website is the Download Center — no
// Chrome Web Store. Fetch the public versions.json, compare with this
// extension's manifest version, and store an updateAvailable flag for
// the popup banner. A failed fetch (offline, site down) leaves the
// previous flag alone and never shows a false update.
async function checkForUpdates() {
  try {
    const res = await fetch(VERSIONS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('versions.json HTTP ' + res.status);
    const data = await res.json();
    const latest = data && data.extension && data.extension.version;
    const current = chrome.runtime.getManifest().version;
    const available = !!(latest && latest !== current);
    await chrome.storage.local.set({
      fpUpdateAvailable: available,
      fpLatestVersion: latest || null,
      fpUpdateCheckedAt: new Date().toISOString()
    });
    console.log('[fp] update check: current', current, 'latest', latest, 'updateAvailable', available);
    return available;
  } catch (err) {
    console.warn('[fp] update check failed (kept previous flag):', err.message);
    return null;
  }
}
const RULE_ID_START = 1000;
const ADS_RULE_ID_START = 5000; // ads/tracker rules live in their own id range
const BLOCK_REDIRECT_ID_START = 3000; // main-frame redirect -> blocked.html
const SAFESEARCH_RULE_ID_START = 8000; // SafeSearch host redirects

// SafeSearch query-param rules — hardcoded fallback when the API is
// unreachable. One rule per engine: a main-frame navigation to the
// engine's search URL gets the SafeSearch-strict param added
// (addOrReplaceParams, so it is idempotent — an already-tagged URL is
// rewritten to the identical URL).
//
// Why a query param, not a redirect to the SafeSearch-locked host
// (forcesafesearch.google.com / strict.bing.com / safe.duckduckgo.com /
// restrict.youtube.com)? Those hostnames only work as DNS CNAME targets,
// where the browser keeps sending Host: www.google.com etc. Navigating
// to them directly changes the Host header, and the engines reject it —
// VERIFIED live 2026-11-18 in headless Chromium: Google /search on
// forcesafesearch.google.com -> HTTP 404, YouTube /watch on
// restrict.youtube.com -> HTTP 404, and Bing looped
// (strict.bing.com redirects back to www.bing.com, ERR_TOO_MANY_REDIRECTS).
// DuckDuckGo's safe host DID serve results, but the host redirect is
// dropped for all four anyway: one mechanism, and the param is what the
// API's url_param rules already describe.
//
// Why no redirect loop from the param rule? The rewritten URL still
// matches the rule's own condition, so a loop was the obvious fear.
// VERIFIED 2026-11-18 with a throwaway extension + local HTTP server: a
// rule adding safe=active to http://127.0.0.1:8125/search* fired exactly
// once — final URL .../search?q=hello&safe=active, page loaded, no
// ERR_TOO_MANY_REDIRECTS. Chrome does not re-apply a DNR redirect rule
// to its own output.
//
// YouTube is NOT enforced here: Restricted Mode has no query param, and
// the restrict.youtube.com host redirect 404s (see above). YouTube
// restriction needs the DNS/CNAME lock at the network level, not this
// extension. The API still lists the YouTube dns rule; the parser below
// skips engines with no param rule, so it never becomes a DNR rule.
const SAFESEARCH_FALLBACK = [
  // Google: google.com + country domains (google.co.uk, google.de,
  // google.com.au, google.co.jp, ...). Matches /search (incl. Images).
  { engine: 'google', regexFilter: '^https://(?:www\\.)?google\\.(?:com(?:\\.[a-z]{2})?|co\\.[a-z]{2}|[a-z]{2,3})/search', paramKey: 'safe', paramValue: 'active' },
  { engine: 'bing', regexFilter: '^https://(?:www\\.)?bing\\.com/search', paramKey: 'adlt', paramValue: 'strict' },
  // DuckDuckGo search URLs carry the query as ?q= (also /html/?q=, /lite/?q=).
  { engine: 'duckduckgo', regexFilter: '^https://(?:www\\.)?duckduckgo\\.com/.*[?&]q=', paramKey: 'kp', paramValue: '1' },
];

// Parse GET /api/v1/safesearch into the same shape as the fallback. The
// API lists each engine twice (a url_param rule + a dns/CNAME rule); only
// the url_param rule is usable in-browser — the dns rule is a network-level
// lock the extension cannot replicate (see SAFESEARCH_FALLBACK above). An
// engine with no url_param rule, or one the extension has no pattern for
// (e.g. youtube), is skipped, never guessed.
function safeSearchEnginesFromApi(apiJson) {
  const engines = (apiJson && apiJson.data && apiJson.data.engines) || [];
  const out = [];
  for (const e of engines) {
    if (e.method !== 'url_param') continue;
    const m = /^([a-z0-9_-]+)=(.+)$/i.exec((e.rule || '').trim());
    if (!m) continue;
    const base = SAFESEARCH_FALLBACK.find(f => f.engine === e.engine);
    if (!base) continue;
    out.push({ engine: e.engine, regexFilter: base.regexFilter, paramKey: m[1], paramValue: m[2] });
  }
  return out;
}

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

  // 5. SafeSearch rules (Phase 3b) — enforced only when the device policy
  // has force_safesearch=true (see sync). Scoped to THIS device so the
  // device's own policy is used, not the default (2026-11-19 fix).
  let safeSearch = { engines: SAFESEARCH_FALLBACK, source: 'fallback' };
  try {
    const ss = await apiGet('/api/v1/safesearch' + (deviceId ? '?device_id=' + encodeURIComponent(deviceId) : ''), token);
    const fromApi = safeSearchEnginesFromApi(ss);
    if (fromApi.length) safeSearch = { engines: fromApi, source: 'api' };
  } catch (e) {
    console.warn('[fp] safesearch fetch failed, using hardcoded fallback rules:', e.message);
  }

  return { policy, domains, adDomains, device, safeSearch };
}

async function buildRules(domains, adDomains, filterAds, safeSearch) {
  // Remove previously installed rules, then install fresh ones.
  // Domain rules: ids 1000+ (block, subresources only — see below).
  // Block-page redirects: ids 3000+ (one per blocked domain, main_frame).
  // Ads rules (only when filterAds): ids 5000+.
  // SafeSearch param rules (only when safeSearch.enforced): ids 8000+.
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);
  const rules = [];
  let id = RULE_ID_START;
  // NOTE: resourceTypes must be listed explicitly. Verified 2026-11-18 in
  // Chrome 159: a rule with NO resourceTypes blocked subresources but did
  // NOT block main-frame navigations; with an explicit list (incl.
  // main_frame) the navigation fails with ERR_BLOCKED_BY_CLIENT.
  const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];
  // Subresource types: everything except main_frame. Main-frame navigations
  // to a blocked domain are NOT blocked — they are REDIRECTED to the
  // Yiddish block page (rules 3000+), so the user sees an explanation
  // instead of the browser's block error page. Subresources (images,
  // scripts, iframes, ...) are still hard-blocked as before.
  const SUBRESOURCE_TYPES = ALL_TYPES.filter(t => t !== 'main_frame');
  const addFor = (domain, startId, types) => {
    let n = startId;
    for (const pattern of [`*://${domain}/*`, `*://*.${domain}/*`]) {
      rules.push({
        id: n++,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: pattern, resourceTypes: types }
      });
    }
    return n;
  };
  for (const domain of domains) id = addFor(domain, id, SUBRESOURCE_TYPES);
  let adsRules = 0;
  if (filterAds) {
    let adsId = ADS_RULE_ID_START;
    for (const domain of adDomains) adsId = addFor(domain, adsId, SUBRESOURCE_TYPES);
    adsRules = adsId - ADS_RULE_ID_START;
  }
  // Block-page redirects (3000+): one per blocked domain, main_frame only.
  // A direct navigation to a blocked domain (facebook.com, doubleclick.net
  // when ads filtering is on, ...) lands on blocked.html instead of the
  // browser error page. The rule passes the domain as ?d= so the page can
  // name it. DNR "redirect" to an extension page uses extensionPath — the
  // documented MV3 mechanism — and blocked.html must be listed in
  // web_accessible_resources (see MANIFEST-PATCH-B.md).
  // LIMIT: extensionPath carries a static string per rule, so only the
  // domain (not the full original URL) can be passed to the page. The
  // policy name is read by blocked.js from chrome.storage.local instead.
  let redirectRules = 0;
  {
    const redirectDomains = [...domains, ...(filterAds ? adDomains : [])];
    let rId = BLOCK_REDIRECT_ID_START;
    for (const domain of redirectDomains) {
      const esc = domain.replace(/\./g, '\\.');
      rules.push({
        id: rId++,
        priority: 2,
        action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?d=' + domain } },
        condition: {
          regexFilter: '^https?://(?:[^/]*\\.)?' + esc + '(/.*)?$',
          resourceTypes: ['main_frame']
        }
      });
      redirectRules++;
    }
  }
  // SafeSearch param rules (8000+): one per engine, main_frame only, only
  // when the policy enforces SafeSearch. Each rule adds the engine's
  // SafeSearch-strict query param (safe=active, adlt=strict, kp=1) to
  // search navigations. See SAFESEARCH_FALLBACK above for why this is a
  // param rewrite and not a host redirect, and why it does not loop.
  let safeSearchRules = 0;
  if (safeSearch && safeSearch.enforced && Array.isArray(safeSearch.engines)) {
    let ssId = SAFESEARCH_RULE_ID_START;
    for (const eng of safeSearch.engines) {
      rules.push({
        id: ssId++,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: eng.paramKey, value: eng.paramValue }] } } }
        },
        condition: { regexFilter: eng.regexFilter, resourceTypes: ['main_frame'] }
      });
      safeSearchRules++;
    }
  }
  // DNR caps dynamic rules at 5000; our list is far below that.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  return { total: rules.length, ads: adsRules, redirects: redirectRules, safeSearch: safeSearchRules };
}

async function sync() {
  const started = Date.now();
  try {
    const { policy, domains, adDomains, device, safeSearch } = await fetchPolicyAndBlocklist();
    const adsEnforced = !!policy.filter_ads;
    // SafeSearch gate: the device policy's force_safesearch. A missing
    // field defaults to ON (the Phase 1 default is true); an explicit
    // false turns enforcement off entirely.
    const safeSearchEnforced = policy.force_safesearch !== false && safeSearch.engines.length > 0;
    const { total: rulesCount, ads: adRulesCount, redirects: blockRedirectRules, safeSearch: safeSearchRulesCount } =
      await buildRules(domains, adDomains, adsEnforced, { enforced: safeSearchEnforced, engines: safeSearch.engines });
    const status = {
      lastSync: new Date().toISOString(),
      policyFetched: true,
      policyName: policy.name,
      policyId: policy.id,
      block_images: !!policy.block_images,
      cover_images: !!policy.cover_images,
      filter_videos: !!policy.filter_videos,
      filter_ads: !!policy.filter_ads,
      force_safesearch: !!policy.force_safesearch,
      auto_decide_threshold: policy.auto_decide_threshold,
      deviceFound: !!device,
      deviceName: device ? device.name : null,
      blocklistDomains: domains.length,
      rulesCount,
      adBlocklistDomains: adDomains.length,
      adRulesCount,
      adsEnforced,
      blockRedirectRules,
      safeSearchEnforced,
      safeSearchRulesCount,
      safeSearchEngines: safeSearch.engines.map(e => e.engine),
      safeSearchSource: safeSearch.source,
      error: null,
      syncMs: Date.now() - started
    };
    await chrome.storage.local.set({ fpPolicy: policy, fpBlocklist: domains, fpAdBlocklist: adDomains, fpSafeSearch: safeSearch, fpStatus: status });
    console.log('[fp] sync ok:', JSON.stringify(status));
    return status;
  } catch (err) {
    // Offline resilience: if the live fetch fails but we have a cached
    // policy + blocklist, keep filtering from the cache (rules rebuilt).
    // Ads rules are rebuilt from the cached ads list ONLY when the cached
    // policy has filter_ads=true — same gate as the live path. SafeSearch
    // rules are rebuilt from the cached SafeSearch list ONLY when the
    // cached policy has force_safesearch != false.
    const cached = await chrome.storage.local.get(['fpPolicy', 'fpBlocklist', 'fpAdBlocklist', 'fpSafeSearch']);
    if (cached.fpPolicy && cached.fpBlocklist && cached.fpBlocklist.length) {
      const adsEnforced = !!cached.fpPolicy.filter_ads;
      const cachedSafeSearch = cached.fpSafeSearch && Array.isArray(cached.fpSafeSearch.engines)
        ? cached.fpSafeSearch : { engines: SAFESEARCH_FALLBACK, source: 'fallback' };
      const safeSearchEnforced = cached.fpPolicy.force_safesearch !== false && cachedSafeSearch.engines.length > 0;
      const { total: rulesCount, ads: adRulesCount, redirects: blockRedirectRules, safeSearch: safeSearchRulesCount } =
        await buildRules(cached.fpBlocklist, cached.fpAdBlocklist || [], adsEnforced, { enforced: safeSearchEnforced, engines: cachedSafeSearch.engines }).catch(() => ({ total: 0, ads: 0, redirects: 0, safeSearch: 0 }));
      const status = {
        lastSync: new Date().toISOString(),
        policyFetched: false,
        policyName: cached.fpPolicy.name,
        policyId: cached.fpPolicy.id,
        block_images: !!cached.fpPolicy.block_images,
        cover_images: !!cached.fpPolicy.cover_images,
        filter_videos: !!cached.fpPolicy.filter_videos,
        filter_ads: !!cached.fpPolicy.filter_ads,
        force_safesearch: !!cached.fpPolicy.force_safesearch,
        auto_decide_threshold: cached.fpPolicy.auto_decide_threshold,
        blocklistDomains: cached.fpBlocklist.length,
        rulesCount,
        adBlocklistDomains: (cached.fpAdBlocklist || []).length,
        adRulesCount,
        adsEnforced,
        blockRedirectRules,
        safeSearchEnforced,
        safeSearchRulesCount,
        safeSearchEngines: cachedSafeSearch.engines.map(e => e.engine),
        safeSearchSource: cachedSafeSearch.source,
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
  chrome.alarms.create('fp-update-check', { periodInMinutes: UPDATE_CHECK_MINUTES });
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(async () => {
  checkForUpdates();
  const { token } = await getSettings();
  if (token) await sync();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'fp-sync') {
    const { token } = await getSettings();
    if (token) await sync();
  } else if (alarm.name === 'fp-update-check') {
    await checkForUpdates();
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
    } else if (msg && msg.type === 'checkUpdate') {
      // Manual trigger for the update check (used by the popup refresh and
      // by verification); the scheduled path is onStartup + the 6h alarm.
      sendResponse({ updateAvailable: await checkForUpdates() });
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
