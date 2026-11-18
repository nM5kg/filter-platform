# Filter Platform — Browser Extension (Phase 2)

Chrome/Edge MV3 extension. Detects human figures in images **on-device** and
blocks/covers them per the Phase 1 policy, and blocks listed domains via
declarativeNetRequest rules fetched from the Phase 1 API.

## Model choice (human detection)

Two detectors run in parallel on every image; a **person OR face hit
counts as human** (presence only — we do **not** use gender, age or
identity classification for any decision, per the project brief:
human-figure detection, not gender guessing). No image data leaves the
browser.

- **Person detector (primary, v1.1.0):** MediaPipe Tasks Vision
  `ObjectDetector`, EfficientDet-Lite0 trained on COCO, category
  allowlist `['person']` — the same detector as `scanner/detector.js`.
  It sees bodies without a visible face (back views, groups, distant
  figures) where the face detector is blind. **PROTOTYPE-ONLY: the
  EfficientDet-Lite0 *weights* license is UNVERIFIED** (the
  `@mediapipe/tasks-vision` runtime code is Apache 2.0, but Google's
  docs state no weights license — see `models-mediapipe/LICENSES.md`).
  Per Yakob's decision this model is for prototype / first testing
  only; do **not** treat it as production-licensed. Weights
  `models-mediapipe/efficientdet_lite0.tflite` (7.2 MB, float16,
  SHA-256 `4b591000…80993`, same file + hash as the scanner).
  Runs on CPU via WASM (`@mediapipe/tasks-vision` 1.2.3, Apache 2.0,
  bundled in `vendor-mediapipe/`).
- **Face detector (fallback + complement):** `@vladmandic/face-api`
  1.7.15 — the maintained fork of `face-api.js` (original by
  justadudewhohacks). **License: MIT.** Bundled locally at
  `vendor/face-api.js` (1.3 MB, includes TensorFlow.js); no CDN, no
  network fetch of library code.
- **Model:** `tinyFaceDetector` (Tiny Face Detector, ~190 KB weights) from
  the original face-api.js weights repo
  (`justadudewhohacks/face-api.js`, weights/ — **MIT**), stored locally in
  `models/` (manifest + 1 shard). Input size 320, score threshold 0.5.
- **Signal:** face **presence only**. A detected face = a human in the
  picture. We do **not** use gender, age or identity classification for any
  decision (per the project brief: human-figure detection, not gender
  guessing). No image data leaves the browser; detection runs in the
  content script via TensorFlow.js (CPU/WebGL backend in-page).
- **Thresholds:** person or face best score ≥ **0.50** → human (the
  old face-only threshold, kept); best score in [0.40, 0.50) → uncertain.
  Note this differs from the scanner, which uses a 0.70 policy
  threshold — so the extension calls some 0.5–0.7 person detections
  "human" that the scanner would call "uncertain". See
  `verify/VERIFY-person-detector.md` for the measured effect.
- **Fail closed:** an image neither detector could clear (both
  detectors failed, a weak 0.40–0.50 signal, or unreadable pixels,
  e.g. cross-origin without CORS) is **uncertain and gets COVERED in
  block/cover/strict modes** — never left visible as if it were clean.
  Only `allow` mode leaves it alone, and only a clean no-human verdict
  leaves an image untouched. (Changed in v1.1.0: uncertain images used
  to stay visible in block/cover mode, covered only in strict.)

### How the person detector runs inside MV3

MediaPipe's loader injects its WASM runtime as a classic `<script>`
into `document.body`, so the bundle and the WASM loader must share
one JS world — a content script's isolated world cannot do that. So
the detector lives in `detector.html`, a hidden `chrome-extension://`
iframe (an extension-origin page, same arrangement as the scanner's
dedicated detector page), and `detector.js` bridges to it over
`postMessage`:

- `detector.js` (content script) injects the iframe lazily on the
  first scan, waits for its `fp-detector-present` ping, then sends a
  `fp-detector-warmup` (loads the model, ~0.5 s after the first page
  load in tests) and per-image `fp-detect-person` messages carrying a
  downscaled JPEG data URL (max 960 px — EfficientDet resizes to
  320×320 internally, so nothing is lost). Only detection numbers
  come back (`{persons, personBest, boxes}`).
