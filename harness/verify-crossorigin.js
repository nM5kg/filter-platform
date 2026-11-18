// Cross-origin refetch verification — Playwright + unpacked extension.
// Usage: node verify-crossorigin.js
// Verifies the v1.2.0 fix: cross-origin <img> pixels are re-fetched from
// the content script (host_permissions) and run through the existing
// person+face detection, instead of short-circuiting to "uncertain".
//   1. test page in demo block mode (expect img-xorigin-local, the
//      cross-origin no-CORS Einstein, now DETECTED as human, not
//      uncertain-covered; facebook favicon probe now detected no-human)
//   2. test page in demo cover mode (same verdicts, covered not blocked)
//   3. labeled 16-photo test set in block mode (precision/recall vs the
//      pre-fix 1.000/0.727 — same-origin set, should reproduce exactly)
//   4. REAL sites via the egress relay (127.0.0.1:18080): Wikipedia Main
//      Page, BBC home, Commons Featured pictures — scroll pass like the
//      scanner, settle wait, then imgs/scanned/human/blocked/covered/
//      uncertain/personHits + per-image log; compare vs the scanner's
//      person+face counts (Wikipedia 4/4, BBC 20/20, Commons 4/4)
//   5. exfiltration audit on the real-site runs: every request the
//      extension makes must be a GET of a URL the page already loads
//      (a DOM <img> src or a redirect descendant of one); no POSTs, no
//      new third-party hosts, no request bodies.
// Demo modes only (no API token, no live policy sync); local servers
// :8123 test page, :8124 photos, :8125 test set.
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const VERIFY_DIR = path.join(EXT, 'verify');
const OUT = path.join(VERIFY_DIR, 'results-crossorigin-2026-11-18.json');
const TEST_PAGE = path.join(EXT, 'test-page');
const TESTSET_DIR = path.join(ROOT, 'scanner', 'testset');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
async function launch(profileTag, useRelay) {
  const profile = path.join('/tmp', 'fp-xorigin-' + profileTag);
  fs.rmSync(profile, { recursive: true, force: true });
  const args = [`--load-extension=${EXT}`, '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'];
  if (useRelay) args.push('--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1');
  return chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
    args,
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
      imgStates: Array.from(document.querySelectorAll('img')).map(i => ({ id: i.id || i.src.slice(-50), action: i.dataset.fpAction || 'none' })),
      blockedPlaceholders: document.querySelectorAll('[data-fp-blocked]').length,
      coveredImgs: document.querySelectorAll('[data-fp-covered]').length,
      bgBlocked: document.querySelectorAll('[data-fp-bg-blocked]').length,
      bgCoverOverlays: document.querySelectorAll('.fp-bg-cover').length,
    };
  });
}
// Stats are "settled" when found/scanned/skipped/human/uncertain/
// no-human/refetched stop changing for 15 s (re-scans keep moving them
// while lazy images load). Returns { settled, key }.
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
// Scanner-style scroll pass (scanner.js:401-403): 600 px steps to trigger
// lazy loading, then back to the top.
async function scrollPass(page) {
  await page.evaluate(async () => {
    const h = document.body ? document.body.scrollHeight : 0;
    for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
}
// Snapshot the page's resources: image URLs, image hosts, and every
// host the page itself references (scripts, links, iframes, backgrounds).
// Taken right after navigation, before the scan blocks/replaces images.
function snapshotResources(page) {
  return page.evaluate(() => {
    const imgUrls = new Set(), imgHosts = new Set(), allHosts = new Set([location.host]);
    const addUrl = (u) => {
      if (!u) return null;
      try {
        const abs = new URL(u, location.href).href;
        allHosts.add(new URL(abs).host);
        return abs;
      } catch (e) { return null; }
    };
    for (const i of document.querySelectorAll('img')) {
      const a = addUrl(i.currentSrc || i.src);
      if (a) { imgUrls.add(a); try { imgHosts.add(new URL(a).host); } catch (e) {} }
    }
    for (const el of document.querySelectorAll('script[src], link[href], iframe[src], source[src], video[poster]')) {
      addUrl(el.src || el.href || el.poster);
    }
    for (const el of document.querySelectorAll('*')) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) { const a = addUrl(m[1]); if (a) { imgUrls.add(a); try { imgHosts.add(new URL(a).host); } catch (e) {} } }
    }
    return { imgUrls: Array.from(imgUrls), imgHosts: Array.from(imgHosts), allHosts: Array.from(allHosts) };
  }).catch(() => ({ imgUrls: [], imgHosts: [], allHosts: [] }));
}

