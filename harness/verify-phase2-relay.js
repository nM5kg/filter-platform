// Phase 2 verification harness — Playwright + unpacked extension.
// Usage: node verify-phase2.js [block|cover]   (default: both, two runs)
// Reads the API token from ../api_token.txt (never printed).
// Serves extension/test-page on http://127.0.0.1:8123, loads the extension
// in a persistent Chromium context (headless), seeds storage via the real
// popup page, and records exact counts + screenshots into extension/verify/.
//
// NOTE: this VM's Chromium cannot reach the public internet directly
// (egress proxy CONNECT fails inside Chromium while curl works). The harness
// therefore tries the live API fetch from the service worker first; if that
// fails it seeds the REAL policy + blocklist (fetched by curl from the live
// API) as the extension's cache, and the background rebuilds DNR rules from
// cache — the cache path is a real shipped feature, and the report says
// exactly which path each run took.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const TEST_PAGE = path.join(EXT, 'test-page');
const VERIFY_DIR = path.join(EXT, 'verify');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
// Real Phase 1 device (Dogfood Phone, active, Standard policy) — from the live API.
const DEVICE_ID = 'eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a';
const CUSTOMER_ID = '142e6a02-14c8-4eda-86f5-09087ded8cdf';
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const TEST_URL = 'http://127.0.0.1:8123/index.html';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function curlApi(pathSuffix) {
  const out = execFileSync('curl', ['-s', '-H', 'Authorization: Bearer ' + TOKEN, API_BASE + pathSuffix], { encoding: 'utf8', timeout: 30000 });
  return JSON.parse(out);
}

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) { /* keep waiting */ }
    await sleep(500);
  }
  console.log('TIMEOUT waiting for:', label);
  return false;
}

