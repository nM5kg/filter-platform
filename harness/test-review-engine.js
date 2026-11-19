// Local proof for the ONLINE REVIEW ENGINE (public/browser-assets/review.js).
// Node + Playwright (Chromium). Serves public/ from a local static server
// (plus scanner/testset/ under /testset/), loads review.js in a real page,
// runs RF-DETR Nano on the 16-photo set, and checks decisions + scores
// against scanner/models/rf-detr/results-nano.json (the Python benchmark).
//
// Run: node harness/test-review-engine.js   (exit 0 = all checks pass)
// Writes: harness/test-review-engine-results.json
//
// Required assertions (from the task):
//   - close-up portrait (p1) in paint mode -> 'block' (area rule, >0.60)
//   - a normal person photo (b2) in paint mode -> 'allow_painted',
//     and in block mode -> 'block'
//   - non-person photos -> 'allow' (best < 0.30)
//   - best scores close to the Python benchmark (tolerance 0.10; the
//     canvas-resize approximation may move borderline scores a hair)
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('node:assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TESTSET = path.join(ROOT, 'scanner', 'testset');
const BENCH = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'scanner', 'models', 'rf-detr', 'results-nano.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(
  path.join(TESTSET, 'manifest.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.mjs': 'text/javascript; charset=utf-8',
};

function serve(root, req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/review-test.html';
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || !fs.statSync(p).isDirectory() === false && !fs.existsSync(p)) {
    res.writeHead(404); res.end('not found'); return;
  }
  if (fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('dir'); return; }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>FpReview test</title>
<script src="/browser-assets/review.js"></script></head>
<body><h1>FpReview test page</h1></body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/review-test.html' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
      return;
    }
    if (req.url.startsWith('/testset/')) {
      serve(TESTSET, { url: req.url.slice('/testset'.length) || '/' }, res);
      return;
    }
    serve(PUBLIC, req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log('serving public/ at', base);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const results = { firstLoad: null, cachedLoad: null, perImage: [], checks: [] };
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text()); });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
    await page.goto(base + '/review-test.html', { waitUntil: 'load' });
    assert.strictEqual(await page.evaluate(() => typeof window.FpReview), 'object', 'FpReview missing');
    assert.strictEqual(await page.evaluate(() => window.FpReview.isReady()), false, 'should start unready');

    // --- First load: ort + 116 MB model from local files ----------------
    const first = await page.evaluate(async () => {
      const phases = [];
      const t0 = performance.now();
      const r = await window.FpReview.ensure((phase, loaded, total) => {
        phases.push([phase, loaded, total]);
      });
      return { ...r, wallMs: Math.round(performance.now() - t0), phases: phases.slice(0, 3).concat(phases.slice(-3)) };
    });
    results.firstLoad = first;
    console.log('FIRST LOAD:', JSON.stringify(first));
    assert.strictEqual(first.ready, true, 'ensure must resolve ready');
    assert.strictEqual(first.fromCache, false, 'first load must not be from cache');
    assert.strictEqual(first.modelBytes, 116607449, 'modelBytes');
    assert.strictEqual(await page.evaluate(() => window.FpReview.isReady()), true, 'isReady after ensure');

    // --- Run all 16 photos (paint mode + block mode) --------------------
    for (const entry of MANIFEST.images) {
      const expected = BENCH.per_photo[entry.id];
      const row = { id: entry.id, file: entry.file, truth: entry.person_present, expectedBest: expected.best_person_score };
      for (const mode of ['paint', 'block']) {
        const out = await page.evaluate(async ({ file, mode }) => {
          const resp = await fetch('/testset/' + file);
          const buf = await resp.arrayBuffer();
          return window.FpReview.review(buf, mode);
        }, { file: entry.file, mode });
        row[mode] = { decision: out.decision, best: +out.best.toFixed(3), boxes: out.boxes, inferMs: out.inferMs, contentHash: out.contentHash.slice(0, 12) + '…' };
        assert.ok(out.contentHash.startsWith('b:'), 'contentHash prefix');
        assert.strictEqual(out.model, 'rf-detr-nano', 'model tag');
      }
      row.bestDiff = +(row.paint.best - expected.best_person_score).toFixed(3);
      results.perImage.push(row);
      console.log(`${row.id.padEnd(18)} truth=${String(row.truth).padEnd(5)} paint=${row.paint.decision.padEnd(13)} block=${row.block.decision.padEnd(6)} best=${row.paint.best} (bench ${expected.best_person_score.toFixed(3)}, diff ${row.bestDiff >= 0 ? '+' : ''}${row.bestDiff}) infer=${row.paint.inferMs}ms boxes=${row.paint.boxes.length}`);
    }

    // --- Required decision assertions ------------------------------------
    const byId = Object.fromEntries(results.perImage.map((r) => [r.id, r]));
    function check(name, cond, detail) {
      results.checks.push({ name, pass: !!cond, detail: detail || '' });
      console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
      assert.ok(cond, 'FAILED: ' + name + ' — ' + (detail || ''));
    }
    check('p1 portrait paint -> block (area rule)',
      byId['p1-huang-portrait'].paint.decision === 'block',
      'got ' + byId['p1-huang-portrait'].paint.decision +
      ', largest box area ' + (byId['p1-huang-portrait'].paint.boxes[0] ?
        (byId['p1-huang-portrait'].paint.boxes[0].w * byId['p1-huang-portrait'].paint.boxes[0].h).toFixed(3) : 'n/a'));
    check('p1 portrait block mode -> block',
      byId['p1-huang-portrait'].block.decision === 'block',
      'got ' + byId['p1-huang-portrait'].block.decision);
    check('b2 normal person paint -> allow_painted',
      byId['b2-behind-back'].paint.decision === 'allow_painted',
      'got ' + byId['b2-behind-back'].paint.decision + ', best ' + byId['b2-behind-back'].paint.best);
    check('b2 normal person block mode -> block',
      byId['b2-behind-back'].block.decision === 'block',
      'got ' + byId['b2-behind-back'].block.decision);
    for (const id of ['a1-dog-running', 'a2-dog-stream', 'l1-glacier-lake', 'l2-mountain-lake', 'o1-vintage-camera']) {
      check(id + ' non-person -> allow',
        byId[id].paint.decision === 'allow',
        'got ' + byId[id].paint.decision + ', best ' + byId[id].paint.best);
    }
    // Accuracy vs benchmark: person photos must be confirmed (>=0.50) in
    // paint mode except possibly the known borderline d3 (bench 0.568);
    // every person photo must at least be >= 0.30 (not 'allow').
    let confirmed = 0, missed = [];
    for (const r of results.perImage) {
      if (!r.truth) continue;
      if (r.paint.best >= 0.50) confirmed++;
      else missed.push(r.id + ' best=' + r.paint.best);
    }
    check('person photos confirmed >=0.50: 11/11 (bench recall 1.000)',
      confirmed === 11, confirmed + '/11 confirmed; below 0.50: ' + (missed.join(', ') || 'none'));
    let maxDiff = 0;
    for (const r of results.perImage) maxDiff = Math.max(maxDiff, Math.abs(r.bestDiff));
    check('best scores within 0.10 of Python benchmark',
      maxDiff <= 0.10, 'max |diff| = ' + maxDiff.toFixed(3));

    // --- Blob + HTMLImageElement sources ---------------------------------
    const alt = await page.evaluate(async () => {
      const resp = await fetch('/testset/b2-behind-back.jpg');
      const blob = await resp.blob();
      const a = await window.FpReview.review(blob, 'paint');
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = '/testset/b2-behind-back.jpg'; });
      const b = await window.FpReview.review(img, 'paint');
      return { blobDecision: a.decision, blobBest: +a.best.toFixed(3), imgDecision: b.decision, imgBest: +b.best.toFixed(3) };
    });
    results.altSources = alt;
    check('Blob source works', alt.blobDecision === 'allow_painted', JSON.stringify(alt));
    check('HTMLImageElement source works', alt.imgDecision === 'allow_painted', JSON.stringify(alt));

    // --- Cached load: reload the SAME page (same browser context, so
    //     IndexedDB persists; a fresh browser.newPage() would be a new
    //     incognito context with an empty IDB). Model must come from IDB.
    await page.reload({ waitUntil: 'load' });
    const cached = await page.evaluate(async () => {
      const t0 = performance.now();
      const r = await window.FpReview.ensure();
      return { ...r, wallMs: Math.round(performance.now() - t0) };
    });
    results.cachedLoad = cached;
    console.log('CACHED LOAD:', JSON.stringify(cached));
    check('cached load fromCache=true', cached.fromCache === true, JSON.stringify(cached));
    check('cached load much faster than first load', cached.wallMs < first.wallMs, cached.wallMs + 'ms vs ' + first.wallMs + 'ms');
    const cachedReview = await page.evaluate(async () => {
      const resp = await fetch('/testset/p2-khrushchev-portrait.jpg');
      return window.FpReview.review(await resp.arrayBuffer(), 'paint');
    });
    check('review works after cached load', cachedReview.decision === 'block', cachedReview.decision);

    const infer = results.perImage.map((r) => r.paint.inferMs);
    results.summary = {
      inferMsMean: Math.round(infer.reduce((a, b) => a + b, 0) / infer.length),
      inferMsMax: Math.max(...infer),
      firstLoadMs: first.wallMs, cachedLoadMs: cached.wallMs,
    };
    console.log('SUMMARY:', JSON.stringify(results.summary));
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(__dirname, 'test-review-engine-results.json'),
    JSON.stringify(results, null, 2) + '\n');
  console.log('wrote harness/test-review-engine-results.json');
  console.log('ALL REVIEW-ENGINE CHECKS PASSED');
}

main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
