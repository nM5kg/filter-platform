/**
 * detector.js — shared on-device person + face detector for the scanner.
 *
 * Used by scanner.js (live page scans) and test_person.js (labeled test
 * set) so both run the exact same detection code.
 *
 * Detectors (both run in a dedicated about:blank detector page, CPU-only,
 * all files bundled locally in models/ — no pixels and no model download
 * leave the machine at scan time):
 *
 *   1. PERSON (primary): MediaPipe Tasks Vision ObjectDetector,
 *      EfficientDet-Lite0 trained on COCO, category allowlist ['person'].
 *      This is a real person detector: it sees bodies without a visible
 *      face (back of head, distant figures, cropped bodies) where the
 *      face detector is blind. Code: @mediapipe/tasks-vision 1.2.3,
 *      Apache 2.0. Weights: efficientdet_lite0.tflite (float16),
 *      downloaded from Google's official MediaPipe model bucket
 *      (storage.googleapis.com/mediapipe-models/...); see
 *      models/LICENSES.md for the license findings.
 *   2. FACE (fallback + complement): face-api.js tinyFaceDetector
 *      (vladmandic fork 1.7.15, MIT), as in the v0.1.0 prototype.
 *      A person OR face hit counts as human. If the person model fails
 *      to load, the face detector still runs; if both fail, detect()
 *      throws and the caller must fail closed (uncertain -> REVIEW).
 *
 * A hit is a detection with score >= SCORE_FLOOR (0.40). The policy
 * threshold (0.70, standard-v1) is applied by the caller, exactly as
 * before: >= 0.70 -> person, 0.40-0.70 -> uncertain, none -> none.
 */
'use strict';

const path = require('path');

const MODELS_DIR = path.join(__dirname, 'models');
const PERSON_MODEL_NAME = 'MediaPipe ObjectDetector (EfficientDet-Lite0, COCO person class)';
const PERSON_MODEL_FILE = 'efficientdet_lite0.tflite';
const FACE_MODEL_NAME = 'face-api.js tinyFaceDetector (vladmandic fork 1.7.15)';
const SCORE_FLOOR = 0.40;
const MAX_PERSON_RESULTS = 10;

/**
 * Create a detector in a fresh about:blank page on the given Playwright
 * context. The context must already route https://scanner-models/* to the
 * local models/ directory (scanner.js does this; test_person.js does it
 * for its own context). `onRequestFailed` is an optional callback for
 * request-failure diagnostics (same shape as Playwright's requestfailed
 * event handler).
 *
 * Returns { info, detect, close }.
 *   info: { name, backend, loaded, person_model, person_loaded,
 *           face_model, face_loaded, error }
 *     loaded = at least one detector loaded (else the caller fails closed).
 *   detect({ src, dataUrl }) -> { persons, personBest, personBoxes,
 *     faces, faceBest } (throws if the image cannot be loaded or neither
 *     detector is available). personBoxes are in image pixels.
 *   close() closes the detector page.
 */
