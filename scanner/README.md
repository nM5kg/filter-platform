# AI Pre-Rendering Website Inspection & Visual Protection Engine

Prototype v0.1.0 — part of the **Filter Platform** (Yakob's free kosher
internet filter). It renders a real website in headless Chromium, finds
every visual element on the rendered page, detects people in the images
on-device (CPU-first), and emits a **Visual Content Map** — per-element
`ALLOW / COVER / BLOCK / REVIEW` decisions under the Standard policy.

This is a **prototype**: it proves the pipeline end-to-end on real sites
with real measurements. It is not yet the production service (see
[Known limits](#known-limits) and [Cloudflare fit](#cloudflare-fit)).

## Files

| File | What it is |
|---|---|
| `scanner.js` | The scanner. SSRF guard, Playwright render, element collection, person+face detection (via `detector.js`), decisions, resource measurement. CLI: `node scanner.js <url> [--out file.json] [--proxy URL] [--spki-pin B64] [--screenshot] [--max-images N]` |
| `detector.js` | Shared on-device detector (MediaPipe ObjectDetector EfficientDet-Lite0 person class + face-api.js tinyFaceDetector fallback). Used by `scanner.js` and `test_person.js` so both run identical detection code. |
| `scan.js` | Scan runner. Scans the default real-site list (or URLs given on the command line), writes one JSON + one PNG screenshot per site into `results/`, and generates `SCAN_REPORT.md` (new run prepended, previous reports kept verbatim underneath). |
| `test_person.js` | Labeled test-set harness. Runs `detector.js` over `testset/` (real Wikimedia Commons photos, ground truth verified by eye) and reports per-image results + precision/recall. CLI: `node test_person.js` |
| `testset/` | Labeled test set: 16 real photos (`manifest.json` with ground truth + source URLs), `results.json`, `TESTSET.md` (per-image table + metrics), `contact-sheet.jpg`. |
| `models/efficientdet_lite0.tflite` | EfficientDet-Lite0 (COCO) weights, float16, 7,254,339 bytes, SHA-256 `4b591000…80993` (see `models/LICENSES.md`). Downloaded from Google's official MediaPipe model bucket. |
| `models/tasks-vision/` | `@mediapipe/tasks-vision` 1.2.3 `vision_bundle.mjs` (ESM, served to the detector page). |
| `models/tasks-vision-wasm/` | MediaPipe vision WASM runtime (`vision_wasm_internal.js` + `.wasm`, ~15 MB). |
| `models/LICENSES.md` | License findings for every model/library shipped in `models/`, including the ones evaluated and rejected (OMZ person-detection-0202, Ultralytics YOLO AGPL). |
| `models/face-api.js` | face-api.js UMD bundle (@vladmandic fork 1.7.15, MIT) — injected into the scanned page. |
| `models/tiny_face_detector_model-weights_manifest.json` + `.bin` | tinyFaceDetector weights (193 KB) — served to the page from local disk, never fetched from the internet. |
| `results/` | One `<slug>.json` Visual Content Map + `<slug>.png` screenshot per scanned site. |
| `test-video-canvas/` | Video/canvas verification: local test pages (`video.html`, `canvas.html`) with a real Commons video + real test-set photos, result JSONs/screenshots, the Google Images probe outputs, and its own `README.md`. Run with `SCANNER_ALLOW_LOOPBACK=1` (test-only, see below). |
| `SCAN_REPORT.md` | Human-readable summary of the last `scan.js` run. |
| `package.json` | `playwright ^1.65.1` (installed; shares the Chromium in `~/.cache/ms-playwright`). |

## How a scan works

1. **Validate (SSRF protection).** Only `http:`/`https:`, no credentials
   in the URL. The hostname is resolved with the system resolver and
   **every** resolved address is checked: private (`10/8`, `172.16/12`,
   `192.168/16`), loopback, link-local (`169.254/16`, `fe80::/10`),
   CGNAT (`100.64/10`), documentation/test nets, multicast, reserved,
   `0.0.0.0/8`, IPv4-mapped IPv6, and `localhost` names are all rejected.
   The same check runs on **every subresource request** (images, scripts,
   fonts, XHR, redirects) via a Playwright route handler, with a
   per-host DNS cache and a cap of 5 redirects. A page that tries to make
   the scanner fetch `http://169.254.169.254/` (cloud metadata) or a
   redirect to an internal host gets the request aborted, and the abort
   is recorded in `ssrf_checks` in the output JSON.
2. **Render (isolated).** A fresh browser context per scan (no shared
   cookies/storage), no permissions granted (no geolocation, camera, or
   microphone), a neutral scanner user-agent, 30 s navigation timeout,
   `networkidle` wait, then a stepwise scroll through the whole page to
   trigger lazy-loaded images, then a settle wait. Pages that keep
   loading (analytics beacons) are recorded, not fatal.
3. **Collect.** All rendered visual elements: `<img>` (with
   `currentSrc`, natural size, alt text), CSS `background-image`s,
   `<svg>` `<image>`s, `<canvas>`es, `<video>`s (current frame). Each
   gets a CSS-path selector, a viewport box `{x, y, w, h}`, and a
   visibility flag. Hidden/off-screen elements are recorded but decided
   `ALLOW` (nothing is shown).
4. **Detect people (on-device, CPU-first).** Two detectors run in a
   **dedicated detector page** (`about:blank`), NOT in the scanned page
   — the scanned page's scripts, timers, CSP, and tainted canvases
   cannot stall or corrupt detection, and a wedged detector page can
   be closed and recreated without touching the scan. Both detectors
   are loaded from local disk via the `https://scanner-models/` route
   (see `detector.js` for the shared implementation):
   - **Person (primary): MediaPipe ObjectDetector, EfficientDet-Lite0
     trained on COCO, category allowlist `['person']`.** A real person
     detector: it sees bodies without a visible face (back of head,
     distant figures, cropped bodies) where the face detector is
     blind. Runs on CPU via WASM (`@mediapipe/tasks-vision` 1.2.3,
     Apache 2.0; weights `efficientdet_lite0.tflite`, see
     `models/LICENSES.md`). Max 10 person boxes per image.
   - **Face (fallback + complement): face-api.js `tinyFaceDetector`**
     (vladmandic fork 1.7.15, MIT), as in v0.1.0. A **person OR face
     hit counts as human**. If the person model fails to load, the
     face detector still runs; if both fail, every candidate becomes
     `uncertain` → `REVIEW` (fail closed).
   The CPU backend is forced for face-api (`tf.setBackend('cpu')`);
   the person detector uses the WASM CPU delegate. Images are loaded
   by URL in the detector page; `<video>` and `<canvas>` are sampled
   via element screenshots (which also bypasses CORS taint). Each
   element gets a 25 s Node-side timeout (Playwright's
   `page.evaluate` has no working timeout option — verified: a
   never-resolving evaluate with `{ timeout: 3000 }` ran past 31 s,
   so the timeout is enforced with `Promise.race` in Node). The
   largest 40 visible elements (≥ 32×32 px) are checked; the rest
   are counted in `detection_skipped`.
   - Person or face score ≥ 0.70 → `person` (0.70 is the Standard policy threshold)
   - Person or face found with 0.40–0.70 → `uncertain`
   - Neither found → `none`
   - Element cannot be analysed at all (CORS-tainted image, blank WebGL
     canvas, detector failure) → `uncertain` with a `note`
   - The per-element `confidence` is the best of the two detectors;
     `persons` / `faces` give the counts, `detected_by` says which
     detector fired (`person`, `face`, or `person+face`).
   - **`<img>` loads are CORS-gated.** The detector page is a fresh
     `about:blank` page (opaque origin) and `detector.js` loads image
     URLs with `crossOrigin='anonymous'`, so a host that does not send
     `Access-Control-Allow-Origin: *` fails the load → `uncertain` →
     `REVIEW` (fail closed). Verified with identical pixels in both
     paths: the same portrait scored 0.966 via canvas screenshot and
     failed as an `<img>` from a server without CORS headers (see
     `test-video-canvas/README.md`). The `<video>`/`<canvas>` screenshot
     path is immune — screenshots are the scanner's own pixels.
5. **Decide (Standard policy v1: `block_images=true`,
   `cover_images=false`, threshold 0.70).**
   - `person` → `BLOCK` (images of people are blocked)
   - `uncertain` → `REVIEW` — and unreviewed content **stays COVERED**
     on the device, so a detection failure can never leak an image
   - `none` / hidden → `ALLOW`
   - If the detector itself fails to load, every candidate becomes
     `uncertain` → `REVIEW` (fail closed, never fail open).
6. **Measure & emit.** Wall time (`scan_ms`), CPU seconds (Node process
   **plus** accumulated Chromium CPU from `/proc`, sampled every 250 ms),
   peak RSS (Node + all Chromium processes from `/proc`), HTTP status,
   redirect count, detector status, per-element decisions, and a
   `failures[]` list that records everything that went wrong. Output is
   the Visual Content Map JSON:

```json
{
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "final_url": "https://en.wikipedia.org/wiki/Main_Page",
  "scanned_at": "2026-11-18T09:xx:xxZ",
  "policy_version": "standard-v1",
  "scan_ms": 12345,
  "cpu_seconds": 4.05,
  "peak_rss_mb": 1050.6,
  "http_status": 200,
  "redirects": 0,
  "detector": { "name": "MediaPipe ObjectDetector (EfficientDet-Lite0, COCO person class) + face-api.js tinyFaceDetector (vladmandic fork 1.7.15)", "backend": "cpu", "loaded": true, "person_model": "MediaPipe ObjectDetector (EfficientDet-Lite0, COCO person class)", "person_loaded": true, "face_model": "face-api.js tinyFaceDetector (vladmandic fork 1.7.15)", "face_loaded": true, "error": null },
  "elements": [
    { "type": "img", "selector": "div > img", "box": { "x": 10, "y": 20, "w": 300, "h": 200 },
      "detection": "person", "confidence": 0.93, "persons": 2, "faces": 2, "detected_by": "person+face", "decision": "BLOCK", "src": "https://…" }
  ],
  "summary": { "total": 24, "people": 1, "covered": 0, "blocked": 1, "review": 5 },
  "verdict": "REVIEW",
  "failures": []
}
```

`verdict` is `ALLOW` (nothing found), `REVIEW` (something blocked or
uncertain), or `ERROR` (navigation/HTTP failure — the map is still
emitted, with whatever was collected).

## Running it

```bash
cd ~/workspace/filter-platform/scanner
npm install            # playwright + @mediapipe/tasks-vision; Chromium already in ~/.cache/ms-playwright
node scan.js           # default real-site list -> results/ + SCAN_REPORT.md
node scanner.js <url> --out results/x.json --screenshot
node test_person.js    # labeled test set (16 real Commons photos) -> testset/results.json + TESTSET.md
```

### Sandbox networking (this VM only)

This VM has no direct internet: all traffic goes through the Hatch
egress proxy, which (a) drops unauthenticated connections without a
407 challenge — Chromium only sends proxy credentials *after* a 407 —
and (b) MITMs TLS with a private CA (`Hatch Sandbox Egress CA`).
Two local-only adaptations bridge that, both documented and off by
default:

- `../harness/egress-relay.js` — a tiny localhost relay that adds
  `Proxy-Authorization` pre-emptively and forwards to the egress proxy.
  Start it, then run with `SCANNER_PROXY=http://127.0.0.1:18080`.
- `SCANNER_TLS_SPKI_PIN=<base64 SPKI SHA-256>` — passed to Chromium as
  `--ignore-certificate-errors-spki-list=…`. It pins **one** CA (the
  sandbox egress CA) instead of disabling validation: any other bad
  certificate still fails. The pin for this VM is the SPKI hash of
  `/usr/local/share/ca-certificates/hatch-egress-ca.crt`.
- `SCANNER_ALLOW_LOOPBACK=1` — **test-only, default off.** Disables the
  SSRF loopback guard for that run so the scanner can be verified against
  local test pages (`test-video-canvas/`, served from 127.0.0.1). The run
  records the override in `failures[]`. Never set in production. Local
  runs need **no proxy** (a proxy would try to route 127.0.0.1 through
  the egress).

**Relay restarts:** the relay is a separate process — editing
`harness/egress-relay.js` does not affect a running relay. After any fix,
restart it (only after a replacement is verified running) and re-test the
failing hosts. 2026-11-18 ~11:20 UTC: the 18080 relay (running pre-fix code
since 10:08) was restarted with the fixed code (new pid 34902) after the
fixed-code 18081 relay proved the fix — Wikipedia/BBC went from 15 s
tunnel failures to 200s in under a second. If a host fails with a 504 /
`ERR_TUNNEL_CONNECTION_FAILED` while others work, check the relay's age
before blaming the site.

In production the scanner container has direct internet: no proxy, no
pin, strict TLS. **Never set either in production.**

## Security / sandbox measures

- **SSRF:** see step 1 above. DNS is resolved by the scanner (not left
  to Chromium), every address is checked, every request is checked —
  including redirects and subresources — and results are cached
  per-scan so a DNS-rebinding flip between check and fetch is confined
  to one scan (a production deployment should additionally resolve once
  and pin the IP, and run the browser in a network namespace with no
  route to internal networks — see Known limits).
- **Isolation:** fresh browser context per scan; no extensions; no
  permissions; no downloads; no geolocation. Chromium sandbox stays on
  — except that this VM runs as root, where Chromium refuses to start
  with the sandbox, so `--no-sandbox` is passed only when `uid == 0`
  and the fact is recorded in `failures[]` on every scan. Production
  runs as a non-root user with the sandbox intact.
- **Untrusted page content:** the scanned page's JavaScript is never
  executed by Node and never trusted — only plain JSON crosses the
  page/Node boundary. Detection runs in-page only because face-api
  needs DOM image pixels.
- **CSP bypass: not used.** The detector runs in its own `about:blank`
  page, which has no CSP, so no bypass is needed. An earlier version
  loaded the detector inside the scanned page and needed
  `bypassCSP: true`, because sites like Wikipedia and the BBC send a
  `connect-src` CSP that blocks `fetch()` of bundled models from the
  intercepted `scanner-models` origin — the fetch fails inside the
  renderer before it ever reaches the route handler, which silently
  degraded every image to REVIEW (the first full run detected 0 people
  on all 4 sites for exactly this reason). The dedicated detector page
  removed the workaround; the scanned page's CSP is now enforced like
  a real browser's. (Removal re-verified on Wikipedia 2026-11-18:
  identical results — 3 people, same confidences.)
- **Fail closed:** detector failure, unanalysable images, and uncertain
  detections all become `REVIEW` (covered on the device). Nothing is
  `ALLOW`ed by default.
- **No secrets:** the scanner takes no credentials. The Phase 1 API
  token is never used here and never appears in code or output.

## License findings (checked 2026-11-18, from the projects' own LICENSE files / registries)

Closed commercial SaaS use is the bar — a "free for the masses" service
still needs components whose licenses allow commercial redistribution
without a copyleft trap. All findings below were verified by fetching
the actual license text (or the npm registry `license` field where the
raw file was unreachable in this sandbox); re-verify before shipping.

| Component | License | Verified how | Verdict for closed commercial SaaS |
|---|---|---|---|
| face-api.js (justadudewhohacks, original) | **MIT** | `LICENSE` fetched from GitHub (1,072 B, "MIT License") | ✅ Permissive; attribution only. |
| @vladmandic/face-api 1.7.15 (fork used here) | **MIT** | `LICENSE` fetched from GitHub + npm `license: MIT` | ✅ Permissive; attribution only. |
| TensorFlow.js (tfjs, bundled inside face-api) | **Apache 2.0** | `LICENSE` fetched from GitHub | ✅ Permissive; attribution + NOTICE. |
| @mediapipe/tasks-vision 1.2.3 (ObjectDetector runtime + WASM) | **Apache 2.0** | npm registry `license: Apache-2.0` + MediaPipe GitHub repo `LICENSE` (Apache 2.0); Google's MediaPipe Tasks overview states "Apache 2.0 (SDK); some models have their own terms (for example, Gemma)" | ✅ Permissive. |
| EfficientDet-Lite0 weights (`efficientdet_lite0.tflite`, float16, from Google's MediaPipe model bucket) | **Apache 2.0, with a re-verify note** | Google's Object Detector docs page states NO model-weights license (checked 2026-11-18 — page text CC-BY 4.0, code samples Apache 2.0 only). Positive evidence: Google's framing (only *some* models have their own terms, Gemma named as the example — EfficientDet-Lite0 is not among them) + the `object_detection` Flutter package, which ships byte-identical copies of Google's official builds and states "Both models are Apache 2.0 licensed". That is a secondary source, not Google's own words — **confirm from Google directly before commercial shipment** | ⚠️ Permissive as far as verified; confirm before shipping. |
| Ultralytics YOLO (v5/v8/v11/v26) — EXCLUDED | **AGPL-3.0** | `LICENSE` fetched from GitHub (34,523 B, "GNU AFFERO GENERAL PUBLIC LICENSE, Version 3"). The AGPL covers code and weights (Ultralytics: AGPL applies even to models trained from scratch with their tools; an Enterprise License is sold separately) | ❌ Copyleft — do not use in closed commercial SaaS without the Enterprise License. No YOLO code or weights are in this repo. |
| ONNX Runtime (+ onnxruntime-web) | **MIT** | npm registry `license: MIT` for onnxruntime-node; GitHub blob page for `LICENSE` exists and is detected as MIT. Raw fetch returned 404 in this sandbox (proxy quirk) — **re-verify the full text before shipping** | ✅ Permissive (pending that re-check). |
| OpenCV | **Apache 2.0** | `LICENSE` fetched from GitHub (4.x branch) | ✅ Permissive. |
| Open Model Zoo (incl. person-detection-0202) | **Apache 2.0** | Repo `LICENSE` fetched + root README: "Open Model Zoo is licensed under Apache License Version 2.0". The person-detection-0202 model README carries no separate license, so it falls under the repo license — **re-verify per model** (a few OMZ models have different terms) | ✅ Permissive, with the per-model re-check. |
| NSFWJS (content classification) | **MIT** | `LICENSE` fetched from GitHub | ✅ Permissive. Note: its models are the question, not the code — NSFWJS models are MIT-licensed too, but check the model release notes. |

**Bottom line:** every component shipped in v0.2.0 is permissive
(MIT / Apache 2.0) — none is copyleft (no GPL/AGPL). One genuine
exception was found and excluded: **Ultralytics YOLO is AGPL-3.0**
(code and weights) and must not be used in the closed service without
an Enterprise License. The remaining license risk is the
**EfficientDet-Lite0 weights**: the code is Apache 2.0, the weights
are Apache 2.0 as far as the evidence goes, but Google's own docs page
does not state the weights license — confirm it from Google before
commercial shipment. Keep `models/LICENSES.md` next to any model you
ship, with the source URL and the license text, and re-check on every
model update.

## Upgrade path (from this prototype)

1. **Person detection, not just faces — DONE in v0.2.0 (2026-11-18).**
   MediaPipe ObjectDetector EfficientDet-Lite0 (COCO `person`) is the
   primary detector, face-api.js stays as fallback/complement; a
   person OR face hit counts as human. Labeled test set (16 real
   Commons photos): precision 1.000, recall 0.455 on the `person`
   verdict; 3 more person images landed `uncertain` (covered, safe);
   3 missed to ALLOW (2 back views, 1 distant figure). See
   [`testset/TESTSET.md`](testset/TESTSET.md). What is still weak:
   back views (1 of 3 found), distant/small figures (score 0.61–0.66
   → REVIEW, or below the 0.40 floor → missed), group undercounting
   (7 of 11, 6 of 7, 10 of ~14). Next step for those: tiled/crop
   detection (detect on crops so small figures are full-size at the
   320×320 model input), or a stronger model — OMZ
   person-detection-0202 (Apache 2.0, verified — see
   `models/LICENSES.md`) as a Node-side detector is the documented
   alternative, but it ships only as OpenVINO IR and needs a
   conversion step plus a native runtime.
2. **Region-level covering.** The Visual Content Map already carries a
   box per element; the next step is per-*face/person* boxes inside an
   image, so the browser app can blur/cover just the person region
   instead of the whole image.
3. **Video.** Today only the current frame of each `<video>` is
   sampled. Full coverage needs periodic frame sampling during
   playback (and, for autoplay, a few frames across the first seconds).
4. **Scale-out.** One Chromium per scan is ~1 GB RSS (measured, see
   below). For 10,000+ customers the scanner must be a pooled worker
   fleet behind a queue (see Cloudflare fit), with per-scan CPU/RAM
   caps and a cache keyed by URL+content-hash so a popular page is
   scanned once, not once per customer.
5. **NSFW/text layer.** Images are half the policy; the "really dirty
   words" half belongs to the text classifier (Phase 1 already has a
   first version). NSFWJS (MIT) is a candidate for the image side if
   face/person detection alone proves insufficient.

## Cloudflare fit (honest assessment)

The scanner needs a **full Chromium render**. That does not run on
Cloudflare Workers — Workers have no browser, no `child_process`, and
a 128 MB / 10 ms–30 s CPU envelope that a Chromium launch alone would
blow. So:

| Piece | Fits Cloudflare? | Notes |
|---|---|---|
| API / orchestration (the Phase 1 Worker) | ✅ **Yes** | Receives scan requests, enforces auth + policy, returns cached Visual Content Maps. Already exists. |
| Queues to dispatch scan jobs | ✅ **Plausible** | A Worker enqueues `{url, policy_version}`; scanner workers consume. Needs a consumer outside Workers (below). |
| R2 to store Visual Content Maps + screenshots | ✅ **Plausible** | Cheap, S3-compatible, same account. Maps are small JSON; screenshots are the bulk. |
| Workers AI for small models | ⚠️ **Assess, don't assume** | Workers AI runs small models on Cloudflare's network, but (a) it cannot see a rendered page — it classifies bytes you send it, not a DOM; (b) the available catalog has no person/face detector sized for this job today, and image input limits are small. It could *complement* the scanner (e.g. second-opinion classification of a cropped image) but it cannot *replace* the Chromium render. Re-check the catalog before committing. |
| The Chromium render itself | ❌ **No** | Needs a real container/VM with Chromium + ~1 GB RAM per concurrent scan. That is the one piece that lives outside Cloudflare. |
| Browser Rendering API | ⚠️ **Maybe, later** | Cloudflare sells a Browser Rendering API (Puppeteer over their infrastructure). It could host the render step without us running VMs — but it is a paid add-on with its own limits, and the scanner's SSRF/sandbox guarantees would then depend on their isolation, not ours. Evaluate it as an alternative to self-hosted containers; do not assume it. |

**Recommended shape (fewest vendors):** keep everything already on
Cloudflare (Worker API, Queues, R2, Pages dashboard, Neon DB) and add
**one** compute home for the scanner — a small container service
(Cloudflare does not offer general containers for this; the honest
answer is a VPS/container host or a Cloudflare-adjacent compute
service, chosen when scale demands it). Do not add a second CDN, a
second queue, or a second object store. The scanner fleet is the only
new vendor-shaped decision, and it is one decision, not five.

## Verification (live, real sites)

### v0.2.0 — person detector (2026-11-18)

Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO `person`)
+ face-api.js tinyFaceDetector fallback, CPU backend, models bundled
locally. Policy standard-v1 throughout. Full detail in
[`SCAN_REPORT.md`](SCAN_REPORT.md) (comparison + raw runs) and
`results/*.json` (+ screenshots).

