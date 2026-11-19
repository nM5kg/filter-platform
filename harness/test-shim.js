// Regression guard for the 2026-11-19 shim breakage: the SHIM_JS string
// in web-browser-worker.js is a JS TEMPLATE LITERAL. `node --check` on
// the Worker file CANNOT catch errors inside it — a single backslash
// (\/ or \?) is consumed by the template literal, and a backtick in a
// comment ends the literal early. Either mistake ships a shim that
// fails to parse, so window.browser is never defined and the whole
// filter dies on every page (that is exactly what the Bug 2 redeploy
// did). This test evaluates the template literal the way the Worker
// runtime does and proves the resulting shim parses and decides
// correctly. Run: node harness/test-shim.js (exit 0 = OK).
//
// 2026-11-19 (review UI): decide() is now kind-aware and no-overcover.
// Decisions carry {id, verdict, reason} plus boxes (painted) and
// unscanned (allowed without a readable detection). See the rules
// block at the top of SHIM_JS in web-browser-worker.js.
const fs = require('fs');
const assert = require('node:assert');
const path = require('path');

const WORKER = path.join(__dirname, '..', 'web-browser-worker.js');
const src = fs.readFileSync(WORKER, 'utf8');
const marker = 'const SHIM_JS = `';
const start = src.indexOf(marker);
assert(start >= 0, 'SHIM_JS template literal not found');
const bodyStart = start + marker.length;
let i = bodyStart;
let raw = '';
while (i < src.length) {
  const c = src[i];
  if (c === '\\' && i + 1 < src.length) { raw += c + src[i + 1]; i += 2; continue; }
  if (c === '`') break;
  raw += c;
  i++;
}
assert(raw.length > 1000, 'SHIM_JS body suspiciously short: ' + raw.length);
assert(!raw.includes('`'), 'unescaped backtick inside SHIM_JS body');
// Evaluate exactly like the Worker runtime does.
const shim = eval('`' + raw + '`');
assert(
  shim.includes('var m = /\\/browse\\?u=([^&]+)/'),
  'evaluated shim lost the unwrap regex escaping'
);
let makeBrowser;
assert.doesNotThrow(() => {
  makeBrowser = new Function('window', shim + '\n;return window.browser;');
}, 'evaluated SHIM_JS must parse');
// Functional check: proxied sources unwrap to original URLs.
const posted = [];
const listeners = {};
const fakeWindow = {
  __fpProxy: { target: 'https://example.com/', apiCheck: 'ok' },
  parent: { postMessage: (m) => posted.push(m) },
  addEventListener: (type, fn) => { listeners[type] = fn; },
};
const browser = makeBrowser(fakeWindow);
assert.strictEqual(typeof listeners.message, 'function', 'shim registers a window message listener (fp-policy)');

const BOX = { x: 0.2, y: 0.1, w: 0.3, h: 0.6, score: 0.9 };

