# Phase 2 verification log — 2026-11-18

Acceptance test for the Filter Platform browser extension (Phase 2).
Run with the harness `~/workspace/filter-platform/harness/verify-phase2.js`
(Playwright 1.65.1, Chromium 159.0.8154.6 "Chrome for Testing", headless).
Final run: 2026-11-18 ~10:20–10:23 EST, all three modes, exit 0.
Raw machine-readable results: `results.json` in this folder.

## How it ran

- Unpacked extension loaded via `--load-extension` in a fresh persistent
  context per mode. Extension id (path-derived, stable):
  `keibjodbjaonlckfkaejiiefaikphdfg`.
- The REAL popup page (`chrome-extension://<id>/popup.html`) was used to seed
  the API token + device id + demo mode, exactly as a user would.
- Device: real Phase 1 device "Dogfood Phone"
  (`eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a`, customer `142e6a02-…`, active) on
  the Standard policy (`179d3448-98d0-4eb4-8a2c-ac813a648e84`).
- Test page served locally (`python3 -m http.server` on 127.0.0.1:8123, plus
  a second server on 127.0.0.1:8124 for the cross-origin test image).

## 1. Policy fetch from the live API

- **Live fetch from the service worker: FAILED in all 3 runs.**
  `sync attempt 1: {"policyFetched":false,"error":"Failed to fetch"}`.
  Cause: this VM's Chromium cannot reach the public internet — every external
  request fails with `ERR_TUNNEL_CONNECTION_FAILED` (the VM egress proxy
  works for curl, not for Chromium). This is a VM environment limit, not an
  extension bug: the same API answers curl fine (see below), and the
  extension's fetch code is a plain `fetch()` with a Bearer header.
- **Fallback used (shipped feature, `rulesBuiltFromCache: true`):** the
  harness fetched the REAL policy + blocklist from the live API with curl and
  seeded them as the extension's cache; the background then rebuilt the DNR
  rules from cache. Policy confirmed live by curl at verification time:
  `Standard — block images + explicit words, rest open`, `block_images=true`,
  `cover_images=false`, `auto_decide_threshold=0.70`. Blocklist: **11 real
  domains** (bet365, facebook, instagram, onlyfans, pornhub, reddit,
  snapchat, tiktok, x, xnxx, xvideos).
- On a normal machine with internet, the live fetch is the path taken
  (nothing in the code is specific to the cache path). Re-verify live fetch
  on a machine with direct internet before calling this "fully live".

## 2. declarativeNetRequest rules

- Background built **22 dynamic rules** in every run (2 per domain:
  `*://<domain>/*` and `*://*.<domain>/*`), verified by reading them back
  with `chrome.declarativeNetRequest.getDynamicRules()` from the popup page.
- **Blocked-domain navigation — BLOCKED in all 3 runs:**
  `page.goto('https://www.facebook.com/')` → `net::ERR_BLOCKED_BY_CLIENT`.
- **Blocked-domain subresource — BLOCKED:** the test page's
  `<img src="https://www.facebook.com/favicon.ico">` never loaded
  (`complete=true, naturalWidth=0`); its performance entry shows
  `transferSize=0, duration=13ms`; a `fetch()` of the same URL from the page
  rejects with `TypeError: Failed to fetch`. A separate focused probe also
  showed a locally-blocked subresource image failing with
  `ERR_BLOCKED_BY_CLIENT`.
- **Important DNR finding (fixed during verification):** a rule with NO
  `resourceTypes` blocked subresources but did NOT block main-frame
  navigations in Chrome 159 (navigation returned 404 / tunnel error instead
  of `ERR_BLOCKED_BY_CLIENT`). With an explicit `resourceTypes` list
  (incl. `main_frame`) the navigation is blocked. `background.js` now lists
  all resource types explicitly.

## 3. Test page results (exact numbers)

The page has 11 `<img>` elements + 1 CSS background image. "Found" = distinct
`<img>` elements detection was attempted on (9); "scanned" = detection records
(10 = 9 images + 1 background). "Skipped" = distinct images skipped at least
once (3 — see per-image table). First scan took ~25–26 s per run
(SwiftShader software rendering on this VM; see Limits).