| Site | Verdict | HTTP | Scan | CPU | Peak RSS* | Elements | People | Blocked | Review |
|---|---|---|---|---|---|---|---|---|---|
| example.com | ALLOW | 200 | 3,623 ms | 0.61 s | 549 MB | 0 | 0 | 0 | 0 |
| commons.wikimedia.org (Featured pictures) | REVIEW | 200 | 77,807 ms | 63.4 s | 1,207 MB | 244 img | **4** | **4** | 202 |
| en.wikipedia.org (Main Page) | REVIEW | 200 | 35,494 ms | 30.4 s | 1,134 MB | 24 img | **4** | **4** | 6 |
| www.bbc.com | REVIEW | 200 | 123,891 ms | 87.9 s | 1,146 MB | 72 img | **20** | **20** | 40 |

(Wikipedia + BBC first ran with **no valid v0.2.0 run** — the sandbox
egress relay was running pre-fix code; see the egress paragraph below.
After the relay restart both have valid runs, shown above.)

**v0.1.0 baseline (face-only, 2026-11-18 ~10:14 UTC)** for comparison:
example.com ALLOW 0 people; Wikipedia REVIEW 3 people / 3 blocked /
7 review (39,087 ms); BBC REVIEW 9 people / 9 blocked / 37 review
(120,050 ms); Commons REVIEW 2 people / 2 blocked / 201 review
(82,588 ms). The baseline report is kept verbatim at the bottom of
[`SCAN_REPORT.md`](SCAN_REPORT.md).

