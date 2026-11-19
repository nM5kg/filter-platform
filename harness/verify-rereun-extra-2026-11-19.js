// Extra verification cases — testing-plan acceptance checklist (2026-11-19).
// Runs AFTER verify-rereun-2026-11-19.js (separate process; same relay port
// 18080 and local servers 8123-8126, so do NOT run both at once).
// Verification only — no extension source is edited.
// Cases:
//   A. canvas.html (drawImage portrait, rAF animated video frames, landscape control)
//   B. video.html (Obama video paused at 5s, then played ~5s)
//   C. test page per-case verdicts (HTML imgs, CSS bg, dynamic, lazy, xorigin)
//   D. live-stream coverage check (inventory only — no live stream is invented)
//   E. slow-3G Wikipedia (CDP Network.emulateNetworkConditions)
//   F. 4x CPU-throttled BBC (CDP Emulation.setCPUThrottlingRate) + sampled RSS/CPU
//   G. classify cache: same target classified twice via the live API
//      (creates 2 request rows for example.com, as dogfood does; token is
//      read from ../api_token.txt and NEVER printed).
// 10,000-customer simulation is deliberately NOT run here.
const { chromium } = require('playwright');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const VERIFY_DIR = path.join(EXT, 'verify');
const OUT = path.join(VERIFY_DIR, 'results-rereun-extra-2026-11-19.json');
const TOKEN = fs.readFileSync(path.join(ROOT, 'api_token.txt'), 'utf8').trim();
const API_BASE = 'https://filter-platform-api.gavhah-copy.workers.dev';
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome';
const TEST_PAGE = path.join(EXT, 'test-page');
const TESTSET_DIR = path.join(ROOT, 'scanner', 'testset');
const CANVAS_DIR = path.join(ROOT, 'scanner', 'test-video-canvas');

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
  const profile = path.join('/tmp', 'fp-rereun-extra-' + profileTag);
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
  await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 20000 });
  const manifest = await popup.evaluate(() => chrome.runtime.getManifest()).catch(() => null);
  await popup.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(s);
  }, seed);
  return { popup, manifest };
}
function readDom(page) {
  return page.evaluate(() => {
    const raw = document.getElementById('fp-dom-stats');
    const parsed = raw ? JSON.parse(raw.textContent) : null;
    return {
      stats: parsed ? parsed.stats : null,
      log: parsed ? parsed.log : [],
      mode: document.documentElement.getAttribute('data-fp-mode'),
      scanDoneAttr: document.documentElement.getAttribute('data-fp-scan-done'),
      imgCount: document.querySelectorAll('img').length,
      canvasCount: document.querySelectorAll('canvas').length,
      videoCount: document.querySelectorAll('video').length,
      coveredImgs: document.querySelectorAll('[data-fp-covered]').length,
      blockedPlaceholders: document.querySelectorAll('[data-fp-blocked]').length,
      bgCoverOverlays: document.querySelectorAll('.fp-bg-cover').length,
    };
  });
}
function navTiming(page) {
  return page.evaluate(() => {
    const t = performance.timing;
    return {
      navStartToDomContentLoadedMs: t.domContentLoadedEventEnd - t.navigationStart,
      navStartToLoadMs: t.loadEventEnd - t.navigationStart,
      domContentLoadedMs: t.domContentLoadedEventEnd - t.responseEnd,
    };
  }).catch(() => null);
}
function msStats(log) {
  const mss = (log || []).map(e => e.ms).filter(x => typeof x === 'number');
  if (!mss.length) return { n: 0 };
  const sorted = [...mss].sort((a, b) => a - b);
  const sum = mss.reduce((a, b) => a + b, 0);
  return { n: mss.length, mean: +(sum / mss.length).toFixed(0), median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
}
function sampleChromeMem() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,rss,pcpu,comm', '--sort=-rss'], { encoding: 'utf8', timeout: 10000 });
    const lines = out.trim().split('\n').filter(l => /chrome|chromium/i.test(l));
    const totalRssKb = lines.reduce((a, l) => a + (parseInt(l.trim().split(/\s+/)[1], 10) || 0), 0);
    return { chromeProcesses: lines.length, totalRssMb: +(totalRssKb / 1024).toFixed(0), top5: lines.slice(0, 5).map(l => l.trim()) };
  } catch (e) { return { error: String(e).slice(0, 200) }; }
}
function curlApi(method, pathSuffix, body) {
  const args = ['-s', '--max-time', '40', '-H', 'Authorization: Bearer ' + TOKEN, '-H', 'Content-Type: application/json'];
  if (method !== 'GET') args.push('-X', method);
  if (body) args.push('-d', JSON.stringify(body));
  args.push(API_BASE + pathSuffix);
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', timeout: 60000 }));
}

