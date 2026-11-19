# Extension v1.2.0 re-verification — 2026-11-19 (re-run + testing-plan cases)

Re-run of the v1.2.0 verification on real sites with Playwright, plus the
extra cases from the testing plan (`TESTING-PLAN.md`, Master Technical
Architecture §16). **Verification only — no extension source file was
edited.** No temp policies or devices were created in the main run; the
only database writes in the whole re-run were 4 classify-request rows
under a throwaway customer for the cache check, all deleted afterwards
and verified gone (see §G).

- **Harness:** `harness/verify-rereun-2026-11-19.js` (based on
  `verify-merged.js` for live sync / test page / block page / SafeSearch /
  test set, with the real-site scroll-pass + settle-wait logic from
  `verify-crossorigin.js`) and `harness/verify-rereun-extra-2026-11-19.js`
  (canvas / video / per-case / slow-3G / CPU-throttle) plus
  `harness/cache-check-2026-11-19.py` (classify cache).
  Playwright 1.65.1, headless Chromium 159, `--load-extension`, egress
  relay `127.0.0.1:18080` spawned by each harness,
  `--ignore-certificate-errors`; local servers :8123 test page, :8124
  photos, :8125 test set, :8126 canvas/video pages.
- **Runs:** main 2026-11-19 ~02:17–02:33 EST (live sync 07:17:36 UTC);
  extra cases ~02:44–02:58 EST. Extension id in both runs:
  `keibjodbjaonlckfkaejiiefaikphdfg`. Manifest version confirmed live via
  `chrome.runtime.getManifest()`: **1.2.0** (the manifest now says 1.2.0 —
  the v1.2.0 report's "manifest still says 1.1.0" note is resolved).
- **Results JSON:** `extension/verify/results-rereun-2026-11-19.json`
  (main cases + `extraCases` merged in) and
  `extension/verify/results-rereun-extra-2026-11-19.json` (extra cases
  as originally recorded).
- **Baseline for comparison:** v1.2.0 cross-origin run 2026-11-18
  (`VERIFY-crossorigin-2026-11-18.md`) and v1.1.0 merged run
  (`VERIFY-merged-2026-11-18.md`).

## Verdict table

| # | Case | Result |
|---|---|---|
| A | Extension loads cleanly (SW, manifest 1.2.0, console) | **PASS** (0 popup console errors) |
| A | Live policy sync from Worker API (Standard policy) | **PASS** (1,527 ms) |
| A | DNR rules, Standard policy | **PASS** (36 = 22 domain block + 11 redirects + 0 ads + 3 SafeSearch) |
| B | Test page, Standard policy (= block) | **PASS** (7 human blocked, 0 uncertain) |
| B | Test page, cover / strict | **PASS** (7 covered, 0 uncertain; strict ≡ cover) |
| B | 16-photo test set | **PASS** (precision 1.000, recall 0.727 — identical to v1.2.0) |
| C | Wikipedia Main Page | **PASS with note** (2 human blocked, 1 uncertain; page content rotated since v1.2.0) |
| C | BBC home | **PASS** (41 human blocked, 2 uncertain — within homepage churn of v1.2.0's 44) |
| C | Commons Featured pictures | **NOT MEASURED this run** (galleries never rendered as `<img>` — only 2 footer logos in the DOM) |
| C | example.com | **PASS** (ALLOW — loads normally, 0 images) |
| D | facebook.com → blocked.html | **PASS** (Yiddish, domain, policy) |
| E | SafeSearch (Bing / DDG / Google) | **PASS** (`adlt=strict`, `kp=1`, `safe=active` in `continue=`) |
| F | Canvas (drawImage portrait, animated video frames, landscape) | **FAIL — extension does not handle `<canvas>` at all** (see §F) |
| F | Video (Obama, paused + playing) | **FAIL — extension does not handle `<video>` at all** (see §F) |
| G | CSS backgrounds / dynamic / lazy images | **PASS** (per-case verdicts in §G) |
| G | Animations / WebGL / live streams | **NOT COVERED** (no test page covers them — see §G) |
| H | Slow internet (slow-3G Wikipedia) | **PASS** (same verdicts as unthrottled) |
| H | CPU overload (4x throttled BBC) | **PASS** (identical verdicts, slower model load) |
| H | Cache (classify twice, same target) | **PASS** (cold → warm: `cached` false → true) |
| H | 10,000-customer simulation | **NOT RUN** (no load-test setup; would risk the live service) |
| I | Google Images | **NOT VERIFIED — Google /sorry again** (HTTP 429; no CAPTCHA attempted) |

## A. Load, live sync, DNR — PASS

- Service worker + popup load; `chrome.runtime.getManifest()`: name
  `Filter Platform — Kosher Browser Filter`, version **1.2.0**.
  Popup console errors: **0**. Normal `[fp]` console lines only
  (`tinyFaceDetector model loaded`, `person detector ready (MediaPipe
  EfficientDet-Lite0, PROTOTYPE-ONLY weights…)`, `content script active`).
- Live sync (Standard policy, device Dogfood Phone
  `eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a`): `policyFetched: true`,
  `policyName: Standard — block images + explicit words, rest open`,
  `block_images: true`, `force_safesearch: true`,
  `auto_decide_threshold: 0.7000`, `blocklistDomains: 11`,
  `rulesCount: 36`, sync **1,527 ms** (v1.2.0 run: 1,316 ms — same
  policy, same rule count).
- DNR dynamic rules **36** = domain block 22 (ids 1000+) + block
  redirects 11 (ids 3000+) + ads 0 + SafeSearch 3 (ids 8000+). Identical
  to the v1.2.0 run.

## B. Test page + test set — PASS, identical verdicts

### Test page (`extension/test-page/`)

| Mode | found / scanned | human | blocked | covered | uncertain | no-human | bg found / bg human | skipped | personHits | refetched / failed | scan |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Standard policy (= block) | 9 / 10 | 7 | 7 | 0 | 0 | 3 | 1 / 1 (blocked) | 3 | 7 | 1 / 0 | 29,855 ms |
| cover (demo) | 10 / 11 | 7 | 0 | 7 | 0 | 4 | 1 / 1 (covered) | 2 | 7 | 2 / 0 | 26,004 ms |
| strict (demo) | 10 / 11 | 7 | 0 | 7 | 0 | 4 | 1 / 1 (covered) | 2 | 7 | 2 / 0 | 25,371 ms |

- Cover/strict counts are **identical to the v1.2.0 run** (10/11, 7
  covered, 0 uncertain). The Standard row differs by one image
  (9/10, 3 no-human vs v1.2.0 demo run's 10/11, 4 no-human) because in
  **policy mode the facebook favicon probe is DNR-blocked** and counted
  as skipped, while in demo mode it loads and scans as no-human. That is
  a mode difference, not a regression: **all 7 expected humans are
  blocked in every mode, 0 uncertain everywhere.**
- The 7 humans: Einstein 0.935, Obama family 0.808, Marie Curie 0.915
  (each also as dynamic/lazy duplicates), cross-origin local Einstein
  via `refetch-iframe` 0.935, background Einstein 0.935. No-human:
  apple, cat, earth — all left alone.
- `img-xorigin` (Wikimedia `Special:FilePath`, `crossorigin="anonymous"`)
  **still never loads** from this VM even via the relay (no log entry,
  counted in `skipped`, never left visible as cleared). Same caveat as
  every previous run.

### 16-photo labeled test set (block mode) — PASS, byte-identical to v1.2.0

| TP / FP / FN / TN | Precision | Recall | Uncertain on person imgs | Missed to ALLOW |
|---|---|---|---|---|
| 8 / 0 / 3 / 5 | **1.000** | **0.727** | 0 | 3 (b1, b2, d3) |

Scan 25,811 ms, model ready, scan done. At the scanner's 0.70
threshold this is recall 0.455. Per-image scores match the v1.2.0 run.

## C. Real sites — PASS except Commons (not measured this run)

Block mode (Standard policy), live sync, scroll pass + settle wait
(15 s stable), 420 s caps.

| Site | imgs in DOM at read | found / scanned | human | blocked | covered | uncertain | no-human | skipped | personHits | refetched / failed / cache | scanDone / settled | elapsed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org/wiki/Main_Page | 21 | 23 / 23 | **2** | 2 | 1 | **1** | 20 | 15 | 3 | 18 / 0 / 0 | yes / yes (35 s) | 128,776 ms |
| www.bbc.com/ | 37 | 134 / 134 | **41** | 41 | 2 | **2** | 91 | 72 | 41 | 66 / 0 / 68 | yes / yes (220 s) | 593,770 ms |
| commons.wikimedia.org/wiki/Commons:Featured_pictures | 2 | 2 / 2 | **0** | 0 | 1 | **1** | 1 | 0 | 0 | 2 / 0 / 0 | yes / yes (15 s) | 23,757 ms |
| example.com | 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 / 0 / 0 | — (loads normally) | — |

**Wikipedia — matches the live page, with one note.** Human (both
`via: refetch-iframe`): Cody Fajardo 0.961 (person+face), Pelé stamp
0.818 (person). The v1.2.0 run's humans (Gilbert 0.853, Jensen Huang
0.964, Khrushchev 0.975) are **no longer on the live Main Page** — the
featured content rotated since yesterday, so 2 vs 4 is page churn, not
a detector change. The 1 uncertain is the **Wikibooks logo SVG** again,
but this time 0.456 → uncertain-covered ("weak signal"), where the
v1.2.0 run scored it 0.581 → human-blocked. It sits right on the 0.50
threshold and wobbles across runs; either way it ends up covered, never
visible. The microscope, horse and other non-human images are correctly
`no-human` again.

**BBC — within churn of v1.2.0.** 134 scanned (v1.2.0: 136), 41 human
blocked (v1.2.0: 44), 2 uncertain (same 2 weak-signal fail-closed
covers). 0 CORS-uncertain — every verdict came through real detection
(`refetch-iframe` 66, `refetch-cache` 68). BBC's homepage churns daily;
do not quote a single BBC count as "the" BBC result.

**Commons — NOT a measurement this run.** Only **2 `<img>` in the DOM**
at scan time (the two Wikimedia footer logos). The Featured-pictures
galleries did not render as `<img>` elements in headless Chromium via
the relay — the same failure as the v1.1.0 merged run (2/2), while the
v1.2.0 run saw 238/242. This is flaky page rendering in this
environment, not a detector change: the 1 uncertain is the footer
Wikimedia SVG ("probe image failed to decode" → covered). **Do not
quote 0 human / 2 scanned as a Commons result.** Commons needs a
re-run on a day the galleries render, or a non-headless browser.

**example.com — PASS (ALLOW).** Loads normally (`Example Domain`
title), final URL `https://example.com/`, 0 images, nothing blocked.

## D. Block page — PASS

`https://www.facebook.com/` →
`chrome-extension://<id>/blocked.html?d=facebook.com`. Title:
`דער פּלאַץ איז בלאקירט — פֿילטער פּלאַטפאָרם`. Body shows:
`בלאקירט` ✓, domain `facebook.com` ✓, policy
`פּאָליסי: Standard — block images + explicit words, rest open` ✓.
Screenshot: `rereun-facebook-blocked.png`.

## E. SafeSearch — PASS

| Engine | Final URL | Param |
|---|---|---|
| Bing | `https://www.bing.com/search?q=albert+einstein&adlt=strict` | `adlt=strict` ✓ |
| DuckDuckGo | `https://duckduckgo.com/?q=albert+einstein&kp=1` | `kp=1` ✓ |
| Google | `https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dalbert%2Beinstein%26safe%3Dactive…` | `safe=active` inside `continue=` ✓ (Google bot-checks headless Chromium — see §I) |
| YouTube | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` (unchanged, loads) | — (Restricted Mode NOT enforced, as documented) |

The SafeSearch-off temp-policy case and the ads-on temp-policy case
were **not** re-run this time (verification only, no DB writes for
temp policies). Their v1.2.0-era results stand as last verified.

## F. Canvas + video — FAIL: the extension does not handle them at all

This is the biggest finding of the extra cases. The **scanner**
(v0.2.0) BLOCKED all of these; the **extension** leaves them all
visible. Code inspection agrees: `content.js` handles `<img>` and CSS
background images only — there is no `<canvas>` or `<video>` handling
in the extension (only `filter_videos` as a policy flag in
`background.js`, which gates nothing in the page).

### Canvas (`scanner/test-video-canvas/canvas.html`, demo block)

| Element | Content | Extension verdict |
|---|---|---|
| `c-person` canvas | Jensen Huang portrait via `drawImage` | **VISIBLE — not scanned** (`fpAction: none`, no overlay, `display: block`) |
| `c-video` canvas | Obama video frames via `requestAnimationFrame` | **VISIBLE — not scanned** |
| `c-landscape` canvas | Glacier lake via `drawImage` (control) | Visible — not scanned (correct outcome, wrong reason) |
| `img-control` (`<img>`) | Same Huang portrait as an `<img>` | **human, BLOCKED** (person 0.968 + face 0.929) |
| `v` (`<video>`) | Obama video, playing (currentTime 9 s) | **VISIBLE — not scanned** |

Only 1 image was found/scanned on the whole page (the `<img>`
control). Zero log entries mention any canvas or video. The same
portrait is blocked as an `<img>` and visible as a `<canvas>` on the
same page — the gap is the element type, not the pixels.
Screenshot: `rereun-extra-canvas.png`.

### Video (`scanner/test-video-canvas/video.html`, Obama statement)

| State | Extension verdict |
|---|---|
| Paused (page reports "paused at 5 s") | **VISIBLE — not scanned** (0 images found/scanned, `fpAction: none`) |
| Playing (~5 s of playback) | **VISIBLE — not scanned** (0 images found/scanned, `fpAction: none`) |

Small observation: the page title said `READY paused-at-5s`, but the
`<video>` element read `currentTime: 0.00` at check time (after the
model + scan wait); it then played 0 → 5 s during the playing check
as expected. Unexplained, and it does not change the verdict — the
extension never touches `<video>` in either state.
Screenshot: `rereun-extra-video.png`.

**What this means:** on the computer version, a person shown only
inside a `<canvas>` or a `<video>` is currently visible to the user.
The testing plan lists Canvas and video as cases to test, and the
scanner proves detection on those pixels is possible — but the
extension build does not have that path. This needs a build decision,
not a re-test.

## G. Test-page per-case verdicts, gaps — PASS for what exists

Demo block mode, test page (`extension/test-page/`):

| Case | Expected | Verdict |
|---|---|---|
| `img-einstein` (HTML image) | human | **human, blocked** (0.935) |
| `img-obama` (HTML image) | human | **human, blocked** (0.808) |
| `img-curie` (HTML image) | human | **human, blocked** (0.915) |
| `img-apple` / `img-cat` / `img-earth` | no-human | **no-human, left alone** (person 0) |
| `bg-person` (CSS background, Einstein div) | human | **human, blocked** (person 0.935 + face) |
| `img-xorigin-local` (cross-origin, no CORS) | human | **human, blocked** via `refetch-iframe` (0.935) |
| `img-xorigin` (Wikimedia FilePath) | human | **never loads** — no log entry, counted skipped, never left visible as cleared |
| `img-facebook-probe` (demo mode) | — | **no-human, left alone** via `refetch-iframe` (in policy mode it is DNR-blocked instead) |
| `img-dynamic` (JS-injected Obama) | human | **human, blocked** (caught after injection) |
| `img-lazy` (loading=lazy Curie) | human | **human, blocked** (caught after scroll) |

Note: blocked images are replaced in the DOM by the extension, so by
read time their `<img>` elements are gone — the per-case table above
is assembled from the detector log (which keeps every verdict) plus
the surviving DOM elements, not from the DOM alone.

**Gaps (no test page covers them — recorded, not built):**
- **Animations:** no animations case exists on the test page
  (checked: no element matching an animation case). Gap.
- **WebGL:** no test page in `extension/test-page/` or
  `scanner/test-video-canvas/` draws WebGL content. Gap. (The
  GeckoView prototype has WebGL test pages; the extension test pages
  do not.)
- **Live content / live streams:** nothing in any existing test page
  covers a live stream (HLS/DASH/live video). `video.html` is a static
  file; `canvas.html` draws a playing file. Recorded as **not
  covered** — no live stream was invented.

## H. Measures — slow internet, CPU overload, cache, load/scan/inference, memory

### Website load time / scan time / AI inference time

| Page / run | Load (DOM content loaded) | Model ready | Scan done / settled | Inference per image (from detector log `ms`) |
|---|---|---|---|---|
| Test page (Standard) | — | 6,491 ms | 29,855 ms | mean 1,554 ms, median 1,250 ms (n=11; first image 4,797 ms incl. warmup) |
| Test set (16 photos) | — | — | 25,811 ms | — |
| Wikipedia (unthrottled) | — | — | settled 35 s | mean 1,334 ms, median 1,139 ms, min 1,014, max 4,774 (n=23) |
| Wikipedia (slow-3G) | **4,139 ms** (load event 12,710 ms) | — | 52,298 ms total | — |
| BBC (unthrottled) | — | — | settled 220 s | mean 1,352 ms, median 1,287 ms, min 1,082, max 4,701 (n=66) |
| BBC (4x CPU throttled) | **13,458 ms** (load event 25,756 ms) | **26,914 ms** | settled, 594,340 ms total | mean 1,781 ms, median 1,584 ms, min 1,318, max 8,260 (n=66) |

Per-image inference is ~1.1–1.8 s on this VM; the first image of a
page is slower (up to ~5–8 s, model warmup). BBC's long totals are
dominated by the settle wait on a churning homepage, not by detection
speed.

### Slow internet — PASS

Slow-3G throttling (CDP `Network.emulateNetworkConditions`: 400 ms
latency, 400 Kbps down/up) on Wikipedia: DOM content loaded in
4,139 ms, scan finished, **same verdicts as unthrottled** — 21/21
scanned, the same 2 humans blocked, the same Wikibooks logo uncertain
(0.456). Slow internet delays the page; it does not change what gets
blocked. (21 vs 23 scanned: fewer lazy images had loaded under
throttling at read time.)

### CPU overload — PASS

4x CPU throttling (CDP `Emulation.setCPUThrottlingRate`, rate 4) on
BBC: model ready took 26,914 ms (vs ~6.5 s unthrottled on the test
page), page load 13,458 ms — but the final stats are **byte-identical
to the unthrottled BBC run** (134/134, 41 human, 2 uncertain, 91
no-human, 72 skipped, same settle key). Verdicts do not change under
CPU pressure; everything just runs slower. Inference per image rose
from mean 1,352 ms to 1,781 ms.

### CPU / RAM usage (sampled, not continuous profiling)

Chromium process totals sampled with `ps` during the runs (all Chrome
processes on the VM at that moment, including the test browser):

| Run | Chrome processes | Total RSS | Largest single process |
|---|---|---|---|
| Slow-3G Wikipedia | 15 | **1,808 MB** | 305 MB |
| BBC 4x CPU throttled | 16 | **1,217 MB** | 345 MB |

These are rough snapshots of the whole headless Chromium (browser +
extension + page), not per-tab measurements and not a substitute for
real profiling. No CPU-overload failure was observed in either run.

### Detection accuracy / false positives / false negatives

- Labeled 16-photo set: precision **1.000**, recall **0.727** (0.50
  threshold; 0.455 at 0.70). **False positives: 0. False negatives: 3**
  (b1 back-view soldier, b2 behind-back, d3 lone beach walker — all
  missed outright to ALLOW, same as every previous run).
- Near-threshold wobble: the Wikibooks logo SVG scored 0.581 (human)
  in the v1.2.0 run and 0.456 (uncertain) this run. It is the only
  image that flips across runs, and it ends up covered either way.
- Real sites: 0 CORS-uncertain on Wikipedia and BBC (detection ran on
  every loaded image); the only uncertains are weak-signal
  fail-closed covers.

### Cache — PASS

Classify called twice on the same target via the live API
(`POST /api/v1/requests` + `POST /api/v1/requests/:id/classify`),
throwaway customer + device (deleted afterwards, verified 0 rows left):

| Target | 1st call | 2nd call |
|---|---|---|
| example.com | `cached: false`, approve 0.95, 1,686 ms | `cached: true`, approve 0.95, 1,353 ms |
| example.org | `cached: false`, approve 0.95, 1,523 ms | `cached: true`, approve 0.95, 1,277 ms |

The 24 h `ai_analysis_results` cache works: the first classify fetches
and analyses the real page, the second is served from cache with the
same verdict. Cache hit rate on a repeat classify: **2/2 (100%)**.
(The first attempt at this check failed with a foreign-key error
because the hardcoded customer id from the old harness no longer
exists in the customers table — the check was re-run with a fresh
customer, which is why the throwaway rows existed at all.)

### 10,000-customer simulation — NOT RUN

There is no load-test setup here, and hammering the live free-tier
Worker + Neon would risk the real service. Recorded as **not run yet —
needs a staged load-test plan with rate limits**.

## I. Google Images — NOT VERIFIED (Google /sorry, as before)

`https://images.google.com/search?q=albert+einstein&tbm=isch` → HTTP
**429**, final URL `https://www.google.com/sorry/index?continue=https://images.google.com/search%3Fq%3Dalbert%2Beinstein%26tbm%3Disch…`
— "Our systems have detected unusual traffic from your computer
network", IP `2606:54c1:1:cd8::22f:a2`, 2026-11-19T07:18:41Z. The
SafeSearch param (`safe=active`, `udm=2`) is present in the `continue=`
URL, which proves the DNR rule fired; no image results were ever
served, so no detection counts exist for Google Images. **Stopped
there — no CAPTCHA attempted, no challenge interaction.**
Screenshot: `rereun-google-images.png`.

## Screenshots (extension/verify/)

- `rereun-standard-testpage.png`, `rereun-cover-testpage.png`,
  `rereun-strict-testpage.png` — test page in the three modes
- `rereun-facebook-blocked.png` — Yiddish block page
- `rereun-google-images.png` — Google /sorry page
- `rereun-wikipedia.png`, `rereun-bbc.png`, `rereun-commons.png` —
  real-site pages as scanned
- `rereun-extra-canvas.png` — canvas page (canvases visible, img control blocked)
- `rereun-extra-video.png` — video page (video visible)
- `rereun-extra-bbc-cpu4x.png` — BBC under 4x CPU throttling

## What is still missing / unverified

1. **Canvas and video are not handled by the extension at all** (§F).
   The scanner blocks them; the extension leaves them visible. This
   is the largest gap against the testing plan.
2. **Commons Featured pictures** — galleries did not render this run
   (2 footer logos only). Not a Commons measurement; needs a re-run
   when the page renders, or a non-headless browser.
3. **Google Images** — /sorry bot-check; unverified in headless
   Chromium. Needs a real (non-headless / residential-IP) browser or a
   different image-search target.
4. **Animations, WebGL, live streams** — no test page covers them.
5. **Direct-path fallback** (content-script fetch when the detector
   iframe is down) is NOT verified live. No test page with a CSP
   blocking `chrome-extension://` iframes was run.
6. **8 MiB cap / 15 s timeout / non-image content-type rejection** are
   implemented, not live-tested.
7. **10,000-customer simulation** — not run; needs a staged load-test
   plan with rate limits.
8. **BBC numbers move between runs** (homepage churn: 136/44 in the
   v1.2.0 run vs 134/41 now). The stable claims are 0 CORS-uncertain
   and detection running on every loaded image.
9. **Wikibooks logo false-positive wobble** (0.581 vs 0.456 across
   runs, straddling the 0.50 threshold). Pre-existing detector
   behavior on a small line-art logo; fail-closed either way.
10. **`img-xorigin` (Wikimedia FilePath) still never loads**, even via
    the relay — counted in `skipped`, never left visible as cleared.
11. No extension bug was found in the parts the extension does handle
    (images + CSS backgrounds): 0 missed-to-ALLOW on real sites in
    this run, 0 refetch failures, 0 `[fp]` console errors.
12. Cleanup note: the classify cache check created a throwaway
    customer + device + 4 request rows; all were deleted and verified
    gone (SELECT counts 0 for customers, devices, requests; device
    absent from `GET /api/v1/devices`). Two `fpsql.py` calls dropped
    the Neon connection mid-call ("Remote end closed connection
    without response") but the deletes had landed — re-run SELECTs
    confirmed 0 rows. The hardcoded customer id in the old harness
    (`142e6a02-…`) no longer exists in the customers table; future
    harnesses should not rely on it.

## Harness notes

- `harness/verify-rereun-2026-11-19.js` — main re-run (live sync, test
  page x3 modes, block page, SafeSearch, Google Images, real sites
  with scroll + settle, example.com, test set). The SafeSearch-off and
  ads-on temp-policy cases from `verify-merged.js` were deliberately
  left out (no DB writes for temp policies).
- `harness/verify-rereun-extra-2026-11-19.js` — canvas, video, test
  page per-case, slow-3G Wikipedia, 4x-CPU BBC (+ sampled `ps` memory).
- `harness/cache-check-2026-11-19.py` — classify-twice cache check
  with throwaway customer/device and verified cleanup.
- No API token was printed anywhere. The main run used the token only
  for the extension's own live sync (read from `api_token.txt` by the
  harness, never echoed).