browser.runtime.sendMessage({ type: 'scan', pageUrl: 'https://example.com/', findings: [
  // (b) person confirmed -> cover
  { id: 'fp-1', kind: 'img', source: 'https://filter-platform-web-browser.gavhah-copy.workers.dev/browse?u=https%3A%2F%2Fexample.com%2Fperson.jpg', detected: true, persons: 1, personBest: 0.9, faces: 0, faceBest: 0 },
  // (c) detection ran, no person, best < 0.40 -> allow
  { id: 'fp-2', kind: 'img', source: 'https://filter-platform-web-browser.gavhah-copy.workers.dev/browse?u=https%3A%2F%2Fexample.com%2Fland.jpg', detected: true, persons: 0, personBest: 0.05, faces: 0, faceBest: 0 },
  // (a) cached review allow_painted -> painted, boxes ride along
  { id: 'fp-3', kind: 'img', source: 'https://example.com/reviewed.jpg', detected: true, persons: 1, personBest: 0.9, faces: 0, faceBest: 0, cachedDecision: { decision: 'allow_painted', boxes: [BOX] } },
  // (a) cached review uncertain -> cover
  { id: 'fp-4', kind: 'img', source: 'https://example.com/unclear.jpg', detected: true, persons: 0, personBest: 0.45, faces: 0, faceBest: 0, cachedDecision: { decision: 'uncertain', boxes: [] } },
  // (d) no detection at all, static kind -> allow, unscanned
  { id: 'fp-5', kind: 'img', source: 'https://example.com/unreadable.jpg', detected: false, persons: 0, personBest: 0, faces: 0, faceBest: 0, detectError: 'both failed' },
  // (d) no detection at all, dynamic kind -> cover (the ONE exception)
  { id: 'fp-6', kind: 'webgl', source: 'https://example.com/gl', detected: false, persons: 0, personBest: 0, faces: 0, faceBest: 0, detectError: 'canvas pixels unreadable' },
  // (b) weak but REAL person signal -> cover
  { id: 'fp-7', kind: 'img', source: 'https://example.com/weak.jpg', detected: true, persons: 1, personBest: 0.5, faces: 0, faceBest: 0 },
  // (c) detection ran, best >= 0.40, no persons/faces -> cover (uncertain signal)
  { id: 'fp-8', kind: 'img', source: 'https://example.com/odd.jpg', detected: true, persons: 0, personBest: 0.45, faces: 0, faceBest: 0 },
  // (a) cached review allow -> allow
  { id: 'fp-9', kind: 'img', source: 'https://example.com/ok.jpg', detected: true, persons: 0, personBest: 0.05, faces: 0, faceBest: 0, cachedDecision: { decision: 'allow', boxes: [] } },
  // (a) cached review block -> block
  { id: 'fp-10', kind: 'img', source: 'https://example.com/bad.jpg', detected: true, persons: 1, personBest: 0.95, faces: 0, faceBest: 0, cachedDecision: { decision: 'block', boxes: [BOX] } },
]}).then((res) => {
  assert.deepStrictEqual(res.decisions, [
    { id: 'fp-1', verdict: 'cover', reason: 'person' },
    { id: 'fp-2', verdict: 'allow', reason: 'no-person' },
    { id: 'fp-3', verdict: 'painted', reason: 'cached-review', boxes: [BOX] },
    { id: 'fp-4', verdict: 'cover', reason: 'cached-review' },
    { id: 'fp-5', verdict: 'allow', reason: 'no-signal-unscanned', unscanned: true },
    { id: 'fp-6', verdict: 'cover', reason: 'unreadable-dynamic' },
    { id: 'fp-7', verdict: 'cover', reason: 'weak-person-signal' },
    { id: 'fp-8', verdict: 'cover', reason: 'weak-signal' },
    { id: 'fp-9', verdict: 'allow', reason: 'cached-review' },
    { id: 'fp-10', verdict: 'block', reason: 'cached-review', boxes: [BOX] },
  ]);
  const st = posted.filter((p) => p.type === 'fp-status').pop();
  assert.strictEqual(st.verdicts['https://example.com/person.jpg'], 'cover');
  assert.strictEqual(st.verdicts['https://example.com/land.jpg'], 'allow');
  assert.strictEqual(st.verdicts['https://example.com/reviewed.jpg'], 'painted');
  assert.strictEqual(st.verdicts['https://example.com/bad.jpg'], 'block');
  assert.strictEqual(st.verdictsById['fp-1'], 'cover');
  assert.strictEqual(st.verdictsById['fp-2'], 'allow');
  assert.strictEqual(st.verdictsById['fp-3'], 'painted');
  assert.strictEqual(st.covered, 5);
  assert.strictEqual(st.allowed, 3);
  assert.strictEqual(st.blocked, 1);
  assert.strictEqual(st.painted, 1);
  assert.strictEqual(st.unscanned, 1);
  assert.strictEqual(st.scanned, 10);
  assert.strictEqual(st.humanImageMode, 'paint');
  // A review message must NEVER be decided by the shim.
  return browser.runtime.sendMessage({ type: 'review', id: 'fp-1', source: 'https://example.com/person.jpg', imageKey: 'u:abc' })
    .then((reply) => {
      assert.strictEqual(reply.type, 'review-unavailable');
      assert.strictEqual(reply.id, 'fp-1');
      // fp-policy from the parent shell switches the mode and re-posts status.
      listeners.message({ source: fakeWindow.parent, data: { type: 'fp-policy', humanImageMode: 'block' } });
      const st2 = posted.filter((p) => p.type === 'fp-status').pop();
      assert.strictEqual(st2.humanImageMode, 'block');
      // A policy message from anyone but the parent is ignored.
      listeners.message({ source: {}, data: { type: 'fp-policy', humanImageMode: 'paint' } });
      const st3 = posted.filter((p) => p.type === 'fp-status').pop();
      assert.strictEqual(st3.humanImageMode, 'block');
      // A review OUTCOME is recorded, not decided: content.js reports
      // it after the review, and the verdict maps + counts update live
      // (painted image stops reading 'cover' for status + downloads).
      return browser.runtime.sendMessage({ type: 'review-applied', id: 'fp-1',
        source: 'https://example.com/person.jpg', verdict: 'painted', boxes: [BOX] })
        .then((reply2) => {
          assert.strictEqual(reply2.type, 'review-applied-ok');
          const st4 = posted.filter((p) => p.type === 'fp-status').pop();
          assert.strictEqual(st4.verdictsById['fp-1'], 'painted');
          assert.strictEqual(st4.verdicts['https://example.com/person.jpg'], 'painted');
          assert.strictEqual(st4.painted, 2);
          assert.strictEqual(st4.covered, 4);
          assert.strictEqual(st4.scanned, 10);
          // An unknown verdict is ignored, never recorded.
          return browser.runtime.sendMessage({ type: 'review-applied', id: 'fp-2',
            source: 'https://example.com/land.jpg', verdict: 'banana' });
        })
        .then((reply3) => {
          assert.strictEqual(reply3.type, 'decisions');
          const st5 = posted.filter((p) => p.type === 'fp-status').pop();
          assert.strictEqual(st5.verdictsById['fp-2'], 'allow');
          console.log('shim tests: all passed (parses + unwraps + kind-aware decide + cached review + policy + review-applied)');
          process.exit(0); // the shim leaves a 120 s detector-ready timer running; exit explicitly
        });
    });
}).catch((e) => {
  console.error('shim test FAILED:', e);
  process.exit(1);
});
