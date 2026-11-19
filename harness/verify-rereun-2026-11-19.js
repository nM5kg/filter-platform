// Re-run verification — Playwright + unpacked extension v1.2.0 (2026-11-19).
// Based on verify-merged.js (live sync, test page, block page, SafeSearch,
// test set) + verify-crossorigin.js real-site logic (scroll pass + settle
// wait). No temp policies/devices are created (no DB writes); the
// SafeSearch-off and ads-on temp-policy cases are NOT re-run here.
// Usage: node verify-merged.js
// Runs, in headless Chromium via the egress relay (127.0.0.1:18080):
//  A. load: SW starts, manifest version, console errors on load
//  B. test page in policy(block, Standard), cover, strict modes
//  C. strict mode (its own case — see B)
//  D. person detection on real sites: Wikipedia Main Page, BBC home,
//     Commons Featured pictures (same URLs as scanner v0.2.0)
//  E. SafeSearch on real searches + force_safesearch=false temp policy
//     (temp policy/device created via API, deleted afterwards; cleanup
//     verified with SELECT via fpsql.py)
//  F. facebook.com -> blocked.html (+ screenshot, Yiddish/domain/policy)
//  G. Google Images attempt (report /sorry honestly, never CAPTCHA)
//  + 16-photo test set in block mode (precision/recall vs ground truth)
// Reads the API token from ../api_token.txt (never printed).
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const VERIFY_DIR = path.join(EXT, 'verify');
const OUT = path.join(VERIFY_DIR, 'results-rereun-2026-11-19.json');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const CUSTOMER_ID = '142e6a02-14c8-4eda-86f5-09087ded8cdf';
const DEVICE_STD = 'eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a';
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const TEST_PAGE = path.join(EXT, 'test-page');
const TESTSET_DIR = path.join(ROOT, 'scanner', 'testset');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function curlApi(method, pathSuffix, body) {
  const args = ['-s', '-H', 'Authorization: Bearer ' + TOKEN];
  if (body) args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  if (method !== 'GET') args.push('-X', method);
  args.push(API_BASE + pathSuffix);
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', timeout: 30000 }));
}
async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) {}
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

