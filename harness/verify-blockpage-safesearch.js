// Block page + SafeSearch verification harness — Playwright + unpacked extension.
// Usage: node verify-blockpage-safesearch.js
// Reads the API token from ../api_token.txt (never printed).
// Spawns the egress relay (harness/egress-relay.js, 127.0.0.1:18080) itself;
// the extension's live fetch runs through it. Results:
// extension/verify/results-blockpage-safesearch.json
//
// Cases:
//   A. Real device eefbc8d5 (Standard policy: filter_ads=false,
//      force_safesearch=true): live sync; DNR counts by id range
//      (domains 1000+, redirects 3000+, ads 5000+ = 0, safesearch 8000+ = 3);
//      facebook.com navigation -> blocked.html (Yiddish, domain + policy
//      shown); Google/Bing/DuckDuckGo searches -> the same engine host
//      with the SafeSearch-strict param added (safe=active, adlt=strict,
//      kp=1); a YouTube watch page loads normally on www.youtube.com
//      (YouTube Restricted Mode has no query param and cannot be enforced
//      by this extension — see background.js — so it must NOT be broken
//      either).
//   B. Temporary test policy (filter_ads=true, force_safesearch=true) +
//      temporary test device, DELETED afterwards: 52 ads rules and a
//      doubleclick.net navigation -> blocked.html (not ERR_BLOCKED_BY_CLIENT).
//   C. Temporary test policy (force_safesearch=false) + temporary test
//      device, DELETED afterwards: 0 SafeSearch rules and a Google search
//      navigation stays on www.google.com (gate verified off).
// NOTE: the manifest patch for blocked.html (extension/MANIFEST-PATCH-B.md)
// was expected to be REQUIRED for the DNR redirect to work. Empirically in
// Chrome 159 headless it is NOT: the facebook.com navigation landed on
// blocked.html with the query string intact and no manifest change. The
// patch file is kept as a belt-and-braces merge item (Chrome's docs ask
// for the listing), but it does not block the block page.

const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// FP_EXT_DIR lets the harness load a COPY of the extension (e.g. with the
// MANIFEST-PATCH-B.md merge applied) without touching the real manifest.json.
const EXT = process.env.FP_EXT_DIR ? path.resolve(process.env.FP_EXT_DIR) : path.join(ROOT, 'extension');
const OUT_NAME = process.env.FP_EXT_DIR ? 'results-blockpage-safesearch-patched.json' : 'results-blockpage-safesearch.json';
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

async function waitForRelay(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return true;
    await sleep(300);
  }
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

// Navigate and report the final URL + a body snippet. A DNR redirect
// changes page.url() before commit, so the URL alone proves enforcement
// even when the target site bot-checks headless Chromium afterwards.
async function navProbe(page, url) {
  const out = { asked: url };
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  } catch (e) {
    out.gotoError = String(e).split('\n')[0];
  }
  await sleep(1500);
  out.finalUrl = page.url();
  try {
    out.title = await page.title();
    out.bodySnippet = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '').catch(() => '')).replace(/\n+/g, ' | ');
    // Capture the full block-page text while we are on it (later probes
    // navigate away, so this cannot be read at the end of the case).
    if ((out.finalUrl || '').includes('/blocked.html')) {
      out.blockedText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      // Screenshot of the block page, for verify/ (name includes the probe
      // name via the caller — set below by runCase through probeShot).
      out.shotBlocked = true;
    }
  } catch (e) { out.bodySnippet = ''; }
  return out;
}

