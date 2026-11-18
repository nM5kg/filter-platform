# Filter Platform — Browser Extension (Phase 2)

Chrome/Edge MV3 extension. Detects human figures in images **on-device** and
blocks/covers them per the Phase 1 policy, and blocks listed domains via
declarativeNetRequest rules fetched from the Phase 1 API.

## Model choice (human detection)

- **Library:** `@vladmandic/face-api` 1.7.15 — the maintained fork of
  `face-api.js` (original by justadudewhohacks). **License: MIT.**
  Bundled locally at `vendor/face-api.js` (1.3 MB, includes TensorFlow.js);
  no CDN, no network fetch of library code.
- **Model:** `tinyFaceDetector` (Tiny Face Detector, ~190 KB weights) from
  the original face-api.js weights repo
  (`justadudewhohacks/face-api.js`, weights/ — **MIT**), stored locally in
  `models/` (manifest + 1 shard). Input size 320, score threshold 0.5.
- **Signal:** face **presence only**. A detected face = a human in the
  picture. We do **not** use gender, age or identity classification for any
  decision (per the project brief: human-figure detection, not gender
  guessing). No image data leaves the browser; detection runs in the
  content script via TensorFlow.js (CPU/WebGL backend in-page).
- **Why not MediaPipe:** MediaPipe Tasks Vision (Apache 2.0) needs its WASM
  runtime + model files fetched from a CDN or a larger local bundle, and its
  face detector is heavier to wire into an MV3 content script. face-api.js
  tinyFaceDetector is the smallest working on-device option that actually
  runs inside an extension page context. A person detector (full body, no
  face needed) is a Phase 3+ upgrade — see Limits.

## Files

- `manifest.json` — MV3: background service worker, content script on all
  http(s) pages, `storage` + `declarativeNetRequest` + `alarms`.
- `background.js` — fetches device policy + blocklist from the Phase 1 API
  (`GET /api/v1/devices`, `GET /api/v1/policies/:id` or default,
  `GET /api/v1/domains?decision=block`), caches them, builds DNR dynamic
  rules (`*://domain/*` and `*://*.domain/*` per domain), re-syncs hourly.
  The API token + device id are **not** in this code — the user pastes them
  in the popup; they live only in `chrome.storage.local`.
- `content.js` — scans `<img>`, CSS `background-image`, lazy images
  (`loading=lazy`, `data-src`) and dynamically added content
  (`MutationObserver` + scroll/load listeners). Per image: face detection →
  human → block (replace with a Yiddish placeholder) or cover (blur +
  overlay); uncertain (e.g. cross-origin canvas taint) → left alone, except
  in strict mode where uncertain is covered. Stats on `window.__fpStats`,
  per-image log on `window.__fpLog`.
- `popup.html` / `popup.js` — Yiddish RTL popup: paste API token + device
  id (+ optional customer id), demo mode switch (policy / block / cover /
  strict), sync button, policy + rule-count + stats display.
- `vendor/face-api.js` — bundled face-api.js (+ tfjs), MIT.
- `models/` — tinyFaceDetector weights (MIT).
- `test-page/index.html` + `test-page/photos/` — local test page (see below).
- `verify/` — verification log (`VERIFY.md`) + screenshots.

## Policy modes

- Standard policy from Phase 1: `block_images=true` → **block** mode.
- Popup demo switch overrides for demo: `block` (remove/replace),
  `cover` (blur + overlay, page stays usable), `strict` (uncertain
  detections count as human → cover). `policy` = follow the server policy.

## Test page

`test-page/index.html` (serve locally, e.g. `python3 -m http.server 8123`):
3 people photos + 3 non-people photos (real photos from Wikimedia Commons,
see `photos/`), a CSS background-image person photo, a cross-origin person
photo (Wikimedia), a facebook.com probe image (DNR block test), a
dynamically injected person photo after 2 s (MutationObserver test), and a
lazy-loaded person photo below the fold (scroll test). Photos:

- `person-einstein.jpg` — Albert Einstein (Wikimedia Commons, public domain)
- `person-obama-family.jpg` — Obama family portrait 2011 (Wikimedia Commons, public domain)
- `person-marie-curie.jpg` — Marie Curie c.1920 (Wikimedia Commons, public domain)
- `nopeople-apple.jpg` — red apple (Wikimedia Commons)
- `nopeople-cat.jpg` — cat poster (Wikimedia Commons)
- `nopeople-earth.jpg` — The Blue Marble, Earth (Wikimedia Commons, NASA, public domain)

## Install (unpacked, Chrome/Edge)

1. `chrome://extensions` → Developer mode → Load unpacked → pick this
   `extension/` folder.
2. Open the popup, paste your API token + device id, choose a mode, Save.
3. Open the test page (local server) and watch images get blocked/covered.

## Known limits (verified, see verify/VERIFY.md)

- Face detector only: a person with no visible face (back view, far away,
  cropped out) is **not** detected. Full-body person detection is future work.
  Group photos: only the clearest face(s) are found (1 face reported for a
  family portrait), though blocking still triggers on ≥1 face.
- Cross-origin images without CORS: the canvas is tainted, pixels cannot be
  read, detection is "uncertain" (left alone in block/cover mode, covered in
  strict mode). Same-origin images (e.g. the local test page) work fully.
- Canvas-rendered images (`<canvas>`), Shadow DOM content, and video frames
  are not scanned in this phase (video filtering is a later phase).
- DNR rules block requests, but cannot rewrite page content; a blocked
  main-frame navigation shows the browser's block error page. Note: DNR
  rules MUST list `resourceTypes` explicitly (incl. `main_frame`) — verified
  in Chrome 159, a rule without them did not block navigations.
- First scan is slow on software rendering (~25 s for 10 images on this
  VM's SwiftShader); on a real machine with GPU/WebGL it is far faster.
  A 20 s per-image detection timeout guards against hangs.

## Verification

`verify/VERIFY.md` + `verify/results.json` + screenshots — Playwright
(Chrome 159, headless), three modes (block / cover / strict), exact counts
per image. Live API fetch from the extension could NOT be verified in this
VM (Chromium has no working internet route here); policy sync was verified
via the cache path with real live API data, and DNR blocking was verified
live (`ERR_BLOCKED_BY_CLIENT` for facebook.com). Google Images was
unreachable from this VM's Chromium and is unverified.
