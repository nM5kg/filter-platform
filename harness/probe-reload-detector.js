// Diagnostic probe v2 for the reload all-unscanned failure.
// Loops reloads until one comes back all-unscanned (or 4 tries), then
// probes the live detector state INSIDE the iframe (via the frame
// object — cross-origin contentWindow access is blocked) and tries a
// direct detection on the landscape image to see the exact error.
// Also captures all [fp] console lines from every frame.
// Results: harness/probe-reload-detector-results.json
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const OUT = path.join(__dirname, 'probe-reload-detector-results.json');
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const SHELL = 'https://filter-platform-dashboard.pages.dev/browser.html';
const TEST01 = 'https://filter-platform-dashboard.pages.dev/test-pages/01-html-images.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const results = { startedAt: new Date().toISOString(), attempts: [], fpLogs: [] };
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
  if (!relayUp) { console.log('relay down'); relay.kill(); process.exit(1); }
  const profile = path.join('/tmp', 'fp-probe2-' + Date.now());
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, timeout: 60000, executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--proxy-server=http://127.0.0.1:18080', '--proxy-bypass-list=localhost;127.0.0.1',
      '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[fp')) results.fpLogs.push({ at: new Date().toISOString(), type: m.type(), text: t.slice(0, 400) });
  });
  page.on('pageerror', (e) => results.fpLogs.push({ at: new Date().toISOString(), type: 'pageerror', text: String(e.message).slice(0, 300) }));
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  const shellStatus = () => page.evaluate(() => ({
    covered: document.getElementById('stCovered').textContent,
    allowed: document.getElementById('stAllowed').textContent,
    scanned: document.getElementById('stScanned').textContent,
    unscanned: document.getElementById('stUnscanned').textContent,
    detector: document.getElementById('stDetector').textContent,
  }));
  const frame = async () => {
    const el = await page.$('#frame');
    if (!el) return null;
    try { return await el.contentFrame(); } catch (e) { return null; }
  };
  const frameEval = async (fn, arg) => {
    const fr = await frame();
    if (!fr) return null;
    try { return await fr.evaluate(fn, arg); } catch (e) { return { error: String(e.message).slice(0, 200) }; }
  };
  const diag = () => frameEval(() => {
    let faceLoaded = null, faceApiPresent = false;
    try {
      faceApiPresent = typeof faceapi !== 'undefined';
      faceLoaded = faceApiPresent && faceapi.nets && faceapi.nets.tinyFaceDetector
        ? faceapi.nets.tinyFaceDetector.isLoaded : null;
    } catch (e) { faceLoaded = 'err:' + String(e.message).slice(0, 80); }
    let personReady = null, personPresent = false;
    try {
      personPresent = typeof FpPersonDetector !== 'undefined';
      personReady = personPresent ? FpPersonDetector.isReady() : null;
    } catch (e) { personReady = 'err:' + String(e.message).slice(0, 80); }
    let iframes = [];
    try { iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(-60)); } catch (e) {}
    let res = [];
    try {
      res = performance.getEntriesByType('resource')
        .filter((r) => /detector|models|face-api|tflite|wasm/i.test(r.name))
        .map((r) => ({ name: r.name.split('/').slice(-2).join('/'), status: r.responseStatus, dur: Math.round(r.duration), size: r.transferSize }));
    } catch (e) {}
    return { faceApiPresent, faceLoaded, personPresent, personReady, fpReady: !!window.__fpPersonReady, iframes, res };
  });
  const waitScanDone = async (timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await shellStatus();
      if (Number(s.scanned) > 0) return s;
      await sleep(2000);
    }
    return await shellStatus();
  };
  try {
    await page.goto(SHELL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    await page.fill('#addr', TEST01);
    await page.click('#goBtn');
    await sleep(1500);
    const base = await waitScanDone(120000);
    results.attempts.push({ load: 'initial', status: base, diag: await diag() });
    console.log('initial:', JSON.stringify(base));
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.click('#reloadBtn');
      const st = await waitScanDone(120000);
      const d = await diag();
      const allUnscanned = Number(st.scanned) > 0 && Number(st.covered) === 0 && Number(st.unscanned) === Number(st.scanned);
      results.attempts.push({ load: 'reload-' + attempt, status: st, diag: d, allUnscanned });
      console.log('reload-' + attempt + ':', JSON.stringify(st), 'allUnscanned=', allUnscanned, 'diag=', JSON.stringify({ faceLoaded: d.faceLoaded, personReady: d.personReady, fpReady: d.fpReady }));
      if (allUnscanned) {
        // Direct probe: try a person-detect + a face-detect on the
        // landscape image right now, and read the exact errors.
        const probe = await frameEval(async () => {
          const out = {};
          try {
            out.personEnsure = await FpPersonDetector.ensure();
          } catch (e) { out.personEnsure = 'throw:' + String(e.message).slice(0, 120); }
          out.personReadyNow = FpPersonDetector.isReady();
          out.faceLoadedNow = faceapi.nets.tinyFaceDetector.isLoaded;
          const img = document.getElementById('img-landscape');
          out.imgComplete = img ? img.complete : null;
          out.imgNatural = img ? (img.naturalWidth + 'x' + img.naturalHeight) : null;
          try {
            const r = await FpPersonDetector.detect(img);
            out.directDetect = r;
          } catch (e) { out.directDetect = 'throw:' + String(e.message).slice(0, 160); }
          try {
            const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
            const det = await faceapi.detectAllFaces(img, opts);
            out.directFace = { faces: det.length };
          } catch (e) { out.directFace = 'throw:' + String(e.message).slice(0, 160); }
          return out;
        });
        results.directProbe = probe;
        console.log('directProbe:', JSON.stringify(probe));
        break;
      }
    }
  } catch (e) {
    results.fatal = String(e && e.stack ? e.stack : e).slice(0, 1500);
    console.error('FATAL:', results.fatal);
  } finally {
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log('wrote', OUT);
    await context.close();
    relay.kill();
  }
  process.exit(0);
})().catch((e) => { console.error('probe FAILED:', e); process.exit(2); });