async function runCase(label, deviceId, checks) {
  const profile = path.join('/tmp', 'fp-bss-' + label.replace(/[^a-z0-9]/gi, ''));
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
      // The egress proxy MITMs TLS for non-allowlisted hosts with its own
      // CA, which Chromium does not trust (ERR_CERT_AUTHORITY_INVALID on
      // the search engines). Test-only flag: accept it so the real pages
      // can load. The DNR redirect itself is proven by the URL/host the
      // browser ends up on, with or without this flag.
      '--ignore-certificate-errors',
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

    const status = await popup.evaluate(async () => {
      try { return await chrome.runtime.sendMessage({ type: 'refresh' }); }
      catch (e) { return { error: String(e) }; }
    });
    console.log('live sync status:', JSON.stringify(status));
    result.liveSync = status;
    result.syncPath = status && status.policyFetched ? 'live' : 'FAILED';

    const rules = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
    const byRange = { domainBlock: 0, blockRedirect: 0, ads: 0, safeSearch: 0, other: 0 };
    const ssRules = [];
    const redirectRules = [];
    for (const r of rules) {
      if (r.id >= 1000 && r.id < 3000) byRange.domainBlock++;
      else if (r.id >= 3000 && r.id < 5000) { byRange.blockRedirect++; redirectRules.push(r); }
      else if (r.id >= 5000 && r.id < 8000) byRange.ads++;
      else if (r.id >= 8000) { byRange.safeSearch++; ssRules.push(r); }
      else byRange.other++;
    }
    result.dnrTotal = rules.length;
    result.dnrByRange = byRange;
    result.safeSearchRules = ssRules.map(r => ({ id: r.id, regexFilter: r.condition.regexFilter, redirect: r.action.redirect }));
    result.blockRedirectSample = redirectRules.slice(0, 3).map(r => ({ id: r.id, regexFilter: r.condition.regexFilter, redirect: r.action.redirect }));
    console.log('DNR total:', rules.length, 'by range:', JSON.stringify(byRange));

    const page = await context.newPage();
    result.probes = {};
    for (const [name, url] of Object.entries(checks.navs || {})) {
      const p = await navProbe(page, url);
      result.probes[name] = p;
      console.log(`probe ${name}:`, JSON.stringify(p).slice(0, 500));
      if (p.shotBlocked) {
        const shotPath = path.join(VERIFY_DIR, `${label}-${name}-blocked.png`);
        await page.screenshot({ path: shotPath }).catch(() => {});
        console.log(`screenshot: ${label}-${name}-blocked.png`);
      }
    }

    // Block-page content check, from the probe that landed on blocked.html.
    const blockedProbe = Object.values(result.probes).find(p => (p.finalUrl || '').includes('/blocked.html'));
    if (blockedProbe) {
      const txt = blockedProbe.blockedText || '';
      result.blockedPage = {
        url: blockedProbe.finalUrl,
        showsBlockedWord: txt.includes('בלאקירט'),
        showsDomain: txt.includes('facebook.com') || txt.includes('doubleclick.net'),
        showsPolicy: /פּאָליסי/.test(txt),
        textSnippet: txt.slice(0, 300).replace(/\n+/g, ' | '),
      };
      console.log('blocked page:', JSON.stringify(result.blockedPage));
    }
    await page.close().catch(() => {});
    await popup.close().catch(() => {});
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
  const results = { ranAt: new Date().toISOString(), syncPathNote: 'live fetch from the extension service worker via egress relay 127.0.0.1:18080 (spawned by this harness)', cases: [] };

  const relay = spawn('node', ['egress-relay.js'], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', d => console.log('[relay]', String(d).trim()));
  relay.stderr.on('data', d => console.log('[relay:err]', String(d).trim().slice(0, 300)));
  if (!await waitForRelay(18080, 15000)) {
    console.log('RELAY FAILED TO START — aborting');
    relay.kill();
    process.exit(1);
  }
  console.log('relay up on 127.0.0.1:18080');

  try {
    // --- Case A: Standard policy (filter_ads=false, force_safesearch=true) ---
    const a = await runCase('A-standard', DEVICE_STD, {
      navs: {
        facebook: 'https://www.facebook.com/',
        bingSearch: 'https://www.bing.com/search?q=albert+einstein',
        ddgSearch: 'https://duckduckgo.com/?q=albert+einstein',
        googleSearch: 'https://www.google.com/search?q=albert+einstein',
        youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    });
    a.expect = {
      liveSync: true, domainBlockRules: 22, blockRedirectRules: 11, adsRules: 0,
      safeSearchRules: 3, facebookLandsOn: 'blocked.html?d=facebook.com',
      googleParam: 'safe=active', bingParam: 'adlt=strict', ddgParam: 'kp=1',
      youtubeUnchangedHost: 'www.youtube.com',
    };
    a.pass = a.ok && a.liveSync && a.liveSync.policyFetched === true
      && a.dnrByRange.domainBlock === 22 && a.dnrByRange.blockRedirect === 11
      && a.dnrByRange.ads === 0 && a.dnrByRange.safeSearch === 3
      && a.probes.facebook && (a.probes.facebook.finalUrl || '').includes('/blocked.html?d=facebook.com')
      && a.blockedPage && a.blockedPage.showsBlockedWord && a.blockedPage.showsDomain
      // SafeSearch = the strict param present on the SAME engine host.
      // Google bot-checks headless Chromium with /sorry; the /sorry URL
      // carries the original search URL in its continue= param, so the
      // check accepts safe=active either in the URL or URL-encoded
      // inside continue=.
      && (a.probes.bingSearch.finalUrl || '').startsWith('https://www.bing.com/search')
      && (a.probes.bingSearch.finalUrl || '').includes('adlt=strict')
      && (a.probes.ddgSearch.finalUrl || '').startsWith('https://duckduckgo.com/')
      && (a.probes.ddgSearch.finalUrl || '').includes('kp=1')
      && (a.probes.googleSearch.finalUrl || '').startsWith('https://www.google.com/')
      && (/safe=active/.test(a.probes.googleSearch.finalUrl || '') || /safe%3Dactive/.test(a.probes.googleSearch.finalUrl || ''))
      && (a.probes.youtube.finalUrl || '').startsWith('https://www.youtube.com/watch');
    // If the block-page redirect failed, say so explicitly instead of a bare fail.
    a.blockedPageRedirectFailed = !!(
      a.probes.facebook
      && !(a.probes.facebook.finalUrl || '').includes('/blocked.html')
    );
    results.cases.push(a);

    // --- Case B: temp policy filter_ads=true + force_safesearch=true ---
    let testPolicyB = null, testDeviceB = null;
    try {
      const p = curlApi('POST', '/api/v1/policies', {
        name: 'Test — Blockpage Ads On',
        description: 'Temporary policy for block-page + SafeSearch verification; deleted after the run.',
        strictness: 2, cover_images: false, block_images: true,
        filter_videos: false, filter_ads: true, force_safesearch: true,
        require_approval_for_new_sites: false,
      });
      testPolicyB = p.data;
      const d = curlApi('POST', '/api/v1/devices', {
        customer_id: CUSTOMER_ID, name: 'Test Blockpage Device B', platform: 'android', policy_id: testPolicyB.id,
      });
      testDeviceB = d.data;
      console.log('\ncreated test policy B:', testPolicyB.id, '| device B:', testDeviceB.id);
    } catch (e) { console.log('FAILED to create test policy/device B:', String(e).slice(0, 500)); }

    if (testDeviceB) {
      const b = await runCase('B-ads-on', testDeviceB.id, {
        navs: { doubleclick: 'https://doubleclick.net/' },
      });
      b.expect = { adsRules: 52, doubleclickLandsOn: 'blocked.html?d=doubleclick.net' };
      b.pass = b.ok && b.liveSync && b.liveSync.policyFetched === true
        && b.liveSync.adRulesCount === 52 && b.dnrByRange.ads === 52
        && b.probes.doubleclick && (b.probes.doubleclick.finalUrl || '').includes('/blocked.html?d=doubleclick.net');
      results.cases.push(b);
    } else {
      results.cases.push({ case: 'B-ads-on', ok: false, error: 'test policy/device creation failed — case not run' });
    }

    // --- Case C: temp policy force_safesearch=false (gate off) ---
    // API BUG (verified 2026-11-18 by direct curl): POST /api/v1/policies
    // with force_safesearch=false still stores true — the create path
    // ignores the field (same family as the earlier "every boolean stored
    // as true" bug). So set the flag directly in the DB and confirm via
    // GET before running the case; if the UPDATE does not stick, the case
    // is recorded as not-run rather than faked.
    let testPolicyC = null, testDeviceC = null, forceOffConfirmed = false;
    try {
      const p = curlApi('POST', '/api/v1/policies', {
        name: 'Test — SafeSearch Off',
        description: 'Temporary policy for SafeSearch gate-off verification; deleted after the run.',
        strictness: 2, cover_images: false, block_images: true,
        filter_videos: false, filter_ads: false, force_safesearch: false,
        require_approval_for_new_sites: false,
      });
      testPolicyC = p.data;
      execFileSync('python3', ['fpsql.py', `UPDATE policies SET force_safesearch = false WHERE id = '${testPolicyC.id}';`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      const back = curlApi('GET', '/api/v1/policies/' + testPolicyC.id);
      forceOffConfirmed = back && back.data && back.data.force_safesearch === false;
      console.log('policy C force_safesearch after DB UPDATE:', back && back.data && back.data.force_safesearch, '| confirmed off:', forceOffConfirmed);
      const d = curlApi('POST', '/api/v1/devices', {
        customer_id: CUSTOMER_ID, name: 'Test Blockpage Device C', platform: 'android', policy_id: testPolicyC.id,
      });
      testDeviceC = d.data;
      console.log('\ncreated test policy C:', testPolicyC.id, '| device C:', testDeviceC.id);
    } catch (e) { console.log('FAILED to create test policy/device C:', String(e).slice(0, 500)); }

    if (testDeviceC && forceOffConfirmed) {
      const c = await runCase('C-safesearch-off', testDeviceC.id, {
        navs: { googleSearch: 'https://www.google.com/search?q=albert+einstein' },
      });
      c.expect = { safeSearchRules: 0, googleStaysOn: 'www.google.com' };
      c.pass = c.ok && c.liveSync && c.liveSync.policyFetched === true
        && c.liveSync.safeSearchEnforced === false && c.dnrByRange.safeSearch === 0
        && c.probes.googleSearch && (c.probes.googleSearch.finalUrl || '').includes('www.google.com/search');
      results.cases.push(c);
    } else {
      results.cases.push({ case: 'C-safesearch-off', ok: false, error: forceOffConfirmed ? 'test policy/device creation failed — case not run' : 'API would not persist force_safesearch=false (see API bug note) and the DB UPDATE did not stick — gate-off case not run, NOT faked' });
    }

    // --- Cleanup: delete temp devices, then policies ---
    for (const [tag, dev, pol] of [['B', testDeviceB, testPolicyB], ['C', testDeviceC, testPolicyC]]) {
      if (dev) {
        try { execFileSync('python3', ['fpsql.py', `DELETE FROM devices WHERE id = '${dev.id}';`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }); console.log(`cleanup: test device ${tag} deleted`); }
        catch (e) { console.log(`cleanup device ${tag} FAILED:`, String(e).slice(0, 300)); }
      }
      if (pol) {
        try { execFileSync('python3', ['fpsql.py', `DELETE FROM policies WHERE id = '${pol.id}';`], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }); console.log(`cleanup: test policy ${tag} deleted`); }
        catch (e) { console.log(`cleanup policy ${tag} FAILED:`, String(e).slice(0, 300)); }
      }
    }
    try {
      const left = curlApi('GET', '/api/v1/policies');
      results.cleanupCheck = {
        testPoliciesGone: !(left.data || []).some(p => p.name && (p.name.startsWith('Test — Blockpage') || p.name.startsWith('Test — SafeSearch'))),
        policyCount: (left.data || []).length,
      };
      console.log('cleanup check:', JSON.stringify(results.cleanupCheck));
    } catch (e) { results.cleanupCheck = { error: String(e).slice(0, 200) }; }
  } finally {
    relay.kill();
  }

  const outPath = path.join(VERIFY_DIR, OUT_NAME);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', outPath);
  for (const c of results.cases) console.log(JSON.stringify({ case: c.case, pass: c.pass, syncPath: c.syncPath, rules: c.dnrTotal, byRange: c.dnrByRange, blockedPageRedirectFailed: c.blockedPageRedirectFailed || undefined, probes: c.probes && Object.fromEntries(Object.entries(c.probes).map(([k, v]) => [k, v.finalUrl || v.gotoError])) }));
})().catch(e => { console.error(e); process.exit(1); });
