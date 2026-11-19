// Review-UI harness: drives the REAL content.js in Chromium against
// STUBBED first-stage decisions and a STUBBED FpReview / native review,
// proving the request button + paint overlays + no-overcover behaviour
// end to end in the DOM. The stubs stand in for the real RF-DETR engine
// (sibling A) and the native Android review (sibling E) — this harness
// proves the UI wiring, not the model itself.
//
// Run: node harness/test-review-ui.js (exit 0 = OK). Serves public/
// on a local static server; nothing is deployed.
'use strict';
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../public/browser-core.js');
const { chromium } = require('playwright');

let n = 0;
function check(cond, label) { n++; assert.ok(cond, label); }
function eq(a, b, label) { n++; assert.strictEqual(a, b, label); }

// ---- (vi) decideDownload('painted') is blocked (node-side, first) ----
assert.deepStrictEqual(
  core.decideDownload('https://example.com/photo.jpg', [], 'painted'),
  { allowed: false, reason: 'verdict-painted' },
  'decideDownload painted -> blocked'
);
n++;

// 1x1 PNGs (distinct bytes; the stub shim decides by source URL).
const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GREEN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BLUE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
const WHITE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function fixturePage(mode) {
  const fpReviewStub = mode === 'web' ? `
<script>
window.__fpReviewCalls = [];
window.__fpStubDecision = 'allow_painted';
window.__fpStubMode = null;
window.FpReview = {
  isReady: function () { return true; },
  ensure: async function (cb) { if (cb) cb(0.5); if (cb) cb(1); },
  review: async function (bytes, m) {
    window.__fpStubMode = m;
    window.__fpReviewCalls.push(m);
    return { decision: window.__fpStubDecision,
      boxes: [{ x: 0.2, y: 0.1, w: 0.3, h: 0.6, score: 0.9 }],
      best: 0.9, model: 'rf-detr-nano', inferMs: 12,
      contentHash: 'b:hash-' + window.__fpStubDecision };
  }
};
</script>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<style>img{width:200px;height:150px;display:block;margin:0}</style></head><body>
<img id="img-painted" src="${RED}">
<img id="img-allow" src="${GREEN}">
<img id="img-uncertain" src="${BLUE}">
<img id="img-land" src="${WHITE}">
${mode === 'web' ? '<img id="img-slow" src="/slow.png">' : ''}
<div style="height:2000px"></div>
<script>
window.__fpStubDecision = 'allow_painted';
window.__fpVerdicts = {};
window.__fpVerdicts['${RED}'] = 'cover';
window.__fpVerdicts['${GREEN}'] = 'cover';
window.__fpVerdicts['${BLUE}'] = 'cover';
window.__fpVerdicts['${WHITE}'] = 'allow';
window.browser = { runtime: {
  getURL: function (p) { return '/browser-assets/' + p; },
  sendMessage: function (msg) {
    if (msg && msg.type === 'scan') {
      var decisions = (msg.findings || []).map(function (f) {
        var v = window.__fpVerdicts[f.source] || 'cover';
        if ((f.source || '').indexOf('/slow.png') !== -1) v = 'allow';
        return { id: f.id, verdict: v };
      });
      return Promise.resolve({ type: 'decisions', decisions: decisions });
    }
    if (msg && msg.type === 'review') {
      return Promise.resolve({ type: 'review-decision', id: msg.id,
        decision: window.__fpStubDecision,
        boxes: [{ x: 0.2, y: 0.1, w: 0.3, h: 0.6, score: 0.9 }],
        best: 0.9, model: 'native-rf-detr', reason: 'stub' });
    }
    return Promise.resolve({ type: 'decisions', decisions: [] });
  }
} };
</script>
${fpReviewStub}
<script>
// Record messages content.js posts to its parent (proves it asks for
// the policy on boot — the shell answers 'fp-policy-request').
window.__fpPostedToParent = [];
(function () {
  var orig = window.postMessage.bind(window);
  window.postMessage = function (m, t) {
    try { if (m && m.type) window.__fpPostedToParent.push(m.type); } catch (e) {}
    return orig(m, t);
  };
})();
</script>
<script src="/browser-assets/content.js"></script>
</body></html>`;
}

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png' };
let reviewPosts = 0;
let lastReviewPost = null; // last parsed POST body (shape-checked below)

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/fixture-web.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixturePage('web'));
    return;
  }
  if (u.pathname === '/fixture-native.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixturePage('native'));
    return;
  }
  if (u.pathname === '/slow.png') {
    // Deliberately slow (3 s): the first scan must NOT decide this
    // image before its bytes arrive (deferral — it stays covered until
    // the load event re-triggers a report).
    setTimeout(() => {
      const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
      res.end(buf);
    }, 3000);
    return;
  }
  if (u.pathname === '/review-decision') {
    // Deliberately FAIL (500): the UI decision must stand anyway.
    if (req.method === 'POST') reviewPosts++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { lastReviewPost = JSON.parse(body); } catch (e) { lastReviewPost = null; }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub api down' }));
    });
    return;
  }
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function closeEnough(a, b, tol) { return Math.abs(a - b) <= tol; }

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });

    // ---- WEB path (window.FpReview stub) ----
    await page.goto(base + '/fixture-web.html');
    // (i) person images covered + request button visible; land allowed.
    // Four overlays: red/green/blue + the slow image, which is covered
    // (deferred — its bytes have not arrived yet) rather than decided.
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-overlay]').length === 4, null, { timeout: 15000 });
    eq(await page.locator('[data-fp-review-btn]').count(), 4, '(i) four request buttons on covered images');
    eq(await page.locator('[data-fp-review-btn]').first().textContent(), 'בעטן אַ באַשלוס', '(i) request button label is Yiddish');
    // (v) non-human image with no detection signal is left visible.
    const landVisible = await page.evaluate(() => {
      const img = document.getElementById('img-land');
      const cs = getComputedStyle(img);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    });
    check(landVisible, '(v) non-human image left visible (no overlay, no cover)');
    const landBtn = await page.locator('[data-fp-download]').count();
    check(landBtn >= 1, '(v) allowed image gets a download button');
    // (i-b) content.js asks the shell for the policy on boot: the
    // shell's posts at navigation / fp-loaded arrive before content.js
    // registers its listener, so without this ask a reloaded tab would
    // review in the default 'paint' mode even when set to 'block'.
    check((await page.evaluate(() => window.__fpPostedToParent || [])).indexOf('fp-policy-request') !== -1,
      '(i-b) content.js posts fp-policy-request on boot');
    // (i-c) deferral: the slow image is covered (not decided) while its
    // bytes are still in flight — only the allowed land image has a
    // download button yet. Once it loads, the load listener re-reports
    // it and the stub allows it (second download button appears).
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-download]').length >= 1, null, { timeout: 15000 });
    eq(await page.locator('[data-fp-download]').count(), 1, '(i-c) slow image has no download button before its bytes arrive');
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-download]').length === 2, null, { timeout: 15000 });
    check(true, '(i-c) slow image re-checked after loading and allowed');

    // (ii) allow_painted: click the first request button (red image) with
    // the policy set to block — the review must receive the mode.
    await page.evaluate(() => { window.__fpStubDecision = 'allow_painted'; });
    await page.evaluate(() => window.postMessage({ type: 'fp-policy', humanImageMode: 'block' }, '*'));
    await page.locator('[data-fp-review-btn]').nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-paint]').length === 1, null, { timeout: 15000 });
    eq(await page.evaluate(() => window.__fpStubMode), 'block', '(ii) review received the fp-policy mode');
    const paintBox = await page.evaluate(() => {
      const img = document.getElementById('img-painted').getBoundingClientRect();
      const o = document.querySelector('[data-fp-paint]').getBoundingClientRect();
      return { img: { x: img.x, y: img.y, w: img.width, h: img.height }, o: { x: o.x, y: o.y, w: o.width, h: o.height } };
    });
    check(closeEnough(paintBox.o.x, paintBox.img.x + 0.2 * paintBox.img.w, 3), '(ii) paint overlay left matches box fraction');
    check(closeEnough(paintBox.o.y, paintBox.img.y + 0.1 * paintBox.img.h, 3), '(ii) paint overlay top matches box fraction');
    check(closeEnough(paintBox.o.w, 0.3 * paintBox.img.w, 3), '(ii) paint overlay width matches box fraction');
    check(closeEnough(paintBox.o.h, 0.6 * paintBox.img.h, 3), '(ii) paint overlay height matches box fraction');
    const tag = await page.locator('[data-fp-paint]').first().textContent();
    check(tag.includes('געמאָלט'), '(ii) paint overlay carries the געמאָלט tag');
    const redVisible = await page.evaluate(() => getComputedStyle(document.getElementById('img-painted')).visibility !== 'hidden');
    check(redVisible, '(ii) painted image itself stays visible');
    check(reviewPosts >= 1, '(ii) review POST attempted even though the stub API returns 500');

    // Paint overlays survive scroll/resize (repositioned with the image).
    await page.evaluate(() => window.scrollTo(0, 100));
    await page.waitForTimeout(300);
    const afterScroll = await page.evaluate(() => {
      const img = document.getElementById('img-painted').getBoundingClientRect();
      const o = document.querySelector('[data-fp-paint]').getBoundingClientRect();
      return { scrollY: window.scrollY, imgY: img.y, oY: o.y, dx: Math.abs(o.x - (img.x + 0.2 * img.width)), dy: Math.abs(o.y - (img.y + 0.1 * img.height)) };
    });
    check(afterScroll.dx <= 3 && afterScroll.dy <= 3, '(ii) paint overlay follows the image on scroll');
    await page.evaluate(() => window.scrollTo(0, 0));

    // (iii) allow: the green image uncovers and gets a download button.
    await page.evaluate(() => { window.__fpStubDecision = 'allow'; });
    await page.locator('[data-fp-review-btn]').nth(0).click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('img-allow')).visibility !== 'hidden', null, { timeout: 15000 });
    eq(await page.locator('[data-fp-overlay]').count(), 1, '(iii) only the uncertain image is still covered');
    check(await page.locator('[data-fp-download]').count() >= 2, '(iii) allowed image gets a download button');

    // (iv) uncertain: stays covered, button says so.
    await page.evaluate(() => { window.__fpStubDecision = 'uncertain'; });
    await page.locator('[data-fp-review-btn]').nth(0).click();
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-fp-review-btn]');
      return b && b.textContent.indexOf('נאָך אומבאַקאַנט') !== -1;
    }, null, { timeout: 15000 });
    eq(await page.locator('[data-fp-overlay]').count(), 1, '(iv) uncertain image stays covered');
    const blueHidden = await page.evaluate(() => getComputedStyle(document.getElementById('img-uncertain')).visibility === 'hidden');
    check(blueHidden, '(iv) uncertain image still hidden');

    // Local cache: one entry per review outcome (keyed by content hash).
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('fp_review_decisions_v1') || '{}'));
    eq(cache['b:hash-allow_painted'].decision, 'allow_painted', 'cache: painted review stored under b: key');
    eq(cache['b:hash-allow'].decision, 'allow', 'cache: allow review stored under b: key');
    eq(cache['b:hash-uncertain'].decision, 'uncertain', 'cache: uncertain review stored under b: key');
    check(reviewPosts >= 3, 'web path POSTed each review decision (fire-and-forget, 500 tolerated)');
    // The live API rejects a string first_detector (400) and a 'b:b:'
    // image_key is a dead key — the POST body shape is part of the
    // contract (found live 2026-11-19: every web POST was 400).
    check(lastReviewPost && typeof lastReviewPost.first_detector === 'object' && lastReviewPost.first_detector !== null,
      'POST first_detector is an object (API rejects a string)');
    check(lastReviewPost && typeof lastReviewPost.first_detector.detector === 'string',
      'POST first_detector.detector names the first-stage detector');
    check(lastReviewPost && typeof lastReviewPost.first_detector.persons === 'number' &&
      typeof lastReviewPost.first_detector.personBest === 'number' &&
      typeof lastReviewPost.first_detector.faces === 'number' &&
      typeof lastReviewPost.first_detector.faceBest === 'number' &&
      typeof lastReviewPost.first_detector.detected === 'boolean',
      'POST first_detector carries the first-stage signal numbers');
    check(lastReviewPost && typeof lastReviewPost.image_key === 'string' && lastReviewPost.image_key.indexOf('b:b:') !== 0,
      'POST image_key has no doubled b:b: prefix');

    // ---- NATIVE path (no FpReview; review via sendMessage) ----
    reviewPosts = 0;
    await page.goto(base + '/fixture-native.html');
    eq(await page.evaluate(() => typeof window.FpReview), 'undefined', 'native: no FpReview on the app path');
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-overlay]').length === 3, null, { timeout: 15000 });
    await page.evaluate(() => { window.__fpStubDecision = 'allow_painted'; });
    await page.locator('[data-fp-review-btn]').nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-fp-paint]').length === 1, null, { timeout: 15000 });
    check(true, 'native: review via sendMessage paints the person box');
    eq(reviewPosts, 0, 'native: no web POST — the native side records the decision');

    console.log(`review-ui tests: ${n} assertions passed (web FpReview path + native sendMessage path)`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('review-ui test FAILED:', e);
  server.close();
  process.exit(1);
});
