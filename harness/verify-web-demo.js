// Web-demo verification harness — Playwright + headless Chromium.
// Usage: node verify-web-demo.js
// Spawns the egress relay (harness/egress-relay.js, 127.0.0.1:18080) itself,
// like verify-blockpage-safesearch.js. Results:
// harness/verify-web-demo-results.json
//
// Cases (all through the live demo shell on Pages + the live proxy Worker):
//   A. Shell loads; default page (test-pages index) renders in the iframe.
//   B. Test page 01 (HTML images) via the shell's one-click link: person
//      images covered, landscape allowed, detector ready, status counts.
//   C. Wikipedia via the address bar: detector runs, counts arrive.
//   D. BBC via the address bar (may bot-check; recorded as-is).
//   E. Test pages 03 (canvas) + 06 (video frames): covered, video paused.
//   F. SafeSearch: Google search gains safe=active, Bing gains adlt=strict.
//   G. Blocked domain: facebook.com shows the Yiddish block page.
//   H. Slow-3G throttle: time to first scan + detector ready on page 01.
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'verify-web-demo-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const PROXY_HOST = 'filter-platform-web-browser.gavhah-copy.workers.dev';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (await pred()) return true; } catch (e) { /* keep waiting */ }
    await sleep(1000);
  }
  console.log('TIMEOUT waiting for:', label);
  return false;
}

function waitForRelay(port, timeoutMs) {
  return new Promise(async (resolve) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((res) => {
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); res(true); });
        s.on('error', () => res(false));
      });
      if (ok) return resolve(true);
      await sleep(300);
    }
    resolve(false);
  });
}

