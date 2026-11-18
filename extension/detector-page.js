// Filter Platform — person detector host page (detector-page.js).
//
// Runs as an ES module inside detector.html, a hidden chrome-extension://
// iframe injected by detector.js. It owns the MediaPipe ObjectDetector
// (EfficientDet-Lite0, COCO `person` class) and answers detection
// requests from the content script over window.postMessage.
//
// ---------------------------------------------------------------------------
// PROTOTYPE-ONLY — EfficientDet-Lite0 weights license UNVERIFIED.
// The @mediapipe/tasks-vision runtime code is Apache 2.0, but the
// efficientdet_lite0.tflite WEIGHTS have no license stated by Google on
// its own docs page (checked 2026-11-18). Per Yakob's decision this model
// is for prototype / first testing ONLY — do NOT confirm it as the
// production model until the exact weights, hash, source and license are
// verified. Full trail: models-mediapipe/LICENSES.md (copied from
// scanner/models/LICENSES.md) and scanner/models/PRODUCTION-MODELS.md.
// ---------------------------------------------------------------------------
//
// All detection is on-device: the .tflite model, the tasks-vision bundle
// and the WASM runtime are bundled in this extension; no image data ever
// leaves the browser, and this page makes no network request except
// fetching those bundled extension files (chrome-extension:// URLs).
//
// Protocol (postMessage with the parent window = the content script):
//   in:  { type: 'fp-detector-warmup', id }            -> load models now
//   out: { type: 'fp-detector-ready', id } | { type: 'fp-detector-error', id, error }
//   in:  { type: 'fp-detect-person', id, dataUrl }     -> detect on the image
//   out: { type: 'fp-detect-result', id, persons, personBest, boxes }
//        | { type: 'fp-detect-result', id, error }
//   in:  { type: 'fp-fetch-image', id, url }           -> fetch image bytes
//   out: { type: 'fp-fetch-result', id, bytes }        -> ArrayBuffer
//        | { type: 'fp-fetch-result', id, error }
//   out (on load): { type: 'fp-detector-present' }     -> "this frame is alive"
// Replies go to event.source with targetOrigin event.origin (the page the
// content script runs on). The content script validates event.source /
// event.origin on its side; this page trusts nothing and only returns
// detection numbers.

'use strict';

const SCORE_FLOOR = 0.40; // same floor as scanner/detector.js
const MAX_PERSON_RESULTS = 10;
const PERSON_MODEL_NAME = 'MediaPipe ObjectDetector (EfficientDet-Lite0, COCO person class)';
const MAX_FETCH_BYTES = 8 * 1024 * 1024; // 8 MiB — same cap as content.js
const FETCH_TIMEOUT_MS = 15000;

let detectorPromise = null; // Promise<ObjectDetector>; null until first use
let detector = null;
let loadError = null;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('image load failed'));
    im.src = dataUrl;
    setTimeout(() => reject(new Error('image load timeout (8s)')), 8000);
  });
}

async function ensureDetector() {
  if (detector) return detector;
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    const t0 = Date.now();
    const stamp = (s) => console.log('[fp-detector] +' + (Date.now() - t0) + 'ms ' + s);
    // Dynamic import: the bundle is an ES module; importing it here (in
    // this extension page) keeps its WASM script-injection in this same
    // JS world, which is what MediaPipe's loader requires.
    const mp = await import('./vendor-mediapipe/tasks-vision/vision_bundle.mjs');
    stamp('vision bundle imported');
    // No trailing slash: the resolver appends '/vision_wasm_internal.js'.
    const vision = await mp.FilesetResolver.forVisionTasks(
      chrome.runtime.getURL('vendor-mediapipe/tasks-vision-wasm'),
    );
    stamp('fileset resolved');
    const od = await mp.ObjectDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL('models-mediapipe/efficientdet_lite0.tflite'),
        delegate: 'CPU',
      },
      runningMode: 'IMAGE',
      scoreThreshold: SCORE_FLOOR,
      maxResults: MAX_PERSON_RESULTS,
      categoryAllowlist: ['person'],
    });
    stamp('ObjectDetector created');
    detector = od;
    console.log('[fp-detector] person detector ready:', PERSON_MODEL_NAME);
    return od;
  })();
  try {
    return await detectorPromise;
  } catch (e) {
    loadError = String(e && e.message ? e.message : e).slice(0, 300);
    detectorPromise = null; // allow a later retry to try again
    console.warn('[fp-detector] person detector failed to load:', loadError);
    throw new Error(loadError);
  }
}

function reply(event, payload) {
  try {
    // event.source is the content script's window; event.origin is the
    // page origin the content script runs on. Reply exactly there.
    event.source.postMessage(payload, event.origin);
  } catch (e) {
    console.warn('[fp-detector] reply failed:', e);
  }
}

// Fetch one image's bytes from THIS extension page (v1.2.0).
//
// A content-script fetch is subject to the page's CORS rules, so it
// cannot read a no-CORS image — but this page is chrome-extension://
// origin, and with the extension's host_permissions (http://*/*
// https://*/*) its fetch is not CORS-gated. Same caps as the old
// content-script fetch: 8 MiB (Content-Length fast path + a streaming
// reader that aborts past the cap), 15 s timeout, image/*
// content-type, credentials omitted (no page cookies sent to the image
// host). Returns an ArrayBuffer. Throws on any failure — the caller
// fails closed (image stays uncertain -> covered).
async function fetchImageBytes(url) {
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
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_FETCH_BYTES) throw new Error('file too large (' + buf.byteLength + ' > ' + MAX_FETCH_BYTES + ')');
      return buf;
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
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  } finally {
    clearTimeout(timer);
  }
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'fp-detector-warmup') {
    try {
      await ensureDetector();
      reply(event, { type: 'fp-detector-ready', id: msg.id });
    } catch (e) {
      reply(event, { type: 'fp-detector-error', id: msg.id, error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
    return;
  }

  if (msg.type === 'fp-fetch-image') {
    try {
      if (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url)) {
        throw new Error('bad url');
      }
      const bytes = await fetchImageBytes(msg.url);
      reply(event, { type: 'fp-fetch-result', id: msg.id, bytes });
    } catch (e) {
      reply(event, { type: 'fp-fetch-result', id: msg.id, error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
    return;
  }

  if (msg.type === 'fp-detect-person') {
    try {
      const od = await ensureDetector();
      if (typeof msg.dataUrl !== 'string' || !msg.dataUrl.startsWith('data:image/')) {
        throw new Error('bad dataUrl');
      }
      const im = await loadImage(msg.dataUrl);
      const out = od.detect(im);
      const result = { persons: 0, personBest: 0, boxes: [] };
      for (const d of (out.detections || [])) {
        const cat = (d.categories || [])[0];
        const score = cat ? cat.score : 0;
        if (score < SCORE_FLOOR) continue;
        result.persons += 1;
        if (score > result.personBest) result.personBest = +score.toFixed(3);
        const b = d.boundingBox || {};
        result.boxes.push({
          x: Math.round(b.originX || 0), y: Math.round(b.originY || 0),
          w: Math.round(b.width || 0), h: Math.round(b.height || 0),
          score: +score.toFixed(3),
        });
      }
      reply(event, { type: 'fp-detect-result', id: msg.id, ...result });
    } catch (e) {
      reply(event, { type: 'fp-detect-result', id: msg.id, error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
    return;
  }
});

// Tell the content script this frame exists. The content script validates
// event.source (this iframe's window) and event.origin (chrome-extension://)
// before trusting anything from here.
try {
  window.parent.postMessage({ type: 'fp-detector-present' }, '*');
} catch (e) { /* parent gone already */ }
