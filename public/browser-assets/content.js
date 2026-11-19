// Filter Platform — built-in WebExtension content script.
//
// Runs at document_start in every frame (all_frames). Its job:
//
//   1. COVER FIRST. Every visual element is covered the moment it is seen —
//      before any verdict exists. An element is uncovered only when the
//      native filter engine replies ALLOW for it. Anything undecided,
//      unreported, or unreached by the native side stays covered.
//      This is the fail-closed rule; see FilterEngine.kt.
//   2. SCAN. Report every visual element to the native engine:
//      HTML images, CSS backgrounds, Canvas, SVG, WebGL, video frames,
//      live streams, and anything added later (MutationObserver).
//   3. DETECT (on-device, v0.2.0 port of the proven v1.2.0 web-extension
//      engine). Two detectors, both bundled locally: MediaPipe
//      ObjectDetector EfficientDet-Lite0 (COCO `person`) in the hidden
//      detector.html iframe via FpPersonDetector (detector.js), and
//      face-api.js tinyFaceDetector in this content script. For every
//      element this script computes detection NUMBERS only — persons,
//      personBest, faces, faceBest, detected, detectError — and sends
//      them with the finding. It NEVER pre-decides human / uncertain /
//      no-human: the Kotlin side decides UNKNOWN vs NO_PERSON from the
//      numbers. Fail closed: anything undecided or unreadable is
//      reported with detected=false and a detectError, and stays covered.
//   4. APPLY the native decisions (allow / cover / block) that come back.
//
// Talk to native through the background relay:
//   content script --runtime.sendMessage--> background.js
//   --runtime.sendNativeMessage("filter-platform")--> Kotlin MessageDelegate
//   --reply--> background.js --sendMessage response--> here.
//
// What is sent per element: {id, kind, source, thumb, playing,
// persons, personBest, faces, faceBest, detected, detectError}.
// `thumb` is a downscaled JPEG data URL (max 320px) ONLY when the pixels
// could actually be read. Cross-origin/tainted images, WebGL canvases
// (no preserveDrawingBuffer) and live streams yield thumb=null, which the
// engine treats as "cannot check" -> REVIEW -> covered. A thumbnail that
// comes back blank (the classic unreadable-WebGL signature) is also
// dropped the same way — a blank thumbnail must never read as "clean".
// Detection numbers (v0.2.0): persons/personBest = MediaPipe person
// detector (best score 0..1, 0 when it found nothing); faces/faceBest =
// face-api tinyFaceDetector. detected = true when at least one detector
// RAN on this element's pixels (even if it found nothing); false when
// neither could run (both failed / timed out / no pixels). detectError
// is "" unless BOTH detectors failed, in which case it names both
// failures. Weak signals (best in [0.40, 0.50)) are still reported as
// numbers with detected=true — the Kotlin side decides UNKNOWN vs
// NO_PERSON from the numbers, so this script never pre-decides a
// verdict in JS. Detection runs entirely on-device; no image data ever
// leaves the browser.
//
// Known prototype gaps (see android/GECKOVIEW-PROTOTYPE.md):
//   * Closed shadow-DOM content is not traversed.
//   * A live stream is sampled as single frames; one clean frame does not
//     decide a stream — streams are re-reported (and re-detected) while
//     playing. Detection now runs on-device (v0.2.0), but a stream's
//     verdict still comes from the native engine per frame.
//   * EfficientDet-Lite0 weights are PROTOTYPE-ONLY (license unverified —
//     see models-mediapipe/LICENSES.md); do not treat this model as
//     production-licensed.
(function () {
  'use strict';

  var FRAME = Math.random().toString(36).slice(2, 8); // unique per frame
  var THUMB_MAX = 320;          // thumbnail long edge, px
  var RETRY_MS = 1000;          // retry delay when native is unreachable
  var MAX_RETRIES = 10;         // then give up (content stays covered)
  var MUTATION_DEBOUNCE_MS = 250;
  var STREAM_RESAMPLE_MS = 3000;

  var seq = 0;
  var tracked = new Map();      // id -> {el, kind, overlay, state, source}
  var pendingReport = false;
  var retriesLeft = MAX_RETRIES;

  function nextId() { return 'fp-' + FRAME + '-' + (++seq); }

  // ---------------------------------------------------------------- cover

  function makeOverlay(rect, label) {
    var o = document.createElement('div');
    o.setAttribute('data-fp-overlay', '1');
    var s = o.style;
    s.position = 'fixed';
    s.left = Math.max(0, rect.left) + 'px';
    s.top = Math.max(0, rect.top) + 'px';
    s.width = Math.max(0, rect.width) + 'px';
    s.height = Math.max(0, rect.height) + 'px';
    s.zIndex = '2147483647';
    s.background = '#1d1d1f';
    s.color = '#f5f5f7';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.textAlign = 'center';
    s.font = '600 13px/1.4 system-ui, sans-serif';
    s.pointerEvents = 'none';
    s.boxSizing = 'border-box';
    s.padding = '6px';
    s.overflow = 'hidden';
    o.textContent = label || 'Filtered — image covered';
    return o;
  }

  function placeOverlay(entry) {
    if (!entry.overlay) return;
    var r = entry.el.getBoundingClientRect();
    var s = entry.overlay.style;
    s.left = Math.max(0, r.left) + 'px';
    s.top = Math.max(0, r.top) + 'px';
    s.width = Math.max(0, r.width) + 'px';
    s.height = Math.max(0, r.height) + 'px';
    s.display = (r.width > 0 && r.height > 0) ? 'flex' : 'none';
  }

  function repositionAll() {
    tracked.forEach(function (entry) {
      if (entry.state === 'covered') placeOverlay(entry);
    });
  }

  // Cover an element now. `kind` decides how: CSS-background elements keep
  // their text visible (only the background image is stripped); everything
  // else is hidden and gets an overlay. Covered videos are paused so a
  // hidden video does not keep playing audio.
  function cover(entry) {
    var el = entry.el;
    if (entry.state === 'covered') { placeOverlay(entry); return; }
    if (entry.kind === 'css') {
      if (el.dataset.fpOrigBg === undefined) {
        el.dataset.fpOrigBg = el.style.backgroundImage || '';
      }
      el.style.backgroundImage = 'none';
    } else {
      if (el.dataset.fpOrigVis === undefined) {
        el.dataset.fpOrigVis = el.style.visibility || '';
      }
      el.style.visibility = 'hidden';
    }
    if (entry.kind === 'video' || entry.kind === 'stream') {
      try { el.pause(); } catch (e) { /* not pausable — overlay still covers it */ }
    }
    entry.overlay = makeOverlay(el.getBoundingClientRect());
    (document.body || document.documentElement).appendChild(entry.overlay);
    entry.state = 'covered';
  }

  function uncover(entry) {
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    var el = entry.el;
    if (entry.kind === 'css') {
      el.style.backgroundImage = el.dataset.fpOrigBg || '';
      delete el.dataset.fpOrigBg;
    } else {
      el.style.visibility = el.dataset.fpOrigVis || '';
      delete el.dataset.fpOrigVis;
    }
    entry.state = 'allowed';
  }

  function block(entry) {
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    entry.el.style.display = 'none';
    entry.state = 'blocked';
  }

  // ---------------------------------------------------------------- thumbs

  function drawThumb(source, sw, sh) {
    var scale = Math.min(1, THUMB_MAX / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  // A thumbnail that is one flat colour carries no information — it is what
  // an unreadable WebGL canvas (no preserveDrawingBuffer) or a blank canvas
  // produces. Treat it as "no pixels", never as "clean".
  function thumbIsBlank(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      var d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var r0 = d[0], g0 = d[1], b0 = d[2];
      for (var i = 4; i < d.length; i += 16) {
        if (Math.abs(d[i] - r0) > 4 || Math.abs(d[i + 1] - g0) > 4 ||
            Math.abs(d[i + 2] - b0) > 4) return false;
      }
      return true;
    } catch (e) { return true; }
  }

  function thumbDataUrl(canvas) {
    if (!canvas) return null;
    try {
      if (thumbIsBlank(canvas)) return null;
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; } // tainted canvas (cross-origin pixels)
  }

  function thumbOfImage(img) {
    if (!img.naturalWidth || !img.naturalHeight) return null;
    try {
      return thumbDataUrl(drawThumb(img, img.naturalWidth, img.naturalHeight));
    } catch (e) { return null; }
  }

  function thumbOfCanvas(canvas) {
    try {
      var c = drawThumb(canvas, canvas.width, canvas.height);
      var url = thumbDataUrl(c);
      // Readable pixels but the canvas paints nothing readable: the classic
      // WebGL-without-preserveDrawingBuffer signature. Flag it so the
      // engine (and the device checklist) can tell it apart from a 2D canvas.
      if (url === null && canvas.width > 0 && canvas.height > 0) {
        return { thumb: null, webglSuspected: true };
      }
      return { thumb: url, webglSuspected: false };
    } catch (e) { return { thumb: null, webglSuspected: true }; }
  }

  function thumbOfVideo(video) {
    if (video.readyState < 2 || !video.videoWidth) return null;
    try {
      return thumbDataUrl(drawThumb(video, video.videoWidth, video.videoHeight));
    } catch (e) { return null; }
  }

  function thumbOfSvg(svgEl) {
    return new Promise(function (resolve) {
      try {
        var xml = new XMLSerializer().serializeToString(svgEl);
        var blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var img = new Image();
        var done = false;
        var finish = function (value) {
          if (done) return; done = true;
          URL.revokeObjectURL(url);
          resolve(value);
        };
        img.onload = function () {
          finish(thumbOfImage(img));
        };
        img.onerror = function () { finish(null); };
        img.src = url;
        setTimeout(function () { finish(null); }, 2000);
      } catch (e) { resolve(null); }
    });
  }

  // ---------------------------------------------------------------- detection
  // On-device human-figure detection — port of the proven v1.2.0
  // web-extension engine (extension/content.js detectImg + refetch).
  // Two detectors, both bundled locally:
  //   1. PERSON (primary): MediaPipe ObjectDetector, EfficientDet-Lite0
  //      (COCO `person`), via FpPersonDetector (detector.js) in the hidden
  //      detector.html iframe. Sees bodies without a visible face.
  //      PROTOTYPE-ONLY weights: license UNVERIFIED — see
  //      models-mediapipe/LICENSES.md.
  //   2. FACE (fallback + complement): face-api.js tinyFaceDetector, in
  //      this content script (vendor/face-api.js, loaded before this file).
  // This section returns NUMBERS ONLY — {persons, personBest, faces,
  // faceBest, detected, detectError} — and never a verdict. The native
  // (Kotlin) side decides UNKNOWN vs NO_PERSON from the numbers.
  // Mirrors extension/content.js exactly on the scoring:
  //   HUMAN_THRESHOLD 0.50, SCORE_FLOOR 0.40 (person detector's
  //   scoreThreshold in detector-page.js), 20 s timeout race per element.
  // detected = true when at least one detector RAN on the element's
  // pixels (even with zero hits). detectError is "" unless BOTH
  // detectors failed / timed out, in which case it names both failures.
  // A weak signal (best in [0.40, 0.50)) is therefore reported as
  // numbers with detected=true — Kotlin decides what it means.
  var SCORE_FLOOR = 0.40; // same floor as detector-page.js / extension
  var HUMAN_THRESHOLD = 0.50; // face scoreThreshold, as in the extension
  var DETECT_TIMEOUT_MS = 20000; // per-element detection race, as in the extension
  var MODEL_URL = browser.runtime.getURL('models');

  var faceReady = false;
  var personReady = false;
  var detectorsWarmupPromise = null;

  // Warm up both detectors in parallel; each in its own try/catch so one
  // failure does not take down the other. Idempotent — the promise is
  // cached, so the models load once per page. Started from boot() (not
  // awaited) so model loading starts early; detectOnPixels() awaits this
  // promise, and its 20 s race bounds how long any element waits for it.
  function warmUpDetectors() {
    if (detectorsWarmupPromise) return detectorsWarmupPromise;
    detectorsWarmupPromise = (async function () {
      var faceP = (async function () {
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
      var personP = (async function () {
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
      var results = await Promise.all([faceP, personP]);
      faceReady = results[0];
      personReady = results[1];
      if (!faceReady && !personReady) console.warn('[fp] NO detector loaded — images cannot be checked');
      return { faceReady: faceReady, personReady: personReady };
    })();
    return detectorsWarmupPromise;
  }

  function noDetection(error) {
    return { persons: 0, personBest: 0, faces: 0, faceBest: 0, detected: false, detectError: error || '' };
  }

  // Detect humans in an <img> element (or a probe Image). Runs BOTH
  // detectors in parallel and returns numbers only — see the section
  // header. A timeout race guards against a detection that never settles
  // (observed in the extension: a tainted canvas can throw an uncaught
  // SecurityError from texSubImage2D outside the detection promise).
  async function detectOnPixels(img) {
    var timeout = new Promise(function (resolve) {
      setTimeout(function () { resolve(noDetection('detection timeout (20s)')); }, DETECT_TIMEOUT_MS);
    });
    var run = (async function () {
      await warmUpDetectors();
      var persons = 0, personBest = 0;
      var faces = 0, faceBest = 0;
      var personError = null, faceError = null;
      var personP = (async function () {
        if (!personReady || typeof FpPersonDetector === 'undefined') {
          personError = 'person detector not ready';
          return;
        }
        try {
          var r = await FpPersonDetector.detect(img);
          persons = r.persons || 0;
          personBest = r.personBest || 0;
        } catch (e) {
          personError = String(e && e.message ? e.message : e);
        }
      })();
      var faceP = (async function () {
        if (typeof faceapi === 'undefined' || !faceapi.nets.tinyFaceDetector.isLoaded) {
          faceError = 'face detector not ready';
          return;
        }
        try {
          var opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: HUMAN_THRESHOLD });
          var detections = await faceapi.detectAllFaces(img, opts);
          faces = detections.length;
          if (faces) faceBest = +Math.max.apply(null, detections.map(function (d) { return d.score; })).toFixed(3);
        } catch (e) {
          // Cross-origin image without CORS: canvas is tainted, pixels unreadable.
          faceError = String(e && e.message ? e.message : e);
        }
      })();
      await Promise.all([personP, faceP]);
      var bothFailed = personError && faceError;
      return {
        persons: persons, personBest: personBest, faces: faces, faceBest: faceBest,
        detected: !bothFailed,
        detectError: bothFailed ? ('person: ' + personError + ' ; face: ' + faceError) : ''
      };
    })();
    return Promise.race([run, timeout]);
  }

  // ------------------------------------------------------------------
  // Cross-origin refetch (v1.2.0) — get readable pixels for a
  // cross-origin <img> the page loaded WITHOUT CORS. Same design as
  // extension/content.js: (1) IFRAME path (preferred) — the detector
  // iframe (an extension-origin page) fetches the bytes, which in the
  // MV3 Chrome build is NOT CORS-gated; in GeckoView that exemption is
  // UNVERIFIED on-device, so (2) DIRECT path (fallback, only when the
  // iframe is unavailable) — a plain content-script fetch, CORS-gated,
  // works only for hosts that send Access-Control-Allow-Origin: *.
  // Either way the bytes are decoded into a probe Image (a blob: object
  // URL, never added to the DOM) and run through detectOnPixels.
  // Privacy: a plain GET of a URL the page ALREADY loads; credentials
  // omitted (no page cookies sent to the image host); no data leaves
  // the browser — bytes go only to the on-device detectors.
  // Fail closed: ANY failure throws here (or yields a noDetection
  // result via the cache wrapper), and the element stays covered.
  // Limits (as in the extension): MAX_FETCH_BYTES 8 MiB, FETCH_TIMEOUT_MS
  // 15 s per fetch, verdicts cached per URL (max 500, oldest evicted).
  // ------------------------------------------------------------------
  var MAX_FETCH_BYTES = 8 * 1024 * 1024; // 8 MiB
  var FETCH_TIMEOUT_MS = 15000;
  var VERDICT_CACHE_MAX = 500;
  var verdictCache = new Map(); // url -> Promise<detectOnPixels result>

  // Cache wrapper: the same URL is never fetched + detected twice.
  // NOTE (app difference from the extension): the extension cached only
  // refetched cross-origin verdicts, because each image was processed
  // once. This app RE-REPORTS covered entries on every scan until the
  // native side allows/blocks them, so direct detections and CSS
  // backgrounds are cached per URL too — otherwise every report would
  // re-run inference on every covered element. A cached failure is
  // cached as a noDetection result (fail closed), never as a pass.
  function cachedDetection(url, computeFn) {
    var cached = verdictCache.get(url);
    if (cached) return cached;
    var p = computeFn().catch(function (e) {
      return noDetection(String(e && e.message ? e.message : e).slice(0, 160));
    });
    verdictCache.set(url, p);
    if (verdictCache.size > VERDICT_CACHE_MAX) {
      verdictCache.delete(verdictCache.keys().next().value); // evict oldest
    }
    return p;
  }

  // Content-script fetch (DIRECT path — see above). CORS-gated: works
  // only for hosts that send Access-Control-Allow-Origin: *. Returns
  // { blob, via: 'refetch-direct' }. Throws on any failure.
  async function fetchImageBytesDirect(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      var res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: controller.signal });
      if (!res.ok) throw new Error('fetch HTTP ' + res.status);
      var len = res.headers.get('content-length');
      if (len !== null && Number(len) > MAX_FETCH_BYTES) {
        throw new Error('file too large (Content-Length ' + len + ' > ' + MAX_FETCH_BYTES + ')');
      }
      var ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (ct && ct.indexOf('image/') !== 0) throw new Error('not an image (Content-Type ' + ct + ')');
      if (!res.body || typeof res.body.getReader !== 'function') {
        var blob = await res.blob();
        if (blob.size > MAX_FETCH_BYTES) throw new Error('file too large (' + blob.size + ' > ' + MAX_FETCH_BYTES + ')');
        return { blob: blob, via: 'refetch-direct' };
      }
      var reader = res.body.getReader();
      var chunks = [];
      var total = 0;
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          try { await reader.cancel(); } catch (e) { /* already aborted */ }
          throw new Error('file too large (>' + MAX_FETCH_BYTES + ' bytes)');
        }
        chunks.push(chunk.value);
      }
      return { blob: new Blob(chunks, { type: ct || 'image/jpeg' }), via: 'refetch-direct' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Re-fetch one image's bytes. Preferred path is the detector iframe
  // (NOT CORS-gated in the MV3 build — UNVERIFIED in GeckoView); if the
  // iframe is unavailable, fall back to the content-script fetch
  // (CORS-gated, CORS-enabled hosts only). Returns { blob, via }.
  // Throws when BOTH paths fail (or the iframe path fails for a reason
  // the direct path cannot fix: HTTP/network/size/content-type —
  // retrying those directly would fail the same way).
  async function fetchImageBytes(url) {
    if (typeof FpPersonDetector !== 'undefined' && typeof FpPersonDetector.fetchImage === 'function') {
      try {
        var bytes = await FpPersonDetector.fetchImage(url);
        return { blob: new Blob([bytes]), via: 'refetch-iframe' };
      } catch (e) {
        var msg = String(e && e.message ? e.message : e);
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

  // Decode a blob/data URL into a fresh Image element (never added to
  // the DOM). Rejects on decode failure / timeout.
  function loadProbeImage(objectUrl) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      var timer = setTimeout(function () { reject(new Error('probe image load timeout (8s)')); }, 8000);
      im.onload = function () { clearTimeout(timer); resolve(im); };
      im.onerror = function () { clearTimeout(timer); reject(new Error('probe image failed to decode')); };
      im.src = objectUrl;
    });
  }

  // Re-fetch one cross-origin image and detect on the re-fetched
  // pixels. Returns the same result shape as detectOnPixels. Throws on
  // any failure (fetch, decode, detection) — the caller fails closed.
  async function detectCrossOrigin(url) {
    var fetched = await fetchImageBytes(url);
    var objectUrl = URL.createObjectURL(fetched.blob);
    try {
      var probe = await loadProbeImage(objectUrl);
      return await detectOnPixels(probe);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Detect on a thumbnail data URL (canvas / video / SVG): decode it
  // into a probe Image and run detectOnPixels on the probe. Any probe
  // failure is a noDetection result (fail closed), never a pass.
  async function detectFromDataUrl(dataUrl) {
    try {
      var probe = await loadProbeImage(dataUrl);
      return await detectOnPixels(probe);
    } catch (e) {
      return noDetection(String(e && e.message ? e.message : e).slice(0, 160));
    }
  }

  // <img>: same-origin / crossOrigin-set / data: -> detect directly on
  // the element; cross-origin http(s) without CORS -> refetch via
  // FpPersonDetector.fetchImage (iframe path first, direct content-script
  // fetch as fallback), decode into a probe Image, detect on the probe.
  // Cross-origin non-http(s) URLs cannot be refetched: noDetection.
  // Verdicts cached per URL (max 500) — see cachedDetection.
  async function detectImgElement(img) {
    if (!img.complete || !img.naturalWidth) {
      return noDetection('image not loaded (no pixels yet)');
    }
    var srcUrl = img.currentSrc || img.src || '';
    var crossOrigin = false;
    try {
      crossOrigin = new URL(srcUrl, location.href).origin !== location.origin;
    } catch (e) { crossOrigin = false; }
    if (!crossOrigin || img.crossOrigin || srcUrl.indexOf('data:') === 0) {
      // Direct: same-origin, CORS-enabled, or data: (pixels readable).
      if (!srcUrl) return detectOnPixels(img);
      return cachedDetection(srcUrl, function () { return detectOnPixels(img); });
    }
    // Only http(s) URLs can be re-fetched; anything else stays
    // undetected (fail closed).
    if (!/^https?:\/\//i.test(srcUrl)) {
      return noDetection('cross-origin non-http(s) URL — pixels unreadable');
    }
    return cachedDetection(srcUrl, function () { return detectCrossOrigin(srcUrl); });
  }

  // CSS background image: load a probe Image (crossOrigin anonymous);
  // if that fails, refetch via the iframe into a probe; detect on the
  // probe. Verdicts cached per URL (max 500) — see cachedDetection.
  async function detectCssBackground(url) {
    return cachedDetection(url, async function () {
      var probe = new Image();
      probe.crossOrigin = 'anonymous';
      var loaded = await new Promise(function (resolve) {
        probe.onload = function () { resolve(true); };
        probe.onerror = function () { resolve(false); };
        probe.src = url;
        setTimeout(function () { resolve(false); }, 6000);
      });
      if (loaded) return detectOnPixels(probe);
      if (/^https?:\/\//i.test(url)) {
        try {
          return await detectCrossOrigin(url);
        } catch (e) { /* fall through to noDetection below */ }
      }
      return noDetection('background image unreadable (probe load failed, refetch failed)');
    });
  }

  // ---------------------------------------------------------------- collect

  function sourceOf(el) {
    return el.currentSrc || el.src || el.getAttribute('data-src') || '';
  }

  function track(el, kind) {
    if (!el || el.dataset.fpId) return null;
    var id = nextId();
    el.dataset.fpId = id;
    var entry = { id: id, el: el, kind: kind, overlay: null, state: 'new' };
    tracked.set(id, entry);
    cover(entry); // cover FIRST, report second — never the other way round
    if (kind === 'img' && el.tagName === 'IMG' && !el.complete) {
      el.addEventListener('load', function () { scheduleReport(); }, { once: true });
    }
    return entry;
  }

  function collectImages(root) {
    var imgs = (root || document).querySelectorAll('img, input[type="image"]');
    imgs.forEach(function (el) { track(el, 'img'); });
  }

  function collectCssBackgrounds(root) {
    // Full-tree walk: only on a full scan, not per mutation.
    var all = (root || document).querySelectorAll('*');
    all.forEach(function (el) {
      if (el.dataset.fpId) return;
      var bg = '';
      try { bg = getComputedStyle(el).backgroundImage || ''; } catch (e) { return; }
      if (bg && bg !== 'none' && bg.indexOf('url(') !== -1) {
        var entry = track(el, 'css');
        if (entry) entry.source = bg;
      }
    });
  }

  function collectCanvas(root) {
    var list = (root || document).querySelectorAll('canvas');
    list.forEach(function (el) { track(el, 'canvas'); });
  }

  function collectSvg(root) {
    var list = (root || document).querySelectorAll('svg');
    list.forEach(function (el) { track(el, 'svg'); });
  }

  function collectVideo(root) {
    var list = (root || document).querySelectorAll('video');
    list.forEach(function (el) {
      var kind = (el.srcObject instanceof MediaStream) ? 'stream' : 'video';
      var entry = track(el, kind);
      if (entry) {
        el.addEventListener('playing', function () { scheduleReport(); });
        el.addEventListener('seeked', function () { scheduleReport(); });
      }
    });
  }

  function collectAll(root) {
    collectImages(root);
    collectCanvas(root);
    collectSvg(root);
    collectVideo(root);
    collectCssBackgrounds(); // always whole-document (computed style)
  }

  // ---------------------------------------------------------------- report

  // Build one scan finding for the native engine. Keeps the existing
  // id/kind/source/thumb/playing fields unchanged and adds the
  // detection numbers (persons, personBest, faces, faceBest, detected,
  // detectError) — see the detection section header. Per kind:
  //   img: direct detect, or refetch-via-iframe for cross-origin http(s)
  //     without CORS (detectImgElement); data: detected directly.
  //   css: probe Image (crossOrigin anonymous), iframe refetch on
  //     failure (detectCssBackground).
  //   canvas: thumbnail data URL -> probe Image -> detect; thumb null
  //     -> detected=false. WebGL-suspected -> detected=false.
  //   video/stream: thumbnail -> probe -> detect; keep resampling while
  //     playing (the interval in boot() re-reports). Thumb null ->
  //     detected=false.
  //   svg: thumbOfSvg -> probe -> detect; thumb null -> detected=false.
  //   webgl-suspected (canvas with no readable pixels) -> detected=false.
  // This script NEVER pre-decides human / uncertain / no-human — the
  // Kotlin side decides UNKNOWN vs NO_PERSON from these numbers.
  async function findingFor(entry) {
    var el = entry.el;
    var base = {
      id: entry.id,
      kind: entry.kind,
      source: entry.source || sourceOf(el),
      thumb: null,
      playing: false,
      persons: 0,
      personBest: 0,
      faces: 0,
      faceBest: 0,
      detected: false,
      detectError: ''
    };
    var attach = function (r) {
      base.persons = r.persons || 0;
      base.personBest = r.personBest || 0;
      base.faces = r.faces || 0;
      base.faceBest = r.faceBest || 0;
      base.detected = !!r.detected;
      base.detectError = r.detectError || '';
      return base;
    };
    if (entry.kind === 'video' || entry.kind === 'stream') {
      base.playing = !el.paused;
      base.thumb = thumbOfVideo(el);
      if (!base.thumb) return attach(noDetection('video frame unreadable'));
      return attach(await detectFromDataUrl(base.thumb));
    }
    if (entry.kind === 'img') {
      base.thumb = thumbOfImage(el);
      return attach(await detectImgElement(el));
    }
    if (entry.kind === 'canvas') {
      var r = thumbOfCanvas(el);
      base.thumb = r.thumb;
      if (r.webglSuspected) {
        base.kind = 'webgl';
        return attach(noDetection('canvas pixels unreadable (WebGL suspected)'));
      }
      if (!base.thumb) return attach(noDetection('canvas produced no readable pixels'));
      return attach(await detectFromDataUrl(base.thumb));
    }
    if (entry.kind === 'svg') {
      base.thumb = await thumbOfSvg(el);
      if (!base.thumb) return attach(noDetection('SVG thumbnail unreadable'));
      return attach(await detectFromDataUrl(base.thumb));
    }
    // css: detect on the background image URL.
    var m = (entry.source || '').match(/url\(["']?([^"')]+)["']?\)/);
    if (!m) return attach(noDetection('no background image URL'));
    return attach(await detectCssBackground(m[1]));
  }

  function sendToNative(message) {
    return browser.runtime.sendMessage(message);
  }

  var reportRunning = false;
  // Serialize reports AND detections within a report: never run two
  // findingFor()/detection passes at once. The v1.2.0 extension work
  // showed concurrent faceapi.detectAllFaces calls corrupt each other
  // under tfjs/WebGL (a tainted-canvas error from one image then fails
  // unrelated images, or deadlocks the scan entirely) — so findings are
  // built one element at a time, in order, and a report that fires
  // while one is running re-schedules itself instead of overlapping it.
  async function report() {
    pendingReport = false;
    if (reportRunning) { scheduleReport(); return; }
    var entries = Array.from(tracked.values()).filter(function (e) {
      return e.state !== 'allowed' && e.state !== 'blocked';
    });
    if (!entries.length) return;
    reportRunning = true;
    try {
      var findings = [];
      for (var i = 0; i < entries.length; i++) {
        findings.push(await findingFor(entries[i]));
      }
      var reply = await sendToNative({
        type: 'scan',
        pageUrl: location.href,
        findings: findings
      });
      retriesLeft = MAX_RETRIES;
      applyDecisions(reply);
    } catch (err) {
      // Native unreachable: keep everything covered and retry.
      if (retriesLeft-- > 0) {
        setTimeout(function () { scheduleReport(); }, RETRY_MS);
      }
    } finally {
      reportRunning = false;
    }
  }

  function applyDecisions(reply) {
    if (!reply || reply.type !== 'decisions' || !Array.isArray(reply.decisions)) return;
    reply.decisions.forEach(function (d) {
      var entry = tracked.get(d.id);
      if (!entry) return;
      if (d.verdict === 'allow') uncover(entry);
      else if (d.verdict === 'block') block(entry);
      else cover(entry); // 'cover' and anything unknown: stay covered
    });
    repositionAll();
  }

  var reportTimer = null;
  function scheduleReport() {
    if (pendingReport) return;
    pendingReport = true;
    reportTimer = setTimeout(report, MUTATION_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------- observe

  function boot() {
    if (!document.documentElement) return;
    // Start warming up both detectors now (not awaited): model loading
    // (WASM compile + .tflite + face model) starts early, and the first
    // report's detections await it behind their 20 s race.
    warmUpDetectors();
    collectAll();
    scheduleReport();

    window.addEventListener('scroll', repositionAll, { capture: true, passive: true });
    window.addEventListener('resize', repositionAll);

    // Dynamic content: new nodes, src/style/class changes (lazy images,
    // carousels, infinite scroll, SPA navigation).
    var observer = new MutationObserver(function (mutations) {
      var needsScan = false;
      mutations.forEach(function (m) {
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          needsScan = true;
        }
        if (m.type === 'attributes' &&
            (m.attributeName === 'src' || m.attributeName === 'style' ||
             m.attributeName === 'class' || m.attributeName === 'data-src')) {
          needsScan = true;
        }
      });
      if (needsScan) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            // The added node itself (querySelectorAll only sees descendants).
            if (n.matches('img, input[type="image"]')) track(n, 'img');
            if (n.matches('canvas')) track(n, 'canvas');
            if (n.matches('svg')) track(n, 'svg');
            if (n.matches('video')) {
              track(n, (n.srcObject instanceof MediaStream) ? 'stream' : 'video');
            }
            collectAll(n);
          });
        });
        collectCssBackgrounds();
        repositionAll();
        scheduleReport();
      }
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['src', 'style', 'class', 'data-src']
    });

    // Live streams / playing video: re-sample while playing so a future
    // detector can re-decide on fresh frames. A stream stays covered
    // until the native engine allows it on a fresh frame's numbers.
    setInterval(function () {
      var playing = false;
      tracked.forEach(function (entry) {
        if ((entry.kind === 'video' || entry.kind === 'stream') &&
            !entry.el.paused && entry.state === 'covered') playing = true;
      });
      if (playing) scheduleReport();
    }, STREAM_RESAMPLE_MS);
  }

  if (document.documentElement) {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
})();
