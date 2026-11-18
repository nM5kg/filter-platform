/**
 * test_person.js — labeled test-set harness for the person detector.
 *
 *   node test_person.js [--manifest testset/manifest.json] [--out testset/results.json]
 *
 * Runs the SAME detector as the live scanner (detector.js: MediaPipe
 * ObjectDetector EfficientDet-Lite0 person class + face-api.js
 * tinyFaceDetector fallback) over every image in testset/manifest.json
 * (real Wikimedia Commons photos, ground truth verified by eye) and
 * writes per-image results plus precision/recall.
 *
 * Scoring (policy threshold 0.70, score floor 0.40):
 *   predicted-positive = detection 'person' (best score >= 0.70)
 *   'uncertain' (0.40-0.70) is NOT a positive, but it is NOT a miss to
 *   ALLOW either — uncertain stays covered on the device. The safety
 *   metric is therefore reported separately: "missed to ALLOW" =
 *   person present but detection 'none'. A 'none' on a no-person image
 *   is a true negative; a 'person' on a no-person image is a false
 *   positive. Precision/recall are computed on the 'person' verdict
 *   only, and the uncertain count is shown alongside so the numbers
 *   cannot be read as better than they are.
 *
 * Sandbox networking: the detector page loads its models from local
 * disk via the https://scanner-models/ route (same as scanner.js).
 * Test images are read from local disk and passed as data URLs, so no
 * network is needed at all for the images themselves. The egress relay
 * proxy / SPKI pin env vars are honoured for Chromium launch parity
 * with scanner.js, but nothing is fetched through them here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createDetector, MODELS_DIR } = require('./detector');

const POLICY_THRESHOLD = 0.70;

function serveModelFile(route, reqUrl) {
  const file = decodeURIComponent(reqUrl.split('/scanner-models/')[1] || '');
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(MODELS_DIR, safe);
  if (!full.startsWith(MODELS_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return route.abort('failed');
  }
  const ext = path.extname(full);
  const type = ext === '.json' ? 'application/json'
    : ext === '.js' || ext === '.mjs' ? 'text/javascript'
    : ext === '.wasm' ? 'application/wasm'
    : 'application/octet-stream';
  return route.fulfill({ body: fs.readFileSync(full), contentType: type });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name, dflt) => {
    const eq = args.find((x) => x.startsWith(`--${name}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    const i = args.indexOf(`--${name}`);
    if (i !== -1 && args[i + 1]) return args[i + 1];
    return dflt;
  };
  const manifestPath = path.resolve(get('manifest', path.join(__dirname, 'testset', 'manifest.json')));
  const outPath = path.resolve(get('out', path.join(__dirname, 'testset', 'results.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dir = path.dirname(manifestPath);

  const launchArgs = [];
  if (typeof process.getuid === 'function' && process.getuid() === 0) launchArgs.push('--no-sandbox');
  const spkiPin = process.env.SCANNER_TLS_SPKI_PIN || null;
  if (spkiPin) launchArgs.push(`--ignore-certificate-errors-spki-list=${spkiPin}`);
  const launchOpts = { args: launchArgs };
  const proxy = process.env.SCANNER_PROXY || null;
  if (proxy) launchOpts.proxy = { server: proxy };

  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith('https://scanner-models/')) return serveModelFile(route, reqUrl);
      return route.abort('blockedbyclient');
    });
    const t0 = Date.now();
    const { info, detect, close } = await createDetector(context);
    const loadMs = Date.now() - t0;
    console.log(`[test] detector: person_loaded=${info.person_loaded} face_loaded=${info.face_loaded} backend=${info.backend} load_ms=${loadMs}${info.error ? ` error=${info.error}` : ''}`);

    const results = [];
    for (const item of manifest.images) {
      if (item.missing) { results.push({ ...item, skipped: true, reason: 'file missing (download blocked by Wikimedia 429)' }); continue; }
      const file = path.join(dir, item.file);
      if (!fs.existsSync(file)) { results.push({ ...item, skipped: true, reason: 'file not found on disk' }); continue; }
      const buf = fs.readFileSync(file);
      const mime = item.file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      const start = Date.now();
      let r;
      let error = null;
      try {
        r = await Promise.race([
          detect({ dataUrl }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('detect timed out after 25s')), 25_000)),
        ]);
      } catch (e) { error = String(e.message).slice(0, 140); }
      const ms = Date.now() - start;
      if (error) {
        results.push({ ...item, detection: 'uncertain', confidence: 0, error, detect_ms: ms });
        console.log(`[test] ${item.id}: ERROR ${error}`);
        continue;
      }
      const best = Math.max(r.personBest || 0, r.faceBest || 0);
      const detection = best >= POLICY_THRESHOLD ? 'person' : (r.persons > 0 || r.faces > 0) ? 'uncertain' : 'none';
      const detectedBy = (r.persons > 0 && r.faces > 0) ? 'person+face' : r.persons > 0 ? 'person' : r.faces > 0 ? 'face' : null;
      results.push({
        ...item,
        detection, confidence: best, detected_by: detectedBy,
        persons: r.persons, person_best: r.personBest, person_boxes: r.personBoxes,
        faces: r.faces, face_best: r.faceBest, detect_ms: ms,
      });
      console.log(`[test] ${item.id}: ${detection} conf=${best} via=${detectedBy || '-'} persons=${r.persons} (best ${r.personBest}) faces=${r.faces} (best ${r.faceBest}) ${ms}ms | truth=${item.person_present ? `person${item.count ? ` x${item.count}` : ''}` : 'none'}`);
    }
    await close();

    // ---- metrics (on the 'person' verdict; uncertain shown separately) --
    const ran = results.filter((r) => !r.skipped);
    let tp = 0, fp = 0, fn = 0, tn = 0, uncertainPos = 0, uncertainNeg = 0, missedToAllow = 0;
    for (const r of ran) {
      if (r.detection === 'person' && r.person_present) tp++;
      else if (r.detection === 'person' && !r.person_present) fp++;
      else if (r.detection === 'uncertain' && r.person_present) { fn++; uncertainPos++; }
      else if (r.detection === 'uncertain' && !r.person_present) { uncertainNeg++; }
      else if (r.detection === 'none' && r.person_present) { fn++; missedToAllow++; }
      else tn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const totalMs = ran.reduce((a, r) => a + (r.detect_ms || 0), 0);
    const metrics = {
      n: ran.length, skipped: results.length - ran.length,
      tp, fp, fn, tn,
      precision: precision === null ? null : +precision.toFixed(3),
      recall: recall === null ? null : +recall.toFixed(3),
      uncertain_person_images: uncertainPos,
      uncertain_no_person_images: uncertainNeg,
      missed_to_allow: missedToAllow,
      mean_detect_ms: ran.length ? +(totalMs / ran.length).toFixed(0) : null,
      median_detect_ms: ran.length ? [...ran].map((r) => r.detect_ms).sort((a, b) => a - b)[Math.floor(ran.length / 2)] : null,
    };
    console.log(`[test] METRICS n=${metrics.n} TP=${tp} FP=${fp} FN=${fn} TN=${tn} precision=${metrics.precision} recall=${metrics.recall} uncertain(person)=${uncertainPos} uncertain(no-person)=${uncertainNeg} missed_to_allow=${missedToAllow} mean_ms=${metrics.mean_detect_ms} median_ms=${metrics.median_detect_ms}`);
    const out = {
      generated: new Date().toISOString(),
      detector: info,
      detector_load_ms: loadMs,
      policy_threshold: POLICY_THRESHOLD,
      score_floor: 0.40,
      metrics,
      results,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`[test] wrote ${outPath}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