// Stats are "settled" when found/scanned/skipped/human/uncertain/
// no-human/refetched stop changing for 15 s. Returns { settled, key }.
async function waitSettled(page, timeoutMs, label) {
  const start = Date.now();
  let lastKey = null, stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const raw = document.getElementById('fp-dom-stats');
      if (!raw) return null;
      const st = JSON.parse(raw.textContent).stats;
      return [st.found, st.scanned, st.skipped, st.human, st.uncertain, st.noHuman, st.refetched, st.refetchCacheHits].join('/');
    }).catch(() => null);
    if (s) {
      if (s === lastKey) {
        if (Date.now() - stableSince >= 15000) return { settled: true, key: s, waitedMs: Date.now() - start };
      } else { lastKey = s; stableSince = Date.now(); }
    }
    await sleep(5000);
  }
  return { settled: false, key: lastKey, waitedMs: Date.now() - start };
}
// Scanner-style scroll pass: 600 px steps to trigger lazy loading, then back to top.
async function scrollPass(page) {
  await page.evaluate(async () => {
    const h = document.body ? document.body.scrollHeight : 0;
    for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
}
function generateTestsetPage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(TESTSET_DIR, 'manifest.json'), 'utf8'));
  const rows = manifest.images.map(im =>
    `  <figure><img id="${im.id}" data-expect="${im.person_present ? 'human' : 'no-human'}" src="${im.file}" alt="${im.id}"><figcaption>${im.id}</figcaption></figure>`).join('\n');
  const html = `<!DOCTYPE html><html lang="yi" dir="rtl"><head><meta charset="utf-8"><title>testset</title>
<style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:20px} .grid{display:flex;flex-wrap:wrap;gap:16px} figure{margin:0;width:280px} figure img{width:280px;height:210px;object-fit:cover;border:1px solid #ccc}</style></head>
<body><h1>testset 16</h1><div class="grid">\n${rows}\n</div></body></html>`;
  fs.writeFileSync(path.join(TESTSET_DIR, 'testset-page.html'), html);
  return manifest;
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
      } catch (e) {}
      await p.close().catch(() => {});
    }
    return false;
  }, 60000, 'extension service worker target');
  await probePage.close().catch(() => {});
  return extId;
}
async function launch(profileTag) {
  const profile = path.join('/tmp', 'fp-rereun-' + profileTag);
  fs.rmSync(profile, { recursive: true, force: true });
  return chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args: [`--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors'],
  });
}
async function seedPopup(context, extId, seed) {
  const popup = await context.newPage();
  const consoleErrors = [];
  popup.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  popup.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)));
  await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
  const manifest = await popup.evaluate(() => chrome.runtime.getManifest()).catch(() => null);
  await popup.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(s);
  }, seed);
  return { popup, consoleErrors, manifest };
}
function readDom(page) {
  return page.evaluate(() => {
    const raw = document.getElementById('fp-dom-stats');
    const parsed = raw ? JSON.parse(raw.textContent) : null;
    return {
      stats: parsed ? parsed.stats : null,
      personReady: parsed ? parsed.personReady : null,
      log: parsed ? parsed.log : [],
      mode: document.documentElement.getAttribute('data-fp-mode'),
      personReadyAttr: document.documentElement.getAttribute('data-fp-person-ready'),
      modelReadyAttr: document.documentElement.getAttribute('data-fp-model-ready'),
      scanDoneAttr: document.documentElement.getAttribute('data-fp-scan-done'),
      imgCount: document.querySelectorAll('img').length,
      imgStates: Array.from(document.querySelectorAll('img')).map(i => ({ id: i.id || i.src.slice(-40), action: i.dataset.fpAction || 'none' })),
      blockedPlaceholders: document.querySelectorAll('[data-fp-blocked]').length,
      coveredImgs: document.querySelectorAll('[data-fp-covered]').length,
      bgBlocked: document.querySelectorAll('[data-fp-bg-blocked]').length,
      bgCoverOverlays: document.querySelectorAll('.fp-bg-cover').length,
    };
  });
}
async function runTestPage(page, url, shotName) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && m.text().includes('[fp]')) errors.push(m.text().slice(0, 250)); });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 250)));
  const navStart = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, 'model load');
  const modelReadyMs = Date.now() - navStart;
  const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 300000, 'first scan');
  const scanMs = Date.now() - navStart;
  await sleep(3500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitFor(async () => page.evaluate(() => {
    const raw = document.getElementById('fp-dom-stats');
    if (!raw) return false;
    const l = JSON.parse(raw.textContent).log;
    return l.filter(e => e.src.includes('person-marie-curie')).length >= 2 && l.filter(e => e.src.includes('person-obama-family')).length >= 2;
  }), 180000, 'dynamic+lazy processed');
  await sleep(1500);
  const dom = await readDom(page);
  await page.screenshot({ path: path.join(VERIFY_DIR, shotName), fullPage: true }).catch(() => {});
  return { ...dom, modelReady, modelReadyMs, scanDone, scanMs, consoleErrors: errors };
}
async function navProbe(page, url) {
  const out = { asked: url };
  try { await page.goto(url, { waitUntil: 'commit', timeout: 30000 }); } catch (e) { out.gotoError = String(e).split('\n')[0]; }
  await sleep(1500);
  out.finalUrl = page.url();
  try {
    out.title = await page.title();
    out.bodySnippet = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '').catch(() => '')).replace(/\n+/g, ' | ');
    if ((out.finalUrl || '').includes('/blocked.html')) {
      out.blockedText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      out.shotBlocked = true;
    }
  } catch (e) { out.bodySnippet = ''; }
  return out;
}

(async () => {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const results = { ranAt: new Date().toISOString(), extensionDir: EXT, manifest: JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')), cases: {} };
  const manifest = generateTestsetPage();

  const relay = spawn('node', ['egress-relay.js'], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', d => console.log('[relay]', String(d).trim()));
  relay.stderr.on('data', d => console.log('[relay:err]', String(d).trim().slice(0, 300)));
  if (!await waitForRelay(18080, 15000)) { console.log('RELAY FAILED'); relay.kill(); process.exit(1); }
  const servers = [
    spawn('python3', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], { cwd: TEST_PAGE, stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn('python3', ['-m', 'http.server', '8124', '--bind', '127.0.0.1'], { cwd: path.join(TEST_PAGE, 'photos'), stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn('python3', ['-m', 'http.server', '8125', '--bind', '127.0.0.1'], { cwd: TESTSET_DIR, stdio: ['ignore', 'pipe', 'pipe'] }),
  ];
  await sleep(1200);

  try {
    // ===== A+B+D+E+F+G: Standard policy context (live sync via relay) =====
    console.log('\n===== CONTEXT std (Standard policy, live sync) =====');
    const ctx = await launch('std');
    try {
      const extId = await findExtensionId(ctx);
      console.log('extension id:', extId);
      results.cases.load = { extensionId: extId, loaded: !!extId };
      if (!extId) throw new Error('Extension SW never appeared');
      const { popup, consoleErrors, manifest: liveManifest } = await seedPopup(ctx, extId, { fpToken: TOKEN, fpDeviceId: DEVICE_STD, fpCustomerId: CUSTOMER_ID, fpDemoMode: 'policy' });
      results.cases.load.manifestVersion = liveManifest && liveManifest.version;
      results.cases.load.manifestName = liveManifest && liveManifest.name;
      results.cases.load.popupConsoleErrors = consoleErrors;
      const status = await popup.evaluate(async () => { try { return await chrome.runtime.sendMessage({ type: 'refresh' }); } catch (e) { return { error: String(e) }; } });
      console.log('live sync:', JSON.stringify(status));
      results.cases.load.liveSync = status;
      results.cases.load.syncPath = status && status.policyFetched ? 'live' : 'FAILED';
      const rules = await popup.evaluate(async () => chrome.declarativeNetRequest.getDynamicRules());
      const byRange = { domainBlock: 0, blockRedirect: 0, ads: 0, safeSearch: 0, other: 0 };
      for (const r of rules) {
        if (r.id >= 1000 && r.id < 3000) byRange.domainBlock++;
        else if (r.id >= 3000 && r.id < 5000) byRange.blockRedirect++;
        else if (r.id >= 5000 && r.id < 8000) byRange.ads++;
        else if (r.id >= 8000) byRange.safeSearch++;
        else byRange.other++;
      }
      results.cases.load.dnrTotal = rules.length;
      results.cases.load.dnrByRange = byRange;
      console.log('DNR total:', rules.length, JSON.stringify(byRange));

      const page = await ctx.newPage();
      page.on('console', m => { if (m.text().includes('[fp]')) console.log('  page console:', m.text().slice(0, 250)); });
      page.on('pageerror', e => console.log('  page error:', String(e).slice(0, 300)));

      // B: test page in policy (=block) mode
      console.log('\n--- test page, Standard policy (expect block) ---');
      const tp = await runTestPage(page, 'http://127.0.0.1:8123/index.html', 'rereun-standard-testpage.png');
      results.cases.testPageStandard = tp;
      console.log('stats:', JSON.stringify(tp.stats), 'mode:', tp.mode, 'personReady:', tp.personReadyAttr);

      // F: facebook -> blocked.html
      console.log('\n--- facebook navigation ---');
      const fb = await navProbe(page, 'https://www.facebook.com/');
      results.cases.facebook = fb;
      console.log('facebook:', JSON.stringify(fb).slice(0, 600));
      if (fb.shotBlocked) await page.screenshot({ path: path.join(VERIFY_DIR, 'rereun-facebook-blocked.png') }).catch(() => {});
      if (fb.blockedText) {
        results.cases.blockedPage = {
          url: fb.finalUrl,
          showsBlockedWord: fb.blockedText.includes('בלאקירט'),
          showsDomain: fb.blockedText.includes('facebook.com'),
          showsPolicy: /פּאָליסי/.test(fb.blockedText),
          textSnippet: fb.blockedText.slice(0, 400).replace(/\n+/g, ' | '),
        };
        console.log('blocked page:', JSON.stringify(results.cases.blockedPage));
      }

      // E: SafeSearch probes
      console.log('\n--- SafeSearch probes ---');
      const ss = {};
      for (const [name, url] of Object.entries({
        bing: 'https://www.bing.com/search?q=albert+einstein',
        ddg: 'https://duckduckgo.com/?q=albert+einstein',
        google: 'https://www.google.com/search?q=albert+einstein',
        youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      })) {
        ss[name] = await navProbe(page, url);
        console.log(`probe ${name}:`, ss[name].finalUrl, '|', (ss[name].title || '').slice(0, 60));
      }
      results.cases.safeSearch = ss;

      // G: Google Images
      console.log('\n--- Google Images ---');
      let g = null;
      try {
        const resp = await page.goto('https://images.google.com/search?q=albert+einstein&tbm=isch', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(6000);
        const gstats = await page.evaluate(() => {
          const raw = document.getElementById('fp-dom-stats');
          return raw ? JSON.parse(raw.textContent).stats : null;
        }).catch(() => null);
        g = { httpStatus: resp ? resp.status() : null, url: page.url(), title: await page.title().catch(() => ''), bodySnippet: (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '').catch(() => '')).replace(/\n+/g, ' | '), stats: gstats };
      } catch (e) { g = { error: String(e).split('\n')[0] }; }
      results.cases.googleImages = g;
      console.log('google images:', JSON.stringify(g));
      await page.screenshot({ path: path.join(VERIFY_DIR, 'rereun-google-images.png') }).catch(() => {});

      // D: real sites (same context, block mode via Standard policy) —
      // cross-origin harness logic: scroll pass + settle wait, 420 s caps.
      console.log('\n--- real sites ---');
      results.cases.realSites = {};
      for (const [name, url, shot] of [
        ['wikipedia', 'https://en.wikipedia.org/wiki/Main_Page', 'rereun-wikipedia.png'],
        ['bbc', 'https://www.bbc.com/', 'rereun-bbc.png'],
        ['commons', 'https://commons.wikimedia.org/wiki/Commons:Featured_pictures', 'rereun-commons.png'],
      ]) {
        console.log(`\n--- real site ${name}: ${url} ---`);
        const t0 = Date.now();
        let navErr = null;
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { navErr = String(e).split('\n')[0]; }
        await sleep(3000);
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, name + ' model load');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 420000, name + ' scan');
        await scrollPass(page);
        const settled = await waitSettled(page, 420000, name + ' settle');
        const dom = await readDom(page).catch(e => ({ readError: String(e).slice(0, 200) }));
        const humanLog = (dom.log || []).filter(e => e.result === 'human' || e.result === 'uncertain');
        const viaCounts = {};
        for (const e of (dom.log || [])) viaCounts[e.via || 'direct'] = (viaCounts[e.via || 'direct'] || 0) + 1;
        results.cases.realSites[name] = { url, finalUrl: page.url(), navError: navErr, modelReady, scanDone, settled, elapsedMs: Date.now() - t0, ...dom, viaCounts, humanLog };
        console.log(name, 'final:', page.url(), 'scanDone:', scanDone, 'settled:', JSON.stringify(settled), 'stats:', JSON.stringify(dom.stats), 'imgs:', dom.imgCount);
        console.log('  via:', JSON.stringify(viaCounts));
        for (const e of humanLog.slice(0, 40)) console.log('  human/uncertain:', JSON.stringify(e));
        await page.screenshot({ path: path.join(VERIFY_DIR, shot) }).catch(() => {});
      }
      // example.com must ALLOW (not blocked, loads normally)
      console.log('\n--- example.com (must ALLOW) ---');
      const ex = await navProbe(page, 'https://example.com/');
      let exDom = null;
      try { exDom = await readDom(page); } catch (e) { exDom = { readError: String(e).slice(0, 200) }; }
      results.cases.exampleCom = { ...ex, stats: exDom && exDom.stats, imgCount: exDom && exDom.imgCount, allowed: !(ex.finalUrl || '').includes('/blocked.html') && (ex.finalUrl || '').startsWith('https://example.com') };
      console.log('example.com:', JSON.stringify({ finalUrl: ex.finalUrl, title: ex.title, allowed: results.cases.exampleCom.allowed, stats: exDom && exDom.stats }));
      await page.close().catch(() => {});
      await popup.close().catch(() => {});
    } finally { await ctx.close().catch(() => {}); }

    // ===== cover + strict demo contexts (test page only) =====
    for (const mode of ['cover', 'strict']) {
      console.log(`\n===== CONTEXT demo-${mode} =====`);
      const c2 = await launch('demo-' + mode);
      try {
        const extId = await findExtensionId(c2);
        const { popup } = await seedPopup(c2, extId, { fpDemoMode: mode });
        await popup.close().catch(() => {});
        const page = await c2.newPage();
        const tp = await runTestPage(page, 'http://127.0.0.1:8123/index.html', `rereun-${mode}-testpage.png`);
        results.cases['testPage_' + mode] = tp;
        console.log(mode, 'stats:', JSON.stringify(tp.stats), 'mode:', tp.mode, 'personReady:', tp.personReadyAttr);
        await page.close().catch(() => {});
      } finally { await c2.close().catch(() => {}); }
    }

    // ===== testset, block mode (precision/recall) =====
    console.log('\n===== CONTEXT testset-block =====');
    const c3 = await launch('testset');
    try {
      const extId = await findExtensionId(c3);
      const { popup } = await seedPopup(c3, extId, { fpDemoMode: 'block' });
      await popup.close().catch(() => {});
      const page = await c3.newPage();
      const navStart = Date.now();
      await page.goto('http://127.0.0.1:8125/testset-page.html', { waitUntil: 'load', timeout: 30000 });
      const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, 'testset model');
      const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 300000, 'testset scan');
      await sleep(2000);
      const ts = await readDom(page);
      const byFile = {};
      for (const e of ts.log) { if (e.kind !== 'img') continue; byFile[decodeURIComponent(e.src.split('/').pop().split('?')[0])] = e; }
      let tpN = 0, fpN = 0, fnN = 0, tnN = 0, uncertainPerson = 0, missedToAllow = 0, missing = 0;
      const perImage = [];
      for (const im of manifest.images) {
        const e = byFile[im.file];
        if (!e) { missing++; perImage.push({ id: im.id, file: im.file, truth: im.person_present, verdict: 'MISSING' }); continue; }
        const verdict = e.result;
        if (im.person_present && verdict === 'human') tpN++;
        else if (!im.person_present && verdict === 'human') fpN++;
        else if (im.person_present && verdict !== 'human') { fnN++; if (verdict === 'uncertain') uncertainPerson++; else missedToAllow++; }
        else tnN++;
        perImage.push({ id: im.id, file: im.file, truth: im.person_present, verdict, persons: e.persons, personBest: e.personBest, faces: e.faces, faceBest: e.faceBest, detectedBy: e.detectedBy, ms: e.ms, action: e.action });
      }
      const metrics = { n: 16, tp: tpN, fp: fpN, fn: fnN, tn: tnN, precision: tpN + fpN ? +(tpN / (tpN + fpN)).toFixed(3) : null, recall: tpN + fnN ? +(tpN / (tpN + fnN)).toFixed(3) : null, uncertainPersonImages: uncertainPerson, missedToAllow, missing, scanMs: Date.now() - navStart, modelReady, scanDone };
      results.cases.testsetBlock = { metrics, perImage, stats: ts.stats, personReady: ts.personReadyAttr };
      console.log('testset metrics:', JSON.stringify(metrics));
      for (const p of perImage) console.log('  img:', JSON.stringify(p));
      await page.close().catch(() => {});
    } finally { await c3.close().catch(() => {}); }

    // NOTE: temp-policy cases (SafeSearch-off, ads-on) and DB cleanup
    // are intentionally NOT re-run here — verification only, no DB writes.
  } finally {
    relay.kill();
    for (const s of servers) s.kill();
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', OUT);
  console.log(JSON.stringify({
    load: results.cases.load && { loaded: results.cases.load.loaded, version: results.cases.load.manifestVersion, syncPath: results.cases.load.syncPath, dnr: results.cases.load.dnrByRange, popupErrors: (results.cases.load.popupConsoleErrors || []).length },
    testPageStandard: results.cases.testPageStandard && results.cases.testPageStandard.stats,
    testPageCover: results.cases.testPage_cover && results.cases.testPage_cover.stats,
    testPageStrict: results.cases.testPage_strict && results.cases.testPage_strict.stats,
    testset: results.cases.testsetBlock && results.cases.testsetBlock.metrics,
    realSites: results.cases.realSites && Object.fromEntries(Object.entries(results.cases.realSites).map(([k, v]) => [k, { scanDone: v.scanDone, settled: v.settled && v.settled.settled, stats: v.stats, imgs: v.imgCount, via: v.viaCounts, finalUrl: v.finalUrl }])),
    facebook: results.cases.facebook && results.cases.facebook.finalUrl,
    safeSearch: results.cases.safeSearch && Object.fromEntries(Object.entries(results.cases.safeSearch).map(([k, v]) => [k, v.finalUrl])),
    exampleCom: results.cases.exampleCom && { allowed: results.cases.exampleCom.allowed, finalUrl: results.cases.exampleCom.finalUrl, stats: results.cases.exampleCom.stats },
    googleImages: results.cases.googleImages,
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
