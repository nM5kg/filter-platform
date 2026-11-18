// Filter Platform — content script (Phase 2)
// On-device human-figure detection, two detectors, both bundled locally:
//   1. PERSON (primary): MediaPipe ObjectDetector, EfficientDet-Lite0
//      (COCO `person` class), running in the hidden detector.html iframe
//      (see detector.js) — it sees bodies without a visible face.
//      PROTOTYPE-ONLY weights: the EfficientDet-Lite0 weights license is
//      UNVERIFIED (see models-mediapipe/LICENSES.md) — do not treat this
//      model as production-licensed.
//   2. FACE (fallback + complement): face-api.js tinyFaceDetector, as
//      before. A person OR face hit counts as human (presence only — we
//      do NOT guess gender, age or identity).
// Detection runs entirely on-device; no image data ever leaves the
// browser. Fail closed: an image neither detector could clear
// (detector failure, weak signal, unreadable pixels) is UNCERTAIN and
// gets COVERED in block/cover/strict modes — never left visible as if
// it were clean.

(function () {
  'use strict';

  const MODEL_URL = chrome.runtime.getURL('models');
  const stats = {
    found: 0, scanned: 0, human: 0, blocked: 0, covered: 0,
    uncertain: 0, noHuman: 0, bgFound: 0, bgHuman: 0, skipped: 0,
    personHits: 0, // images where the person detector found >= 1 person
    refetched: 0, // cross-origin images re-fetched for detection (v1.2.0)
    refetchFailed: 0, // refetch attempts that failed -> uncertain (fail closed)
    refetchCacheHits: 0 // images whose verdict came from the per-URL cache
  };
  const log = []; // per-image: {src, kind, persons, personBest, faces, faceBest, detectedBy, result, action}
  window.__fpStats = stats;
  window.__fpLog = log;
  window.__fpModelReady = false;
  window.__fpPersonReady = false;
  window.__fpScanDone = false;
  window.__fpMode = 'unknown';

  let mode = 'block'; // block | cover | strict | allow
  let modelReady = false;
  let personReady = false;
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
      root.setAttribute('data-fp-person-ready', String(window.__fpPersonReady));
      root.setAttribute('data-fp-scan-done', String(window.__fpScanDone));
      root.setAttribute('data-fp-stats', JSON.stringify(stats));
      let div = document.getElementById('fp-dom-stats');
      if (!div) {
        div = document.createElement('div');
        div.id = 'fp-dom-stats';
        div.style.display = 'none';
        (document.body || root).appendChild(div);
      }
      div.textContent = JSON.stringify({ stats, personReady: window.__fpPersonReady, log: log.slice(-500) });
    } catch (e) { /* DOM not ready yet; next call retries */ }
  }

  function record(kind, src, r, result, action, error) {
    stats.scanned++;
    if (result === 'human') stats.human++;
    if (result === 'no-human') stats.noHuman++;
    if (result === 'uncertain') stats.uncertain++;
    if (r && r.persons > 0) stats.personHits++;
    if (action === 'blocked') stats.blocked++;
    if (action === 'covered') stats.covered++;
    note({
      src: (src || '').slice(0, 200), kind,
      persons: r ? (r.persons || 0) : 0,
      personBest: r ? (r.personBest || 0) : 0,
      faces: r ? (r.faces || 0) : 0,
      faceBest: r ? (r.faceBest || 0) : 0,
      best: r ? (r.best || 0) : 0,
      detectedBy: r ? (r.detectedBy || null) : null,
      via: r ? (r.via || 'direct') : undefined, // direct | refetch-iframe | refetch-direct | refetch-cache | refetch (failed) | short-circuit
      ms: r && r.ms ? r.ms : undefined,
      result, action, mode,
      error: error ? String(error).slice(0, 120) : undefined
    });
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

  // Load both detectors in parallel; each in its own try/catch so one
  // failure does not take down the other. modelReady = at least one
  // detector loaded, else the scan cannot run at all. The person
  // detector loads lazily here (first scan), so page load is not
  // blocked by the 14 MB WASM runtime + 7 MB model fetch — both are
  // bundled extension files, fetched from chrome-extension:// only.
  async function loadModels() {
    if (modelReady) return true;
    const faceP = (async () => {
      if (typeof faceapi === 'undefined') {
        console.warn('[fp] faceapi not loaded (vendor bundle missing?)');
        return false;
      }
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        console.log('[fp] tinyFaceDetector model loaded from', MODEL_URL);
        return true;
      } catch (e) {
        console.warn('[fp] face model load failed:', e);
        return false;
      }
    })();
    const personP = (async () => {
      if (typeof FpPersonDetector === 'undefined') {
        console.warn('[fp] FpPersonDetector not loaded (detector.js missing?)');
        return false;
      }
      try {
        return await FpPersonDetector.ensure();
      } catch (e) {
        console.warn('[fp] person detector ensure failed:', e);
        return false;
      }
    })();
    const [faceOk, personOk] = await Promise.all([faceP, personP]);
    personReady = personOk;
    window.__fpPersonReady = personOk;
    modelReady = faceOk || personOk;
    window.__fpModelReady = modelReady;
    if (!modelReady) console.warn('[fp] NO detector loaded — images cannot be checked');
    return modelReady;
  }

  // Detect humans in an <img> element (or a probe Image for backgrounds).
  // Runs BOTH detectors in parallel and combines them:
  //   person OR face with best score >= HUMAN_THRESHOLD (0.50) -> human
  //   best score in [SCORE_FLOOR, 0.50)                    -> uncertain
  //   neither detector found anything                       -> no-human
  //   BOTH detectors failed on this image                   -> uncertain
  //     (fail closed — the caller COVERS uncertain images)
  // A timeout race guards against a detection that never settles
  // (observed before: a tainted canvas can throw an uncaught
  // SecurityError from texSubImage2D outside the detection promise).
  // Returns { persons, personBest, faces, faceBest, best, detectedBy,
  //           human, uncertain, error? }.
  const SCORE_FLOOR = 0.40; // same floor as scanner/detector.js
  const HUMAN_THRESHOLD = 0.50; // same as the old face-only threshold
  async function detectImg(img) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ uncertain: true, error: 'detection timeout (20s)' }), 20000));
    const run = (async () => {
      let persons = 0, personBest = 0;
      let faces = 0, faceBest = 0;
      let personError = null, faceError = null;
      const personP = (async () => {
        if (!personReady || typeof FpPersonDetector === 'undefined') {
          personError = 'person detector not ready';
          return;
        }
        try {
          const r = await FpPersonDetector.detect(img);
          persons = r.persons;
          personBest = r.personBest;
        } catch (e) {
          personError = String(e && e.message ? e.message : e);
        }
      })();
      const faceP = (async () => {
        if (typeof faceapi === 'undefined' || !faceapi.nets.tinyFaceDetector.isLoaded) {
          faceError = 'face detector not ready';
          return;
        }
        try {
          const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: HUMAN_THRESHOLD });
          const detections = await faceapi.detectAllFaces(img, opts);
          faces = detections.length;
          if (faces) faceBest = +Math.max(...detections.map((d) => d.score)).toFixed(3);
        } catch (e) {
          // Cross-origin image without CORS: canvas is tainted, pixels unreadable.
          faceError = String(e && e.message ? e.message : e);
        }
      })();
      await Promise.all([personP, faceP]);
      const best = Math.max(personBest, faceBest);
      const detectedBy = persons > 0 && faces > 0 ? 'person+face'
        : persons > 0 ? 'person' : faces > 0 ? 'face' : null;
      const base = { persons, personBest, faces, faceBest, best, detectedBy };
      if (persons === 0 && faces === 0) {
        if (personError && faceError) {
          return { ...base, uncertain: true, error: 'person: ' + personError + ' ; face: ' + faceError };
        }
        // Weak person signal below the human threshold (0.40-0.50):
        // not a clear human, but not clear either -> uncertain.
        if (best >= SCORE_FLOOR) return { ...base, uncertain: true, error: 'weak person signal ' + best };
        return { ...base, human: false };
      }
      if (best >= HUMAN_THRESHOLD) return { ...base, human: true };
      return { ...base, uncertain: true, error: 'weak signal ' + best };
    })();
    return Promise.race([run, timeout]);
  }

  // ------------------------------------------------------------------
  // Cross-origin refetch (v1.2.0) — get readable pixels for a
  // cross-origin <img> the page loaded WITHOUT CORS.
  //
  // The page's <img> pixels can never be read (drawing it taints the
  // canvas), but the extension itself CAN fetch the same URL — two
  // paths, in order:
  //
  //   1. IFRAME path (preferred): the detector iframe (detector.html,
  //      an extension-origin page) fetches the bytes — see
  //      FpPersonDetector.fetchImage in detector.js. An extension
  //      page's fetch runs with the extension's host_permissions
  //      (http://*/* https://*/*) and is NOT CORS-gated, so it reads
  //      ANY http(s) image the page loads, CORS headers or not.
  //   2. DIRECT path (fallback, only when the iframe is unavailable —
  //      e.g. a page whose CSP blocks chrome-extension:// iframes):
  //      a plain content-script fetch. This one IS subject to the
  //      page's CORS rules (verified 2026-11-18: it fails with
  //      "Failed to fetch" on no-CORS hosts, and succeeds where the
  //      host sends Access-Control-Allow-Origin: *), so it only helps
  //      for CORS-enabled hosts — but on a page where the person
  //      detector is down anyway, it still lets face detection run.
  //
  // Either way the bytes are decoded into a probe Image (a blob:
  // object URL, never added to the DOM — so the MutationObserver /
  // scan never sees it and no detection loop can form), and run
  // through the SAME person+face detection (detectImg).
  //
  // Privacy: the fetch is a plain GET of a URL the page ALREADY loads
  // (the <img> src the browser just fetched); credentials are omitted
  // (no page cookies are sent to the image host), no request body, and
  // no data leaves the browser — the bytes go only to the on-device
  // detectors. The page's own image load usually leaves the bytes in
  // the browser HTTP cache, so the refetch is often a cache hit, not
  // a second download.
  //
  // Fail closed: ANY failure (network, page CSP, HTTP error, non-image
  // content-type, oversized file, undecodable bytes, detection error)
  // throws here, and the caller turns the image UNCERTAIN -> COVERED,
  // exactly as the old short-circuit did.
  //
  // Limits:
  //   MAX_FETCH_BYTES 8 MiB — larger files are rejected without
  //     downloading them fully (Content-Length fast path + a streaming
  //     reader that aborts past the cap).
  //   FETCH_TIMEOUT_MS 15 s per fetch (AbortController; the iframe
  //     round trip allows 20 s).
  //   Verdicts are cached per URL (max 500 entries, oldest evicted) so
  //     the same image is never fetched + detected twice — a page that
  //     repeats one placeholder 50 times pays for one detection.
  // ------------------------------------------------------------------
  const MAX_FETCH_BYTES = 8 * 1024 * 1024; // 8 MiB
  const FETCH_TIMEOUT_MS = 15000;
  const VERDICT_CACHE_MAX = 500;
  const verdictCache = new Map(); // url -> Promise<detectImg result>

  // Content-script fetch (DIRECT path — see above). CORS-gated: works
  // only for hosts that send Access-Control-Allow-Origin: *. Returns
  // { blob, via: 'refetch-direct' }. Throws on any failure.
  async function fetchImageBytesDirect(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: controller.signal });
      if (!res.ok) throw new Error('fetch HTTP ' + res.status);
      const len = res.headers.get('content-length');
      if (len !== null && Number(len) > MAX_FETCH_BYTES) {
        throw new Error('file too large (Content-Length ' + len + ' > ' + MAX_FETCH_BYTES + ')');
      }
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (ct && !ct.startsWith('image/')) throw new Error('not an image (Content-Type ' + ct + ')');
      if (!res.body || typeof res.body.getReader !== 'function') {
        const blob = await res.blob();
        if (blob.size > MAX_FETCH_BYTES) throw new Error('file too large (' + blob.size + ' > ' + MAX_FETCH_BYTES + ')');
        return { blob, via: 'refetch-direct' };
      }
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          try { await reader.cancel(); } catch (e) { /* already aborted */ }
          throw new Error('file too large (>' + MAX_FETCH_BYTES + ' bytes)');
        }
        chunks.push(value);
      }
      return { blob: new Blob(chunks, { type: ct || 'image/jpeg' }), via: 'refetch-direct' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Re-fetch one image's bytes. Preferred path is the detector iframe
  // (NOT CORS-gated — see detector.js fetchImage); if the iframe is
  // unavailable, fall back to the content-script fetch (CORS-gated,
  // CORS-enabled hosts only). Returns { blob, via }. Throws when BOTH
  // paths fail (or the iframe path fails for a reason the direct path
  // cannot fix: HTTP/network/size/content-type — retrying those
  // directly would fail the same way).
  async function fetchImageBytes(url) {
    if (typeof FpPersonDetector !== 'undefined' && typeof FpPersonDetector.fetchImage === 'function') {
      try {
        const bytes = await FpPersonDetector.fetchImage(url);
        return { blob: new Blob([bytes]), via: 'refetch-iframe' };
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // The iframe itself is down (page CSP) — the direct fetch is
        // still worth trying for CORS-enabled hosts. Any other failure
        // came from the fetch, and the direct path would fail the same
        // way (same network, same URL) — do not retry, fail closed.
        if (msg.indexOf('detector iframe unavailable') !== 0) throw new Error('refetch failed (iframe): ' + msg);
      }
    }
    try {
      return await fetchImageBytesDirect(url);
    } catch (e) {
      throw new Error('refetch failed (direct): ' + String(e && e.message ? e.message : e));
    }
  }

  // Decode a blob URL into a fresh Image element (never added to the
  // DOM). Rejects on decode failure / timeout.
  function loadProbeImage(objectUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      const timer = setTimeout(() => reject(new Error('probe image load timeout (8s)')), 8000);
      im.onload = () => { clearTimeout(timer); resolve(im); };
      im.onerror = () => { clearTimeout(timer); reject(new Error('probe image failed to decode')); };
      im.src = objectUrl;
    });
  }

  // Re-fetch one cross-origin image and detect on the re-fetched
  // pixels. Returns the same result shape as detectImg, with via =
  // 'refetch-iframe' (detector-iframe fetch) or 'refetch-direct'
  // (content-script fetch fallback). Throws on any failure (fetch,
  // decode, detection) — the caller fails closed.
  async function detectCrossOrigin(url) {
    const { blob, via } = await fetchImageBytes(url);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const probe = await loadProbeImage(objectUrl);
      const t0 = Date.now();
      const r = await detectImg(probe);
      r.ms = Date.now() - t0;
      r.via = via;
      return r;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // FAIL CLOSED: an UNCERTAIN image (both detectors failed, a weak
  // signal, or unreadable pixels) is COVERED in block/cover/strict
  // modes — it is never left visible as if it were cleared. Only
  // 'allow' mode leaves it alone, and only a clean no-human verdict
  // leaves an image untouched.
  function applyActionToImg(img, r) {
    const src = img.currentSrc || img.src || '';
    if (r.human) {
      if (mode === 'block') {
        blockImg(img);
        record('img', src, r, 'human', 'blocked');
      } else if (mode === 'cover' || mode === 'strict') {
        coverImg(img);
        record('img', src, r, 'human', 'covered');
      } else {
        record('img', src, r, 'human', 'none-allow-mode');
      }
    } else if (r.uncertain) {
      if (mode === 'block' || mode === 'cover' || mode === 'strict') {
        coverImg(img);
        record('img', src, r, 'uncertain', 'covered', r.error);
      } else {
        record('img', src, r, 'uncertain', 'none-allow-mode', r.error);
      }
    } else {
      record('img', src, r, 'no-human', 'none');
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
    // Cross-origin image loaded WITHOUT CORS: the page's <img> pixels
    // can never be read (drawing it taints the canvas, and tfjs then
    // throws an uncaught SecurityError from texSubImage2D while the
    // detection promise hangs forever — which also stalls the NEXT
    // image behind it). So do NOT call either detector on the page's
    // element. Instead (v1.2.0) re-fetch the same URL from the
    // extension side and detect on the re-fetched bytes (see
    // detectCrossOrigin); any failure there still ends UNCERTAIN and
    // fail-closed means it gets COVERED (see applyActionToImg).
    // Images loaded with crossOrigin='anonymous' (or same-origin
    // images) are safe to detect directly, as before.
    let crossOrigin = false;
    try {
      crossOrigin = new URL(img.currentSrc || img.src, location.href).origin !== location.origin;
    } catch (e) { crossOrigin = false; }
    if (crossOrigin && !img.crossOrigin) {
      const srcUrl = img.currentSrc || img.src || '';
      // Data-URI images carry no origin, but their pixels ARE readable
      // (drawing them never taints a canvas) — detect them directly.
      if (srcUrl.startsWith('data:')) {
        const t0 = Date.now();
        const r = await detectImg(img);
        r.ms = Date.now() - t0;
        applyActionToImg(img, r);
        return;
      }
      // Only http(s) URLs can be re-fetched; anything else stays
      // uncertain (fail closed), as the old short-circuit did.
      if (!/^https?:\/\//i.test(srcUrl)) {
        applyActionToImg(img, { uncertain: true, persons: 0, personBest: 0, faces: 0, faceBest: 0, best: 0, detectedBy: null, via: 'short-circuit', error: 'cross-origin non-http(s) URL — pixels unreadable' });
        return;
      }
      let r;
      const cached = verdictCache.get(srcUrl);
      if (cached) {
        stats.refetchCacheHits++;
        r = { ...(await cached), via: 'refetch-cache', ms: undefined };
      } else {
        const p = detectCrossOrigin(srcUrl).catch((e) => ({
          uncertain: true, persons: 0, personBest: 0, faces: 0, faceBest: 0,
          best: 0, detectedBy: null, via: 'refetch',
          error: String(e && e.message ? e.message : e).slice(0, 160),
        }));
        verdictCache.set(srcUrl, p);
        if (verdictCache.size > VERDICT_CACHE_MAX) {
          verdictCache.delete(verdictCache.keys().next().value); // evict oldest
        }
        stats.refetched++;
        r = await p;
        if (r.uncertain && r.error && r.error.indexOf('refetch failed') === 0) stats.refetchFailed++;
      }
      applyActionToImg(img, r);
      return;
    }
    const t0 = Date.now();
    const r = await detectImg(img);
    r.ms = Date.now() - t0;
    applyActionToImg(img, r);
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
    // Same combined person+face detection as <img> (detectImg works on
    // any image element, including this probe). A detection failure after
    // the probe loaded is fail-closed: COVER the background in
    // block/cover/strict modes, same as an uncertain <img>.
    const t0 = Date.now();
    const r = await detectImg(probe);
    r.ms = Date.now() - t0;
    // record() counts scanned for the human/uncertain branches; count it
    // here for the no-human branch, where record() is not called. (Do NOT
    // count it in both places — that double-counted the background scan.)
    if (r.human) {
      stats.bgHuman++;
      if (mode === 'block') {
        el.style.backgroundImage = 'none';
        el.setAttribute('data-fp-bg-blocked', '1');
        record('background', url, r, 'human', 'blocked');
      } else if (mode === 'cover' || mode === 'strict') {
        el.style.position = el.style.position || 'relative';
        const ov = document.createElement('div');
        ov.className = 'fp-bg-cover';
        ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;color:#fff;font:13px sans-serif;z-index:9998;';
        ov.textContent = 'באַדעקט — מענטש אויף בילד';
        el.appendChild(ov);
        record('background', url, r, 'human', 'covered');
      } else {
        record('background', url, r, 'human', 'none-allow-mode');
      }
    } else if (r.uncertain) {
      if (mode === 'block' || mode === 'cover' || mode === 'strict') {
        el.style.position = el.style.position || 'relative';
        const ov = document.createElement('div');
        ov.className = 'fp-bg-cover';
        ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;color:#fff;font:13px sans-serif;z-index:9998;';
        ov.textContent = 'באַדעקט — אומזיכער בילד';
        el.appendChild(ov);
        record('background', url, r, 'uncertain', 'covered', r.error);
      } else {
        record('background', url, r, 'uncertain', 'none-allow-mode', r.error);
      }
    } else {
      stats.scanned++;
      stats.noHuman++;
      note({ src: url.slice(0, 200), kind: 'background', persons: r.persons, personBest: r.personBest, faces: r.faces, faceBest: r.faceBest, best: r.best, detectedBy: r.detectedBy, ms: r.ms, result: 'no-human', action: 'none', mode });
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
    const ok = await loadModels();
    if (!ok) {
      window.__fpScanDone = true; // nothing more we can do
      publishStats();
      console.warn('[fp] content script running WITHOUT any detector — images not checked');
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