| mode | found | scanned | human | no-human | uncertain | blocked | covered | bg found/human | skipped |
|------|-------|---------|-------|----------|-----------|---------|---------|----------------|---------|
| block | 9 | 10 | 6 | 3 | 1 | 6 | 0 | 1 / 1 | 3 |
| cover | 9 | 10 | 6 | 3 | 1 | 0 | 6 | 1 / 1 | 3 |
| strict | 9 | 10 | 6 | 3 | 1 | 0 | 7 | 1 / 1 | 3 |

Checks: `human + noHuman + uncertain = scanned` (6+3+1=10) in all runs.
Block: blocked (6) = human (6). Cover: covered (6) = human (6).
Strict: covered (7) = human (6) + uncertain (1) — strict covers uncertainty.

### Per image (identical classification in all 3 runs)

| image | detector | block | cover | strict |
|-------|----------|-------|-------|--------|
| Einstein portrait (same-origin) | human, 1 face | blocked (placeholder) | covered (blur) | covered |
| Obama family portrait (same-origin) | human, 1 face | blocked | covered | covered |
| Marie Curie portrait (same-origin) | human, 1 face | blocked | covered | covered |
| Apple (same-origin) | no-human, 0 faces | untouched | untouched | untouched |
| Cat poster (same-origin) | no-human, 0 faces | untouched | untouched | untouched |
| Earth / Blue Marble (same-origin) | no-human, 0 faces | untouched | untouched | untouched |
| CSS background-image, Einstein div | human, 1 face | background removed | blur overlay | blur overlay |
| Dynamic Obama photo (JS-injected after 2 s) | human, 1 face | blocked | covered | covered |
| Lazy Marie Curie (`loading=lazy`, below fold) | human, 1 face | blocked | covered | covered |
| Cross-origin Einstein (127.0.0.1:**8124**, no CORS) | uncertain — "cross-origin without CORS — pixels unreadable" | left visible | left visible | **covered** |
| Cross-origin Einstein (Wikimedia Commons) | never loaded in this VM (`ERR_TUNNEL_CONNECTION_FAILED`) | skipped | skipped | skipped |
| facebook.com favicon probe | never loaded (DNR-blocked) | skipped | skipped | skipped |

Notes:
- The Obama family portrait has several faces; the detector reported 1 face
  (the largest/clearest). Blocking still triggers (≥1 face = human), but
  small/distant faces in group photos are missed — see Limits.
- In block mode the dynamic image is *replaced* by a placeholder, so
  `document.getElementById('img-dynamic')` is absent afterwards; the log
  entry (human → blocked) is the proof it was handled. Same for the lazy
  image in block mode.
- The two "uncertain" cases in earlier (pre-fix) runs were detection
  timeouts caused by real bugs (concurrent scans corrupting tfjs; detection
  attempted on a mid-decode image). Both are fixed in the shipped code; the
  only remaining uncertain case is the genuinely unreadable cross-origin
  image.

### MutationObserver / lazy proof

- Dynamic image (injected by page JS 2 s after load): detected and
  blocked/covered in all 3 runs — MutationObserver re-scan works.
- Lazy image (below the fold, `loading=lazy`): only processed after the
  harness scrolled the page; detected and blocked/covered in all 3 runs.
- The content script's re-scan is serialized (one scan at a time) — see
  "bugs found" below.

## 4. Google Images (real site)

- **Not testable in this VM.** `https://images.google.com/search?q=albert+einstein&tbm=isch`
  fails in Chromium with `net::ERR_TUNNEL_CONNECTION_FAILED` in all 3 runs —
  the same egress-proxy failure as every other external Chromium request.
  The content script's Google behavior is therefore **unverified**; it needs
  a machine with working internet in Chrome. (The content script matches
  all http(s) pages, including Google Search/Images, and would run there;
  cross-origin Google thumbnail images would mostly be "uncertain" — see
  Limits.)

## 5. What did NOT work / known limits (do not hide)

1. **Live API fetch from the extension fails in this VM** (see §1). Policy
   sync was verified via the cache path with real live data, not via a live
   in-browser fetch. Re-verify on a machine with internet.
2. **Google Images not reached** (see §4).
3. **Face detection only.** A person with no visible face (back view, far
   away, cropped out) is NOT detected. Full-body person detection is future
   work. Group photos: only the clearest face(s) are found (Obama portrait:
   1 face reported).
