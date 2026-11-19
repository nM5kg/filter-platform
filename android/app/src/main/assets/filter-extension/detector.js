// Filter Platform — person-detector bridge (content-script side).
//
// The MediaPipe person detector cannot run in this content script's
// isolated world: its loader injects the WASM runtime as a classic
// <script> into document.body, which executes in the page's main world,
// while the bundle itself lives in the isolated world — the two halves
// would never see each other ("ModuleFactory not set"). So the detector
// lives in detector.html, a hidden extension-origin iframe (an
// extension-origin page, same arrangement as the scanner's dedicated
// detector page), and this module bridges to it over postMessage.
// GeckoView note: this built-in extension is installed from
// resource://android/assets/filter-extension/; browser.runtime.getURL()
// returns the extension-origin URL for its files (expected to be a
// moz-extension:// URL — UNVERIFIED on-device). No origin string is
// hardcoded anywhere here: EXT_ORIGIN below is derived from getURL().
//
// What crosses the bridge: a downscaled JPEG data URL of the image
// (max 960 px, quality 0.85 — EfficientDet-Lite0 resizes to 320x320
// internally, so nothing is lost) and back come detection numbers only
// ({persons, personBest, boxes}). No image data leaves the browser: the
// iframe fetches only bundled extension files (extension-origin URLs) —
// plus, since v1.2.0, the image bytes it is asked to fetch (see
// fetchImage): the iframe is an extension-origin page, so its fetch
// runs with the extension's permissions ("<all_urls>") and is not
// CORS-gated in the MV3 Chrome build. Whether GeckoView grants the same
// CORS exemption to a built-in extension page's fetch is UNVERIFIED
// on-device — if it does not, cross-origin refetch falls back to the
// content-script fetch (CORS-enabled hosts only) and anything else
// stays uncertain / covered (fail closed).
//
// face-api.js (tinyFaceDetector) stays in this content script as the
// fallback + complement: if the person detector is unavailable or fails
// on an image, face detection still runs; if BOTH fail, content.js
// treats the image as uncertain and COVERS it (fail closed).
//
// Page CSP note: a page whose CSP blocks extension-origin iframes
// (frame-src / default-src) prevents this bridge from loading. That is
// detected fast (no 'fp-detector-present' ping within 10 s) and the
// extension falls back to face-only detection on that page. It never
// fails open: unreadable / uncheckable images are covered, not allowed.

