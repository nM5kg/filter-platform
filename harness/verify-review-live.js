// LIVE verification of the review/paint build (wave-1 A+B+C + integration
// fixes) against the DEPLOYED URLs — no stubs, no local server.
//   Shell:  https://filter-platform-dashboard.pages.dev/browser.html
//   Proxy:  https://filter-platform-web-browser.gavhah-copy.workers.dev
//   API:    https://filter-platform-api.gavhah-copy.workers.dev
//
// Run: node harness/verify-review-live.js (exit 0 = core checks pass).
// Results: harness/verify-review-live-results.json
//
// Cases (all numbers from this live run, nothing stubbed):
//   (a) human images covered on first scan (test page 01)
//   (b) human image painted after a real review (allow_painted + boxes:
//       paint overlay divs checked against the cached box fractions)
//   (c) non-human images left visible (landscape allowed + download btn)
//   (d) uncertain -> request -> decision round-trip end-to-end:
//       click the request button on a real covered image, wait for the
//       ~150 MB first model load + inference, verify the final state
//       (painted) AND the decision recorded (API GET via proxy + direct)
//   (e) downloads fail closed: covered image + painted image -> blocked
//   (f) paint/block setting flip: same image (d1 crowd) paints in paint
//       mode and blocks whole in block mode
//   (g) real sites: Wikipedia + BBC counts (covered / allowed / unscanned)
// Fresh browser profile every run, so the first review measures a true
// first model load (IndexedDB empty).
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'verify-review-live-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const PAGES = 'https://filter-platform-dashboard.pages.dev';
const PROXY = 'https://filter-platform-web-browser.gavhah-copy.workers.dev';
const API = 'https://filter-platform-api.gavhah-copy.workers.dev';
const TEST01 = PAGES + '/test-pages/01-html-images.html';
const D1_URL = PAGES + '/test-pages/assets/d1-crowd-funeral.jpg';
const P1_URL = PAGES + '/test-pages/assets/p1-huang-portrait.jpg';
const L1_URL = PAGES + '/test-pages/assets/l1-glacier-lake.jpg';
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uKey = (url) => 'u:' + crypto.createHash('sha256').update(url).digest('hex');

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) { /* keep waiting */ }
    await sleep(2000);
  }
  console.log('TIMEOUT waiting for:', label);
  return false;
}