- `detector-page.js` (module inside the iframe) imports the bundled
  `vision_bundle.mjs`, resolves the WASM runtime from
  `vendor-mediapipe/tasks-vision-wasm/`, and creates the
  `ObjectDetector` with the bundled `.tflite`. It makes no network
  request except fetching those bundled extension files.
- Messages are validated on both sides (`event.source` must be the
  iframe's window, `event.origin` must be this extension).
- The manifest needs `content_security_policy.extension_pages` with
  `'wasm-unsafe-eval'` — MV3's default CSP blocks WebAssembly
  compilation otherwise. `wasm-unsafe-eval` permits WASM only, not
  `eval()` or inline scripts.
- If the iframe cannot load (e.g. a page whose CSP blocks
  `chrome-extension://` iframes via `frame-src`), the bridge fails
  fast (10 s) and the extension falls back to face-only detection on
  that page. If the person detector fails but face-api works, faces
  still block; if both fail, the image is covered (fail closed).

## Files

- `manifest.json` — MV3: background service worker, content script on all
  http(s) pages, `storage` + `declarativeNetRequest` + `alarms`.
- `background.js` — fetches device policy + blocklist from the Phase 1 API
  (`GET /api/v1/devices`, `GET /api/v1/policies/:id` or default,
  `GET /api/v1/domains?decision=block`), caches them, builds DNR dynamic
  rules (`*://domain/*` and `*://*.domain/*` per domain), re-syncs hourly.
  The API token + device id are **not** in this code — the user pastes them
  in the popup; they live only in `chrome.storage.local`.
  **Phase 3 (2026-11-18):** also fetches `GET /api/v1/ads/blocklist` (26
  ad/tracker domains) and builds DNR rules from it — **only when the device
  policy has `filter_ads=true`**. Ads rules live in their own id range
  (5000+, domains stay 1000+) so the two sets never collide; the status
  object reports `adBlocklistDomains`, `adRulesCount`, `adsEnforced`, and
  the popup shows the ads-filter state. The Standard policy has
  `filter_ads=false`, so by default the 26 domains are fetched but NOT
  enforced. The cache fallback applies the same gate (cached ads list +
  cached policy flag). A failed ads fetch degrades to an empty ads list and
  never breaks the domains sync.
  **Phase 3b — block page + SafeSearch (2026-11-18):** `background.js`
  also fetches `GET /api/v1/safesearch` (7 engine rules; the Standard
  policy has `force_safesearch=true`) and builds DNR rules from it — see
  "Block page + SafeSearch" below. Blocked main-frame navigations are
  REDIRECTED to `blocked.html` (rule ids 3000+, one per blocked domain,
  `?d=<domain>`) instead of failing with `ERR_BLOCKED_BY_CLIENT`;
  subresources of blocked domains are still hard-blocked (rule ids 1000+,
  all types except `main_frame`). Ads domains get the same treatment when
  `filter_ads=true` (their redirects join the 3000+ range, so a direct
  navigation to doubleclick.net now lands on the block page instead of
  the browser error page). The status object reports
  `blockRedirectRules`, `force_safesearch`, `safeSearchEnforced`,
  `safeSearchRulesCount`, `safeSearchEngines`, `safeSearchSource`, and the
  SafeSearch list is cached in `fpSafeSearch` so the offline cache path
  rebuilds it under the same `force_safesearch` gate. No secrets are in
  the code; the token still comes only from the popup.
- `blocked.html` / `blocked.js` — Yiddish RTL block page shown instead of
  the browser error page. Shows the blocked domain (from `?d=`), the
  policy name (read from `chrome.storage.local`), a link to request a
  review and a link to the dashboard
  (`https://filter-platform-dashboard.pages.dev`), and a back button.
  `blocked.js` is a separate file (MV3 extension pages forbid inline
  scripts). See `MANIFEST-PATCH-B.md` for the one manifest addition
  (`blocked.html` in `web_accessible_resources`) — verified NOT blocking
  in Chrome 159, kept as belt-and-braces.
- `MANIFEST-PATCH-B.md` — exact manifest JSON to merge (another agent
  owns `manifest.json`); no new permissions are needed.
- `content.js` — scans `<img>`, CSS `background-image`, lazy images
  (`loading=lazy`, `data-src`) and dynamically added content
  (`MutationObserver` + scroll/load listeners). Per image: person +
  face detection → human → block (replace with a Yiddish placeholder)
  or cover (blur + overlay); uncertain (detector failure, weak signal,
  unreadable pixels) → covered in block/cover/strict modes (fail
  closed, since v1.1.0). Stats on `window.__fpStats`, per-image log on
  `window.__fpLog`; `window.__fpPersonReady` / `data-fp-person-ready`
  say whether the person detector loaded.
- `detector.js` — content-script side of the person-detector bridge:
  injects the hidden detector iframe, warmup + per-image requests over
  `postMessage`, downscales images to JPEG data URLs (max 960 px).
  **v1.2.0:** also exposes `fetchImage(url)` — fetches image bytes
  through the iframe (extension origin, not CORS-gated) for the
  cross-origin refetch; see "Cross-origin refetch" in Known limits.
- `detector.html` / `detector-page.js` — hidden extension-origin
  iframe hosting the MediaPipe person detector (ES module, imports the
  bundled tasks-vision runtime). `detector.html` is the only new file
  in `web_accessible_resources`; the model/WASM files are fetched by
  the extension page itself, not by web pages.
- `vendor-mediapipe/tasks-vision/vision_bundle.mjs` —
  `@mediapipe/tasks-vision` 1.2.3 (Apache 2.0), copied from
  `scanner/models/`.
- `vendor-mediapipe/tasks-vision-wasm/` — MediaPipe vision WASM
  runtime (`vision_wasm_internal.js` + `.wasm`, ~15 MB), copied from
  `scanner/models/`.
- `models-mediapipe/` — `efficientdet_lite0.tflite` (7.2 MB, SHA-256
  `4b591000…80993`) + `LICENSES.md` (copied verbatim from
  `scanner/models/` — **weights license UNVERIFIED, prototype-only**).
- `popup.html` / `popup.js` — Yiddish RTL popup: paste API token + device
  id (+ optional customer id), demo mode switch (policy / block / cover /
  strict), sync button, policy + rule-count + stats display. The status
  lines now include the ads filter (`אָן` with rule/domain counts, or
  `אויס (פּאָליטיק filter_ads=ניין)`).
- `vendor/face-api.js` — bundled face-api.js (+ tfjs), MIT.
- `models/` — tinyFaceDetector weights (MIT).
- `test-page/index.html` + `test-page/photos/` — local test page (see below).
- `verify/` — verification log (`VERIFY.md`) + screenshots.

## Block page + SafeSearch (2026-11-18)

**Block page.** A navigation to a blocked domain (blocklist, or an ads
domain when `filter_ads=true`) is redirected by a DNR rule
(`redirect.extensionPath`, the documented MV3 mechanism, ids 3000+) to
`blocked.html?d=<domain>`. The page is Yiddish RTL and names the domain
and the policy, links to the dashboard to request a review, and offers a
back button. Limit: `extensionPath` carries a static string per rule, so
only the domain — not the full original URL — is passed to the page; the
policy name comes from storage instead. Verified live: facebook.com and
doubleclick.net navigations land on the block page with the right domain
and policy name (see Verification).

**SafeSearch.** When the synced policy has `force_safesearch=true`
(Standard: true; a missing field defaults to ON, an explicit `false`
turns it off), the extension adds the SafeSearch-strict query param to
search navigations via DNR `redirect.transform.queryTransform`
(`addOrReplaceParams`, main_frame only): Google `/search` → `safe=active`
(incl. country domains google.co.uk, google.de, google.com.au, ...),
Bing `/search` → `adlt=strict`, DuckDuckGo `?q=` → `kp=1`. Rules are
fetched from `GET /api/v1/safesearch` (its `url_param` rules) on every
sync, with the hardcoded list in `background.js` as fallback when the API
is unreachable, and the cached list is reused by the offline path. Rule
ids 8000+ (3 rules).

Why a query param and NOT a redirect to the SafeSearch-locked hostnames
(`forcesafesearch.google.com`, `strict.bing.com`, `safe.duckduckgo.com`,
`restrict.youtube.com`)? Those hostnames only work as DNS CNAME targets,
where the browser keeps sending `Host: www.google.com`. Navigating to
them directly changes the Host header and the engines reject it —
verified live 2026-11-18: Google `/search` on forcesafesearch.google.com
→ HTTP 404, YouTube `/watch` on restrict.youtube.com → HTTP 404, Bing
looped (`strict.bing.com` redirects back to `www.bing.com`,
`ERR_TOO_MANY_REDIRECTS`). DuckDuckGo's safe host did serve results, but
the param mechanism is used for all engines for consistency. The param
rule does NOT loop even though its output still matches its own
condition — verified 2026-11-18 with a throwaway extension + local HTTP
server (rule fired once, final URL `.../search?q=hello&safe=active`).

**YouTube is NOT enforced by the extension:** Restricted Mode has no
query param, and the host redirect 404s (above). YouTube restriction
needs the DNS/CNAME lock at the network level. The API still lists the
YouTube dns rule; the extension's parser skips engines with no
`url_param` rule, so it never becomes a DNR rule — and a YouTube watch
page loads normally on `www.youtube.com` (verified as a regression
check).

## Policy modes

- Standard policy from Phase 1: `block_images=true` → **block** mode.
- Popup demo switch overrides for demo: `block` (remove/replace),
  `cover` (blur + overlay, page stays usable), `strict` (uncertain
  detections count as human → cover). `policy` = follow the server policy.
- Since v1.1.0 uncertain images are covered in **all** of block/cover/
  strict (fail closed), so for images `strict` now behaves the same as
  `cover` — the strict switch is kept for the popup, but it no longer
  changes image handling.

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

- Person detector (v1.1.0): bodies without a visible face are now
  found (back view b3, both crowds, both group photos — see
  `verify/VERIFY-person-detector.md`), but the labeled test set shows
  it is not solved: back views 1 of 3 (b1 soldier, b2 guitarist still
  missed to ALLOW), distant single figure d3 missed, crowds score
  0.61–0.66 (human at the extension's 0.50 threshold, uncertain at the
  scanner's 0.70). Group person *counts* undercount (7 of 11, 6 of 7,
  10 of ~14) — do not use `persons` as a headcount. The weights are
  **prototype-only, license unverified** — see above.
- Cross-origin images without CORS: the canvas is tainted, pixels cannot be
  read, detection is "uncertain" — **covered in block/cover/strict modes
  since v1.1.0** (fail closed; previously left alone in block/cover).
  Same-origin images (e.g. the local test page) work fully. Note the
  trade-off: any cross-origin image served without CORS headers gets
  covered, even when it shows no person — there is no per-image unblock
  in this phase.
- **Cross-origin refetch (v1.2.0, see `verify/VERIFY-crossorigin-2026-11-18.md`):**
  a cross-origin `<img>` without CORS is no longer short-circuited to
  uncertain. The extension re-fetches the same URL and detects on the
  re-fetched pixels, so real sites (Wikipedia, BBC, Commons) are now
  actually detected instead of indiscriminately covered. Two fetch paths,
  in order: (1) the **detector iframe** (`detector.html`, an
  extension-origin page) fetches the bytes — its fetch runs with the
  extension's `host_permissions` and is **not CORS-gated**, so it reads
  any http(s) image the page loads; (2) if the iframe is unavailable
  (page CSP blocks `chrome-extension://` iframes), a plain content-script
  fetch is tried — that one **is** CORS-gated, so it only works where the
  host sends `Access-Control-Allow-Origin: *`. Any failure on both paths
  (network, HTTP error, non-image content-type, undecodable bytes) still
  ends uncertain → covered (fail closed). Limits: **8 MiB** per file
  (larger files rejected without full download), **15 s** fetch timeout,
  verdicts cached per URL (max 500, oldest evicted) so a repeated image
  is fetched + detected once. The fetch is a plain GET of a URL the page
  already loads, credentials omitted, no body; bytes go only to the
  on-device detectors and never leave the browser. Probe images are
  `blob:` object URLs never added to the DOM, so no detection loops.
  Same-origin images and `crossorigin='anonymous'` images still use the
  direct path, untouched. The test page's cross-origin Einstein
  (`img-xorigin-local`, :8124, no CORS headers) is now detected as human
  via the iframe path instead of uncertain-covered.
- Canvas-rendered images (`<canvas>`), Shadow DOM content, and video frames
  are not scanned in this phase (video filtering is a later phase).
- DNR rules block requests, but cannot rewrite page content. A blocked
  main-frame navigation used to show the browser's block error page —
  since 2026-11-18 it shows the Yiddish `blocked.html` instead (DNR
  redirect, ids 3000+). Note: DNR rules MUST list `resourceTypes`
  explicitly (incl. `main_frame`) — verified in Chrome 159, a rule
  without them did not block navigations.
- SafeSearch: YouTube Restricted Mode is NOT enforced by the extension
  (no query param; the `restrict.youtube.com` host redirect 404s —
  needs the DNS/CNAME lock). Google serves `/sorry` (bot-check) to
  headless Chromium, so a real Google results page cannot be eyeballed
  from this VM — enforcement is proven by the `safe=active` param in the
  URL (visible in the `/sorry` redirect's `continue=` param). SafeSearch
  params are added to main-frame search navigations only, not to
  in-page search boxes that fetch via XHR (those are same-origin
  requests the engine serves with its own defaults).
- First scan is slow on software rendering (~25 s for 10 images on this
  VM's SwiftShader); on a real machine with GPU/WebGL it is far faster.
  A 20 s per-image detection timeout guards against hangs. The person
  detector adds ~5 s of one-time model load per page (WASM compile +
  `.tflite`, ~0.5–1.2 s of it measured in the iframe; the rest is the
  iframe + face-model load in parallel) and ~1.2–1.3 s per image
  (person+face together, median on this VM) — the model is reloaded on
  every page load; a persistent detector (offscreen document) would
  need a background.js change and is future work.
- A page whose CSP blocks `chrome-extension://` iframes (`frame-src` /
  `default-src`) prevents the person detector from loading; the
  extension then runs face-only on that page (verified fallback path:
  the bridge fails fast in 10 s, no hang, no fail-open).
- Extension size is now ~27 MB (was ~2 MB): 15 MB WASM runtime +
  7 MB person model + 1.3 MB face-api + weights.

## Verification

`verify/VERIFY.md` + `verify/results.json` + screenshots — Playwright
(Chrome 159, headless), three modes (block / cover / strict), exact counts
per image. Live API fetch from the extension could NOT be verified in this
VM (Chromium has no working internet route here); policy sync was verified
via the cache path with real live API data, and DNR blocking was verified
live (`ERR_BLOCKED_BY_CLIENT` for facebook.com). Google Images was
unreachable from this VM's Chromium and is unverified.

**Phase 3 ads (2026-11-18):** `harness/verify-phase3-ads.js` +
`verify/results-phase3-ads.json` — two LIVE syncs from the service worker
through the egress relay (127.0.0.1:18080): Standard policy
(`filter_ads=false`) → 22 DNR rules, 0 ads rules; temporary test policy
(`filter_ads=true`, device + policy deleted after the run) → 74 rules
(22 domains + 52 ads, ids 5000–5051) and `doubleclick.net` navigation fails
with `ERR_BLOCKED_BY_CLIENT`. The Phase 2 regression re-run
(`harness/verify-phase2-relay.js block`) still passes with the new
background.js: live sync, 22 domain rules, 9 found/10 scanned, 6 human
blocked, facebook.com blocked. Note: that re-run overwrote
`verify/results-relay.json` with the block-mode run only; the full 3-mode
results remain in `verify/results.json`.

**Phase 3b block page + SafeSearch (2026-11-18):**
`harness/verify-blockpage-safesearch.js` +
`verify/results-blockpage-safesearch.json` + screenshots
(`verify/A-standard-facebook-blocked.png`,
`verify/B-ads-on-doubleclick-blocked.png`) — three LIVE syncs through the
egress relay (spawned by the harness), all `pass: true` in the final run
(2026-11-18 20:27):
- **A — Standard policy** (`filter_ads=false`, `force_safesearch=true`):
  live sync, 36 DNR rules (22 domain block + 11 block-page redirects + 0
  ads + 3 SafeSearch, source `api`, engines google/bing/duckduckgo);
  facebook.com → `chrome-extension://<id>/blocked.html?d=facebook.com`
  with Yiddish text, domain and policy name shown; Bing search →
  `www.bing.com/search?q=albert+einstein&adlt=strict`; DuckDuckGo →
  `duckduckgo.com/?q=albert+einstein&kp=1`; Google search →
  `www.google.com/sorry/index?continue=...search%3Fq%3Dalbert%2Beinstein%26safe%3Dactive...`
  (Google bot-checks headless Chromium with `/sorry`, as before — the
  `safe=active` param is in the URL before Google's redirect); YouTube
  watch loads normally on `www.youtube.com`.
- **B — temp policy `filter_ads=true`, `force_safesearch=true`** (device +
  policy deleted after): 114 rules (22 + 37 redirects + 52 ads + 3
  SafeSearch); doubleclick.net → `blocked.html?d=doubleclick.net` with
  the test policy name shown.
- **C — temp policy `force_safesearch=false`** (device + policy deleted
  after): live sync, 33 rules, `safeSearchEnforced: false`, 0 SafeSearch
  rules; Google search stays on `www.google.com` with NO `safe` param.
  Cleanup check: test policies gone, 1 policy left (Standard).
- Earlier runs of the same harness caught two real things before the
  final design landed: the SafeSearch **host redirect** (first design)
  404'd Google `/search` and YouTube `/watch` and looped Bing, and the
  **API ignores `force_safesearch: false` on POST** — verified by direct
  curl (create returns `force_safesearch: true`; case C therefore sets
  the flag with a direct DB `UPDATE` and confirms it via GET first).
  The DDG probe in one run failed with `ERR_CONNECTION_CLOSED` (flaky
  egress route to duckduckgo.com) and passed on re-run; the rule had
  already fired (the loading URL showed `&kp=1`).

**Person detector v1.1.0 (2026-11-18):** `harness/verify-phase2-person.js`
+ `verify/results-person-detector-block.json` (block mode) +
`verify/results-person-detector-cover.json` (cover mode) +
`verify/VERIFY-person-detector.md` (full report). Playwright headless
Chrome 159, local test servers only (no API token — demo mode seeded).
Block mode, extension test page: 9 found / 10 scanned, 6 human blocked,
1 uncertain covered (cross-origin without CORS, fail closed), 3
no-human untouched, background Einstein blocked, dynamic + lazy person
photos blocked, `personReady: true`, `personHits: 6` (all 6 human
images found by the person detector too, `person+face`). Cover mode:
same 6 human covered + 1 uncertain covered, background covered.
Labeled 16-photo test set (same photos + ground truth as the scanner):
**precision 1.000, recall 0.727** (TP 8, FP 0, FN 3, TN 5; the 3
misses are the same 3 the scanner misses: b1, b2, d3) vs the face-only
baseline measured with the same harness on the same set minutes
earlier: precision 1.000, recall **0.273** (TP 3). Per-image scores
match the scanner within ~0.01 (b3 0.885 vs 0.896, g3 0.734 vs 0.736,
p1 0.968 vs 0.968). Mean detect 1.3 s/image (person+face together),
model ready ~5 s per page. No-exfiltration audit: 43 requests per run,
0 unexpected, 0 non-GET — the detector fetched only bundled
`chrome-extension://` files (detector.html, vision bundle, WASM,
`.tflite`). Two real bugs found and fixed during this verification:
MV3's default CSP blocks WASM compilation (fixed with
`'wasm-unsafe-eval'` in `extension_pages`), and the warmup
`postMessage` was sent only after the 60 s wait was awaited (fixed by
posting before awaiting). The face-only fallback was verified live
while the person detector was down (both runs before the fixes:
face-only numbers, no crash, no fail-open).