(function () {
  'use strict';

  const IFRAME_URL = browser.runtime.getURL('detector.html');
  // Extension origin, derived from getURL() — never hardcoded. In the
  // MV3 Chrome build this was 'chrome-extension://' + chrome.runtime.id;
  // in GeckoView the built-in extension's origin is whatever getURL()
  // returns (expected moz-extension://… — UNVERIFIED on-device), so the
  // origin is computed from the same URL the iframe is loaded from.
  let EXT_ORIGIN = '';
  try { EXT_ORIGIN = new URL(IFRAME_URL).origin; } catch (e) { EXT_ORIGIN = ''; }
  const MAX_DIM = 960; // downscale target; matches the scanner's 960px test images
  const JPEG_QUALITY = 0.85;
  const PRESENT_TIMEOUT_MS = 10000; // wait for the iframe's presence ping
  const WARMUP_TIMEOUT_MS = 60000; // model load (WASM compile + .tflite)
  const DETECT_TIMEOUT_MS = 20000; // per-image round trip
  const FETCH_TIMEOUT_MS = 20000; // per-image fetch round trip (iframe fetch timeout is 15 s)

  let iframe = null;
  let presentPromise = null; // resolves true when the iframe announces itself
  let warmupPromise = null; // resolves true when the person detector is ready
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, timer }
  let readyFlag = false;

  window.__fpPersonReady = false;

  function waitFor(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
    });
  }

  window.addEventListener('message', (event) => {
    // Only accept messages that provably came from OUR detector iframe.
    // event.source must be the iframe's window — a page script cannot
    // forge event.source, so the source check is the real authentication
    // here. The origin check is a second line of defence, but it is NOT
    // trusted as the gate: if the origin does not match the computed
    // extension origin (e.g. GeckoView reports the built-in extension's
    // iframe origin differently than getURL() — UNVERIFIED on-device),
    // log a warning and STILL accept the message when event.source
    // matches. Rejecting on origin alone would silently kill person
    // detection on-device for a mere origin-string surprise, while
    // accepting on source alone cannot let a page script in — it has no
    // way to make event.source be our iframe's window.
    if (!iframe || event.source !== iframe.contentWindow) return;
    if (EXT_ORIGIN && event.origin !== EXT_ORIGIN) {
      console.warn('[fp] detector message origin mismatch (expected ' + EXT_ORIGIN + ', got ' + event.origin + ') — accepting on event.source match');
    }
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'fp-detector-present') {
      if (presentPromise) presentPromise.resolve(true);
      return;
    }
    if (msg.type === 'fp-detector-ready' || msg.type === 'fp-detector-error' || msg.type === 'fp-detect-result' || msg.type === 'fp-fetch-result') {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });

  function injectIframe() {
    iframe = document.createElement('iframe');
    iframe.src = IFRAME_URL;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    // display:none iframes still load and run. Keep it out of layout.
    iframe.style.cssText = 'display:none!important;width:0!important;height:0!important;border:0!important;position:absolute!important;';
    (document.body || document.documentElement).appendChild(iframe);
  }

  // Inject the detector iframe (if not already there) and wait for its
  // 'fp-detector-present' ping. Resolves true when the frame is alive,
  // false when it never announced itself (page CSP blocking
  // extension-origin iframes, or a load error). Idempotent: the
  // promise is cached, so a failed presence check costs 10 s once per
  // page, not once per image. This does NOT need the person model — the
  // frame can fetch images (see fetchImage) even if the model failed.
  function ensureIframe() {
    if (presentPromise) return presentPromise;
    // Create the presence promise BEFORE injecting the frame, so a fast
    // 'fp-detector-present' ping cannot arrive before we listen.
    let resolvePresent;
    presentPromise = new Promise((r) => { resolvePresent = r; });
    presentPromise.resolve = resolvePresent;
    // The iframe posts 'fp-detector-present' as soon as its module
    // runs. If it never arrives, the frame was blocked (page CSP)
    // or failed to load — fail fast to face-only.
    setTimeout(() => resolvePresent(false), PRESENT_TIMEOUT_MS);
    if (!iframe) injectIframe();
    return presentPromise;
  }

  // Start the detector (idempotent). Resolves true when the person
  // detector is loaded and ready, false when it is unavailable (CSP
  // block, load error, timeout). Never rejects; a slow load keeps
  // resolving in the background and later ensure() calls see it.
  function ensure() {
    if (warmupPromise) return warmupPromise;
    warmupPromise = (async () => {
      try {
        const present = await ensureIframe();
        if (!present) {
          console.warn('[fp] person-detector iframe never announced itself (page CSP may block extension iframes?) — face-only fallback');
          return false;
        }
        const id = nextId++;
        // Register the waiter BEFORE posting, then await it — posting
        // must happen before the await, or the message is never sent
        // until the timeout fires.
        const resPromise = waitFor(id, WARMUP_TIMEOUT_MS);
        try {
          iframe.contentWindow.postMessage({ type: 'fp-detector-warmup', id }, '*');
        } catch (e) {
          console.warn('[fp] person-detector warmup post failed:', e);
          return false;
        }
        const res = await resPromise;
        if (res.timeout) {
          console.warn('[fp] person-detector warmup timed out — face-only fallback (detector may still come up later)');
          return false;
        }
        console.log('[fp] person-detector warmup reply:', res.type, res.error || '');
        if (res.type === 'fp-detector-ready') {
          readyFlag = true;
          window.__fpPersonReady = true;
          console.log('[fp] person detector ready (MediaPipe EfficientDet-Lite0, PROTOTYPE-ONLY weights — see models-mediapipe/LICENSES.md)');
          return true;
        }
        console.warn('[fp] person detector unavailable:', res.error || 'unknown error', '— face-only fallback');
        return false;
      } catch (e) {
        console.warn('[fp] person detector ensure failed:', e, '— face-only fallback');
        return false;
      }
    })();
    return warmupPromise;
  }

  // Fetch image bytes THROUGH the detector iframe (v1.2.0).
  //
  // Why not fetch() here in the content script? A content-script fetch
  // runs with the PAGE as its initiator, so the page's CORS rules apply
  // to it — host_permissions do NOT exempt it (verified 2026-11-18: a
  // content-script fetch of a no-CORS image fails with "Failed to
  // fetch", while the same fetch succeeds for hosts that send
  // Access-Control-Allow-Origin: *). The detector iframe is an
  // extension-origin page, so ITS fetch runs with
  // the extension's host_permissions and is not CORS-gated: it can read
  // the bytes of ANY http(s) image the page loads. The iframe returns
  // the bytes (ArrayBuffer, structured-cloned over postMessage); the
  // caller decodes them into a probe Image and detects on-device.
  // The iframe enforces the same caps as the old content-script fetch
  // (8 MiB, 15 s, image/* content-type) — see detector-page.js.
  // Throws when the iframe is unavailable ('detector iframe
  // unavailable' — the caller may fall back to a content-script fetch,
  // which still works for CORS-enabled hosts) or when the fetch itself
  // fails. Never returns pixels for a different URL than asked.
  async function fetchImage(url) {
    const present = await ensureIframe();
    if (!present) throw new Error('detector iframe unavailable (page CSP may block extension iframes?)');
    const id = nextId++;
    const resPromise = waitFor(id, FETCH_TIMEOUT_MS);
    iframe.contentWindow.postMessage({ type: 'fp-fetch-image', id, url }, '*');
    const res = await resPromise;
    if (res.timeout) throw new Error('image fetch timeout (20s)');
    if (res.error) throw new Error(res.error);
    if (!(res.bytes instanceof ArrayBuffer)) throw new Error('bad fetch reply (no bytes)');
    return res.bytes;
  }

  function imgToDataUrl(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('image has no pixels');
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    // Throws if the canvas is tainted (cross-origin without CORS). The
    // caller gates those images out first; this is a second line of
    // defence — a throw here means "cannot read pixels", never "no human".
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }

  // Detect persons in an <img> element (or any image-like element with
  // naturalWidth/naturalHeight). Returns { persons, personBest, boxes }.
  // Throws when the person detector is unavailable or the detection
  // itself fails — the caller falls back to face detection, and covers
  // the image if both fail.
  async function detect(img) {
    const ready = await ensure();
    if (!ready) throw new Error('person detector not ready');
    const dataUrl = imgToDataUrl(img);
    const id = nextId++;
    const resPromise = waitFor(id, DETECT_TIMEOUT_MS);
    iframe.contentWindow.postMessage({ type: 'fp-detect-person', id, dataUrl }, '*');
    const res = await resPromise;
    if (res.timeout) throw new Error('person detection timeout (20s)');
    if (res.error) throw new Error(res.error);
    return { persons: res.persons || 0, personBest: res.personBest || 0, boxes: res.boxes || [] };
  }

  function isReady() { return readyFlag; }

  window.FpPersonDetector = { ensure, detect, isReady, fetchImage };
})();