async function createDetector(context, onRequestFailed) {
  const info = {
    name: `${PERSON_MODEL_NAME} + ${FACE_MODEL_NAME}`,
    backend: 'cpu',
    loaded: false,
    person_model: PERSON_MODEL_NAME,
    person_loaded: false,
    face_model: FACE_MODEL_NAME,
    face_loaded: false,
    error: null,
  };
  const page = await context.newPage();
  if (onRequestFailed) page.on('requestfailed', onRequestFailed);

  // --- face-api.js (classic script) -------------------------------------
  await page.addScriptTag({ path: path.join(MODELS_DIR, 'face-api.js') });

  // --- MediaPipe Tasks Vision (ES module bundle) ------------------------
  // addScriptTag resolves before a module finishes executing, so the
  // module sets a flag and we wait for it below.
  await page.addScriptTag({
    type: 'module',
    content: `
      import { FilesetResolver, ObjectDetector } from 'https://scanner-models/tasks-vision/vision_bundle.mjs';
      window.__mp = { FilesetResolver, ObjectDetector };
      window.__mpReady = true;
    `,
  });

  // --- load both models; each in its own try/catch so one failure does
  // not take down the other. ----------------------------------------------
  const load = await page.evaluate(async ({ floor, maxResults }) => {
    const out = { face: null, person: null };
    // Face detector.
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri('https://scanner-models/');
      await faceapi.tf.setBackend('cpu');
      await faceapi.tf.ready();
      out.face = { backend: faceapi.tf.getBackend() };
    } catch (e) {
      out.face = { error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    // Person detector.
    try {
      if (!window.__mpReady || !window.__mp) throw new Error('tasks-vision module did not load');
      const vision = await window.__mp.FilesetResolver.forVisionTasks(
        'https://scanner-models/tasks-vision-wasm/',
      );
      window.__objectDetector = await window.__mp.ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://scanner-models/efficientdet_lite0.tflite',
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        scoreThreshold: floor,
        maxResults,
        categoryAllowlist: ['person'],
      });
      out.person = { loaded: true };
    } catch (e) {
      out.person = { error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
    return out;
  }, { floor: SCORE_FLOOR, maxResults: MAX_PERSON_RESULTS });

  if (load.face && !load.face.error) {
    info.face_loaded = true;
    info.backend = load.face.backend || 'cpu';
  }
  if (load.person && !load.person.error) info.person_loaded = true;
  info.loaded = info.face_loaded || info.person_loaded;
  const errors = [];
  if (load.face && load.face.error) errors.push(`face: ${load.face.error}`);
  if (load.person && load.person.error) errors.push(`person: ${load.person.error}`);
  if (errors.length) info.error = errors.join(' ; ').slice(0, 300);
  if (!info.loaded) {
    try { await page.close(); } catch {}
    throw new Error(`no detector loaded (${info.error || 'unknown error'})`);
  }
  // If the module script itself never ran, __mpReady is unset and the
  // person load above already recorded that error; nothing more to do.

  async function detect(input) {
    if (!info.loaded) throw new Error('detector not loaded');
    return page.evaluate(async ({ src, dataUrl, floor }) => {
      const loadImg = (s) => new Promise((resolve, reject) => {
        const im = new Image();
        if (!s.startsWith('data:')) im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('load failed / CORS'));
        im.src = s;
        setTimeout(() => reject(new Error('load timeout')), 8000);
      });
      const im = await loadImg(dataUrl || src);
      const result = { persons: 0, personBest: 0, personBoxes: [], faces: 0, faceBest: 0 };
      if (window.__objectDetector) {
        const od = window.__objectDetector.detect(im);
        for (const d of (od.detections || [])) {
          const cat = (d.categories || [])[0];
          const score = cat ? cat.score : 0;
          if (score < floor) continue;
          result.persons += 1;
          if (score > result.personBest) result.personBest = +score.toFixed(3);
          const b = d.boundingBox || {};
          result.personBoxes.push({
            x: Math.round(b.originX || 0), y: Math.round(b.originY || 0),
            w: Math.round(b.width || 0), h: Math.round(b.height || 0),
            score: +score.toFixed(3),
          });
        }
      }
      if (typeof faceapi !== 'undefined' && faceapi.nets.tinyFaceDetector.isLoaded) {
        const dets = await faceapi.detectAllFaces(
          im, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: floor }),
        );
        result.faces = dets.length;
        if (dets.length) result.faceBest = +Math.max(...dets.map((d) => d.score)).toFixed(3);
      }
      return result;
    }, { src: input.src || null, dataUrl: input.dataUrl || null, floor: SCORE_FLOOR });
  }

  async function close() {
    try { await page.close(); } catch {}
  }

  return { info, detect, close, page };
}

module.exports = { createDetector, MODELS_DIR, PERSON_MODEL_NAME, PERSON_MODEL_FILE, FACE_MODEL_NAME, SCORE_FLOOR };
