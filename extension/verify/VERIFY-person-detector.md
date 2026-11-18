# Person detector in the extension — verification (v1.1.0, 2026-11-18)

Port of the scanner's MediaPipe ObjectDetector (EfficientDet-Lite0,
COCO `person`) into the MV3 extension. Person OR face = human;
face-api.js stays as fallback/complement; both failing on an image
means uncertain → COVERED (fail closed).

## What was built

| File | What it is |
|---|---|
| `detector.html` | Hidden `chrome-extension://` iframe hosting the detector (extension-origin page). Only new file in `web_accessible_resources`. |
| `detector-page.js` | ES module in the iframe: imports the tasks-vision bundle, creates the `ObjectDetector`, answers `postMessage` detection requests. |
| `detector.js` | Content-script bridge: injects the iframe lazily on first scan, warmup + per-image requests, downscales images to JPEG data URLs (max 960 px). |
| `vendor-mediapipe/tasks-vision/vision_bundle.mjs` | `@mediapipe/tasks-vision` 1.2.3 (Apache 2.0), copied from `scanner/models/`. |
| `vendor-mediapipe/tasks-vision-wasm/` | MediaPipe vision WASM runtime (`.js` + 14.6 MB `.wasm`), copied from `scanner/models/`. |
| `models-mediapipe/efficientdet_lite0.tflite` | EfficientDet-Lite0 weights, 7,254,339 bytes, SHA-256 `4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993` — same file + hash as the scanner. **PROTOTYPE-ONLY: weights license UNVERIFIED** (see `models-mediapipe/LICENSES.md`). |
| `models-mediapipe/LICENSES.md` | Copied verbatim from `scanner/models/LICENSES.md`. |
| `content.js` | Combined person+face detection, fail-closed cover for uncertain, `personHits` stat, `data-fp-person-ready`. |
| `manifest.json` | `detector.js` added to content scripts, `detector.html` added to WAR, `content_security_policy.extension_pages` with `'wasm-unsafe-eval'` (see Bugs below), version 1.1.0. `background.js`, `popup.js`, `blocked.html` untouched. |
| `harness/verify-phase2-person.js` | This verification's harness (test page + 16-photo set + request audit). |

