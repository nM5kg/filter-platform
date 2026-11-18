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
| `scanner.js` | The scanner. SSRF guard, Playwright render, element collection, face-api.js detection, decisions, resource measurement. CLI: `node scanner.js <url> [--out file.json] [--proxy URL] [--spki-pin B64] [--screenshot] [--max-images N]` |
| `scan.js` | Scan runner. Scans the default real-site list (or URLs given on the command line), writes one JSON + one PNG screenshot per site into `results/`, and generates `SCAN_REPORT.md`. |
| `models/face-api.js` | face-api.js UMD bundle (@vladmandic fork 1.7.15, MIT) — injected into the scanned page. |
| `models/tiny_face_detector_model-weights_manifest.json` + `.bin` | tinyFaceDetector weights (193 KB) — served to the page from local disk, never fetched from the internet. |
| `results/` | One `<slug>.json` Visual Content Map + `<slug>.png` screenshot per scanned site. |
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
4. **Detect people (on-device, CPU-first).** face-api.js
   `tinyFaceDetector` runs in a **dedicated detector page**
   (`about:blank`), NOT in the scanned page — the scanned page's
   scripts, timers, CSP, and tainted canvases cannot stall or corrupt
   detection, and a wedged detector page can be closed and recreated
   without touching the scan. The CPU backend is forced
   (`tf.setBackend('cpu')`). The script and the model weights are
   bundled locally in `models/`; the weights are served to the
   detector page by intercepting a fake origin
   (`https://scanner-models/`) and fulfilling from disk — no model
   download at scan time, no pixels leave the browser. Images are
   loaded by URL in the detector page; `<video>` and `<canvas>` are
   sampled via element screenshots (which also bypasses CORS taint).
   Each element gets a 25 s Node-side timeout (Playwright's
   `page.evaluate` has no working timeout option — verified: a
   never-resolving evaluate with `{ timeout: 3000 }` ran past 31 s,
   so the timeout is enforced with `Promise.race` in Node). The
   largest 40 visible elements (≥ 32×32 px) are checked; the rest
   are counted in `detection_skipped`.
   - Face score ≥ 0.70 → `person` (0.70 is the Standard policy threshold)
   - Face found with 0.40–0.70 → `uncertain`
   - No face → `none`
   - Element cannot be analysed at all (CORS-tainted image, blank WebGL
     canvas, detector failure) → `uncertain` with a `note`
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
  "detector": { "name": "face-api.js tinyFaceDetector (vladmandic fork 1.7.15)", "backend": "cpu", "loaded": true, "error": null },
  "elements": [
    { "type": "img", "selector": "div > img", "box": { "x": 10, "y": 20, "w": 300, "h": 200 },
      "detection": "person", "confidence": 0.93, "faces": 2, "decision": "BLOCK", "src": "https://…" }
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
npm install            # playwright only; Chromium already in ~/.cache/ms-playwright
node scan.js           # default real-site list -> results/ + SCAN_REPORT.md
node scanner.js <url> --out results/x.json --screenshot
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
| MediaPipe / @mediapipe/tasks-vision (ImageSegmenter, FaceDetector, BlazePose) | **Apache 2.0** | `LICENSE` fetched from GitHub + npm `license: Apache-2.0` | ✅ Permissive. Note: MediaPipe *models* (e.g. face_detector.tflite) are distributed under their own terms — check the model card for each model before use. |
| ONNX Runtime (+ onnxruntime-web) | **MIT** | npm registry `license: MIT` for onnxruntime-node; GitHub blob page for `LICENSE` exists and is detected as MIT. Raw fetch returned 404 in this sandbox (proxy quirk) — **re-verify the full text before shipping** | ✅ Permissive (pending that re-check). |
| OpenCV | **Apache 2.0** | `LICENSE` fetched from GitHub (4.x branch) | ✅ Permissive. |
| Open Model Zoo (incl. person-detection-0202) | **Apache 2.0** | Repo `LICENSE` fetched + root README: "Open Model Zoo is licensed under Apache License Version 2.0". The person-detection-0202 model README carries no separate license, so it falls under the repo license — **re-verify per model** (a few OMZ models have different terms) | ✅ Permissive, with the per-model re-check. |
| NSFWJS (content classification) | **MIT** | `LICENSE` fetched from GitHub | ✅ Permissive. Note: its models are the question, not the code — NSFWJS models are MIT-licensed too, but check the model release notes. |

**Bottom line:** every candidate in the upgrade path is permissive
(MIT / Apache 2.0) — none is copyleft (no GPL/AGPL). The license risk
is not the code, it is the **model weights**: each model file needs its
own check (MediaPipe model cards, OMZ per-model notes, NSFWJS model
releases). Keep a `LICENSES.md` next to any model you ship, with the
source URL and the license text, and re-check on every model update.

## Upgrade path (from this prototype)

1. **Person detection, not just faces (next).** tinyFaceDetector only
   sees faces — a person photographed from behind, a body with the face
   turned away, or a small/distant figure is missed. The next step is a
   full person detector: OpenVINO `person-detection-0202` (MobileNetV2
   + SSD, ~3.1 GFLOPs, Apache 2.0) via ONNX Runtime, or MediaPipe
   BlazePose / ObjectDetector (person class) via Tasks Vision. Either
   runs CPU-first; ONNX Runtime Web can run inside the page like
   face-api does now, or the detector can move to the scanner process
   (Node + `onnxruntime-node`, screenshots as input).
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

Final verified run: **2026-11-18 ~10:14 UTC** (`node scan.js`, code as
shipped, no `bypassCSP`). Full detail in
[`SCAN_REPORT.md`](SCAN_REPORT.md) and `results/*.json` (+ screenshots).
Policy standard-v1 throughout. Detector: face-api.js tinyFaceDetector,
CPU backend, models bundled locally. Runs happened on this VM through
the sandbox egress relay + TLS SPKI pin (see above); the scanner's own
numbers are the same code path as production (direct internet, no
proxy/pin).

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

- **Faces only, not people.** tinyFaceDetector misses bodies without
  a visible face (back of head, distant figures, cropped bodies).
  Every such image lands in REVIEW (covered), which is safe but noisy
  until the person detector lands.
- **CORS-tainted images.** A cross-origin `<img>` without CORS headers
  cannot be read as pixels; background images from such hosts fail the
  same way. They become `uncertain` → REVIEW, with a note.
- **Canvas / WebGL.** A `<canvas>` whose drawing buffer was already
  presented (no `preserveDrawingBuffer`) reads back blank; WebGL
  content is effectively unanalysable in-page. Recorded as `uncertain`.
- **Video is one frame.** Only the current frame at scan time is
  checked; later frames are not.
- **Lazy / infinite content.** The scroll pass triggers lazy loading,
  but infinite-scroll pages keep growing; the scanner stops after one
  full pass and records what it saw.
- **Detection budget.** 40 largest visible elements per scan; the rest
  are `uncertain` → REVIEW and counted in `detection_skipped`
  (BBC: 33 skipped in the final run, 66 in the first — live pages
  change; Commons: 24 skipped). Raising the budget costs ~1.3 s of
  CPU per image on this VM.
- **Detection speed (CPU).** ~1.2–1.5 s per image with tinyFaceDetector
  on the CPU backend (a few images take ~4 s). A 40-image page costs
  ~60–90 s end-to-end. A person detector (ONNX/OpenVINO) or a WASM
  backend would cut this substantially.
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