async function runMode(mode) {
  const profile = path.join('/tmp', 'fp-profile-' + mode);
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n===== MODE: ${mode} (profile ${profile}) =====`);
  const result = { mode, ok: false };
  // NOTE: no --proxy-server here. This VM's Chromium cannot tunnel to the
  // public internet through the egress proxy (ERR_TUNNEL_CONNECTION_FAILED /
  // ERR_NO_SUPPORTED_PROXIES) while curl can; forcing the proxy into Chrome
  // also breaks localhost. External fetches from the SW therefore fail and
  // the harness uses the cache path (step 4) — recorded honestly per run.

  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 60000,
    executablePath: CHROME,
    // Playwright's defaults include --disable-extensions and
    // --disable-component-extensions-with-background-pages, which together
    // prevent --load-extension from loading anything. Both must be removed.
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [
      `--load-extension=${EXT}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080',
      '--proxy-bypass-list=localhost;127.0.0.1',
    ],
  });

  try {
    // 1. Find the extension's service worker (proves the extension loaded).
    const probePage = await context.newPage();
    let extId = null;
    await waitFor(async () => {
      const cdp = await context.newCDPSession(probePage);
      const t = await cdp.send('Target.getTargets');
      const sws = (t.targetInfos || []).filter(x => x.type === 'service_worker' && x.url.includes('chrome-extension://') && x.url.endsWith('/background.js'));
      // Several built-in component extensions also have background.js — find
      // the one whose popup.html exists and is ours.
      for (const sw of sws) {
        const id = sw.url.split('/')[2];
        const p = await context.newPage().catch(() => null);
        if (!p) continue;
        try {
          await p.goto(`chrome-extension://${id}/popup.html`, { timeout: 8000 });
          const txt = await p.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
          if (txt.includes('פֿילטער')) { extId = id; await p.close().catch(() => {}); return true; }
        } catch (e) { /* not ours */ }
        await p.close().catch(() => {});
      }
      return false;
    }, 60000, 'extension service worker target');
    console.log('extension id:', extId);
    result.extensionId = extId;
    if (!extId) throw new Error('Extension service worker never appeared — extension did not load.');

    // 2. Open the REAL popup page and seed token/device/mode through it.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
    await popup.evaluate(async ({ token, deviceId, customerId, demoMode }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ fpToken: token, fpDeviceId: deviceId, fpCustomerId: customerId, fpDemoMode: demoMode });
    }, { token: TOKEN, deviceId: DEVICE_ID, customerId: CUSTOMER_ID, demoMode: mode });

    // 3. Ask the background to sync (live API fetch from the service worker).
    let status = await popup.evaluate(async () => {
      try { return await chrome.runtime.sendMessage({ type: 'refresh' }); }
      catch (e) { return { error: String(e) }; }
    });
    console.log('sync attempt 1 (live fetch from SW):', JSON.stringify(status));
    result.liveSync = status;
    let syncPath = 'live';

    // 4. If the live fetch failed inside Chromium (VM proxy), seed the REAL
    // policy + blocklist (fetched by curl from the live API) as cache and
    // let the background rebuild the rules from cache.
    if (!status || !status.policyFetched) {
      const policies = curlApi('/api/v1/policies');
      const policy = (policies.data || []).find(p => p.is_default) || (policies.data || [])[0];
      const doms = curlApi('/api/v1/domains?decision=block&limit=500');
      const blocklist = [...new Set((doms.data || []).map(d => (d.domain || '').toLowerCase().replace(/^www\./, '').trim()).filter(Boolean))];
      console.log('curl live API: policy =', policy && policy.name, '| blocklist domains =', blocklist.length);
      await popup.evaluate(async ({ policy, blocklist }) => {
        await chrome.storage.local.set({ fpPolicy: policy, fpBlocklist: blocklist });
      }, { policy, blocklist });
      status = await popup.evaluate(async () => {
        try { return await chrome.runtime.sendMessage({ type: 'refresh' }); }
        catch (e) { return { error: String(e) }; }
      });
      console.log('sync attempt 2 (cache fallback):', JSON.stringify(status));
      result.cacheSync = status;
      syncPath = 'cache';
    }
    result.syncPath = syncPath;
    result.policyFetch = status;

    // 5. Count the DNR rules the background actually built.
    const rules = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
    result.dnrRuleCount = rules.length;
    result.dnrRules = rules.map(r => r.condition.urlFilter);
    console.log('DNR dynamic rules:', rules.length);
    console.log('DNR rules:', JSON.stringify(result.dnrRules));

    // 6. Open the local test page and read the content script's DOM mirror
    // (content scripts run in an isolated world; window.* is not visible to
    // the page, but the DOM is shared — see content.js publishStats()).
    const page = await context.newPage();
    page.on('console', m => { if (m.text().includes('[fp]')) console.log('  page console:', m.text().slice(0, 250)); });
    page.on('pageerror', e => console.log('  page error:', String(e).slice(0, 300)));
    const failedRequests = [];
    page.on('requestfailed', r => failedRequests.push({ url: r.url().slice(0, 120), error: (r.failure() && r.failure().errorText) || '?' }));
    const navStart = Date.now();
    await page.goto(TEST_URL, { waitUntil: 'load', timeout: 30000 });
    await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 60000, 'model load');
    const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 180000, 'first scan');
    const scanMs = Date.now() - navStart;
    result.scanMs = scanMs;
    result.scanDone = scanDone;
    console.log('first scan took (ms):', scanMs, 'done flag:', scanDone);
    await sleep(3500); // dynamic image (2s) + MutationObserver re-scan
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    // Settle: the lazy + dynamic images are processed by a RE-scan that only
    // starts after the first scan ends. Wait until the log shows both of
    // them (2nd marie-curie entry = lazy, 2nd obama entry = dynamic).
    await waitFor(async () => page.evaluate(() => {
      const raw = document.getElementById('fp-dom-stats');
      if (!raw) return false;
      const l = JSON.parse(raw.textContent).log;
      const curie = l.filter(e => e.src.includes('person-marie-curie')).length;
      const obama = l.filter(e => e.src.includes('person-obama-family')).length;
      return curie >= 2 && obama >= 2;
    }), 120000, 'dynamic+lazy processed');
    await sleep(1500);

    const domStats = await page.evaluate(() => {
      const raw = document.getElementById('fp-dom-stats');
      const parsed = raw ? JSON.parse(raw.textContent) : null;
      return {
        stats: parsed ? parsed.stats : null,
        log: parsed ? parsed.log : [],
        mode: document.documentElement.getAttribute('data-fp-mode'),
        blockedPlaceholders: document.querySelectorAll('[data-fp-blocked]').length,
        coveredImgs: document.querySelectorAll('[data-fp-covered]').length,
        imgsRemaining: document.querySelectorAll('img').length,
        imgStates: Array.from(document.querySelectorAll('img')).map(i => ({ id: i.id, action: i.dataset.fpAction || 'none' })),
        bgBlocked: document.querySelectorAll('[data-fp-bg-blocked]').length,
        bgCoverOverlays: document.querySelectorAll('.fp-bg-cover').length,
        facebookProbe: (() => { const el = document.getElementById('img-facebook-probe'); return el ? { complete: el.complete, naturalWidth: el.naturalWidth } : null; })(),
        dynamicImgPresent: !!document.getElementById('img-dynamic'),
        dynamicImgAction: (() => { const el = document.getElementById('img-dynamic'); return el ? (el.dataset.fpAction || 'none') : 'absent'; })(),
        lazyImgAction: (() => { const el = document.getElementById('img-lazy'); return el ? (el.dataset.fpAction || 'none') : 'absent'; })(),
        xoriginLocalAction: (() => { const el = document.getElementById('img-xorigin-local'); return el ? (el.dataset.fpAction || 'none') : 'absent'; })(),
        xoriginAction: (() => { const el = document.getElementById('img-xorigin'); return el ? (el.dataset.fpAction || 'none') : 'absent'; })(),
      };
    });
    result.failedRequests = failedRequests;
    console.log('failed requests:', JSON.stringify(failedRequests));
    result.testPage = domStats;
    console.log('mode on page:', domStats.mode);
    console.log('stats:', JSON.stringify(domStats.stats));
    console.log('img states:', JSON.stringify(domStats.imgStates));
    console.log('bg blocked:', domStats.bgBlocked, 'bg covered:', domStats.bgCoverOverlays);
    console.log('facebook probe:', JSON.stringify(domStats.facebookProbe));
    for (const e of domStats.log) console.log('  log:', JSON.stringify(e));

    await page.screenshot({ path: path.join(VERIFY_DIR, mode + '-mode.png'), fullPage: true });
    console.log('screenshot:', mode + '-mode.png');

    // 7. Blocked-domain check: navigate to facebook.com (on the blocklist).
    let fbNav = null;
    try {
      const resp = await page.goto('https://www.facebook.com/', { waitUntil: 'commit', timeout: 25000 });
      fbNav = { status: resp ? resp.status() : null, url: page.url() };
    } catch (e) {
      fbNav = { error: String(e).split('\n')[0] };
    }
    result.facebookNav = fbNav;
    console.log('facebook.com navigation:', JSON.stringify(fbNav));

    // 8. Google Images (real site) — record what happens.
    let g = null;
    try {
      const resp = await page.goto('https://images.google.com/search?q=albert+einstein&tbm=isch', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(6000);
      const gstats = await page.evaluate(() => {
        const raw = document.getElementById('fp-dom-stats');
        return raw ? JSON.parse(raw.textContent).stats : null;
      }).catch(() => null);
      const title = await page.title().catch(() => '');
      const bodyText = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '').catch(() => '')).replace(/\n+/g, ' | ');
      g = { httpStatus: resp ? resp.status() : null, url: page.url(), title, bodySnippet: bodyText, stats: gstats };
    } catch (e) {
      g = { error: String(e).split('\n')[0] };
    }
    result.googleImages = g;
    console.log('google images:', JSON.stringify(g));
    await page.screenshot({ path: path.join(VERIFY_DIR, mode + '-google-images.png') }).catch(() => {});

    result.ok = true;
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e).slice(0, 2000);
    console.log('RUN ERROR:', result.error);
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