async function apiGet(key) {
  const r = await fetch(PROXY + '/review-decision?image_key=' + encodeURIComponent(key),
    { headers: { 'User-Agent': UA } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* raw */ }
  return { via: 'proxy', status: r.status, body: j || t.slice(0, 200) };
}
async function apiGetDirect(key) {
  const r = await fetch(API + '/api/v1/review-decisions?image_key=' + encodeURIComponent(key),
    { headers: { 'User-Agent': UA, Authorization: 'Bearer ' + TOKEN } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) { /* raw */ }
  return { via: 'api-direct', status: r.status, body: j || t.slice(0, 200) };
}

(async () => {
  const results = { startedAt: new Date().toISOString(), cases: {}, errors: [] };
  // The sandbox egress proxy needs the local relay (same as
  // verify-web-browser.js): Chromium only sends Proxy-Authorization
  // after a 407, and the egress proxy drops unauthenticated connections
  // without one — direct launch fails with ERR_TUNNEL_CONNECTION_FAILED.
  const relay = spawn('node', [path.join(__dirname, 'egress-relay.js')], {
    env: { ...process.env, RELAY_PORT: '18080' }, stdio: 'ignore',
  });
  const relayUp = await new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const s = net.connect(18080, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { if (Date.now() - start > 15000) resolve(false); else setTimeout(tick, 300); });
    };
    tick();
  });
  if (!relayUp) { console.log('relay did not come up'); relay.kill(); process.exit(1); }
  console.log('relay up on 127.0.0.1:18080');
  const profile = path.join('/tmp', 'fp-review-live-' + Date.now());
  const dlDir = path.join('/tmp', 'fp-review-live-downloads-' + Date.now());
  fs.mkdirSync(dlDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 60000,
    executablePath: CHROME,
    acceptDownloads: true,
    downloadsPath: dlDir,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080',
      '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const browser = context;
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  page.on('download', (dl) => { console.log('DOWNLOAD EVENT:', dl.suggestedFilename()); });
  page.on('pageerror', (e) => results.errors.push('pageerror: ' + String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') results.errors.push('console: ' + m.text().slice(0, 200)); });

  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    blocked: document.getElementById('stBlocked').textContent,
    painted: document.getElementById('stPainted').textContent,
    scanned: document.getElementById('stScanned').textContent,
    unscanned: document.getElementById('stUnscanned').textContent,
    detector: document.getElementById('stDetector').textContent,
    api: document.getElementById('stApi').textContent,
    addr: document.getElementById('addr').value,
  }));
  const proxyFrame = async () => {
    const el = await page.$('#frame');
    if (!el) return null;
    try { return await el.contentFrame(); } catch (e) { return null; }
  };
  const frameEval = async (fn, arg) => {
    const fr = await proxyFrame();
    if (!fr) return null;
    try { return await fr.evaluate(fn, arg); } catch (e) { return { error: String(e.message).slice(0, 200) }; }
  };
  const navigateViaShell = async (target) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.fill('#addr', target);
    await page.click('#goBtn');
    await sleep(1500);
  };
  // Wait for a settled scan; if the scan comes back all-unscanned
  // (first-stage detector failed on this load — seen once live on a
  // reload: covered 0, allowed 7, unscanned 7), reload once and retry
  // instead of trusting the empty result.
  const waitSettled = async (label) => {
    let ok = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.covered) >= 2 && Number(s.allowed) >= 1;
    }, 120000, label);
    if (!ok) {
      const s = await shellStatus();
      if (Number(s.scanned) > 0 && Number(s.unscanned) === Number(s.scanned) && Number(s.covered) === 0) {
        console.log('all-unscanned scan detected — reloading once and retrying');
        await page.click('#reloadBtn');
        await sleep(2000);
        ok = await waitFor(async () => {
          const s2 = await shellStatus();
          return Number(s2.covered) >= 2 && Number(s2.allowed) >= 1;
        }, 120000, label + ' (after reload)');
      }
    }
    return ok;
  };
  // Wait for a REAL site's own scan: the iframe target AND the shell
  // address must show the host (a bare scanned>0 check can pass on the
  // PREVIOUS page's stale counts), then wait for the counts to stop
  // changing (two identical readings) so the snapshot is the new page's.
  const waitSiteScan = async (host, label) => {
    const arrived = await waitFor(async () => {
      const t = await frameEval(() => (window.__fpProxy || {}).target || location.href);
      const s = await shellStatus();
      return (typeof t === 'string' && t.includes(host)) && s.addr.includes(host);
    }, 120000, label + ': page arrived');
    if (!arrived) return false;
    let prev = '';
    const start = Date.now();
    while (Date.now() - start < 180000) {
      const s = await shellStatus();
      const key = [s.covered, s.allowed, s.blocked, s.painted, s.scanned, s.unscanned].join('/');
      if (Number(s.scanned) > 0 && key === prev) return true;
      prev = key;
      await sleep(3000);
    }
    console.log('TIMEOUT waiting for:', label + ': counts to settle');
    return false;
  };
  const openMenu = async (act) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#menuBtn');
    await sleep(500);
    await page.click('#menuDropdown [data-act="' + act + '"]');
    await sleep(800);
  };
  const shellLs = (key) => page.evaluate((k) => {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return 'parse-error'; }
  }, key);
  // DOM click inside the iframe (no Playwright actionability checks):
  // the review/download buttons live in fixed overlays, and Playwright's
  // scroll-into-view never brings a below-fold fixed button into the
  // viewport, so locator.click() times out. A DOM .click() is exactly
  // what a user click dispatches to the button's handler.
  const frameClick = (sel, idx) => frameEval(([s, i]) => {
    const els = [...document.querySelectorAll(s)];
    if (i < 0 || i >= els.length) return false;
    els[i].click();
    return true;
  }, [sel, idx]);
  // Scroll an image into view inside the iframe (lazy images only load
  // + get scanned once visible) and wait until it is covered.
  const scrollImgIntoView = (imgId) => frameEval((id) => {
    const img = document.getElementById(id);
    if (!img) return false;
    img.scrollIntoView({ block: 'center' });
    return true;
  }, imgId);
  // exactly over its image, so pick the button whose centre is inside the
  // image's rect. Returns the button index among all review buttons.
  const reviewBtnIndexFor = (imgId) => frameEval((id) => {
    const img = document.getElementById(id);
    if (!img) return -1;
    const r = img.getBoundingClientRect();
    const btns = [...document.querySelectorAll('[data-fp-review-btn]')];
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i].getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cx >= r.left - 5 && cx <= r.right + 5 && cy >= r.top - 5 && cy <= r.bottom + 5) return i;
    }
    return -1;
  }, imgId);
  const imgStates = () => frameEval(() => {
    const out = {};
    for (const img of document.querySelectorAll('img')) {
      const cs = getComputedStyle(img);
      out[img.id || img.src.split('/').pop()] = {
        src: (img.currentSrc || img.src || '').split('/').pop(),
        visible: cs.visibility !== 'hidden' && cs.display !== 'none',
        display: cs.display, visibility: cs.visibility,
      };
    }
    out._overlays = document.querySelectorAll('[data-fp-overlay]').length;
    out._reviewBtns = document.querySelectorAll('[data-fp-review-btn]').length;
    out._paintDivs = document.querySelectorAll('[data-fp-paint]').length;
    out._downloadBtns = document.querySelectorAll('[data-fp-download]').length;
    return out;
  });

  try {
    // ---- 1. shell + test page 01, first scan -------------------------
    console.log('\n===== 1. test page 01 first scan =====');
    const c1 = { case: 'a-first-scan' };
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    await navigateViaShell(TEST01);
    c1.detectorReady = await waitFor(async () => (await shellStatus()).detector.includes('גרייט'), 180000, 'detector ready');
    c1.countsSettled = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.covered) >= 2 && Number(s.allowed) >= 1;
    }, 120000, 'counts settled covered>=2 allowed>=1');
    c1.status = await shellStatus();
    c1.images = await imgStates();
    c1.ok = c1.detectorReady && c1.countsSettled;
    results.cases.firstScan = c1;
    console.log(JSON.stringify(c1, null, 2));

    // ---- 2. (d) round-trip: request a decision on the crowd image ----
    // img-crowd is d1-crowd-funeral.jpg: benchmark best 0.704, 18 boxes,
    // small boxes -> paint mode must return allow_painted (not block).
    console.log('\n===== 2. review round-trip on img-crowd (d1) =====');
    const c2 = { case: 'd-round-trip', image: 'img-crowd (d1-crowd-funeral.jpg)' };
    const btnIdx = await reviewBtnIndexFor('img-crowd');
    c2.reviewBtnIndex = btnIdx;
    c2.fpReviewPresent = await frameEval(() => typeof window.FpReview !== 'undefined' && !!window.FpReview);
    const t0 = Date.now();
    if (btnIdx >= 0) {
      c2.clicked = await frameClick('[data-fp-review-btn]', btnIdx);
      c2.painted = await waitFor(async () => {
        const st = await imgStates();
        return st && st._paintDivs >= 1;
      }, 360000, 'paint overlays appear (first model load ~150 MB)');
      c2.wallMsClickToPainted = Date.now() - t0;
    } else { c2.clicked = false; }
    c2.statusAfter = await shellStatus();
    c2.imagesAfter = await imgStates();
    // Paint fractions vs the cached boxes.
    const d1key = uKey(D1_URL);
    c2.imageKey = d1key;
    const cache = await frameEval(() => {
      try { return JSON.parse(localStorage.getItem('fp_review_decisions_v1') || '{}'); } catch (e) { return {}; }
    });
    c2.cacheEntry = cache && cache[d1key] ? cache[d1key] : null;
    if (c2.cacheEntry) {
      const frac = await frameEval((boxes) => {
        const img = document.getElementById('img-crowd');
        if (!img) return { error: 'no img-crowd' };
        const r = img.getBoundingClientRect();
        const paints = [...document.querySelectorAll('[data-fp-paint]')].map((o) => {
          const b = o.getBoundingClientRect();
          return {
            x: +((b.left - r.left) / r.width).toFixed(3),
            y: +((b.top - r.top) / r.height).toFixed(3),
            w: +(b.width / r.width).toFixed(3),
            h: +(b.height / r.height).toFixed(3),
          };
        });
        return { imgRect: { w: Math.round(r.width), h: Math.round(r.height) }, paints, boxCount: boxes.length };
      }, c2.cacheEntry.boxes || []);
      c2.paintFractions = frac;
      // Every cached box should have a paint div at (nearly) its fraction.
      if (frac.paints && c2.cacheEntry.boxes) {
        const tol = 0.03;
        c2.boxesMatched = c2.cacheEntry.boxes.filter((b) => frac.paints.some((p) =>
          Math.abs(p.x - b.x) <= tol && Math.abs(p.y - b.y) <= tol &&
          Math.abs(p.w - b.w) <= tol && Math.abs(p.h - b.h) <= tol)).length;
        c2.boxesTotal = c2.cacheEntry.boxes.length;
      }
    }
    // Decision recorded server-side? (fire-and-forget POST — allow a beat)
    await sleep(5000);
    c2.apiViaProxy = await apiGet(d1key);
    c2.apiDirect = await apiGetDirect(d1key);
    // Cached-load timing probe: a second review on the same bytes.
    c2.cachedProbe = await frameEval(async () => {
      try {
        const t0 = performance.now();
        await window.FpReview.ensure();
        const ensureMs = Math.round(performance.now() - t0);
        const res = await fetch(document.getElementById('img-crowd').currentSrc || document.getElementById('img-crowd').src);
        const blob = await res.blob();
        const out = await window.FpReview.review(blob, 'paint');
        return { ensureMs, inferMs: out.inferMs, totalMs: out.totalMs, decision: out.decision, best: out.best };
      } catch (e) { return { error: String(e.message).slice(0, 200) }; }
    });
    c2.ok = c2.painted && c2.cacheEntry && c2.cacheEntry.decision === 'allow_painted' &&
      c2.apiViaProxy.status === 200 && c2.apiViaProxy.body && c2.apiViaProxy.body.data &&
      c2.apiViaProxy.body.data.decision === 'allow_painted' &&
      c2.apiViaProxy.body.data.first_detector &&
      typeof c2.apiViaProxy.body.data.first_detector === 'object';
    results.cases.roundTrip = c2;
    console.log(JSON.stringify(c2, null, 2));

    // ---- 3. (f) paint/block flip: same image blocks in block mode -----
    // Flip to block, clear the local cache (else img-crowd would inherit
    // its allow_painted via the u: key), reload, review img-crowd in
    // block mode -> block whole. (A no-reload variant using the lazy
    // image was tried and dropped: a lazy image decided allow-unscanned
    // before its bytes arrive is never re-checked — report() excludes
    // 'allowed' entries — so it stays visible; that is a separate
    // pre-existing gap, reported, not fixed here.)
    console.log('\n===== 3. paint/block setting flip =====');
    const c3 = { case: 'f-setting-flip', image: 'img-crowd (d1, reviewed in paint mode in case 2)' };
    await openMenu('settings');
    await page.click('input[name="fp-human-image-mode"][value="block"]');
    await sleep(800);
    c3.settingsAfterFlip = await shellLs('fp_settings_v1');
    await page.click('#panelBack');
    await sleep(800);
    await frameEval(() => { try { localStorage.removeItem('fp_review_decisions_v1'); } catch (e) {} return true; });
    await page.click('#reloadBtn');
    await sleep(2000);
    c3.settled = await waitSettled('counts settled after reload');
    const btnIdx2 = await reviewBtnIndexFor('img-crowd');
    c3.reviewBtnIndexCrowd = btnIdx2;
    const t1 = Date.now();
    if (btnIdx2 >= 0) {
      c3.clicked = await frameClick('[data-fp-review-btn]', btnIdx2);
      c3.blocked = await waitFor(async () => {
        const st = await frameEval(() => {
          const img = document.getElementById('img-crowd');
          if (!img) return false;
          return getComputedStyle(img).display === 'none';
        });
        return st === true;
      }, 180000, 'img-crowd display:none (blocked whole)');
      c3.wallMsClickToBlocked = Date.now() - t1;
    }
    c3.statusAfterBlock = await shellStatus();
    c3.imagesAfterBlock = await imgStates();
    c3.apiAfterBlock = await apiGet(d1key);
    // Flip back to paint.
    await openMenu('settings');
    await page.click('input[name="fp-human-image-mode"][value="paint"]');
    await sleep(800);
    c3.settingsAfterFlipBack = await shellLs('fp_settings_v1');
    await page.click('#panelBack');
    await sleep(800);
    c3.ok = c3.settingsAfterFlip && c3.settingsAfterFlip.humanImageMode === 'block' &&
      c3.settled === true && c3.blocked === true && Number(c3.statusAfterBlock.blocked) >= 1 &&
      c3.apiAfterBlock.status === 200 && c3.apiAfterBlock.body && c3.apiAfterBlock.body.data &&
      c3.apiAfterBlock.body.data.decision === 'block' &&
      c3.settingsAfterFlipBack && c3.settingsAfterFlipBack.humanImageMode === 'paint';
    results.cases.settingFlip = c3;
    console.log(JSON.stringify(c3, null, 2));

    // ---- 4. repaint + (e) downloads fail closed ----------------------
    console.log('\n===== 4. repaint + download policy =====');
    const c4 = { case: 'e-downloads' };
    await frameEval(() => { try { localStorage.removeItem('fp_review_decisions_v1'); } catch (e) {} return true; });
    await page.click('#reloadBtn');
    await sleep(2000);
    c4.settled = await waitSettled('counts settled for repaint');
    const btnIdx3 = await reviewBtnIndexFor('img-crowd');
    c4.repaintBtnIndex = btnIdx3;
    if (btnIdx3 >= 0) {
      c4.repaintClicked = await frameClick('[data-fp-review-btn]', btnIdx3);
      c4.repainted = await waitFor(async () => {
        const st = await imgStates();
        return st && st._paintDivs >= 1;
      }, 180000, 'repaint overlays appear (cached model)');
    }
    c4.statusAfterRepaint = await shellStatus();
    const dlBefore = await shellLs('fp_downloads_v1');
    c4.downloadsBefore = Array.isArray(dlBefore) ? dlBefore.length : dlBefore;
    // Forced download request for the PAINTED image (link path, no elementId:
    // the shell looks the verdict up by URL -> 'painted' after the fix).
    await frameEval((u) => {
      window.parent.postMessage({ source: 'filter-platform-web', type: 'fp-download-request', url: u, kind: 'link' }, '*');
      return true;
    }, D1_URL);
    await sleep(3000);
    // Forced download request for a COVERED image (p1 portrait).
    await frameEval((u) => {
      window.parent.postMessage({ source: 'filter-platform-web', type: 'fp-download-request', url: u, kind: 'link' }, '*');
      return true;
    }, P1_URL);
    await sleep(3000);
    const dlAfter = await shellLs('fp_downloads_v1');
    c4.downloadRecords = Array.isArray(dlAfter) ? dlAfter.slice(0, 4) : dlAfter;
    const paintedRec = Array.isArray(dlAfter) ? dlAfter.find((r) => r.url === D1_URL) : null;
    const coveredRec = Array.isArray(dlAfter) ? dlAfter.find((r) => r.url === P1_URL) : null;
    c4.paintedDownload = paintedRec || null;
    c4.coveredDownload = coveredRec || null;
    // Positive control: the allowed landscape HAS a download button; click it.
    const dlBtn = await frameEval(() => {
      const img = document.getElementById('img-landscape');
      if (!img) return -1;
      const r = img.getBoundingClientRect();
      const btns = [...document.querySelectorAll('[data-fp-download]')];
      for (let i = 0; i < btns.length; i++) {
        const b = btns[i].getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        if (cx >= r.left - 5 && cx <= r.right + 5 && cy >= r.top - 5 && cy <= r.bottom + 5) return i;
      }
      return -1;
    });
    c4.landscapeDownloadBtnIndex = dlBtn;
    if (dlBtn >= 0) {
      c4.landscapeDownloadClicked = await frameClick('[data-fp-download]', dlBtn);
      await sleep(8000);
      const dlFinal = await shellLs('fp_downloads_v1');
      c4.landscapeDownload = Array.isArray(dlFinal) ? dlFinal.find((r) => r.url === L1_URL) || null : null;
    }
    c4.ok = !!c4.repainted && c4.paintedDownload && c4.paintedDownload.status === 'blocked' &&
      c4.paintedDownload.reason === 'verdict-painted' &&
      c4.coveredDownload && c4.coveredDownload.status === 'blocked';
    results.cases.downloads = c4;
    console.log(JSON.stringify(c4, null, 2));

    // ---- 5. real sites: Wikipedia, then BBC ---------------------------
    console.log('\n===== 5. Wikipedia =====');
    const c5 = { case: 'g-wikipedia', url: 'https://en.wikipedia.org/wiki/Albert_Einstein' };
    await navigateViaShell(c5.url);
    c5.scanned = await waitSiteScan('en.wikipedia.org', 'wikipedia');
    c5.status = await shellStatus();
    c5.images = await imgStates();
    c5.ok = c5.scanned;
    results.cases.wikipedia = c5;
    console.log(JSON.stringify(c5, null, 2));

    console.log('\n===== 6. BBC =====');
    const c6 = { case: 'g-bbc', url: 'https://www.bbc.com/news' };
    await navigateViaShell(c6.url);
    c6.scanned = await waitSiteScan('bbc.com', 'bbc');
    c6.status = await shellStatus();
    c6.images = await imgStates();
    c6.ok = c6.scanned;
    results.cases.bbc = c6;
    console.log(JSON.stringify(c6, null, 2));
  } catch (e) {
    results.fatal = String(e && e.stack ? e.stack : e).slice(0, 2000);
    console.error('FATAL:', results.fatal);
  } finally {
    results.finishedAt = new Date().toISOString();
    results.overallOk = !!(results.cases.roundTrip && results.cases.roundTrip.ok &&
      results.cases.settingFlip && results.cases.settingFlip.ok &&
      results.cases.downloads && results.cases.downloads.ok);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('\nOVERALL:', results.overallOk ? 'PASS' : 'FAIL');
    console.log('wrote', OUT);
    await browser.close();
    relay.kill();
  }
  process.exit(results.overallOk ? 0 : 1);
})().catch((e) => { console.error('harness FAILED:', e); process.exit(2); });