(async () => {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const results = { ranAt: new Date().toISOString(), extensionDir: EXT, manifest: JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')), cases: {} };

  const relay = spawn('node', ['egress-relay.js'], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  relay.stdout.on('data', d => console.log('[relay]', String(d).trim()));
  relay.stderr.on('data', d => console.log('[relay:err]', String(d).trim().slice(0, 300)));
  if (!await waitForRelay(18080, 15000)) { console.log('RELAY FAILED'); relay.kill(); process.exit(1); }
  const servers = [
    spawn('python3', ['-m', 'http.server', '8123', '--bind', '127.0.0.1'], { cwd: TEST_PAGE, stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn('python3', ['-m', 'http.server', '8124', '--bind', '127.0.0.1'], { cwd: path.join(TEST_PAGE, 'photos'), stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn('python3', ['-m', 'http.server', '8125', '--bind', '127.0.0.1'], { cwd: TESTSET_DIR, stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn('python3', ['-m', 'http.server', '8126', '--bind', '127.0.0.1'], { cwd: CANVAS_DIR, stdio: ['ignore', 'pipe', 'pipe'] }),
  ];
  await sleep(1200);

  try {
    // ===== A+B+C: demo-block context, canvas + video + test page per-case =====
    console.log('\n===== CONTEXT extra-demo-block =====');
    const ctx = await launch('demo');
    try {
      const extId = await findExtensionId(ctx);
      const { popup, manifest: liveManifest } = await seedPopup(ctx, extId, { fpDemoMode: 'block' });
      results.cases.manifestVersion = liveManifest && liveManifest.version;
      await popup.close().catch(() => {});
      const page = await ctx.newPage();
      page.on('pageerror', e => console.log('  page error:', String(e).slice(0, 300)));

      // A. canvas.html
      console.log('\n--- A. canvas.html ---');
      {
        const t0 = Date.now();
        await page.goto('http://127.0.0.1:8126/canvas.html', { waitUntil: 'load', timeout: 30000 });
        const ready = await waitFor(async () => page.title().then(t => t.startsWith('READY')), 60000, 'canvas READY');
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, 'canvas model');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 180000, 'canvas scan');
        await sleep(3000);
        const timing = await navTiming(page);
        const dom = await readDom(page);
        const canvasState = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map(c => ({
          id: c.id, w: c.width, h: c.height, fpAction: c.dataset.fpAction || 'none',
          hasOverlaySibling: !!(c.parentElement && c.parentElement.querySelector('.fp-cover, [data-fp-covered]')),
          styleDisplay: getComputedStyle(c).display, styleVisibility: getComputedStyle(c).visibility,
        })));
        const videoState = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map(v => ({
          id: v.id, paused: v.paused, currentTime: +v.currentTime.toFixed(1), fpAction: v.dataset.fpAction || 'none',
        })));
        const imgControl = (dom.log || []).find(e => (e.src || '').includes('p1-huang'));
        results.cases.canvas = { url: 'http://127.0.0.1:8126/canvas.html', pageReady: ready, modelReady, scanDone, elapsedMs: Date.now() - t0, navTiming: timing, stats: dom.stats, inferenceMs: msStats(dom.log), canvasState, videoState, imgControlLog: imgControl || null, log: dom.log, verdict: 'see canvasState/log — extension handles <img>/backgrounds; canvas/video elements are NOT scanned by the extension (no log entries for them = left visible)' };
        console.log('canvas stats:', JSON.stringify(dom.stats), 'inference:', JSON.stringify(results.cases.canvas.inferenceMs));
        console.log('canvasState:', JSON.stringify(canvasState));
        console.log('videoState:', JSON.stringify(videoState));
        console.log('imgControl:', JSON.stringify(imgControl));
        await page.screenshot({ path: path.join(VERIFY_DIR, 'rereun-extra-canvas.png'), fullPage: true }).catch(() => {});
      }

      // B. video.html — paused, then playing
      console.log('\n--- B. video.html ---');
      {
        const t0 = Date.now();
        await page.goto('http://127.0.0.1:8126/video.html', { waitUntil: 'load', timeout: 30000 });
        const ready = await waitFor(async () => page.title().then(t => t.startsWith('READY')), 60000, 'video READY paused');
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, 'video model');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 180000, 'video scan');
        await sleep(3000);
        const timing = await navTiming(page);
        const domPaused = await readDom(page);
        const vPaused = await page.evaluate(() => { const v = document.getElementById('v'); return v ? { paused: v.paused, currentTime: +v.currentTime.toFixed(1), fpAction: v.dataset.fpAction || 'none' } : null; });
        // now play ~5 s and re-check
        await page.evaluate(() => { const v = document.getElementById('v'); if (v) v.play().catch(() => {}); });
        await sleep(5000);
        const domPlaying = await readDom(page);
        const vPlaying = await page.evaluate(() => { const v = document.getElementById('v'); return v ? { paused: v.paused, currentTime: +v.currentTime.toFixed(1), fpAction: v.dataset.fpAction || 'none' } : null; });
        results.cases.video = { url: 'http://127.0.0.1:8126/video.html', pageReady: ready, modelReady, scanDone, elapsedMs: Date.now() - t0, navTiming: timing, paused: { videoState: vPaused, stats: domPaused.stats, log: domPaused.log }, playing: { videoState: vPlaying, stats: domPlaying.stats, log: domPlaying.log }, verdict: 'see videoState/log — <video> elements are NOT scanned by the extension (no log entries for them = left visible, paused and playing)' };
        console.log('video paused:', JSON.stringify(vPaused), 'stats:', JSON.stringify(domPaused.stats));
        console.log('video playing:', JSON.stringify(vPlaying), 'stats:', JSON.stringify(domPlaying.stats));
        await page.screenshot({ path: path.join(VERIFY_DIR, 'rereun-extra-video.png'), fullPage: true }).catch(() => {});
      }

      // C. test page per-case verdicts (demo block)
      console.log('\n--- C. test page per-case ---');
      {
        const t0 = Date.now();
        await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'load', timeout: 30000 });
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 120000, 'testpage model');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 300000, 'testpage scan');
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
        const timing = await navTiming(page);
        const dom = await readDom(page);
        // Map log entries to the page's own cases by element id / src.
        const bySrc = {};
        for (const e of dom.log) {
          const key = (e.src || '').split('/').pop().split('?')[0];
          (bySrc[key] = bySrc[key] || []).push(e);
        }
        const perCase = await page.evaluate(() => {
          const out = {};
          for (const el of document.querySelectorAll('img')) {
            out[el.id || el.src.slice(-40)] = { expect: el.dataset.expect || null, src: (el.src || '').slice(-60), action: el.dataset.fpAction || 'none', complete: el.complete, naturalWidth: el.naturalWidth };
          }
          const bg = document.getElementById('bg-person');
          if (bg) out['bg-person(div)'] = { expect: bg.dataset.expect || null, action: bg.dataset.fpAction || 'none', hasCoverOverlay: !!bg.querySelector('.fp-bg-cover') };
          return out;
        });
        // Attach the detector log verdict to each case where a log entry exists.
        for (const [id, c] of Object.entries(perCase)) {
          const file = (c.src || '').split('/').pop().split('?')[0];
          const entries = bySrc[file] || [];
          c.logEntries = entries.map(e => ({ result: e.result, action: e.action, via: e.via, personBest: e.personBest, faces: e.faces, ms: e.ms, error: e.error || undefined }));
          if (id === 'bg-person(div)') {
            c.logEntries = (dom.log || []).filter(e => e.kind === 'background').map(e => ({ result: e.result, action: e.action, via: e.via, personBest: e.personBest, faces: e.faces, ms: e.ms, error: e.error || undefined }));
          }
        }
        const animationsCase = await page.evaluate(() => !!document.querySelector('[data-expect*="anim"], .anim, [id*="anim"]'));
        results.cases.testPagePerCase = { url: 'http://127.0.0.1:8123/index.html', modelReady, scanDone, elapsedMs: Date.now() - t0, navTiming: timing, stats: dom.stats, inferenceMs: msStats(dom.log), perCase, animationsCasePresent: animationsCase, webglCasePresent: false, liveStreamCasePresent: false };
        console.log('testpage stats:', JSON.stringify(dom.stats));
        for (const [id, c] of Object.entries(perCase)) console.log('  case', id, 'expect=', c.expect, 'action=', c.action, 'log=', JSON.stringify(c.logEntries));
        console.log('animations case present:', animationsCase);
      }
      await page.close().catch(() => {});
    } finally { await ctx.close().catch(() => {}); }

    // ===== E. slow-3G Wikipedia =====
    console.log('\n===== E. slow-3G Wikipedia =====');
    {
      const ctx = await launch('slow3g');
      try {
        const extId = await findExtensionId(ctx);
        const { popup } = await seedPopup(ctx, extId, { fpDemoMode: 'block' });
        await popup.close().catch(() => {});
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 });
        const t0 = Date.now();
        await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'domcontentloaded', timeout: 120000 });
        const domLoadedMs = Date.now() - t0;
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 180000, 'slow3g model');
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 420000, 'slow3g scan');
        await sleep(5000);
        const timing = await navTiming(page);
        const dom = await readDom(page);
        const mem = sampleChromeMem();
        results.cases.slow3gWikipedia = { throttling: { preset: 'Slow 3G (DevTools)', latencyMs: 400, downloadKbps: 400, uploadKbps: 400 }, domContentLoadedMs: domLoadedMs, modelReady, scanDone, elapsedMs: Date.now() - t0, navTiming: timing, stats: dom.stats, inferenceMs: msStats(dom.log), chromeMemorySample: mem, humanLog: (dom.log || []).filter(e => e.result === 'human' || e.result === 'uncertain') };
        console.log('slow3g:', JSON.stringify({ domLoadedMs, modelReady, scanDone, elapsedMs: Date.now() - t0, stats: dom.stats, mem }));
        await page.close().catch(() => {});
      } finally { await ctx.close().catch(() => {}); }
    }

    // ===== F. 4x CPU-throttled BBC =====
    console.log('\n===== F. 4x CPU BBC =====');
    {
      const ctx = await launch('cpu4x');
      try {
        const extId = await findExtensionId(ctx);
        const { popup } = await seedPopup(ctx, extId, { fpDemoMode: 'block' });
        await popup.close().catch(() => {});
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        const t0 = Date.now();
        await page.goto('https://www.bbc.com/', { waitUntil: 'domcontentloaded', timeout: 120000 });
        const domLoadedMs = Date.now() - t0;
        const modelReady = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-model-ready') === 'true'), 180000, 'cpu4x model');
        const modelReadyMs = Date.now() - t0;
        const scanDone = await waitFor(async () => page.evaluate(() => document.documentElement.getAttribute('data-fp-scan-done') === 'true'), 420000, 'cpu4x scan');
        await page.evaluate(async () => {
          const h = document.body ? document.body.scrollHeight : 0;
          for (let y = 0; y <= h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
          window.scrollTo(0, 0);
        }).catch(() => {});
        // settle: stats stable 15 s, cap 300 s
        let settled = false, settleKey = null;
        {
          const s0 = Date.now();
          let lastKey = null, stableSince = Date.now();
          while (Date.now() - s0 < 300000) {
            const s = await page.evaluate(() => {
              const raw = document.getElementById('fp-dom-stats');
              if (!raw) return null;
              const st = JSON.parse(raw.textContent).stats;
              return [st.found, st.scanned, st.skipped, st.human, st.uncertain, st.noHuman, st.refetched, st.refetchCacheHits].join('/');
            }).catch(() => null);
            if (s) {
              if (s === lastKey) { if (Date.now() - stableSince >= 15000) { settled = true; settleKey = s; break; } }
              else { lastKey = s; stableSince = Date.now(); }
            }
            await sleep(5000);
          }
          if (!settled) settleKey = lastKey;
        }
        const timing = await navTiming(page);
        const dom = await readDom(page);
        const mem = sampleChromeMem();
        results.cases.cpu4xBbc = { throttling: { method: 'Emulation.setCPUThrottlingRate', rate: 4 }, domContentLoadedMs: domLoadedMs, modelReady, modelReadyMs, scanDone, settled, settleKey, elapsedMs: Date.now() - t0, navTiming: timing, stats: dom.stats, inferenceMs: msStats(dom.log), chromeMemorySample: mem, humanLog: (dom.log || []).filter(e => e.result === 'human' || e.result === 'uncertain').slice(0, 20) };
        console.log('cpu4x:', JSON.stringify({ domLoadedMs, modelReadyMs, scanDone, settled, elapsedMs: Date.now() - t0, stats: dom.stats, inference: results.cases.cpu4xBbc.inferenceMs, mem }));
        await page.screenshot({ path: path.join(VERIFY_DIR, 'rereun-extra-bbc-cpu4x.png') }).catch(() => {});
        await page.close().catch(() => {});
      } finally { await ctx.close().catch(() => {}); }
    }

    // ===== G. classify cache: same target twice =====
    console.log('\n===== G. classify cache (example.com x2) =====');
    {
      const target = 'example.com';
      const runs = [];
      // Use the existing Dogfood Phone device/customer from the main run? No —
      // requests need a customer+device; reuse the dogfood customer id from
      // the API list is fragile, so create requests with the known Standard
      // device's customer (142e6a02-14c8-4eda-86f5-09087ded8cdf) and the
      // Dogfood Phone device id used by the main run.
      const CUSTOMER_ID = '142e6a02-14c8-4eda-86f5-09087ded8cdf';
      const DEVICE_ID = 'eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a';
      for (let i = 1; i <= 2; i++) {
        const t0 = Date.now();
        let req = null, cls = null, err = null;
        try {
          req = curlApi('POST', '/api/v1/requests', { customer_id: CUSTOMER_ID, device_id: DEVICE_ID, kind: 'website', target });
          cls = curlApi('POST', `/api/v1/requests/${req.data.id}/classify`);
        } catch (e) { err = String(e).slice(0, 300); }
        runs.push({
          call: i, elapsedMs: Date.now() - t0, requestId: req && req.data && req.data.id,
          cached: cls && cls.data && cls.data.analysis ? cls.data.analysis.cached : null,
          verdict: cls && cls.data && cls.data.request ? cls.data.request.ai_verdict : null,
          confidence: cls && cls.data && cls.data.request ? cls.data.request.ai_confidence : null,
          error: err,
        });
        console.log(`classify #${i}:`, JSON.stringify(runs[runs.length - 1]));
      }
      results.cases.classifyCache = { target, runs, note: 'Two separate requests for the same target; the 24h ai_analysis_results cache should make the 2nd call cached=true (or both true if the target was already cached by an earlier dogfood run).' };
    }

    // ===== D + 10k: inventory notes (no live stream exists; no load test) =====
    results.cases.liveStream = { coveredByAnyTestPage: false, note: 'No test page in extension/test-page/ or scanner/test-video-canvas/ covers a live stream (HLS/DASH/live video). video.html is a static file, canvas.html draws a playing file. Recorded as NOT COVERED — no live stream was invented.' };
    results.cases.tenThousandCustomers = { run: false, note: 'NOT RUN — no load-test setup exists here, and hammering the live free-tier Worker + Neon would risk the real service. Needs a staged load-test plan with rate limits.' };
    results.cases.webgl = { coveredByAnyTestPage: false, note: 'No test page in extension/test-page/ or scanner/test-video-canvas/ draws WebGL content. The GeckoView prototype has WebGL test pages, but the extension test pages do not. Recorded as NOT COVERED.' };
  } finally {
    relay.kill();
    for (const s of servers) s.kill();
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('\nResults saved to', OUT);
  console.log(JSON.stringify({
    canvas: results.cases.canvas && { stats: results.cases.canvas.stats, canvasState: results.cases.canvas.canvasState, imgControl: results.cases.canvas.imgControlLog },
    video: results.cases.video && { paused: results.cases.video.paused.videoState, playing: results.cases.video.playing.videoState },
    testPagePerCase: results.cases.testPagePerCase && results.cases.testPagePerCase.perCase,
    slow3gWikipedia: results.cases.slow3gWikipedia && { domLoadedMs: results.cases.slow3gWikipedia.domContentLoadedMs, scanDone: results.cases.slow3gWikipedia.scanDone, elapsedMs: results.cases.slow3gWikipedia.elapsedMs, stats: results.cases.slow3gWikipedia.stats },
    cpu4xBbc: results.cases.cpu4xBbc && { scanDone: results.cases.cpu4xBbc.scanDone, settled: results.cases.cpu4xBbc.settled, elapsedMs: results.cases.cpu4xBbc.elapsedMs, stats: results.cases.cpu4xBbc.stats },
    classifyCache: results.cases.classifyCache,
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