(async () => {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const modes = process.argv[2] ? [process.argv[2]] : ['block', 'cover', 'strict'];
  const server = spawn('python3', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], {
    cwd: TEST_PAGE, stdio: ['ignore', 'pipe', 'pipe']
  });
  // Second server on another port = a real cross-origin origin (no CORS
  // headers) for the taint/uncertain test image.
  const server2 = spawn('python3', ['-m', 'http.server', '8124', '--bind', '127.0.0.1'], {
    cwd: path.join(TEST_PAGE, 'photos'), stdio: ['ignore', 'pipe', 'pipe']
  });
  await sleep(1200);
  const results = [];
  try {
    for (const m of modes) results.push(await runMode(m));
  } finally {
    server.kill();
    server2.kill();
  }
  const outPath = path.join(VERIFY_DIR, 'results-relay.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', outPath);
  for (const r of results) {
    console.log(JSON.stringify({
      mode: r.mode, ok: r.ok, syncPath: r.syncPath,
      policyFetchedLive: r.liveSync && r.liveSync.policyFetched,
      rules: r.dnrRuleCount,
      stats: r.testPage && r.testPage.stats,
      facebook: r.facebookNav,
      google: r.googleImages && (r.googleImages.error || (r.googleImages.httpStatus + ' ' + r.googleImages.url)),
    }));
  }
})().catch(e => { console.error(e); process.exit(1); });