Why an iframe: MediaPipe's loader injects its WASM runtime as a
classic `<script>` into `document.body`, so the bundle and the WASM
loader must share one JS world — a content script's isolated world
cannot do that. The hidden extension-origin iframe is that world
(same arrangement as the scanner's dedicated detector page). The
offscreen-document alternative would have needed a `background.js`
change, which was out of scope.

## Verification method

`harness/verify-phase2-person.js [block|cover]` — Playwright 1.65.1,
headless Chrome 159, unpacked extension, local test servers only
(test page :8123, photos :8124, test set :8125). No API token: only
`fpDemoMode` is seeded via the real popup page; mode resolves from it.
Runs, in order: (1) `extension/test-page` with the same settle logic
as `verify-phase2.js` (dynamic + lazy images), (2) a generated page
with the scanner's 16-photo labeled test set
(`scanner/testset/testset-page.html`, generated from `manifest.json`)
with precision/recall vs ground truth using the scanner's conventions
(uncertain counts as FN for recall, reported separately), (3) an audit
of EVERY request the pages + the detector iframe made.

Face-only baseline: the same harness run against a pristine copy of
the pre-change extension (`/tmp/ext-faceonly-baseline`, snapshotted
before any edit) on the same 16-photo set, minutes earlier.

## Results

### Extension test page

| | block | cover |
|---|---|---|
| model ready | 5,499 ms | 6,250 ms |
| first scan done | 27,786 ms | 27,977 ms |
| found / scanned | 9 / 10 | 9 / 10 |
| human | 6 | 6 |
| blocked | 6 | 0 |
| covered | 1 | 7 |
| uncertain | 1 | 1 |
| no-human | 3 | 3 |
| bg found / bg human | 1 / 1 (blocked) | 1 / 1 (covered) |
| skipped | 3 | 3 |
| personHits (person detector fired) | 6 | 6 |
| personReady | true | true |

All 6 human images (Einstein, Obama family, Curie ×2 incl. dynamic
and lazy) were found by the person detector too (`person+face`:
Einstein person 0.935, Obama 3 persons 0.808, Curie 0.915; background
Einstein person 0.935, blocked/covered). The 1 covered uncertain is
the cross-origin image without CORS (`img-xorigin-local`) — fail
closed, new in v1.1.0 (it used to stay visible in block/cover). The 3
skipped are the same as the face-only baseline (facebook probe and the
Wikimedia cross-origin image never load — this VM's Chromium has no
internet route — plus one lazy-load retry count); identical counts in
the baseline run.

### Labeled 16-photo test set (same photos + ground truth as the scanner)

| ID | Truth | Verdict | Persons | Person best | Faces | Via |
|---|---|---|---|---|---|---|
| b1-back-soldier | person | **no-human** ❌ | 0 | 0 | 0 | – |
| b2-behind-back | person | **no-human** ❌ | 0 | 0 | 0 | – |
| b3-back-tattoo | person | human | 1 | 0.885 | 0 | person |
| d1-crowd-funeral | person | human | 5 | 0.617 | 0 | person |
| d2-crowd-street-night | person | human | 5 | 0.627 | 0 | person |
| d3-lone-beach | person | **no-human** ❌ | 0 | 0 | 0 | – |
| g1-team-cincinnati | person | human | 7 | 0.661 | 1 | person+face |
| g2-imperial-family | person | human | 6 | 0.882 | 0 | person |
| g3-west-point-1899 | person | human | 10 | 0.734 | 0 | person |
| p1-huang-portrait | person | human | 1 | 0.968 | 1 | person+face |
| p2-khrushchev-portrait | person | human | 1 | 0.980 | 1 | person+face |
| a1-dog-running | none | no-human | 0 | 0 | 0 | – |
| a2-dog-stream | none | no-human | 0 | 0 | 0 | – |
| l1-glacier-lake | none | no-human | 0 | 0 | 0 | – |
| l2-mountain-lake | none | no-human | 0 | 0 | 0 | – |
| o1-vintage-camera | none | no-human | 0 | 0 | 0 | – |

Metrics (n=16, 11 person-present, 5 no-person):

| | person+face (this build) | face-only baseline (same harness, same set) | scanner v0.2.0 (for reference) |
|---|---|---|---|
| TP / FP / FN / TN | 8 / 0 / 3 / 5 | 3 / 0 / 8 / 5 | 5 / 0 / 6 / 5 |
| Precision | **1.000** | 1.000 | 1.000 |
| Recall | **0.727** | 0.273 | 0.455 |
| Uncertain on person images | 0 | 0 | 3 |
| Missed to ALLOW | 3 (b1, b2, d3) | 8 | 3 (b1, b2, d3) |

The 3 misses are exactly the same 3 the scanner misses. Per-image
scores match the scanner within ~0.01 (b3 0.885 vs 0.896, g3 0.734 vs
0.736, p1 0.968 vs 0.968, g1 7 persons 0.661 vs 0.660) — the port
reproduces the scanner's detector behavior.

**Threshold note — read the recall number honestly.** The extension
calls "human" at best score ≥ 0.50 (the old face-only threshold,
kept); the scanner calls "human" at ≥ 0.70. The three extra TPs here
(d1 0.617, d2 0.627, g1 0.661) are "uncertain" under the scanner's
threshold. At the scanner's 0.70 threshold this build scores TP 5,
recall 0.455 — identical to the scanner. The 0.727 is a threshold
effect, not a detector difference. Whether 0.50 or 0.70 is the right
human threshold for the extension is an open product decision; 0.50
was kept to avoid changing the already-verified face behavior.

Timing: model ready ~5.1–5.3 s per page; test-set scan 22.5–22.7 s
for 16 images; mean detect 1,328–1,354 ms/image, median
1,179–1,191 ms (person+face together, this VM, SwiftShader).

### No-exfiltration audit

43 requests per run (26 local test servers, 1 page cross-origin
image — the test page's own Wikimedia `<img>`, not the extension —
16 `chrome-extension://` files). **0 unexpected requests, 0 non-GET
requests.** The detector iframe fetched only bundled extension files:
`detector.html`, `detector-page.js`, `vision_bundle.mjs`,
`vision_wasm_internal.js` + `.wasm`, `efficientdet_lite0.tflite`
(+ the face-model files). No image data leaves the browser; the only
pixels that cross any boundary are the downscaled JPEG data URLs from
the content script to the extension's own iframe on the same machine.

## Bugs found and fixed during this verification

1. **MV3 default CSP blocks WASM compilation.** The first run failed
   with `Aborted(CompileError: WebAssembly.instantiate(): Compiling
   or instantiating WebAssembly module violates the following Content
   Security policy directive because neither 'wasm-eval' nor
   'unsafe-eval' is an …` — MV3's default `extension_pages` CSP
   (`script-src 'self'`) does not allow WASM. Fixed with
   `"content_security_policy": { "extension_pages": "script-src 'self'
   'wasm-unsafe-eval'; object-src 'self'" }` in `manifest.json`.
   `wasm-unsafe-eval` permits WASM only, not `eval()` or inline scripts.
2. **Warmup message sent after the wait was awaited.** In the first
   version of `detector.js`, `ensure()` did `const res = await
   waitFor(id, 60000)` and only then `postMessage(warmup)` — so the
   warmup was never sent until the 60 s timeout fired, and the
   detector (which then loaded in ~1 s) replied to a dead waiter.
   The stage logs in the iframe proved the detector itself was fine
   (bundle +47 ms, ObjectDetector created +1,173 ms). Fixed by
   registering the waiter, posting, then awaiting. After the fix:
   warmup reply in ~0.5 s, model ready ~5 s per page.

The face-only fallback was verified live while the person detector
was down (both pre-fix runs): face-only numbers, no crash, no
fail-open — the extension kept working with `personReady: false`.

## Behavior changes (deliberate, v1.1.0)

- **Uncertain images are now COVERED in block/cover/strict modes**
  (was: left alone in block/cover, covered only in strict). This
  covers detector failures, weak 0.40–0.50 signals, and cross-origin
  images without CORS. Trade-off: any cross-origin image served
  without CORS headers gets covered even when it shows no person;
  there is no per-image unblock in this phase.
- **`strict` mode now behaves the same as `cover` for images**
  (both cover human + uncertain). The switch is kept in the popup.
- Log entries now carry `persons`, `personBest`, `faceBest`,
  `detectedBy` (`person` / `face` / `person+face`), `best`, and per-image
  `ms`; stats gain `personHits`; DOM gains `data-fp-person-ready`.

## Not verified / still open

- **Strict mode** was not run through the harness (block + cover
  only). It shares the same code path as cover for images, but that
  is reasoning, not a run.
- **Google Images / real sites:** not verified from this VM (headless
  Chromium gets `/sorry` / no internet route). The cross-origin
  Wikimedia test image never loads here, so the person detector on a
  real cross-origin image with CORS headers is unproven in the
  extension (the scanner proved the detector on real-site images;
  the extension path differs only in the data-URL handoff).
- **CSP-strict page fallback:** the face-only fallback when a page's
  CSP blocks extension iframes is implemented (10 s fast-fail) but
  was not exercised against a real CSP-blocking page.
- **DNR / live policy sync:** untouched by this change and not
  re-verified here — the existing `harness/verify-phase2.js`
  (block/cover/strict + live sync) remains the check for that. This
  harness seeds demo mode only and builds no DNR rules.
- **Real-machine timing:** all timings are this VM (SwiftShader,
  shared CPU). The ~5 s per-page model load is re-paid on every page
  load (no persistent detector); a persistent offscreen-document
  detector would need a `background.js` change.
- **Human threshold 0.50 vs 0.70:** open product decision (see
  threshold note above). If the threshold moves to 0.70, recall on
  this set becomes 0.455 with 3 more person images uncertain
  (covered, safe) instead of blocked.
- **EfficientDet-Lite0 weights license:** still UNVERIFIED —
  prototype-only. Confirm from Google (or switch to a verified model)
  before any production/commercial shipment.