**What changed on Commons (valid comparison): 2 → 4 people.**
Two finds face-only missed, both via `person` with 0 faces: the
"Terror of War" photo (0.736, 10 persons) and a Gotland Grand
National 2026 photo (0.858, 4 persons). The two baseline finds were
still found (Quero 0.87, STS-107 crew 0.844). Review is essentially
unchanged (202 vs 201).

**Wikipedia + BBC: valid v0.2.0 runs after the relay restart
(2026-11-18 ~11:23 UTC).** Before the restart, three attempts per site
over ~1.5 hours all failed the same way: Wikipedia navigation fails in
~15 s with `net::ERR_TUNNEL_CONNECTION_FAILED` (0 elements); BBC's page
loads (HTTP 200, 143 elements) but every image host fails the same way
(`ichef.bbci.co.uk`, `static.bbci.co.uk`, `static.files.bbci.co.uk`),
each image load burning its 8 s timeout until the 180 s hard cap. Direct
`curl` through the same relay confirmed it: `CONNECT tunnel failed,
response 504` after 15.0 s for `en.wikipedia.org` and
`ichef.bbci.co.uk`, while `www.bbc.com` (200, ~1 s),
`commons.wikimedia.org` (200, 0.44 s) and `example.com` (200, 0.41 s)
still connected. The cause was the sandbox egress relay: a sibling agent
had fixed a real bug in `harness/egress-relay.js`, but the relay process
on 18080 (started 10:08) still ran the old code. Controlled comparison,
same minute: old-code relay failed all three hosts (000 after 15.0 s),
fixed-code relay on 18081 returned 200 in 0.5–0.6 s. The 18080 relay was
restarted with the fixed code (new pid 34902, only after the 18081
replacement was verified running) and now returns 200 for all four hosts
in under a second. The valid re-runs: **Wikipedia 4 people / 4 blocked /
6 review (35,494 ms)** — Gilbert 0.849, Bunlet Harcourt 1937 0.963,
Jensen Huang 0.967, Khrushchev 0.986, all `person+face` (one more than
the face-only baseline's 3); **BBC 20 people / 20 blocked / 40 review
(123,891 ms)** — confidences 0.749–0.997, `person+face` 13,
`person`-only 6, `face`-only 1 (the complement runs both ways), 31
skipped over the 40-image budget. Live homepages change between runs, so
these are not pure A/B comparisons against the baseline — but both prove
the person detector works end-to-end on real BBC/Wikipedia images. The
failed runs are kept verbatim in `SCAN_REPORT.md` (the three v0.2.0
sections underneath the current one). Do not quote 0 people for
BBC/Wikipedia from the failed runs — those runs never got to detect.

**Video + canvas — VERIFIED on real media (2026-11-18, v0.2.0).**
Local test pages in `test-video-canvas/` (real Commons video + real
test-set photos, served from 127.0.0.1:8125, `SCANNER_ALLOW_LOOPBACK=1`):
a `<video>` of Obama paused at 5 s → `person` 0.82 via `person` (0 faces)
→ **BLOCK**; a `<canvas>` with a portrait drawn via `drawImage` →
`person` 0.966 `person+face` → **BLOCK**; an animated canvas drawing
video frames via `requestAnimationFrame` → `person` 0.818 → **BLOCK**; a
landscape canvas control → `none` → **ALLOW**; a second playing video
(427×240) → `person` 0.768 → **BLOCK**. Per-element cost ~3–8 s
(screenshot + detect) vs ~1.4 s for a plain `<img>`. Full detail in
`test-video-canvas/README.md`.

**Google Images — still unverified (2026-11-18).** Chromium reaches
Google (HTTP 200 in ~1.5 s) but Google redirects to `/sorry/index`
("unusual traffic … not a robot"), 0 images — tried via relay 18080 +
SPKI pin, via `--ignore-certificate-errors`, via relay 18081, and with
automation markers removed (still `/sorry`); direct upstream proxy fails
with `ERR_TUNNEL_CONNECTION_FAILED` (no 407, so Chromium cannot
authenticate — the relay is required). Control: `curl` with a browser UA
through the same relay gets a real results page (200, 93,959 bytes). So
the proxy/TLS path works and the relay restart changed nothing here —
Google's bot-check targets headless Chromium specifically. No CAPTCHA was
attempted. The extension content script was never shown real Google
Images thumbnails; that check needs a machine where Google serves real
results to a real browser. Full detail in
`test-video-canvas/README.md`.

**Labeled test set (16 real Commons photos):** precision **1.000**,
recall **0.455** on the `person` verdict (TP 5, FP 0, FN 6, TN 5);
3 more person images `uncertain` (covered, safe); **3 missed to
ALLOW** (2 back views, 1 distant figure). Face-only on the same set
scores recall 0.18. Full per-image table in
[`testset/TESTSET.md`](testset/TESTSET.md). Per-image inference is
~1.4 s (quiet VM) to ~2.5 s (loaded VM) for person+face together.

### v0.1.0 — face-only baseline (kept for reference)

Final verified run: **2026-11-18 ~10:14 UTC** (`node scan.js`, code as
shipped, no `bypassCSP`). Policy standard-v1 throughout. Detector:
face-api.js tinyFaceDetector, CPU backend, models bundled locally.
Runs happened on this VM through the sandbox egress relay + TLS SPKI
pin (see above); the scanner's own numbers are the same code path as
production (direct internet, no proxy/pin).

| Site | Verdict | HTTP | Scan | CPU | Peak RSS* | Elements | People | Blocked | Review |
|---|---|---|---|---|---|---|---|---|---|
| example.com | ALLOW | 200 | 3,511 ms | 0.66 s | 544 MB | 0 | 0 | 0 | 0 |
| en.wikipedia.org (Main Page) | REVIEW | 200 | 39,087 ms | 39.9 s | 2,592 MB | 24 img | 3 | 3 | 7 |
| www.bbc.com | REVIEW | 200 | 120,050 ms | 88.4 s | 2,723 MB | 74 img | 9 | 9 | 37 |
| commons.wikimedia.org (Featured pictures) | REVIEW | 200 | 82,588 ms | 84.9 s | 2,626 MB | 240 img + 4 bg | 2 | 2 | 201 |

\* Peak RSS counts **all** Chromium processes on the VM (other agents'
browsers included — Playwright exposes no per-browser PID), so the
2.6–2.7 GB figures are inflated; the cleanest single-scan figure is
example.com's 544 MB with no other Chrome running. Same caveat
applies to CPU seconds (upper bound). Per-image inference is
~1.2–1.5 s on the CPU backend.

**People detected (all BLOCKED under the Standard policy):**
- Wikipedia (3): 1937 portrait 0.957; Jensen Huang 0.944; Khrushchev
  1956 photo 0.986. One more face at 0.452 → `uncertain` → REVIEW.
- BBC (9): confidences 0.711–0.967, including 2-face (0.814, 0.865)
  and 3-face (0.93) images. Three more faces at 0.414–0.656 →
  `uncertain` → REVIEW.
- Commons (2): 0.706 (1 face); STS-107 crew photo 0.844 (**9 faces**).
  One more at 0.682 → `uncertain` → REVIEW.
- **Total: 14 people detected across the 3 content sites, all
  blocked; 0 people on example.com (no images).** No false `person`
  on animals/landscapes (bird, horse, flowers, nebulae all `none`).

**What FAILED (not hidden):**
- BBC: Chartbeat analytics ping blocked 3× by Chromium's Opaque
  Response Blocking (`ERR_BLOCKED_BY_ORB`) — a tracker beacon, not
  page content; `networkidle` not reached in 15 s (page keeps
  loading). Neither affected detection.
- Commons: navigation timed out twice (30 s cap, `ERR_TIMED_OUT`)
  before the sandbox relay bug was fixed (see Known limits); with
  the fixed relay it navigates in ~2 s. The first full run also saw
  a 30 s Commons navigation timeout under the old relay.
- Every run records `--no-sandbox` (VM runs as root; production runs
  non-root with the sandbox on).
- SSRF blocks triggered: **none** on any site — all subresources were
  public hosts. The guard itself was unit-tested separately: 24
  cases (169.254.169.254, 10/8, 192.168/16, 172.16/12, 127/8,
  ::1, fe80::/10, fd00::/7, ::ffff:192.168.1.1, CGNAT, TEST-NETs,
  multicast, 0/8, ftp/file/credential URLs, localhost) — all blocked
  as required; public IPs/hosts allowed. (Two real bugs found and
  fixed by that test: CIDR masking beyond /8, and IPv6-literal
  bracket handling.)
- No video or canvas elements were present on the four test pages,
  so the video-frame/canvas screenshot paths are implemented but
  **not yet verified on a real video/canvas page** — that is open
  verification work, not a passing result.
- Repeatability: Wikipedia gave 3 people and BBC 4 people in the
  first full run, 3 and 9 in the final run — live homepages change
  between runs; the people *found* were correct in every run, and
  the uncertain/review counts move with the page content and the
  40-image budget.

## Known limits

- **People, not just faces — v0.2.0 (partial).** The person detector
  finds bodies the face detector misses (groups, back views, the
  "Terror of War" photo on Commons), but the labeled test set shows
  it is not solved: back views 1 of 3 found, distant/small figures
  score 0.61–0.66 (→ REVIEW, covered) or below the 0.40 floor (→
  missed to ALLOW, 3 of 16 images). See
  [`testset/TESTSET.md`](testset/TESTSET.md) for the honest numbers.
  A `none` on a person image is still possible — the fail-closed
  design only covers failures the scanner *knows* about (detector
  errors, unanalysable images); a confident-looking `none` is a real
  miss, and the test set measures how often it happens.
- **CORS-tainted images.** A cross-origin `<img>` without CORS headers
  cannot be read as pixels; background images from such hosts fail the
  same way. They become `uncertain` → REVIEW, with a note. Verified with
  identical pixels in both paths (2026-11-18): the same portrait scored
  0.966 via canvas screenshot and failed as an `<img>` from a server
  without CORS headers — the detector page is `about:blank` (opaque
  origin) and loads images with `crossOrigin='anonymous'`, so the host
  must send `Access-Control-Allow-Origin: *`.
- **Canvas / WebGL.** 2D `<canvas>` is verified (static `drawImage` and
  animated `requestAnimationFrame`, both detected — see
  `test-video-canvas/`). A `<canvas>` whose drawing buffer was already
  presented (no `preserveDrawingBuffer`) reads back blank; WebGL
  content is effectively unanalysable in-page. Recorded as `uncertain`.
- **Video is one frame.** Only the current frame at scan time is
  checked; later frames are not. Verified on a real video (Obama
  statement, frame at 5 s → `person` 0.82 → BLOCK), but it is still one
  frame — a video that shows a person only later is missed.
- **Lazy / infinite content.** The scroll pass triggers lazy loading,
  but infinite-scroll pages keep growing; the scanner stops after one
  full pass and records what it saw.
- **Detection budget.** 40 largest visible elements per scan; the rest
  are `uncertain` → REVIEW and counted in `detection_skipped`
  (BBC: 33 skipped in the final run, 66 in the first — live pages
  change; Commons: 24 skipped). Raising the budget costs ~1.3 s of
  CPU per image on this VM.
- **Detection speed (CPU).** ~1.4 s per image with person+face
  together on a quiet VM (median 1,425 ms over 14 test images), ~2.5 s
  when the VM is loaded (median 2,722 ms over 16 test images) — the
  person model adds little over the old face-only ~1.2–1.5 s, because
  both run in one page evaluate and the WASM person inference is fast.
  A 40-image page costs ~60–120 s end-to-end. Tiled detection (for
  small figures) would multiply this per image.
- **RSS is approximate and inflated here.** Peak RSS is Node + *all*
  Chromium processes on the VM, because Playwright exposes no
  per-browser PID and other Chrome instances (other agents, the
  user's browser) run concurrently. Cleanest single-scan figure:
  example.com with no other Chrome running, 548 MB. The 2.3–2.8 GB
  figures in the report include those other browsers. Per-scan cost
  in isolation is ~0.5–1 GB; do not run two scans per GB.
- **CPU seconds are approximate.** Node CPU is exact; Chromium CPU is
  accumulated from `/proc` samples every 250 ms, so short-lived
  renderer processes can lose a slice. Values also include other
  Chrome processes' CPU when they run concurrently (same caveat as
  RSS) — treat them as an upper bound.
- **Sandbox relay bug (found and fixed 2026-11-18).** The first
  `egress-relay.js` wrote bytes arriving after a CONNECT 200 response
  back *upstream* instead of to the client, corrupting tunnels whose
  200 + first TLS bytes arrived together, and never closed dead
  sockets (CLOSE-WAIT leak). It made Commons navigation time out
  twice (30 s cap, `ERR_TIMED_OUT`) while direct egress `curl`
  fetched the same page in 0.9 s. Fixed (forward to client, close
  propagation, 15 s establish timeout); Commons navigation is now
  ~2 s. The relay is sandbox-only test plumbing, not part of the
  scanner.
- **Bot protection / 403s.** Some sites block headless Chromium (or
  the sandbox proxy). A 403/429 is recorded as verdict `ERROR`, not
  silently treated as clean.
- **DNS pinning.** The SSRF check resolves the host once per scan and
  caches it; a hostile host that flips its DNS between check and fetch
  (rebinding) is not yet pinned to one IP, and the browser does not yet
  run in a network namespace without internal routes. Both belong in
  the production hardening pass.
- **Navigation timeouts.** The 30 s `domcontentloaded` cap is real:
  Commons hit it twice when the (buggy) sandbox relay stalled
  (see relay note above). With the fixed relay, Commons navigates in
  ~2 s. On a slow network a heavy page can still exceed the cap; the
  scan then reports `ERROR` with whatever was collected, honestly.
- **In-page detection hangs (lesson learned, fixed).** The first
  version ran face-api inside the scanned page. On Wikipedia it hung
  indefinitely (idle renderer, no CPU) — never diagnosed to a single
  cause, but the detector page architecture removed the whole class:
  detection now runs in a clean `about:blank` page with a 25 s
  Node-side timeout per element and page recycling on timeout.
  (Also found: Playwright's `page.evaluate` has no working `timeout`
  option — a never-resolving evaluate with `{ timeout: 3000 }` was
  still pending after 31 s — so timeouts are enforced with
  `Promise.race` in Node.)