4. **Cross-origin images without CORS are unreadable.** Canvas taint means
   pixels cannot be read; such images are "uncertain" (left alone in
   block/cover, covered in strict). Verified live with the :8124 image.
   Same-origin images and CORS-enabled images (`crossOrigin='anonymous'`
   + server CORS headers) work fully.
5. **Canvas-rendered images (`<canvas>`), Shadow DOM content, and video
   frames are NOT scanned** in this phase (not implemented; video filtering
   is a later phase). No test was run for them — they are out of scope here,
   not silently passing.
6. **First scan is slow on this VM: ~25 s** for 10 detections (SwiftShader
   software WebGL, 1.5 shared CPUs). On a real machine with GPU/WebGL it
   should be ~100–500 ms per image. A 20 s per-image detection timeout
   guards against hangs; a detection that exceeds it is "uncertain".
7. **DNR blocks requests, it cannot rewrite page content.** A blocked
   main-frame navigation shows the browser's `ERR_BLOCKED_BY_CLIENT` error
   page, not a Yiddish block page (a custom block page would need a
   redirect rule + an extension page — future work).
8. **The VM's own Chromium cannot be used for headed testing** (Hatch
   policy error) and headed Playwright launches under Xvfb timed out at
   launch (60 s / 180 s); all verification here is headless, which works
   once the extension-loading flags are fixed (see below).

## 6. Bugs found and fixed during verification

1. `manifest.json` declared `"default_locale": "en"` with no `_locales/`
   folder → Chrome refused to load the extension ("Default locale was
   specified, but _locales subtree is missing"). Removed the key.
2. Playwright's default flags `--disable-extensions` and
   `--disable-component-extensions-with-background-pages` prevent
   `--load-extension` from loading anything. The harness removes both via
   `ignoreDefaultArgs`. (Also: `--disable-extensions-except` takes
   extension IDs, not paths — it was dropped.)
3. DNR rules without `resourceTypes` did not block main-frame navigations
   in Chrome 159 → explicit resource type list (see §2).
4. Content-script `window.__fpStats` is invisible to the page (isolated JS
   world) → stats are now mirrored into the DOM (`data-fp-*` attributes +
   `#fp-dom-stats` JSON div); the test page's status panel reads the DOM.
5. Two concurrent scans corrupted tfjs/WebGL (unrelated same-origin images
   went "uncertain", one run's first scan never finished — 240 s timeout).
   Scans are now serialized (single runner + pending flag).
6. Detecting a mid-decode image hangs tfjs forever → images are only
   detected when `complete` is true; skipped images are retried by later
   scans (previously they were marked processed and never retried).
7. Cross-origin images without CORS were passed to tfjs, which threw an
   uncaught `SecurityError` (tainted canvas) and hung the detection promise
   → such images are now marked uncertain without calling tfjs at all.
8. Background-image scan double-counted `scanned` (manual increment +
   `record()`) → fixed; stats now reconcile exactly (see §3 checks).
9. Popup "save" previously needed a manual refresh to sync; storage changes
   now auto-trigger a sync, and a failed sync rebuilds DNR rules from the
   cache (offline resilience).

## 7. Screenshots

- `block-mode.png` — full test page, block mode: 3 person photos replaced
  by Yiddish blocked placeholders, apple/cat/Earth visible, background-image
  box emptied, cross-origin :8124 Einstein visible (uncertain), dynamic +
  lazy photos replaced, live stats panel at the top.
- `cover-mode.png` — same page, cover mode: person photos blurred with
  overlay badges, rest untouched, live stats panel.
- `strict-mode.png` — same page, strict mode: person photos + the
  uncertain cross-origin photo all blurred.
- `*-google-images.png` — the failed Google Images navigation (proxy
  error page, 26,971 bytes each — identical, since the navigation never
  reached Google).

## 8. Model choice (record)

- Library: `@vladmandic/face-api` 1.7.15 (maintained fork of `face-api.js`),
  **MIT**, bundled locally (`vendor/face-api.js`, 1.3 MB incl. TensorFlow.js).
- Model: `tinyFaceDetector` weights (~190 KB) from the original
  `justadudewhohacks/face-api.js` weights repo, **MIT**, in `models/`.
  Input size 320, score threshold 0.5.
- Signal: face **presence only**. No gender, age, or identity classification
  is used for any decision. All detection runs on-device; no image data
  leaves the browser.
