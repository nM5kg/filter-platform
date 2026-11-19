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
// persons, personBest, faces, faceBest, detected, detectError, boxes,
// image_key, cachedDecision}.
// `boxes` are NORMALIZED person/face box fractions {x,y,w,h,score}
// (0..1, relative to the image): person boxes from FpPersonDetector
// (pixels in the 960-downscaled image — divided by the downscaled
// dims), face boxes from face-api .box (divided by the image dims).
// Person boxes win when present; face boxes are the fallback.
// `image_key` is 'u:' + sha256(canonical URL) when the source is an
// http(s) URL, else null. `cachedDecision` is the locally cached
// review outcome for that key ({decision, boxes}), so the shim can
// honour an earlier review without re-asking.
//
// Review flow (Yakob 2026-11-19): a covered image carries a REQUEST
// BUTTON ("בעטן אַ באַשלוס"). Clicking it runs the second-stage
// review — window.FpReview on the web (RF-DETR), or a native review
// via browser.runtime.sendMessage {type:'review'} in the Android app.
// Outcomes: allow -> uncover; allow_painted -> paint overlays over
// just the person boxes; block -> block; uncertain -> stays covered.
// Every outcome is recorded locally (localStorage
// 'fp_review_decisions_v1', under the 'u:' key and, when the review
// returns a contentHash, under the 'b:' key too) and, on the web
// path only, POSTed fire-and-forget to '/review-decision' (a failed
// POST never blocks or undoes the UI decision).
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
//
// ------------------------------------------------------------------
// Web-demo shell protocol (postMessage with the demo shell in
// public/browser.html). The shell cannot read inside the cross-origin
// iframe, so everything goes through window.postMessage with
// source 'filter-platform-web':
//   OUT fp-download-request {source, type:'fp-download-request',
//       url:<absolute ORIGINAL image/link URL>, kind:'image'|'link',
//       elementId:<the element's fp id, image buttons only>}
//       — posted when the user clicks the Download button on an
//       ALLOWED image, or clicks a link to an image file / a link
//       with a download attribute. The elementId lets the shell look
//       the verdict up per ELEMENT (verdictsById), which is the only
//       unambiguous lookup when one source URL backs several elements
//       with different verdicts. Link clicks carry NO elementId and
//       fall back to the by-source lookup in the shell.
//       policy (it blocks covered/unknown images using the verdicts
//       map from fp-status) and does the actual fetching — this
//       script never downloads anything itself. Covered / blocked /
//       review images get NO download button.
//   IN  fp-find {type:'fp-find', query, backwards} — from
//       window.parent (the shell) only; runs window.find and replies:
//   OUT fp-find-result {source, type:'fp-find-result', found, query}
//   (fp-loaded / fp-status are posted by the Worker shim, not here;
//   fp-status carries verdicts {sourceUrl: 'allow'|'cover'|'block'}
//   (keys unwrapped to ORIGINAL URLs) and verdictsById
//   {elementId: 'allow'|'cover'|'block'}, which the shell uses for
//   its download policy.)
// ------------------------------------------------------------------
(function () {
  'use strict';

  var FRAME = Math.random().toString(36).slice(2, 8); // unique per frame
  var THUMB_MAX = 320;          // thumbnail long edge, px
  var RETRY_MS = 1000;          // retry delay when native is unreachable
  var MAX_RETRIES = 10;         // then give up (content stays covered)
  var MUTATION_DEBOUNCE_MS = 250;
  var STREAM_RESAMPLE_MS = 3000;
  var REVIEW_CACHE_KEY = 'fp_review_decisions_v1';
  var REVIEW_TIMEOUT_MS = 60000;
  var DETECTOR_MAX_DIM = 960;   // same downscale as detector.js imgToDataUrl
  var humanImageMode = 'paint'; // 'paint' | 'block'; set by fp-policy from the shell/shim

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
      else if (entry.state === 'painted') placePaintOverlays(entry);
      else if (entry.state === 'allowed') placeDownloadButton(entry);
    });
  }

  // ---------------------------------------------------------------- review cache
  // Local decision cache: image_key -> {decision, boxes, mode, best, at}.
  // decision is the REVIEW decision ('allow' | 'allow_painted' | 'block'
  // | 'uncertain'); the shim maps it to a verdict. Guarded: localStorage
  // may be unavailable (private mode, sandbox) — then reviews still
  // apply to the live page, they just are not remembered.
  function loadReviewCache() {
    try { return JSON.parse(localStorage.getItem(REVIEW_CACHE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveReviewCache(cache) {
    try { localStorage.setItem(REVIEW_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* unremembered, not fatal */ }
  }
  function lookupReviewDecision(key) {
    if (!key) return null;
    var cache = loadReviewCache();
    return cache[key] || null;
  }
  function storeReviewDecision(key, value) {
    if (!key || !value) return;
    var cache = loadReviewCache();
    cache[key] = value;
    saveReviewCache(cache);
  }

  function sha256hex(text) {
    try {
      if (!crypto || !crypto.subtle || typeof TextEncoder === 'undefined') return Promise.resolve(null);
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  // Clamp a box to normalized fractions 0..1.
  function normalizeBox(b) {
    function cl(v) { v = Number(v); if (isNaN(v)) return 0; return Math.min(1, Math.max(0, v)); }
    return { x: cl(b.x), y: cl(b.y), w: cl(b.w), h: cl(b.h), score: cl(b.score == null ? 0 : b.score) };
  }

  // ---------------------------------------------------------------- downloads
  // The proxied page's URLs are rewritten to /browse?u=<original>.
  // Unwrap one back to the original absolute URL, so the shell can
  // fetch it via /browse?u=<original> itself. Non-proxied URLs pass
  // through unchanged.
  function originalUrl(raw) {
    try {
      var u = new URL(raw, location.href);
      var orig = u.searchParams.get('u');
      if (orig) return new URL(orig, location.href).href;
      return u.href;
    } catch (e) { return raw || ''; }
  }

  function placeDownloadButton(entry) {
    var btn = entry.downloadBtn;
    if (!btn) return;
    var r = entry.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) { btn.style.display = 'none'; return; }
    btn.style.display = 'block';
    // Sit on the image's top-right corner, straddling the edge so it
    // hides as little of the image itself as possible.
    var w = btn.offsetWidth || 84;
    var h = btn.offsetHeight || 24;
    var top = r.top - h / 2;
    if (top < 0) top = r.top; // image at the viewport top: fall back inside
    btn.style.left = Math.max(0, r.right - w / 2) + 'px';
    btn.style.top = top + 'px';
  }

  // Small "Download" button on an ALLOWED image only. Clicking it just
  // asks the shell (window.parent) to download — the shell enforces
  // the policy and fetches the bytes; this script downloads nothing.
  // Covered / blocked / review images never get a button.
  function addDownloadButton(entry) {
    if (entry.downloadBtn || entry.kind !== 'img') return;
    var el = entry.el;
    if (el.tagName !== 'IMG' && el.tagName !== 'INPUT') return;
    var url = originalUrl(entry.source || sourceOf(el));
    if (!url) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-fp-download', '1');
    btn.textContent = '⤓ Download';
    var s = btn.style;
    s.position = 'fixed';
    s.zIndex = '2147483646';
    s.padding = '2px 8px';
    s.font = '600 11px/1.6 system-ui, sans-serif';
    s.color = '#fff';
    s.background = 'rgba(20, 50, 79, 0.92)';
    s.border = '1px solid rgba(255,255,255,0.6)';
    s.borderRadius = '6px';
    s.cursor = 'pointer';
    s.boxSizing = 'border-box';
    s.whiteSpace = 'nowrap';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.parent.postMessage({
          source: 'filter-platform-web', type: 'fp-download-request',
          url: url, kind: 'image', elementId: entry.id
        }, '*');
      } catch (err) { /* parent gone */ }
    });
    (document.body || document.documentElement).appendChild(btn);
    entry.downloadBtn = btn;
    placeDownloadButton(entry);
  }

  function removeDownloadButton(entry) {
    if (entry.downloadBtn) { entry.downloadBtn.remove(); entry.downloadBtn = null; }
  }

  // Cover an element now. `kind` decides how: CSS-background elements keep
  // their text visible (only the background image is stripped); everything
  // else is hidden and gets an overlay. Covered videos are paused so a
  // hidden video does not keep playing audio. A covered element also gets
  // the REQUEST BUTTON (Yakob req 2): the user can ask the second-stage
  // review (RF-DETR on the web, native review in the app) to decide
  // whether the image may open. The button is a real <button> with
  // pointer-events:auto inside the pointer-events:none overlay.
  function makeRequestButton(entry) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-fp-review-btn', '1');
    btn.textContent = 'בעטן אַ באַשלוס';
    var s = btn.style;
    s.position = 'absolute';
    s.left = '50%';
    s.bottom = '8px';
    s.transform = 'translateX(-50%)';
    s.zIndex = '2';
    s.padding = '6px 12px';
    s.font = '600 13px/1.4 system-ui, sans-serif';
    s.color = '#fff';
    s.background = '#1d4ed8';
    s.border = '1px solid rgba(255,255,255,0.7)';
    s.borderRadius = '8px';
    s.cursor = 'pointer';
    s.pointerEvents = 'auto';
    s.whiteSpace = 'nowrap';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      requestReview(entry);
    });
    return btn;
  }

  function ensureRequestButton(entry) {
    if (!entry.overlay) return;
    if (entry.reviewBtn && entry.overlay.contains(entry.reviewBtn)) return;
    entry.reviewBtn = makeRequestButton(entry);
    entry.overlay.appendChild(entry.reviewBtn);
  }

  function cover(entry) {
    var el = entry.el;
    removeDownloadButton(entry);
    removePaintOverlays(entry);
    if (entry.state === 'covered') { placeOverlay(entry); ensureRequestButton(entry); return; }
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
    ensureRequestButton(entry);
  }

  function uncover(entry) {
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    entry.reviewBtn = null;
    removePaintOverlays(entry);
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
    removeDownloadButton(entry);
    removePaintOverlays(entry);
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    entry.reviewBtn = null;
    entry.el.style.display = 'none';
    entry.state = 'blocked';
  }

  // ---------------------------------------------------------------- paint
  // Paint overlays (Yakob req 3, default mode 'paint'): the image stays
  // visible, and one opaque overlay div is placed over JUST each person
  // box (fractions x the image's displayed rect, fixed positioning like
  // the cover overlay). A small "געמאָלט" tag marks the first box.
  // Paint overlays are repositioned in repositionAll (scroll/resize)
  // and removed on uncover / block / repaint / cover.
  function removePaintOverlays(entry) {
    if (entry.paintOverlays) {
      entry.paintOverlays.forEach(function (o) { o.remove(); });
    }
    entry.paintOverlays = [];
    entry.paintBoxes = [];
  }

  function placePaintOverlays(entry) {
    if (!entry.paintOverlays || !entry.paintOverlays.length) return;
    var r = entry.el.getBoundingClientRect();
    entry.paintOverlays.forEach(function (o, idx) {
      var b = (entry.paintBoxes && entry.paintBoxes[idx]) || { x: 0, y: 0, w: 0, h: 0 };
      var s = o.style;
      // No Math.max(0, ...) clamp on left/top here (unlike the cover
      // overlay): the paint box must track the image exactly, even
      // when the image has scrolled partly off the viewport top.
      s.left = (r.left + (b.x || 0) * r.width) + 'px';
      s.top = (r.top + (b.y || 0) * r.height) + 'px';
      s.width = Math.max(0, (b.w || 0) * r.width) + 'px';
      s.height = Math.max(0, (b.h || 0) * r.height) + 'px';
      s.display = (r.width > 0 && r.height > 0 && (b.w || 0) > 0 && (b.h || 0) > 0) ? 'block' : 'none';
    });
  }

  function paint(entry, boxes) {
    removePaintOverlays(entry);
    removeDownloadButton(entry);
    if (entry.overlay) { entry.overlay.remove(); entry.overlay = null; }
    entry.reviewBtn = null;
    var el = entry.el;
    // Restore the image itself (same as uncover, minus the download
    // button — a painted image's raw bytes still contain the person,
    // so it must never download; see browser-core decideDownload).
    if (entry.kind === 'css') {
      el.style.backgroundImage = el.dataset.fpOrigBg || '';
      delete el.dataset.fpOrigBg;
    } else {
      el.style.visibility = el.dataset.fpOrigVis || '';
      delete el.dataset.fpOrigVis;
    }
    entry.state = 'painted';
    entry.paintBoxes = (boxes || []).map(normalizeBox);
    entry.paintOverlays = [];
    var rect = el.getBoundingClientRect();
    entry.paintBoxes.forEach(function (b, idx) {
      var o = document.createElement('div');
      o.setAttribute('data-fp-paint', '1');
      var s = o.style;
      s.position = 'fixed';
      s.left = (rect.left + b.x * rect.width) + 'px';
      s.top = (rect.top + b.y * rect.height) + 'px';
      s.width = Math.max(0, b.w * rect.width) + 'px';
      s.height = Math.max(0, b.h * rect.height) + 'px';
      s.zIndex = '2147483647';
      s.background = '#1d1d1f';
      s.boxSizing = 'border-box';
      s.pointerEvents = 'none';
      s.overflow = 'hidden';
      if (idx === 0) {
        var tag = document.createElement('span');
        tag.textContent = 'געמאָלט';
        tag.style.cssText = 'position:absolute;top:2px;inset-inline-start:2px;padding:1px 6px;font:600 10px/1.5 system-ui,sans-serif;color:#fff;background:rgba(20,50,79,0.92);border-radius:4px;';
        o.appendChild(tag);
      }
      (document.body || document.documentElement).appendChild(o);
      entry.paintOverlays.push(o);
    });
    placePaintOverlays(entry);
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
  // Face-model load timeout: loadFromUri has NO timeout of its own, so a
  // hung fetch / stalled tfjs init would leave warmUpDetectors() pending
  // FOREVER (Promise.all never settles) — personReady is only set after
  // it resolves, so a hung face load silently kills PERSON detection
  // too: every finding comes back detected=false while the shell still
  // shows the detector ready (the person warmup alone succeeded).
  // Seen live 2026-11-19: post-review reloads came back covered 0 /
  // allowed 7 / unscanned 7 with detector ready. The timeout bounds the
  // damage: after 45 s the warmup resolves with face=false and person
  // detection proceeds; a late face model still works for later
  // elements (faceP checks isLoaded, not faceReady).
  var FACE_LOAD_TIMEOUT_MS = 45000;
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
          // Race the load against FACE_LOAD_TIMEOUT_MS (see above): a
          // hung load must resolve false, never hang the warmup.
          var loaded = await Promise.race([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL).then(
              function () { return true; },
              function () { return false; }),
            new Promise(function (resolve) {
              setTimeout(function () { resolve('timeout'); }, FACE_LOAD_TIMEOUT_MS);
            })
          ]);
          if (loaded === 'timeout') {
            console.warn('[fp] face model load timed out (' + (FACE_LOAD_TIMEOUT_MS / 1000) +
              's) — continuing with person detector only; face may still come up later');
            return false;
          }
          if (!loaded) {
            console.warn('[fp] face model load failed');
            return false;
          }
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
    return { persons: 0, personBest: 0, faces: 0, faceBest: 0, detected: false, detectError: error || '', boxes: [] };
  }

  // Downscaled dims detector.js imgToDataUrl uses for this image
  // (scale min(1, 960/max) — same formula here, so person boxes in
  // downscaled pixels divide back to fractions of the full image).
  function downscaledDims(img) {
    var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    var scale = Math.min(1, DETECTOR_MAX_DIM / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
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
      var personBoxes = [], faceBoxes = [];
      var personP = (async function () {
        if (!personReady || typeof FpPersonDetector === 'undefined') {
          personError = 'person detector not ready';
          return;
        }
        try {
          var r = await FpPersonDetector.detect(img);
          persons = r.persons || 0;
          personBest = r.personBest || 0;
          // Boxes are pixels in the 960-downscaled image: divide by the
          // downscaled dims to get fractions of the full image.
          var dd = downscaledDims(img);
          personBoxes = (r.boxes || []).map(function (b) {
            return normalizeBox({
              x: (b.x || 0) / dd.w, y: (b.y || 0) / dd.h,
              w: (b.w || 0) / dd.w, h: (b.h || 0) / dd.h, score: b.score || 0
            });
          });
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
          // face-api .box is in pixels of the image passed in: divide
          // by the image dims to get fractions.
          var iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
          faceBoxes = detections.map(function (d) {
            var b = d.box || {};
            return normalizeBox({
              x: (b.x || 0) / iw, y: (b.y || 0) / ih,
              w: (b.width || 0) / iw, h: (b.height || 0) / ih, score: d.score || 0
            });
          });
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
        detectError: bothFailed ? ('person: ' + personError + ' ; face: ' + faceError) : '',
        // Prefer person boxes; fall back to face boxes when the person
        // detector found no body (a face is still a person region).
        boxes: personBoxes.length ? personBoxes : faceBoxes
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
  // NOT_LOADED_MSG: the image has no pixels YET. findingFor marks such
  // a finding deferred and report() does not send it — deciding now
  // would record allow+unscanned (detected=false) and the entry would
  // never be re-checked (report() skips 'allowed' entries). That is the
  // reload all-unscanned failure AND the lazy-image gap, both seen live
  // 2026-11-19: a reload right after a heavy download (or a below-fold
  // lazy image) is scanned before its bytes arrive, and every image
  // comes back allowed+unscanned forever. The entry stays covered; the
  // image's load listener (track()) re-schedules a report when its
  // bytes arrive, and only then is it decided. An image that never
  // loads stays covered — fail closed.
  var NOT_LOADED_MSG = 'image not loaded (no pixels yet)';
  async function detectImgElement(img) {
    if (!img.complete || !img.naturalWidth) {
      return noDetection(NOT_LOADED_MSG);
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
      detectError: '',
      boxes: [],
      image_key: null,
      cachedDecision: null
    };
    var attach = function (r) {
      base.persons = r.persons || 0;
      base.personBest = r.personBest || 0;
      base.faces = r.faces || 0;
      base.faceBest = r.faceBest || 0;
      base.detected = !!r.detected;
      base.detectError = r.detectError || '';
      base.boxes = (r.boxes || []).map(normalizeBox);
      return base;
    };
    // First detector for the review record: which first-stage detector
    // produced the signal (the review record names it), plus the
    // first-stage signal numbers — the API stores first_detector as a
    // JSON object (a plain string is rejected 400).
    var setFirstDetector = function () {
      entry.firstDetector = base.persons > 0 ? 'efficientdet' : (base.faces > 0 ? 'face-api' : 'none');
      entry.firstSignal = {
        persons: base.persons || 0, personBest: base.personBest || 0,
        faces: base.faces || 0, faceBest: base.faceBest || 0,
        detected: !!base.detected
      };
    };
    // Image key + cached review decision, attached AFTER detection so
    // the shim can honour an earlier review without re-asking.
    var attachKeyAndCache = async function () {
      var canonical = originalUrl(base.source || '');
      if (canonical && /^https?:\/\//i.test(canonical)) {
        var hex = await sha256hex(canonical);
        if (hex) base.image_key = 'u:' + hex;
      }
      entry.imageKey = base.image_key;
      if (base.image_key) {
        var cached = lookupReviewDecision(base.image_key);
        if (cached) base.cachedDecision = { decision: cached.decision, boxes: cached.boxes || [] };
      }
      setFirstDetector();
      return base;
    };
    if (entry.kind === 'video' || entry.kind === 'stream') {
      base.playing = !el.paused;
      base.thumb = thumbOfVideo(el);
      if (!base.thumb) { attach(noDetection('video frame unreadable')); return attachKeyAndCache(); }
      attach(await detectFromDataUrl(base.thumb));
      return attachKeyAndCache();
    }
    if (entry.kind === 'img') {
      base.thumb = thumbOfImage(el);
      attach(await detectImgElement(el));
      // No pixels yet: defer — do not decide this image (see
      // NOT_LOADED_MSG above). report() leaves deferred findings out
      // of the batch it sends, so the entry stays covered until its
      // bytes arrive.
      if (base.detectError === NOT_LOADED_MSG) base.deferred = true;
      return attachKeyAndCache();
    }
    if (entry.kind === 'canvas') {
      var r = thumbOfCanvas(el);
      base.thumb = r.thumb;
      if (r.webglSuspected) {
        base.kind = 'webgl';
        attach(noDetection('canvas pixels unreadable (WebGL suspected)'));
        return attachKeyAndCache();
      }
      if (!base.thumb) { attach(noDetection('canvas produced no readable pixels')); return attachKeyAndCache(); }
      attach(await detectFromDataUrl(base.thumb));
      return attachKeyAndCache();
    }
    if (entry.kind === 'svg') {
      base.thumb = await thumbOfSvg(el);
      if (!base.thumb) { attach(noDetection('SVG thumbnail unreadable')); return attachKeyAndCache(); }
      attach(await detectFromDataUrl(base.thumb));
      return attachKeyAndCache();
    }
    // css: detect on the background image URL.
    var m = (entry.source || '').match(/url\(["']?([^"')]+)["']?\)/);
    if (!m) { attach(noDetection('no background image URL')); return attachKeyAndCache(); }
    attach(await detectCssBackground(m[1]));
    return attachKeyAndCache();
  }

  function sendToNative(message) {
    return browser.runtime.sendMessage(message);
  }

  // ---------------------------------------------------------------- review flow
  // Second-stage review for a covered image (Yakob req 2 + 3).
  // Two paths, same outcome shape {decision, boxes, best, model}:
  //   WEB: window.FpReview (sibling A — RF-DETR, lazy-loaded via
  //     ensure(progressCb), review(bytes, humanImageMode)).
  //   APP: browser.runtime.sendMessage {type:'review'} to the native
  //     bridge (sibling E — native RF-DETR); reply
  //     {type:'review-decision', id, decision, boxes, reason}.
  // Neither available -> the button says "נישט פֿאַראַן" briefly and
  // the image stays covered. The review NEVER unblocks by itself on
  // failure: any error leaves the image covered.
  function fmtProgress(p) {
    if (typeof p === 'number') return Math.round(p * 100);
    if (p && typeof p.progress === 'number') return Math.round(p.progress * 100);
    if (p && typeof p.loaded === 'number' && typeof p.total === 'number' && p.total > 0) {
      return Math.round((p.loaded / p.total) * 100);
    }
    return null;
  }

  // Bytes for the review: re-fetch http(s) images (same refetch as
  // detection), fetch data:/blob: URLs directly, else snapshot the
  // readable element pixels to a JPEG blob.
  async function getReviewBytes(entry) {
    var src = originalUrl(entry.source || sourceOf(entry.el));
    if (/^https?:\/\//i.test(src)) {
      var fetched = await fetchImageBytes(src);
      return fetched.blob;
    }
    if (/^(data|blob):/i.test(src)) {
      var res = await fetch(src);
      return await res.blob();
    }
    var el = entry.el;
    var w = el.naturalWidth || el.videoWidth || el.width || 0;
    var h = el.naturalHeight || el.videoHeight || el.height || 0;
    if (!w || !h) throw new Error('no readable pixels for review');
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas context for review');
    ctx.drawImage(el, 0, 0, w, h);
    var blob = await new Promise(function (resolve) { c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.85); });
    if (!blob) throw new Error('canvas snapshot failed');
    return blob;
  }

  // Record a review decision on the server (web path ONLY — the native
  // app path records it on the native side). Fire-and-forget: a failed
  // POST must NEVER block or undo the UI decision (log only).
  function postReviewDecision(body) {
    if (!body || !body.image_key) return;
    try {
      fetch('/review-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit'
      }).catch(function (e) { console.warn('[fp] review-decision POST failed:', e); });
    } catch (e) { console.warn('[fp] review-decision POST failed:', e); }
  }

  async function applyReviewResult(entry, result, mode) {
    var decision = result.decision;
    var boxes = (result.boxes || []).map(normalizeBox);
    var best = typeof result.best === 'number' ? result.best : 0;
    var record = { decision: decision, boxes: boxes, mode: mode, best: best, at: Date.now() };
    // Local cache under the 'u:' key and, when the review ran on
    // fetched bytes, under the content-hash key too. NOTE: the review
    // engine's contentHash ALREADY carries the 'b:' prefix ('b:' +
    // sha256) — use it verbatim; prepending 'b:' again stored dead
    // 'b:b:…' keys that nothing ever looks up (fixed 2026-11-19).
    if (entry.imageKey) storeReviewDecision(entry.imageKey, record);
    if (result.contentHash) storeReviewDecision(result.contentHash, record);
    if (result.via === 'web') {
      postReviewDecision({
        image_key: entry.imageKey || result.contentHash || null,
        image_url: originalUrl(entry.source || sourceOf(entry.el)),
        page_url: location.href,
        decision: decision,
        model: result.model || 'rf-detr-nano',
        best_score: best,
        boxes: boxes,
        human_image_mode: mode,
        // first_detector MUST be an object (or null): the API rejects a
        // plain string with 400 ("must be an object or null"). Same
        // shape as the Android app: {detector: <name>} plus the
        // first-stage signal numbers. The web copy used to send the
        // bare string and every web POST was rejected (found 2026-11-19
        // by the live proxy round-trip; enriched to the full shape
        // per the integration follow-up the same day).
        first_detector: Object.assign({ detector: entry.firstDetector || 'none' },
          entry.firstSignal || {})
      });
    }
    if (decision === 'allow') { uncover(entry); addDownloadButton(entry); }
    else if (decision === 'allow_painted') { paint(entry, boxes); }
    else if (decision === 'block') { removeDownloadButton(entry); block(entry); }
    else { // 'uncertain' (and anything unknown): stays covered.
      if (entry.reviewBtn) entry.reviewBtn.textContent = 'נאָך אומבאַקאַנט — בלייבט באַדעקט';
    }
    // Tell the shim the outcome (web path only — the native app has no
    // shim to tell): without this the shell's verdict map + status
    // line keep the stale 'cover' from the first scan until a reload,
    // and a painted image's download would read verdict-cover instead
    // of verdict-painted. Fire-and-forget: a failed notify must never
    // undo the UI decision.
    if (result.via === 'web') {
      try {
        var shimVerdict = decision === 'allow' ? 'allow' :
          decision === 'allow_painted' ? 'painted' :
          decision === 'block' ? 'block' : 'cover';
        var notify = sendToNative({
          type: 'review-applied', id: entry.id,
          source: entry.source || sourceOf(entry.el),
          verdict: shimVerdict, boxes: boxes
        });
        if (notify && typeof notify.catch === 'function') {
          notify.catch(function () { /* notify only */ });
        }
      } catch (e) { /* notify only */ }
    }
    repositionAll();
  }

  async function requestReview(entry) {
    if (!entry || entry.reviewing || entry.state !== 'covered') return;
    entry.reviewing = true;
    var btn = entry.reviewBtn;
    function setBtn(t) { if (btn) btn.textContent = t; }
    try {
      var mode = humanImageMode;
      var bytes = await getReviewBytes(entry);
      var result = null;
      if (typeof window.FpReview !== 'undefined' && window.FpReview) {
        setBtn('לאָדט דעם צווייטן מאָדעל…');
        await window.FpReview.ensure(function (p) {
          var pct = fmtProgress(p);
          setBtn(pct === null ? 'לאָדט דעם צווייטן מאָדעל…' : 'לאָדט דעם צווייטן מאָדעל… ' + pct + '%');
        });
        setBtn('טשעקט…');
        result = await window.FpReview.review(bytes, mode);
        result = result || {};
        result.via = 'web';
      } else {
        setBtn('טשעקט…');
        var reply = await Promise.race([
          sendToNative({ type: 'review', id: entry.id, source: entry.source || sourceOf(entry.el), imageKey: entry.imageKey || null }),
          new Promise(function (resolve, reject) {
            setTimeout(function () { reject(new Error('review timeout')); }, REVIEW_TIMEOUT_MS);
          })
        ]);
        if (!reply || reply.type !== 'review-decision' || !reply.decision) {
          throw new Error('review unavailable');
        }
        result = {
          decision: reply.decision, boxes: reply.boxes || [],
          best: reply.best || 0, model: reply.model || 'native',
          reason: reply.reason || '', via: 'native'
        };
      }
      await applyReviewResult(entry, result, mode);
    } catch (e) {
      // Review unavailable / failed: stay covered, say so briefly.
      setBtn('נישט פֿאַראַן');
      setTimeout(function () {
        if (entry.reviewBtn) entry.reviewBtn.textContent = 'בעטן אַ באַשלוס';
      }, 2500);
    } finally {
      entry.reviewing = false;
    }
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
      return e.state !== 'allowed' && e.state !== 'blocked' && e.state !== 'painted';
    });
    if (!entries.length) return;
    reportRunning = true;
    try {
      var findings = [];
      for (var i = 0; i < entries.length; i++) {
        findings.push(await findingFor(entries[i]));
      }
      // Deferred findings (image not loaded yet) are NOT sent: deciding
      // them now would record allow+unscanned and they would never be
      // re-checked. They stay covered; each image's load listener
      // re-schedules a report when its bytes arrive (see
      // NOT_LOADED_MSG). If every finding is deferred, send nothing —
      // do not re-schedule here, or the report would spin forever on
      // images that never load (they correctly stay covered).
      var readyFindings = findings.filter(function (f) { return !f.deferred; });
      if (!readyFindings.length) return;
      var reply = await sendToNative({
        type: 'scan',
        pageUrl: location.href,
        findings: readyFindings
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
      if (d.verdict === 'allow') { uncover(entry); addDownloadButton(entry); }
      else if (d.verdict === 'block') { removeDownloadButton(entry); block(entry); }
      else if (d.verdict === 'painted') { removeDownloadButton(entry); paint(entry, d.boxes || []); }
      else { removeDownloadButton(entry); cover(entry); } // 'cover' and anything unknown: stay covered
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

    // Image-file / download links: do not navigate — ask the shell to
    // download instead (it enforces the policy and fetches the bytes).
    // Normal navigation links are never intercepted. The extension
    // check runs on the ORIGINAL url (proxied hrefs are /browse?u=...,
    // whose own pathname is just '/browse').
    document.addEventListener('click', function (e) {
      try {
        var a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a || !a.href) return;
        var orig = originalUrl(a.href);
        var linkPath = '';
        try { linkPath = new URL(orig, location.href).pathname.toLowerCase(); } catch (err) { return; }
        var isImageFile = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(linkPath);
        if (!isImageFile && !a.hasAttribute('download')) return;
        e.preventDefault();
        e.stopPropagation();
        window.parent.postMessage({
          source: 'filter-platform-web', type: 'fp-download-request',
          url: orig, kind: 'link'
        }, '*');
      } catch (err) { /* never break the page's own clicks */ }
    }, true);

    // Human-image policy from the shell (same pattern as the shim's
    // fp-policy listener): 'paint' (default) or 'block'. The review
    // call passes the current mode to FpReview / the native side.
    window.addEventListener('message', function (e) {
      try {
        if (!e || e.source !== window.parent) return;
        var d = e.data;
        if (d && d.type === 'fp-policy' &&
            (d.humanImageMode === 'paint' || d.humanImageMode === 'block')) {
          humanImageMode = d.humanImageMode;
        }
      } catch (err) { /* a policy message must never break the filter */ }
    });

    // Ask the shell for the current policy now that the listener above
    // exists. The shell's posts at navigation time and on fp-loaded
    // both arrive BEFORE this script (last injected) registers its
    // listener, so without this ask a reloaded tab reviews in the
    // default 'paint' mode even when the setting is 'block' — found
    // live 2026-11-19 (case-3 review upserted allow_painted with
    // human_image_mode 'paint' while the setting was 'block'). The
    // app ignores the unknown message type.
    try {
      window.parent.postMessage({ source: 'filter-platform-web', type: 'fp-policy-request' }, '*');
    } catch (err) { /* no shell to ask */ }

    // Find in page, driven by the shell. Only messages from the parent
    // frame (the shell) are accepted. Everything is guarded so a find
    // failure can never break the filter.
    window.addEventListener('message', function (e) {
      try {
        if (!e || e.source !== window.parent) return;
        var d = e.data;
        if (!d || d.type !== 'fp-find' || typeof d.query !== 'string') return;
        var found = false;
        try {
          if (typeof window.find === 'function') {
            found = !!window.find(d.query, false, !!d.backwards, true, false, false, false);
          }
        } catch (err) { found = false; }
        window.parent.postMessage({
          source: 'filter-platform-web', type: 'fp-find-result',
          found: found, query: d.query
        }, '*');
      } catch (err) { /* a find failure must never break the filter */ }
    });

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
