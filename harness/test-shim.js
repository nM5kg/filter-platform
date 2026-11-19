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
const fakeWindow = {
  __fpProxy: { target: 'https://example.com/', apiCheck: 'ok' },
  parent: { postMessage: (m) => posted.push(m) },
};
const browser = makeBrowser(fakeWindow);
browser.runtime.sendMessage({ type: 'scan', pageUrl: 'https://example.com/', findings: [
  { id: 'fp-1', kind: 'img', source: 'https://filter-platform-web-browser.gavhah-copy.workers.dev/browse?u=https%3A%2F%2Fexample.com%2Fperson.jpg', detected: true, persons: 1, personBest: 0.9, faces: 0, faceBest: 0 },
  { id: 'fp-2', kind: 'img', source: 'https://filter-platform-web-browser.gavhah-copy.workers.dev/browse?u=https%3A%2F%2Fexample.com%2Fland.jpg', detected: true, persons: 0, personBest: 0.05, faces: 0, faceBest: 0 },
]}).then((res) => {
  assert.deepStrictEqual(res.decisions, [
    { id: 'fp-1', verdict: 'cover' },
    { id: 'fp-2', verdict: 'allow' },
  ]);
  const st = posted.filter((p) => p.type === 'fp-status').pop();
  assert.strictEqual(st.verdicts['https://example.com/person.jpg'], 'cover');
  assert.strictEqual(st.verdicts['https://example.com/land.jpg'], 'allow');
  assert.strictEqual(st.verdictsById['fp-1'], 'cover');
  assert.strictEqual(st.verdictsById['fp-2'], 'allow');
  assert.strictEqual(st.covered, 1);
  assert.strictEqual(st.allowed, 1);
  console.log('shim tests: all passed (parses + unwraps + decides)');
}).catch((e) => {
  console.error('shim test FAILED:', e);
  process.exit(1);
});
