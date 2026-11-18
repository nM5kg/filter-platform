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
//   3. APPLY the native decisions (allow / cover / block) that come back.
//
// Talk to native through the background relay:
//   content script --runtime.sendMessage--> background.js
//   --runtime.sendNativeMessage("filter-platform")--> Kotlin MessageDelegate
//   --reply--> background.js --sendMessage response--> here.
//
// What is sent per element: {id, kind, source, thumb, playing}.
// `thumb` is a downscaled JPEG data URL (max 320px) ONLY when the pixels
// could actually be read. Cross-origin/tainted images, WebGL canvases
// (no preserveDrawingBuffer) and live streams yield thumb=null, which the
// engine treats as "cannot check" -> REVIEW -> covered. A thumbnail that
// comes back blank (the classic unreadable-WebGL signature) is also
// dropped the same way — a blank thumbnail must never read as "clean".
//
// Known prototype gaps (see android/GECKOVIEW-PROTOTYPE.md):
//   * CSS backgrounds are reported without a thumbnail (the URL would have
//     to be re-fetched); they stay covered until a detector can check them.
//   * Closed shadow-DOM content is not traversed.
//   * A live stream is sampled as single frames; one clean frame does not
//     decide a stream — streams are re-reported while playing and stay
//     covered in this prototype (no detector runs on device yet).
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

  function findingFor(entry) {
    var el = entry.el;
    var base = {
      id: entry.id,
      kind: entry.kind,
      source: entry.source || sourceOf(el),
      thumb: null,
      playing: false
    };
    if (entry.kind === 'video' || entry.kind === 'stream') {
      base.playing = !el.paused;
      base.thumb = thumbOfVideo(el);
      return Promise.resolve(base);
    }
    if (entry.kind === 'img') { base.thumb = thumbOfImage(el); return Promise.resolve(base); }
    if (entry.kind === 'canvas') {
      var r = thumbOfCanvas(el);
      base.thumb = r.thumb;
      if (r.webglSuspected) base.kind = 'webgl';
      return Promise.resolve(base);
    }
    if (entry.kind === 'svg') {
      return thumbOfSvg(el).then(function (t) { base.thumb = t; return base; });
    }
    return Promise.resolve(base); // css: no thumbnail in this prototype
  }

  function sendToNative(message) {
    return browser.runtime.sendMessage(message);
  }

  function report() {
    pendingReport = false;
    var entries = Array.from(tracked.values()).filter(function (e) {
      return e.state !== 'allowed' && e.state !== 'blocked';
    });
    if (!entries.length) return;
    Promise.all(entries.map(findingFor)).then(function (findings) {
      return sendToNative({
        type: 'scan',
        pageUrl: location.href,
        findings: findings
      });
    }).then(function (reply) {
      retriesLeft = MAX_RETRIES;
      applyDecisions(reply);
    }).catch(function (err) {
      // Native unreachable: keep everything covered and retry.
      if (retriesLeft-- > 0) {
        setTimeout(function () { scheduleReport(); }, RETRY_MS);
      }
    });
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
    // detector can re-decide on fresh frames. In this prototype the verdict
    // stays REVIEW (no detector) and the element stays covered.
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