// Context-level request capture (sees the detector iframe's fetches too —
// page-level capture would miss them). Returns { requests, responses, detach }.
function attachCapture(context) {
  const requests = [];
  const responses = {};
  const onReq = r => {
    let root = r.url();
    let red = r.redirectedFrom();
    while (red) { root = red.url(); red = red.redirectedFrom(); }
    requests.push({ url: r.url(), method: r.method(), resourceType: r.resourceType(), redirectRoot: root === r.url() ? null : root });
  };
  const onResp = (resp) => {
    responses[resp.url()] = { status: resp.status(), fromCache: null };
    try {
      const v = resp.fromCache();
      if (v && typeof v.then === 'function') v.then(x => { if (responses[resp.url()]) responses[resp.url()].fromCache = x; }).catch(() => {});
      else responses[resp.url()].fromCache = v;
    } catch (e) {}
  };
  context.on('request', onReq);
  context.on('response', onResp);
  return { requests, responses, detach: () => { context.off('request', onReq); context.off('response', onResp); } };
}

// Build the audit inputs from a nav snapshot + the extension log, then run it.
function runAudit(requests, responses, pageOrigin, navSnap, log) {
  const logSrcs = (log || []).map(e => e.src).filter(Boolean);
  const logRefetchUrls = new Set((log || []).filter(e => ['refetch-iframe', 'refetch-direct', 'refetch'].includes(e.via)).map(e => e.src).filter(Boolean)); // 'refetch-cache' issued no fetch — excluded
  const refUrls = new Set([...(navSnap ? navSnap.imgUrls : []), ...logSrcs]);
  const refHosts = new Set(navSnap ? navSnap.allHosts : []);
  const domImgHosts = new Set(navSnap ? navSnap.imgHosts : []);
  for (const u of refUrls) {
    try { const h = new URL(u).host; refHosts.add(h); domImgHosts.add(h); } catch (e) {}
  }
  return auditRequests(requests, responses, pageOrigin, Array.from(refUrls), refHosts, domImgHosts, logRefetchUrls);
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
// --- request audit -----------------------------------------------------
// Requests are captured at CONTEXT level (not page level) so the
// detector iframe's fetches (an extension-origin subframe) are seen too.
// Reference sets:
//   refUrls  = nav-time DOM image URLs + every src in the extension log
//              (the log is authoritative: a blocked image leaves the DOM
//              when blockImg replaces it, so a post-scan DOM snapshot
//              alone would miss exactly the human images)
//   refHosts = hosts of every nav-time page resource (img/script/link/
//              iframe/bg) + the page origin — the page's own assets.
// A request is EXPECTED if it is a local test server / chrome-extension
// file / inline (data:/blob: probe loads) / a ref URL (or a redirect
// descendant of one) / a page-asset host / a page image load.
// fetch/xhr requests get a second, stricter check (refetchMatch): every
// URL the extension log says was refetched (via refetch-iframe /
// refetch-direct) must have a matching fetch request to exactly that
// URL, and any fetch to an image host NOT in the log is listed for
// review. Non-GET requests are listed with hosts — the extension issues
// only GETs (code inspection), so every non-GET must be the page's own
// telemetry/ads or Chrome's own odml telemetry.
function auditRequests(requests, responses, pageOrigin, refUrls, refHosts, domImgHosts, logRefetchUrls) {
  const refSet = new Set(refUrls);
  const byClass = {};
  const unexpected = [];
  const fetchReqs = [];
  const nonGet = [];
  const hosts = {};
  for (const r of requests) {
    let cls;
    const u = r.url;
    let host = '';
    try { host = new URL(u).host; } catch (e) {}
    hosts[host] = (hosts[host] || 0) + 1;
    if (u.startsWith('http://127.0.0.1:8123/') || u.startsWith('http://127.0.0.1:8124/') || u.startsWith('http://127.0.0.1:8125/')) cls = 'local-test-server';
    else if (u.startsWith('chrome-extension://')) cls = 'extension-file';
    else if (u.startsWith('data:') || u.startsWith('blob:')) cls = 'inline';
    else if (refSet.has(u)) cls = 'ref-url';
    else if (r.redirectRoot && refSet.has(r.redirectRoot)) cls = 'ref-url-redirect';
    else if (host === pageOrigin) cls = 'page-own-origin';
    else if (refHosts.has(host)) cls = 'page-asset-host';
    else if (r.resourceType === 'image') cls = 'page-image-other';
    else cls = 'UNEXPECTED';
    byClass[cls] = (byClass[cls] || 0) + 1;
    if (cls === 'UNEXPECTED') unexpected.push({ url: u.slice(0, 200), method: r.method, type: r.resourceType });
    if (r.resourceType === 'fetch' || r.resourceType === 'xhr') {
      fetchReqs.push({ url: u, method: r.method, type: r.resourceType, cls, imgHost: domImgHosts.has(host), redirectRoot: r.redirectRoot || undefined, status: responses[u] ? responses[u].status : undefined, fromCache: responses[u] ? responses[u].fromCache : undefined });
    }
    if (r.method !== 'GET') nonGet.push({ url: u.slice(0, 200), method: r.method, host });
  }
  // Refetch matching: every refetched log URL must have a fetch request
  // to exactly that URL (page load = image request, refetch = fetch
  // request). A fetch to an IMAGE host that is in neither the log nor
  // the nav DOM would be a fetch the extension cannot account for.
  const refetchUrls = [...logRefetchUrls];
  const refetchWithoutFetch = refetchUrls.filter(u => !fetchReqs.some(f => f.url === u));
  const fetchToImgHostNotLogged = fetchReqs.filter(f => f.imgHost && !refSet.has(f.url) && !(f.redirectRoot && refSet.has(f.redirectRoot)));
  return { total: requests.length, byClass, hosts, unexpected, fetchReqs, fetchToImgHostNotLogged, nonGet, refetchMatch: { refetchUrls: refetchUrls.length, refetchWithoutFetch: refetchWithoutFetch.slice(0, 10), refetchWithoutFetchCount: refetchWithoutFetch.length, fetchToImgHostNotLoggedCount: fetchToImgHostNotLogged.length } };
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
    // ===== 1+2. test page, demo block + cover (relay context so the
    // Wikimedia cross-origin image can load) =====
    for (const mode of ['block', 'cover']) {
      console.log(`\n===== TEST PAGE demo-${mode} =====`);
      const ctx = await launch('tp-' + mode, true);
      try {
        const extId = await findExtensionId(ctx);
        const { popup } = await seedPopup(ctx, extId, { fpDemoMode: mode });
        await popup.close().catch(() => {});
        const page = await ctx.newPage();
        const cap = attachCapture(ctx);
        const tp = await runTestPage(page, 'http://127.0.0.1:8123/index.html', `xorigin-${mode}-testpage.png`);
        results.cases['testPage_' + mode] = tp;
        console.log(mode, 'stats:', JSON.stringify(tp.stats), 'mode:', tp.mode, 'personReady:', tp.personReadyAttr);
        for (const e of tp.log) {
          if (e.src.includes('xorigin') || e.src.includes('facebook') || e.src.includes('8124') || e.kind === 'background') console.log('  xorigin/bg log:', JSON.stringify(e));
        }
        // Local-run audit: reference = post-run DOM + extension log srcs.
        const navSnap = await snapshotResources(page);
        const audit = runAudit(cap.requests, cap.responses, '127.0.0.1:8123', navSnap, tp.log);
        cap.detach();
        // For the local run, page-xorigin images (wikimedia FilePath,
        // facebook favicon) are ref URLs, so the generic audit applies.
        results.cases['testPage_' + mode].audit = audit;
        console.log('audit byClass:', JSON.stringify(audit.byClass), '| UNEXPECTED:', audit.unexpected.length, '| non-GET:', audit.nonGet.length);
        console.log('refetchMatch:', JSON.stringify(audit.refetchMatch), '| fetch-to-img-host-not-logged:', audit.fetchToImgHostNotLogged.length);
        for (const f of audit.fetchReqs) console.log('  fetch req:', JSON.stringify({ ...f, url: f.url.slice(0, 160) }));
        for (const u of audit.unexpected.slice(0, 5)) console.log('  UNEXPECTED:', JSON.stringify(u));
        await page.close().catch(() => {});
      } finally { await ctx.close().catch(() => {}); }
    }

    // ===== 3. test set, block mode =====
    console.log('\n===== TEST SET (16 photos, block) =====');
    const c3 = await launch('testset', true);
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
        perImage.push({ id: im.id, file: im.file, truth: im.person_present, verdict, persons: e.persons, personBest: e.personBest, faces: e.faces, faceBest: e.faceBest, detectedBy: e.detectedBy, via: e.via, ms: e.ms, action: e.action });
      }
      const metrics = { n: 16, tp: tpN, fp: fpN, fn: fnN, tn: tnN, precision: tpN + fpN ? +(tpN / (tpN + fpN)).toFixed(3) : null, recall: tpN + fnN ? +(tpN / (tpN + fnN)).toFixed(3) : null, uncertainPersonImages: uncertainPerson, missedToAllow, missing, scanMs: Date.now() - navStart, modelReady, scanDone };
      results.cases.testsetBlock = { metrics, perImage, stats: ts.stats, personReady: ts.personReadyAttr };
      console.log('testset metrics:', JSON.stringify(metrics));
      for (const p of perImage) console.log('  img:', JSON.stringify(p));
      await page.close().catch(() => {});
    } finally { await c3.close().catch(() => {}); }

    // ===== 4. REAL sites (demo block, relay) =====
    console.log('\n===== REAL SITES (demo block) =====');
    const ctx = await launch('real', true);
    try {
      const extId = await findExtensionId(ctx);
      console.log('extension id:', extId);
      const { popup, manifest: liveManifest } = await seedPopup(ctx, extId, { fpDemoMode: 'block' });
      results.cases.realSites = { manifestVersion: liveManifest && liveManifest.version, sites: {} };
      await popup.close().catch(() => {});
      const page = await ctx.newPage();
      page.on('console', m => { if (m.text().includes('[fp]')) console.log('  page console:', m.text().slice(0, 250)); });
      page.on('pageerror', e => console.log('  page error:', String(e).slice(0, 300)));

      for (const [name, url, shot] of [
        ['wikipedia', 'https://en.wikipedia.org/wiki/Main_Page', 'xorigin-wikipedia.png'],
        ['bbc', 'https://www.bbc.com/', 'xorigin-bbc.png'],
        ['commons', 'https://commons.wikimedia.org/wiki/Commons:Featured_pictures', 'xorigin-commons.png'],
      ]) {
        console.log(`\n--- real site ${name}: ${url} ---`);
        const cap = attachCapture(ctx);
        const t0 = Date.now();
        let navErr = null;
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { navErr = String(e).split('\n')[0]; }
        await sleep(3000);
        const navSnap = await snapshotResources(page);
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, name + ' model load');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 420000, name + ' scan');
        await scrollPass(page);
        const settled = await waitSettled(page, 420000, name + ' settle');
        const dom = await readDom(page).catch(e => ({ readError: String(e).slice(0, 200) }));
        const pageOrigin = new URL(url).host;
        const audit = runAudit(cap.requests, cap.responses, pageOrigin, navSnap, dom.log || []);
        cap.detach();
        const humanLog = (dom.log || []).filter(e => e.result === 'human' || e.result === 'uncertain');
        const viaCounts = {};
        for (const e of (dom.log || [])) viaCounts[e.via || 'direct'] = (viaCounts[e.via || 'direct'] || 0) + 1;
        results.cases.realSites.sites[name] = {
          url, finalUrl: page.url(), navError: navErr, modelReady, scanDone, settled,
          elapsedMs: Date.now() - t0, ...dom, navImgUrls: navSnap.imgUrls.length,
          viaCounts, humanLog, audit,
        };
        console.log(name, 'final:', page.url(), 'scanDone:', scanDone, 'settled:', JSON.stringify(settled), 'stats:', JSON.stringify(dom.stats), 'imgs:', dom.imgCount, 'navImgUrls:', navSnap.imgUrls.length);
        console.log('  via:', JSON.stringify(viaCounts));
        console.log('  audit byClass:', JSON.stringify(audit.byClass), '| UNEXPECTED:', audit.unexpected.length, '| non-GET:', audit.nonGet.length);
        console.log('  refetchMatch:', JSON.stringify(audit.refetchMatch));
        console.log('  hosts:', JSON.stringify(audit.hosts));
        for (const f of audit.fetchToImgHostNotLogged.slice(0, 10)) console.log('  FETCH-TO-IMG-HOST-NOT-LOGGED:', JSON.stringify({ ...f, url: f.url.slice(0, 160) }));
        for (const u of audit.unexpected.slice(0, 10)) console.log('  UNEXPECTED:', JSON.stringify(u));
        for (const g of audit.nonGet.slice(0, 10)) console.log('  non-GET:', JSON.stringify(g));
        for (const e of humanLog.slice(0, 40)) console.log('  human/uncertain:', JSON.stringify(e));
        await page.screenshot({ path: path.join(VERIFY_DIR, shot) }).catch(() => {});
      }
      await page.close().catch(() => {});
    } finally { await ctx.close().catch(() => {}); }
  } finally {
    relay.kill();
    for (const s of servers) s.kill();
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', OUT);
  console.log(JSON.stringify({
    testPageBlock: results.cases.testPage_block && results.cases.testPage_block.stats,
    testPageCover: results.cases.testPage_cover && results.cases.testPage_cover.stats,
    testset: results.cases.testsetBlock && results.cases.testsetBlock.metrics,
    realSites: results.cases.realSites && Object.fromEntries(Object.entries(results.cases.realSites.sites).map(([k, v]) => [k, { scanDone: v.scanDone, settled: v.settled && v.settled.settled, stats: v.stats, imgs: v.imgCount, via: v.viaCounts, auditByClass: v.audit && v.audit.byClass, unexpected: v.audit && v.audit.unexpected.length, refetchMatch: v.audit && v.audit.refetchMatch }])),
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