async function main() {
  const results = { ranAt: new Date().toISOString(), shell: SHELL, cases: [] };
  const relay = spawn('node', [path.join(__dirname, 'egress-relay.js')], {
    env: { ...process.env, RELAY_PORT: '18080' }, stdio: 'ignore',
  });
  if (!await waitForRelay(18080, 15000)) {
    console.log('relay did not come up'); process.exit(1);
  }
  console.log('relay up on 127.0.0.1:18080');

  const profile = path.join('/tmp', 'fp-webdemo-' + Date.now());
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    timeout: 60000,
    executablePath: CHROME,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080',
      '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[fp') || t.includes('fp-detector')) consoleLines.push(t.slice(0, 300));
  });
  page.on('pageerror', (e) => consoleLines.push('PAGEERROR: ' + String(e.message).slice(0, 300)));

  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    blocked: document.getElementById('stBlocked').textContent,
    scanned: document.getElementById('stScanned').textContent,
    detector: document.getElementById('stDetector').textContent,
    api: document.getElementById('stApi').textContent,
    addr: document.getElementById('addr').value,
  }));
  const proxyFrame = () => page.frames().find((f) => f.url().includes(PROXY_HOST));
  const frameEval = async (fn, retries = 1) => {
    const fr = proxyFrame();
    if (!fr) return null;
    try { return await fr.evaluate(fn); } catch (e) {
      // The frame navigates between pages; a stale execution context is a
      // harness race, not a product failure — re-attach once and retry.
      if (retries > 0 && String(e.message).includes('Execution context was destroyed')) {
        await sleep(1500);
        return frameEval(fn, retries - 1);
      }
      return { error: String(e.message).slice(0, 200) };
    }
  };
  const navigateViaShell = async (target) => {
    await page.fill('#addr', target);
    await page.click('#goBtn');
    await sleep(1500);
  };

  try {
    // ---- A. Shell loads, default page in iframe ----
    console.log('\n===== A. shell loads =====');
    const caseA = { case: 'A-shell-loads' };
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    caseA.shellUrl = page.url();
    caseA.iframeSrc = await page.evaluate(() => document.getElementById('frame').src);
    caseA.status = await shellStatus();
    caseA.framePresent = !!proxyFrame();
    caseA.frameTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    caseA.ok = caseA.framePresent && !!caseA.frameTarget;
    results.cases.push(caseA);
    console.log(JSON.stringify(caseA, null, 2));

    // ---- B. Test page 01 via one-click link ----
    console.log('\n===== B. test page 01 (HTML images) =====');
    const caseB = { case: 'B-test-page-01' };
    const t0 = Date.now();
    await page.evaluate(() => {
      const links = [...document.querySelectorAll('#testList a')];
      links.find((a) => a.textContent.includes('01 —')).click();
    });
    // Detector ready (first load compiles WASM + loads .tflite: allow 180s).
    caseB.detectorReady = await waitFor(async () => {
      const s = await shellStatus();
      return s.detector.includes('גרייט');
    }, 180000, 'detector ready on page 01');
    caseB.detectorReadyMs = Date.now() - t0;
    // Counts settle AFTER detector-ready: the final fp-status can arrive
    // after the detector-ready flag, so a snapshot taken the moment
    // detector-ready appears can read stale counts (seen: 7 covered /
    // 0 allowed while the frame already showed 6/1). Wait for two
    // consecutive identical covered+allowed+scanned readings 1s apart
    // (bounded 60 s) before snapshotting.
    caseB.countsSettled = await waitFor(async () => {
      const s1 = await shellStatus();
      const key1 = [s1.covered, s1.allowed, s1.scanned].join('/');
      await sleep(1000);
      const s2 = await shellStatus();
      const key2 = [s2.covered, s2.allowed, s2.scanned].join('/');
      return key1 === key2 && Number(s2.scanned) > 0;
    }, 60000, 'counts settle on page 01');
    caseB.status = await shellStatus();
    caseB.frame = await frameEval(() => {
      const vis = (id) => {
        const el = document.getElementById(id);
        if (!el) return 'missing';
        return getComputedStyle(el).visibility;
      };
      return {
        overlays: document.querySelectorAll('[data-fp-overlay]').length,
        personVisibility: vis('img-person'),
        crowdVisibility: vis('img-crowd'),
        landscapeVisibility: vis('img-landscape'),
        pictureVisibility: vis('img-picture'),
        datasrcVisibility: vis('img-datasrc'),
        personReady: !!window.__fpPersonReady,
        fpProxy: window.__fpProxy || null,
      };
    });
    caseB.ok = caseB.detectorReady
      && caseB.frame && caseB.frame.personVisibility === 'hidden'
      && caseB.frame.landscapeVisibility === 'visible'
      && Number(caseB.status.covered) >= 2 && Number(caseB.status.allowed) >= 1;
    results.cases.push(caseB);
    console.log(JSON.stringify(caseB, null, 2));

    // ---- C. Wikipedia via address bar ----
    console.log('\n===== C. wikipedia =====');
    const caseC = { case: 'C-wikipedia' };
    await navigateViaShell('https://en.wikipedia.org/wiki/Main_Page');
    caseC.countsArrived = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.scanned) > 0;
    }, 120000, 'wikipedia scan counts');
    caseC.status = await shellStatus();
    caseC.frame = await frameEval(() => ({
      overlays: document.querySelectorAll('[data-fp-overlay]').length,
      imgs: document.querySelectorAll('img').length,
      title: document.title,
      personReady: !!window.__fpPersonReady,
    }));
    caseC.ok = caseC.countsArrived && caseC.frame && caseC.frame.imgs > 0;
    results.cases.push(caseC);
    console.log(JSON.stringify(caseC, null, 2));

    // ---- D. BBC via address bar ----
    console.log('\n===== D. bbc =====');
    const caseD = { case: 'D-bbc' };
    await navigateViaShell('https://www.bbc.com');
    caseD.countsArrived = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.scanned) > 0;
    }, 120000, 'bbc scan counts');
    caseD.status = await shellStatus();
    caseD.frame = await frameEval(() => ({
      overlays: document.querySelectorAll('[data-fp-overlay]').length,
      imgs: document.querySelectorAll('img').length,
      title: document.title,
      bodySnippet: (document.body ? document.body.innerText : '').slice(0, 200).replace(/\n+/g, ' | '),
      personReady: !!window.__fpPersonReady,
    }));
    caseD.ok = caseD.countsArrived;
    results.cases.push(caseD);
    console.log(JSON.stringify(caseD, null, 2));

    // ---- E. Canvas (03) + video (06) test pages ----
    console.log('\n===== E. canvas + video test pages =====');
    const caseE = { case: 'E-canvas-video' };
    await page.evaluate(() => {
      [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes('03 —')).click();
    });
    await waitFor(async () => {
      const s = await shellStatus();
      // Addr-gated: the previous page's counts already satisfy scanned>0,
      // so without the addr check this returns before the frame navigates.
      return s.addr.includes('03-canvas') && Number(s.scanned) > 0;
    }, 120000, 'canvas page scan counts');
    caseE.canvas = await frameEval(() => ({
      overlays: document.querySelectorAll('[data-fp-overlay]').length,
      canvases: [...document.querySelectorAll('canvas')].map((c) => getComputedStyle(c).visibility),
    }));
    caseE.canvasStatus = await shellStatus();
    await page.evaluate(() => {
      [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes('06 —')).click();
    });
    await waitFor(async () => {
      const s = await shellStatus();
      // Addr-gated: see the canvas wait above — the 03 counts would
      // otherwise satisfy this before the frame reaches page 06.
      return s.addr.includes('06-video-frames') && Number(s.scanned) > 0;
    }, 120000, 'video page scan counts');
    caseE.video = await frameEval(() => ({
      overlays: document.querySelectorAll('[data-fp-overlay]').length,
      videos: [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, visibility: getComputedStyle(v).visibility })),
    }));
    caseE.videoStatus = await shellStatus();
    caseE.ok = caseE.canvas && caseE.canvas.overlays > 0
      && caseE.video && caseE.video.overlays > 0
      && caseE.video.videos.every((v) => v.paused);
    results.cases.push(caseE);
    console.log(JSON.stringify(caseE, null, 2));

    // ---- F. SafeSearch ----
    console.log('\n===== F. safesearch =====');
    const caseF = { case: 'F-safesearch' };
    await navigateViaShell('https://www.google.com/search?q=cats');
    await sleep(5000);
    caseF.googleTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    // Google bot-checks headless Chromium and redirects to /sorry — but the
    // SafeSearch rewrite is still proven: the /sorry continue= URL carries
    // the rewritten search URL (URL-encoded), so decode before checking.
    caseF.googleHasSafeActive = typeof caseF.googleTarget === 'string'
      && decodeURIComponent(caseF.googleTarget).includes('safe=active');
    caseF.googleBotChecked = typeof caseF.googleTarget === 'string' && caseF.googleTarget.includes('/sorry/');
    await navigateViaShell('https://www.bing.com/search?q=cats');
    await sleep(5000);
    caseF.bingTarget = await frameEval(() => (window.__fpProxy || {}).target || location.href);
    caseF.bingHasAdltStrict = typeof caseF.bingTarget === 'string' && caseF.bingTarget.includes('adlt=strict');
    caseF.ok = caseF.googleHasSafeActive && caseF.bingHasAdltStrict;
    results.cases.push(caseF);
    console.log(JSON.stringify(caseF, null, 2));

    // ---- G. Blocked domain ----
    console.log('\n===== G. blocked domain =====');
    const caseG = { case: 'G-blocked-facebook' };
    await navigateViaShell('https://www.facebook.com');
    await sleep(4000);
    caseG.frameBody = await frameEval(() => (document.body ? document.body.innerText : '').slice(0, 300));
    caseG.frameUrl = proxyFrame() ? proxyFrame().url() : null;
    caseG.ok = typeof caseG.frameBody === 'string' && caseG.frameBody.includes('דער פּלאַץ איז בלאקירט');
    results.cases.push(caseG);
    console.log(JSON.stringify(caseG, null, 2));

    // ---- H. Slow 3G ----
    console.log('\n===== H. slow 3G =====');
    const caseH = { case: 'H-slow-3g' };
    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8,
    });
    const h0 = Date.now();
    await page.evaluate(() => {
      [...document.querySelectorAll('#testList a')].find((a) => a.textContent.includes('01 —')).click();
    });
    caseH.firstCounts = await waitFor(async () => {
      const s = await shellStatus();
      return Number(s.scanned) > 0;
    }, 180000, 'slow-3g first counts');
    caseH.firstCountsMs = Date.now() - h0;
    caseH.detectorReady = await waitFor(async () => {
      const s = await shellStatus();
      return s.detector.includes('גרייט');
    }, 180000, 'slow-3g detector ready');
    caseH.detectorReadyMs = Date.now() - h0;
    caseH.status = await shellStatus();
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    caseH.ok = caseH.firstCounts && caseH.detectorReady;
    results.cases.push(caseH);
    console.log(JSON.stringify(caseH, null, 2));
  } catch (e) {
    console.log('HARNESS ERROR:', e);
    results.harnessError = String(e && e.stack ? e.stack : e).slice(0, 1000);
  } finally {
    results.consoleLines = consoleLines.slice(0, 60);
    results.summary = {
      passed: results.cases.filter((c) => c.ok).length,
      total: results.cases.length,
      cases: results.cases.map((c) => c.case + ': ' + (c.ok ? 'PASS' : 'FAIL')),
    };
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('\nSUMMARY:', JSON.stringify(results.summary, null, 2));
    console.log('wrote', OUT);
    await context.close().catch(() => {});
    relay.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
