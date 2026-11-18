// Phase 3 ads verification harness — Playwright + unpacked extension.
// Usage: node verify-phase3-ads.js
// Reads the API token from ../api_token.txt (never printed).
// Two live runs through the egress relay (127.0.0.1:18080, already running):
//   A. Real device eefbc8d5 (Standard policy, filter_ads=false):
//      live sync must build ONLY the domains DNR rules — 0 ads rules.
//   B. A temporary test policy (filter_ads=true) + temporary test device,
//      created via the live API and DELETED afterwards (fpsql): live sync
//      must build 26 domains x 2 = 52 ads DNR rules, and a navigation to
//      https://doubleclick.net/ must fail with ERR_BLOCKED_BY_CLIENT.
// Results: extension/verify/results-phase3-ads.json
// The extension's live fetch runs through the relay; the report says so.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const VERIFY_DIR = path.join(EXT, 'verify');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const CUSTOMER_ID = '142e6a02-14c8-4eda-86f5-09087ded8cdf';
const DEVICE_STD = 'eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a';
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function curlApi(method, pathSuffix, body) {
  const args = ['-s', '-H', 'Authorization: Bearer ' + TOKEN];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  if (method !== 'GET') args.push('-X', method);
  args.push(API_BASE + pathSuffix);
  const out = execFileSync('curl', args, { encoding: 'utf8', timeout: 30000 });
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

async function findExtensionId(context) {
  const probePage = await context.newPage();
  let extId = null;
  await waitFor(async () => {
    const cdp = await context.newCDPSession(probePage);
    const t = await cdp.send('Target.getTargets');
    const sws = (t.targetInfos || []).filter(x => x.type === 'service_worker' && x.url.includes('chrome-extension://') && x.url.endsWith('/background.js'));
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
  await probePage.close().catch(() => {});
  return extId;
}

async function runCase(label, deviceId) {
  const profile = path.join('/tmp', 'fp-ads-' + label.replace(/[^a-z0-9]/gi, ''));
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n===== CASE ${label} (device ${deviceId}) =====`);
  const result = { case: label, deviceId, ok: false };
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 60000,
    executablePath: CHROME,
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
    const extId = await findExtensionId(context);
    console.log('extension id:', extId);
    result.extensionId = extId;
    if (!extId) throw new Error('Extension service worker never appeared.');

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
    await popup.evaluate(async ({ token, deviceId, customerId }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ fpToken: token, fpDeviceId: deviceId, fpCustomerId: customerId, fpDemoMode: 'policy' });
    }, { token: TOKEN, deviceId, customerId: CUSTOMER_ID });

    // Live sync from the service worker (through the relay).
    const status = await popup.evaluate(async () => {
      try { return await chrome.runtime.sendMessage({ type: 'refresh' }); }
      catch (e) { return { error: String(e) }; }
    });
    console.log('live sync status:', JSON.stringify(status));
    result.liveSync = status;
    result.syncPath = status && status.policyFetched ? 'live' : 'FAILED';

    const state = await popup.evaluate(async () => {
      try { return await chrome.runtime.sendMessage({ type: 'getState' }); }
      catch (e) { return { error: String(e) }; }
    });
    result.getState = {
      adsEnforced: state.adsEnforced, adBlocklist: (state.adBlocklist || []).length,
      blocklist: (state.blocklist || []).length, policyName: state.policy && state.policy.name,
      filter_ads: state.policy && state.policy.filter_ads,
    };
    console.log('getState:', JSON.stringify(result.getState));

    const rules = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
    const filters = rules.map(r => r.condition.urlFilter);
    const adRules = filters.filter(f => f.includes('doubleclick.net') || f.includes('google-analytics.com') || f.includes('taboola.com'));
    const domainRules = filters.filter(f => f.includes('facebook.com'));
    result.dnrRuleCount = rules.length;
    result.dnrAdRuleCount = adRules.length;
    result.dnrDomainRuleCount = domainRules.length;
    result.dnrRuleIds = rules.map(r => r.id).sort((a, b) => a - b);
    console.log('DNR rules total:', rules.length, '| ads rules:', adRules.length, '| facebook rules:', domainRules.length);
    console.log('DNR rule ids:', JSON.stringify(result.dnrRuleIds));

    // Navigation probe: only for the filter_ads=true case.
    if (status && status.filter_ads) {
      const page = await context.newPage();
      let nav = null;
      try {
        const resp = await page.goto('https://doubleclick.net/', { waitUntil: 'commit', timeout: 25000 });
        nav = { status: resp ? resp.status() : null, url: page.url() };
      } catch (e) {
        nav = { error: String(e).split('\n')[0] };
      }
      result.doubleclickNav = nav;
      console.log('doubleclick.net navigation:', JSON.stringify(nav));
      await page.close().catch(() => {});
    }
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
  const results = { ranAt: new Date().toISOString(), syncPathNote: 'live fetch from the extension service worker via egress relay 127.0.0.1:18080', cases: [] };

  // --- Case A: Standard policy, filter_ads=false (real device) ---
  const a = await runCase('A-filter_ads-false', DEVICE_STD);
  a.expect = { filter_ads: false, adRulesCount: 0 };
  a.pass = a.ok && a.liveSync && a.liveSync.policyFetched === true && a.liveSync.filter_ads === false
    && a.liveSync.adRulesCount === 0 && a.dnrAdRuleCount === 0 && a.dnrDomainRuleCount >= 2;
  results.cases.push(a);

  // --- Case B: temporary test policy with filter_ads=true ---
  let testPolicy = null, testDevice = null;
  try {
    const p = curlApi('POST', '/api/v1/policies', {
      name: 'Test — Ads On (filter_ads=true)',
      description: 'Temporary policy for Phase 3 ads verification; deleted after the run.',
      strictness: 2, cover_images: false, block_images: true,
      filter_videos: false, filter_ads: true, require_approval_for_new_sites: false,
    });
    testPolicy = p.data;
    console.log('\ncreated test policy:', testPolicy.id, testPolicy.name, 'filter_ads=', testPolicy.filter_ads);
    const d = curlApi('POST', '/api/v1/devices', {
      customer_id: CUSTOMER_ID, name: 'Test Ads Device', platform: 'android', policy_id: testPolicy.id,
    });
    testDevice = d.data;
    console.log('created test device:', testDevice.id, testDevice.name, 'policy_id=', testDevice.policy_id);
  } catch (e) {
    console.log('FAILED to create test policy/device:', String(e).slice(0, 500));
  }

  if (testDevice) {
    const b = await runCase('B-filter_ads-true', testDevice.id);
    b.expect = { filter_ads: true, adRulesCount: 52, doubleclickBlocked: 'ERR_BLOCKED_BY_CLIENT' };
    b.pass = b.ok && b.liveSync && b.liveSync.policyFetched === true && b.liveSync.filter_ads === true
      && b.liveSync.adRulesCount === 52 && b.dnrAdRuleCount >= 6
      && b.doubleclickNav && /ERR_BLOCKED_BY_CLIENT/.test(b.doubleclickNav.error || '');
    results.cases.push(b);
  } else {
    results.cases.push({ case: 'B-filter_ads-true', ok: false, error: 'test policy/device creation failed — case not run' });
  }

  // --- Cleanup: delete the temporary device, then the policy (versions cascade) ---
  if (testDevice) {
    try {
      execFileSync('python3', ['fpsql.py', `DELETE FROM devices WHERE id = '${testDevice.id}';`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      console.log('cleanup: test device deleted');
    } catch (e) { console.log('cleanup device FAILED:', String(e).slice(0, 300)); }
  }
  if (testPolicy) {
    try {
      execFileSync('python3', ['fpsql.py', `DELETE FROM policies WHERE id = '${testPolicy.id}';`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      console.log('cleanup: test policy deleted');
    } catch (e) { console.log('cleanup policy FAILED:', String(e).slice(0, 300)); }
  }
  // Verify nothing remains.
  try {
    const left = curlApi('GET', '/api/v1/policies');
    results.cleanupCheck = {
      testPolicyGone: !(left.data || []).some(p => p.name && p.name.startsWith('Test — Ads On')),
      policyCount: (left.data || []).length,
    };
    console.log('cleanup check:', JSON.stringify(results.cleanupCheck));
  } catch (e) { results.cleanupCheck = { error: String(e).slice(0, 200) }; }

  const outPath = path.join(VERIFY_DIR, 'results-phase3-ads.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', outPath);
  for (const c of results.cases) console.log(JSON.stringify({ case: c.case, pass: c.pass, syncPath: c.syncPath, rules: c.dnrRuleCount, adRules: c.dnrAdRuleCount, doubleclick: c.doubleclickNav }));
})().catch(e => { console.error(e); process.exit(1); });
