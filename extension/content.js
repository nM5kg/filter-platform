// Filter Platform — content script (Phase 2)
// On-device human-figure detection: face-api.js tinyFaceDetector, bundled
// locally. A detected FACE = a human in the picture (presence only — we do
// NOT guess gender, age or identity). Detection runs entirely on-device;
// no image data ever leaves the browser.

(function () {
  'use strict';

  const MODEL_URL = chrome.runtime.getURL('models');
  const stats = {
    found: 0, scanned: 0, human: 0, blocked: 0, covered: 0,
    uncertain: 0, noHuman: 0, bgFound: 0, bgHuman: 0, skipped: 0
  };
  const log = []; // per-image: {src, kind, faces, result, action}
  window.__fpStats = stats;
  window.__fpLog = log;
  window.__fpModelReady = false;
  window.__fpScanDone = false;
  window.__fpMode = 'unknown';

  let mode = 'block'; // block | cover | strict | allow
  let modelReady = false;
  let scanQueued = false;
  const processedImgs = new WeakSet();
  const processedBg = new WeakSet();
  const skippedImgs = new WeakSet(); // counted once per element, not per scan
  const bgFailed = new WeakSet(); // bg probe failed once; do not recount

  function note(entry) {
    log.push(entry);
    // Keep the log bounded.
    if (log.length > 500) log.splice(0, log.length - 500);
    publishStats();
  }

  // Mirror state into the DOM: content scripts run in an isolated JS world,
  // so window.__fpStats is invisible to the page (and to test harnesses).
  // The DOM is shared, so stats live here too (data attributes + JSON div).
  function publishStats() {
    try {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-fp-mode', mode);
      root.setAttribute('data-fp-model-ready', String(window.__fpModelReady));
      root.setAttribute('data-fp-scan-done', String(window.__fpScanDone));
      root.setAttribute('data-fp-stats', JSON.stringify(stats));
      let div = document.getElementById('fp-dom-stats');
      if (!div) {
        div = document.createElement('div');
        div.id = 'fp-dom-stats';
        div.style.display = 'none';
        (document.body || root).appendChild(div);
      }
      div.textContent = JSON.stringify({ stats, log: log.slice(-100) });
    } catch (e) { /* DOM not ready yet; next call retries */ }
  }

  function record(kind, src, faces, result, action, error) {
    stats.scanned++;
    if (result === 'human') stats.human++;
    if (result === 'no-human') stats.noHuman++;
    if (result === 'uncertain') stats.uncertain++;
    if (action === 'blocked') stats.blocked++;
    if (action === 'covered') stats.covered++;
    note({ src: (src || '').slice(0, 200), kind, faces, result, action, mode, error: error ? String(error).slice(0, 120) : undefined });
  }

  async function resolveMode() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getState' });
      if (res && res.mode) mode = res.mode;
    } catch (e) {
      // Background unreachable (e.g. service worker asleep) — safe default.
      mode = 'block';
    }
    window.__fpMode = mode;
    return mode;
  }

  async function loadModel() {
    if (modelReady) return true;
    if (typeof faceapi === 'undefined') {
      console.warn('[fp] faceapi not loaded (vendor bundle missing?)');
      return false;
    }
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      modelReady = true;
      window.__fpModelReady = true;
      console.log('[fp] tinyFaceDetector model loaded from', MODEL_URL);
      return true;
    } catch (e) {
      console.warn('[fp] model load failed:', e);
      return false;
    }
  }

  // Detect faces in an <img> element. Returns {faces} or {uncertain:true}.
  // A timeout race guards against a tfjs/WebGL failure that never settles
  // (observed: a tainted canvas can throw an uncaught SecurityError from
  // texSubImage2D outside the detection promise — without the race the
  // scan would stall on that image forever).
  async function detectImg(img) {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ uncertain: true, error: 'detection timeout (20s)' }), 20000));
    const run = (async () => {
      try {
        const detections = await faceapi.detectAllFaces(img, opts);
        return { faces: detections.length };
      } catch (e) {
        // Cross-origin image without CORS: canvas is tainted, pixels unreadable.
        return { uncertain: true, error: String(e && e.message ? e.message : e) };
      }
    })();
    return Promise.race([run, timeout]);
  }

  function applyActionToImg(img, isHuman, uncertain, error) {
    const src = img.currentSrc || img.src || '';
    if (isHuman) {
      if (mode === 'block') {
        blockImg(img);
        record('img', src, 1, 'human', 'blocked');
      } else if (mode === 'cover' || mode === 'strict') {
        coverImg(img);
        record('img', src, 1, 'human', 'covered');
      } else {
        record('img', src, 1, 'human', 'none-allow-mode');
      }
    } else if (uncertain) {
      if (mode === 'strict') {
        // Strict mode: uncertain counts as human -> cover.
        coverImg(img);
        record('img', src, 0, 'uncertain', 'covered', error);
      } else {
        record('img', src, 0, 'uncertain', 'none', error);
      }
    } else {
      record('img', src, 0, 'no-human', 'none');
    }
  }

  function blockImg(img) {
    if (img.dataset.fpAction) return;
    img.dataset.fpAction = 'blocked';
    const w = img.width || img.naturalWidth || 300;
    const h = img.height || img.naturalHeight || 200;
    const ph = document.createElement('div');
    ph.className = 'fp-blocked-placeholder';
    ph.setAttribute('data-fp-blocked', '1');
    ph.style.cssText = [
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'text-align:center', 'width:' + Math.max(w, 120) + 'px',
      'height:' + Math.max(h, 80) + 'px', 'max-width:100%',
      'background:#f3f4f6', 'color:#111827', 'border:2px dashed #9ca3af',
      'border-radius:8px', 'font:14px sans-serif', 'padding:8px',
      'box-sizing:border-box', 'vertical-align:middle'
    ].join(';');
    ph.textContent = '⛔ בילד בלאקירט דורך פילטער — מענטש אויף בילד';
    ph.title = 'Filter Platform: image blocked (human figure detected)';
    if (img.parentNode) img.parentNode.replaceChild(ph, img);
    else img.style.display = 'none';
  }

  function coverImg(img) {
    if (img.dataset.fpAction) return;
    img.dataset.fpAction = 'covered';
    img.style.filter = 'blur(22px) grayscale(1) brightness(0.85)';
    img.style.pointerEvents = 'none';
    img.setAttribute('data-fp-covered', '1');
    img.title = 'Filter Platform: image covered (human figure detected)';
    // Small badge so the user sees *why* it is blurred.
    try {
      const badge = document.createElement('span');
      badge.className = 'fp-cover-badge';
      badge.textContent = 'באַדעקט — מענטש אויף בילד';
      badge.style.cssText = [
        'position:absolute', 'z-index:9999', 'background:rgba(0,0,0,0.65)',
        'color:#fff', 'font:12px sans-serif', 'padding:3px 8px',
        'border-radius:4px', 'pointer-events:none'
      ].join(';');
      const parent = img.parentElement;
      if (parent) {
        const cs = getComputedStyle(parent);
        if (cs.position === 'static') parent.style.position = 'relative';
        parent.appendChild(badge);
      }
    } catch (e) { /* badge is cosmetic */ }
  }

  async function processImg(img) {
    if (processedImgs.has(img)) return;
    // Do NOT mark the image processed yet: if it is skipped (not fully
    // loaded), a later scan must retry it. Marking happens below, only
    // once detection is actually attempted.
    // Lazy images: wait until they actually have pixels.
    if (!img.complete || img.naturalWidth === 0) {
      await new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    }
    if (!img.isConnected || img.naturalWidth === 0 || !img.complete) {
      // Not fully loaded/decoded yet (e.g. a lazy image whose 5 s load wait
      // expired mid-decode: naturalWidth is already known but pixels are
      // not). Detecting now hangs tfjs indefinitely — skip; the image will
      // be picked up by a later re-scan (load event / scroll) when complete.
      if (!skippedImgs.has(img)) { skippedImgs.add(img); stats.skipped++; }
      return;
    }
    processedImgs.add(img);
    skippedImgs.delete(img);
    stats.found++;
    // Cross-origin image loaded WITHOUT CORS: its pixels can never be read
    // (drawing it taints the canvas, and tfjs then throws an uncaught
    // SecurityError from texSubImage2D while the detection promise hangs
    // forever — which also stalls the NEXT image behind it). Do not call
    // tfjs at all: mark it uncertain right away. Images loaded with
    // crossOrigin='anonymous' (or same-origin images) are safe to detect.
    let crossOrigin = false;
    try {
      crossOrigin = new URL(img.currentSrc || img.src, location.href).origin !== location.origin;
    } catch (e) { crossOrigin = false; }
    if (crossOrigin && !img.crossOrigin) {
      applyActionToImg(img, false, true, 'cross-origin without CORS — pixels unreadable');
      return;
    }
    const r = await detectImg(img);
    if (r.uncertain) applyActionToImg(img, false, true, r.error);
    else applyActionToImg(img, r.faces > 0, false);
  }

  // CSS background images: load a fresh Image (CORS-enabled) and detect.
  async function processBg(el) {
    if (processedBg.has(el)) return;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none' || !bg.includes('url(')) return;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (!m) return;
    const url = m[1];
    if (url.startsWith('data:')) { stats.skipped++; return; }
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    const loaded = await new Promise((resolve) => {
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = url;
      setTimeout(() => resolve(false), 6000);
    });
    if (!loaded) {
      // Not marked processed: a later scan retries (e.g. transient failure).
      // Count it only once, so repeated retries do not inflate the stats.
      if (!bgFailed.has(el)) {
        bgFailed.add(el);
        note({ src: url.slice(0, 200), kind: 'background', faces: 0, result: 'uncertain', action: 'none', mode, error: 'bg load failed (CORS or network)' });
        stats.uncertain++;
      }
      return;
    }
    processedBg.add(el);
    bgFailed.delete(el);
    stats.bgFound++;
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
    let faces = 0;
    try {
      faces = (await faceapi.detectAllFaces(probe, opts)).length;
    } catch (e) {
      stats.uncertain++;
      note({ src: url.slice(0, 200), kind: 'background', faces: 0, result: 'uncertain', action: 'none', mode, error: 'canvas taint' });
      return;
    }
    // record() counts scanned for the human branch; count it here for the
    // no-human branch, where record() is not called. (Do NOT count it in
    // both places — that double-counted the background scan.)
    if (faces > 0) {
      stats.bgHuman++;
      if (mode === 'block') {
        el.style.backgroundImage = 'none';
        el.setAttribute('data-fp-bg-blocked', '1');
        record('background', url, faces, 'human', 'blocked');
      } else if (mode === 'cover' || mode === 'strict') {
        el.style.position = el.style.position || 'relative';
        const ov = document.createElement('div');
        ov.className = 'fp-bg-cover';
        ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;color:#fff;font:13px sans-serif;z-index:9998;';
        ov.textContent = 'באַדעקט — מענטש אויף בילד';
        el.appendChild(ov);
        record('background', url, faces, 'human', 'covered');
      } else {
        record('background', url, faces, 'human', 'none-allow-mode');
      }
    } else {
      stats.scanned++;
      stats.noHuman++;
      note({ src: url.slice(0, 200), kind: 'background', faces: 0, result: 'no-human', action: 'none', mode });
    }
  }

  async function scanAll() {
    if (!modelReady) return;
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) await processImg(img);
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (el.tagName === 'IMG') continue;
      await processBg(el);
    }
    window.__fpScanDone = true;
    publishStats();
    try {
      await chrome.runtime.sendMessage({ type: 'report', stats, url: location.href });
    } catch (e) { /* background may be asleep; stats still live on window */ }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      runScan();
    }, 400);
  }

  // Serialize scans: NEVER run two scanAll() loops at once. Two concurrent
  // loops call faceapi.detectAllFaces at the same time, and under tfjs/WebGL
  // (SwiftShader in tests, and equally on weak machines) the in-flight ops
  // corrupt each other — a tainted-canvas error from one image then fails
  // unrelated same-origin images, or deadlocks the scan entirely (observed:
  // first scan never finished, 240 s timeout, flaky uncertain results).
  // queueScan only marks "dirty"; the runner re-scans once when free.
  let scanRunning = false;
  let scanPending = false;
  async function runScan() {
    if (scanRunning) { scanPending = true; return; }
    scanRunning = true;
    try {
      await scanAll();
    } finally {
      scanRunning = false;
      if (scanPending) { scanPending = false; runScan(); }
    }
  }

  async function init() {
    await resolveMode();
    publishStats();
    // Attach observers BEFORE the first scan: the first scan can be slow
    // (on-device inference), and images injected while it runs must still
    // be caught — otherwise a 2 s dynamic image would be missed entirely.
    const obs = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mut of mutations) {
        if (mut.type === 'childList' && (mut.addedNodes.length || mut.removedNodes.length)) { relevant = true; break; }
        if (mut.type === 'attributes' && (mut.attributeName === 'src' || mut.attributeName === 'data-src' || mut.attributeName === 'style' || mut.attributeName === 'class')) { relevant = true; break; }
      }
      if (relevant) queueScan();
    });
    obs.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src', 'data-src', 'style', 'class']
    });
    // Lazy images that load on scroll.
    document.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'IMG') queueScan();
    }, true);
    window.addEventListener('scroll', queueScan, { passive: true });
    const ok = await loadModel();
    if (!ok) {
      window.__fpScanDone = true; // nothing more we can do
      publishStats();
      console.warn('[fp] content script running WITHOUT model — images not checked');
      return;
    }
    await runScan();
    console.log('[fp] content script active, mode=', mode);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
