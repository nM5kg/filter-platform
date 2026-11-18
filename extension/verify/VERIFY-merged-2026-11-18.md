# Merged-build verification — Filter Platform MV3 extension v1.1.0 (2026-11-18)

Merged build = person detection (MediaPipe EfficientDet-Lite0) + Yiddish block
page + SafeSearch, all in one unpacked extension, verified **together**.
Read-only verification: no extension source file was edited.

- **Harness:** `harness/verify-merged.js` (new; Playwright 1.65.1, headless
  Chromium 159, `--load-extension`, egress relay `127.0.0.1:18080` spawned by
  the harness, `--ignore-certificate-errors`; local servers :8123 test page,
  :8124 photos, :8125 test set)
- **Run:** 2026-11-18 ~15:40–15:49 EST (live sync 20:40:05 UTC; last temp-policy
  sync 20:49:24 UTC). Extension id in this run:
  `keibjodbjaonlckfkaejiiefaikphdfg`. Manifest version confirmed live via
  `chrome.runtime.getManifest()`: **1.1.0**.
- **Results JSON:** `extension/verify/results-merged-2026-11-18.json`
  (full per-image logs, DNR rules, probe URLs)
- **Note on prior runs:** the merged `manifest.json` (mtime 20:38 UTC) is
  newer than both the block-page run (20:31 UTC) and the person-detector run
  (20:34 UTC), so the separate verifications did not cover this exact build.
  This run re-verifies everything in the merged build.

## Verdict table

| # | Case | Result |
|---|---|---|
| A | Extension loads cleanly (SW, manifest, console) | **PASS** |
| B | Phase 2 regression — test page, Standard policy (= block) | **PASS** (identical counts to the person-detector run) |
| B | facebook.com navigation → blocked.html | **PASS** |
| B | Live policy sync from Worker API | **PASS** (live, 1,316 ms) |
| B | Ads rules when filter_ads=true; doubleclick.net → blocked.html | **PASS** (52 rules) |
| C | Strict mode test page | **PASS** (≡ cover for images, as documented) |
| D | Person detection on real sites (Wikipedia / BBC / Commons) | **FAIL as "person detection" — see §D.** Fail-closed covering works; the person detector itself fired **0 times** on all three sites |
| E | SafeSearch on real searches (Google / Bing / DDG) | **PASS** |
| E | force_safesearch=false disables the rules (temp policy) | **PASS** — and the old API bug is gone (see §E) |
| F | Block page content (Yiddish, domain, policy) + screenshot | **PASS** |
| G | Google Images | **NOT VERIFIED — Google /sorry again** (reported honestly, no CAPTCHA attempted) |
| H | dogfood.py at end | **PASS** (exit 0, `DOGFOOD TEST COMPLETE`) |
| — | Temp policy/device cleanup (SELECT-verified) | **PASS** |

## A. Load — PASS

- Service worker target `chrome-extension://<id>/background.js` found;
  popup page loads, Yiddish text present.
- `chrome.runtime.getManifest()`: name `Filter Platform — Kosher Browser
  Filter`, version `1.1.0`.
- Popup console errors: **0**. Extension `[fp]` console lines on every page:
  only the normal `tinyFaceDetector model loaded`, `person-detector warmup
  reply: fp-detector-ready`, `person detector ready (MediaPipe
  EfficientDet-Lite0, PROTOTYPE-ONLY weights…)`, `content script active`.
- Page errors seen during the run belong to the **sites**, not the extension:
  BBC's own JS threw repeated `Minified React error #418 / #423`, and
  Google's /sorry page threw `ReferenceError: solveSimpleChallenge is not
  defined`. No `[fp]` error, no extension page error.

## B. Phase 2 regression — PASS

Live sync (Standard policy, device Dogfood Phone
`eefbc8d5-07f7-4e43-bded-3ee1f6d2b32a`): `policyFetched: true`,
`policyName: Standard — block images + explicit words, rest open`,
`blocklistDomains: 11`, `rulesCount: 36`, `safeSearchSource: api`,
`safeSearchEngines: [google, bing, duckduckgo]`, sync 1,316 ms.
DNR dynamic rules **36** = domain block 22 (ids 1000+) + block redirects 11
(ids 3000+) + ads 0 + SafeSearch 3 (ids 8000+).

### Test page (`extension/test-page/`)

| Mode | found / scanned | human | blocked | covered | uncertain | no-human | bg found / bg human | skipped | personHits | model ready | scan |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Standard policy (= block) | 9 / 10 | 6 | 6 | 1 | 1 | 3 | 1 / 1 (blocked) | 3 | 6 | 6,362 ms | 28,945 ms |
| cover (demo) | 10 / 11 | 6 | 0 | 8 | 2 | 3 | 1 / 1 (covered) | 2 | 6 | — | 23,505 ms |
| strict (demo) | 10 / 11 | 6 | 0 | 8 | 2 | 3 | 1 / 1 (covered) | 2 | 6 | — | 22,784 ms |

- Block-mode counts are **identical** to the standalone person-detector run
  (9/10, 6 human, 6 blocked, 1 covered, 1 uncertain, 3 no-human,
  personHits 6). Background Einstein: person 0.935 + face 0.956 →
  `person+face`, blocked/covered in all modes.
- Cover/strict scanned 11 vs block's 10 because the demo-mode contexts seed
  **no token/policy, so no DNR rules exist there**: the facebook favicon
  probe (`img-facebook-probe`) is not DNR-blocked in those contexts, loads,
  and is scanned as cross-origin uncertain → covered. In the live-sync
  (block) context it is DNR-blocked and counted as skipped. Harness artifact,
  not an extension difference; the image-mode verdicts are unaffected.
- The 1 covered uncertain in block mode is `img-xorigin-local` (same image
  from :8124, no CORS headers) — fail closed, as in v1.1.0.
- The cross-origin Wikimedia test image (`img-xorigin`,
  `commons.wikimedia.org/wiki/Special:FilePath/…`) **never loaded in any
  mode** (no log entry, no action): the earlier caveat persists even via the
  egress relay. It is counted in `skipped`, never left visible as cleared.

### 16-photo labeled test set (block mode) — PASS, reproduces the standalone run exactly

| TP / FP / FN / TN | Precision | Recall | Uncertain on person imgs | Missed to ALLOW |
|---|---|---|---|---|
| 8 / 0 / 3 / 5 | **1.000** | **0.727** | 0 | 3 (b1, b2, d3) |

Per-image scores match the standalone run (b3 0.885, d1 0.617, d2 0.627,
g1 7 persons 0.661 + 1 face, g2 0.882, g3 10 persons 0.734, p1 0.968,
p2 0.980; all 5 no-person images `no-human`). Scan 25,293 ms, model ready,
scan done. At the scanner's 0.70 threshold this is recall 0.455, same as the
scanner — the 0.727 uses the extension's 0.50 threshold (see the
person-detector report's threshold note).

## C. Strict mode — PASS

Strict test page: 10/11, 6 human, 0 blocked, **8 covered**, 2 uncertain,
3 no-human, bg 1/1 covered, skipped 2, personHits 6 — **byte-identical
counts to cover mode**. That is the documented behavior
(`extension/README.md` ~l.225–229; `content.js` `applyActionToImg`:
human → cover in `cover|strict`, uncertain → cover in
`block|cover|strict`): for images, strict now behaves the same as cover.
The strict switch is kept for the popup; no image-behavior difference
remains to verify. (Video/other strict-only behavior, if any is intended,
is not part of this extension build and was not tested.)

## D. Person detection on REAL sites — FAIL as "person detection" (fail-closed covering works)

Same URLs as scanner v0.2.0, block mode (Standard policy), live sync:

| Site | imgs in DOM | found / scanned | human | blocked | covered | uncertain | no-human | skipped | personHits |
|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org/wiki/Main_Page | 24 | 9 / 9 | **0** | 0 | 6 | 6 | 3 | 15 | **0** |
| www.bbc.com/ | 127 | 58 / 58 | **0** | 0 | 58 | 58 | 0 | 109 | **0** |
| commons.wikimedia.org/wiki/Commons:Featured_pictures | 2 | 2 / 2 | **0** | 0 | 2 | 2 | 0 | 0 | **0** |

Scanner v0.2.0 on the same URLs: Wikipedia 4 people / 4 blocked, BBC 20 / 20,
Commons 4 / 4. **None of that reproduces in the extension — not one person
detection fired on any real site.**

Why (verified in code + logs, not a guess): `content.js:321–333` short-circuits
every cross-origin `<img>` without a `crossOrigin` attribute straight to
`uncertain` with error `cross-origin without CORS — pixels unreadable` —
**detection is never attempted on it**. On real sites essentially every
image is cross-origin (Wikipedia thumbs are `thumb.wikimedia.org` vs
`en.wikipedia.org`; BBC images are `ichef.bbci.co.uk` /
`static.files.bbci.co.uk` vs `www.bbc.com`). Every scanned real-site image
carries exactly that error in the log. The person detector only ever runs on
same-origin images (local test page / test set), where it works (see §B).

What this means in practice:

- **Safe, but blind:** nothing slips through visible — every unreadable image
  is covered (Wikipedia screenshot `merged-wikipedia.png` shows the Gilbert
  portrait and the garbage-bin photo both blurred under the cover overlay).
  But the cover is indiscriminate: non-human images are covered too
  (Wikipedia: microscope photo, Przewalski's horse; BBC: even the grey
  placeholder PNGs, which appear dozens of times in the log). On BBC, 58 of
  58 scanned images were covered as uncertain, and 109 of 127 DOM images were
  `skipped` (not yet loaded / lazy / srcset placeholders — BBC lazy-loads
  most images; the scan only sees what has loaded).
- **This is a design limitation, not a merged-build regression and not a
  crash:** the same short-circuit existed in the person-detector build, and
  the standalone run only ever proved detection on same-origin images.
  Background images are the exception — they are probed with a CORS-enabled
  `Image` (`crossOrigin='anonymous'`, `content.js:342–352`), so a background
  image whose host sends CORS headers *can* be detected.
- **Commons is barely a measurement:** only **2 `<img>` in the DOM** at scan
  time (the two Wikimedia footer logos, both uncertain-covered). The
  Featured-pictures galleries did not render as `<img>` elements in headless
  Chromium via the relay in this run — so Commons "4/4" is **unverified in
  the merged build**, and the 2/2 number must not be quoted as a Commons
  result.
- **Follow-up (decision needed, NOT fixed here — read-only task):** to make
  person detection actually run on real sites, the extension would need to
  re-fetch cross-origin image bytes with CORS (e.g. `fetch(url)` from the
  content script / background and detect on the blob) or set
  `crossOrigin='anonymous'` before the image loads — neither exists in this
  build. Until then, "person detection on real sites" = "cover everything
  unreadable", and the scanner's per-person counts (4/4, 20/20) do not
  transfer to the extension.

No bug was found in the merged build itself (no crash, no missed-to-ALLOW on
real sites — 0 missed; everything unreadable was covered). The gap is the
missing cross-origin fetch path.

## E. SafeSearch — PASS

Standard policy (`force_safesearch: true`, rules from API):

| Engine | Final URL | Param |
|---|---|---|
| Bing | `https://www.bing.com/search?q=albert+einstein&adlt=strict` | `adlt=strict` ✓ |
| DuckDuckGo | `https://duckduckgo.com/?q=albert+einstein&kp=1` | `kp=1` ✓ |
| Google | `https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dalbert%2Beinstein%26safe%3Dactive…` | `safe=active` inside `continue=` ✓ (Google bot-checks headless Chromium — see §G) |
| YouTube | `https://www.youtube.com/watch?v=dQw4w9WgXcQ` (unchanged, loads) | — (Restricted Mode NOT enforced, as documented; needs DNS/CNAME) |

### Gate-off (temp policy) — PASS, and the old API bug is FIXED

- Created temp policy `Test — Merged SafeSearch Off`
  (`29640720-affe-4610-a8d4-9d8a223ed8f4`) with `force_safesearch: false`
  via `POST /api/v1/policies` — **the API stored `false` directly**
  (`stored force_safesearch: false`, GET-back confirmed `false`). The
  earlier bug (POST ignoring the field, DB UPDATE workaround needed) is
  gone; no DB workaround was used this time.
- Temp device `abd68b33-debe-4ca6-a1b1-8556796e2d79`, live sync:
  `safeSearchEnforced: false`, `safeSearchRulesCount: 0`, DNR total 33
  (22 + 11 + 0). Google search navigation stayed on `www.google.com`
  (via /sorry, whose `continue=` contains the search URL **without**
  `safe=active`). `pass: true`.

### Ads-on (temp policy) — PASS

- Temp policy `Test — Merged Ads On` (`c2280d5e-d82b-45a8-afe4-6df0353df5c8`,
  `filter_ads: true`) + device `ef7357a4-6c7d-4875-95c6-07eb48cbab16`.
  Live sync: `adBlocklistDomains: 26`, `adRulesCount: 52`, DNR total 114
  (22 + 37 redirects + 52 ads + 3 SafeSearch).
- `https://doubleclick.net/` → `chrome-extension://<id>/blocked.html?d=doubleclick.net`
  (Yiddish, policy `Test — Merged Ads On` shown). `pass: true`.

### Cleanup — PASS (SELECT-verified)

Both temp devices + both temp policies deleted via `fpsql.py`. Verified
afterwards with single-statement SELECTs (the harness's multi-statement
SELECT failed — `fpsql.py` takes one statement; re-run singly):
`SELECT … FROM policies WHERE name LIKE 'Test%'` → **0 rows**;
`SELECT … FROM devices WHERE name LIKE 'Test%'` → **0 rows**;
`SELECT count(*) FROM policies` → **1** (Standard only);
`SELECT count(*) FROM devices` → **8**. API `GET /api/v1/policies` also
shows no `Test — Merged` policy. (The JSON's `cleanup` object was updated
with the verified SELECT results.)

## F. Block page — PASS

`https://www.facebook.com/` →
`chrome-extension://<id>/blocked.html?d=facebook.com` (not
`ERR_BLOCKED_BY_CLIENT`). Title: `דער פּלאַץ איז בלאקירט — פֿילטער פּלאַטפאָרם`.
Body shows: `בלאקירט` ✓, domain `facebook.com` ✓, policy
`פּאָליסי: Standard — block images + explicit words, rest open` ✓.
Screenshot (visually checked): `merged-facebook-blocked.png` — Yiddish
heading, domain in red, policy line, review/dashboard/back buttons.
DoubleClick block page likewise screenshotted
(`merged-doubleclick-blocked.png`).

## G. Google Images — NOT VERIFIED (Google /sorry, as before)

`https://images.google.com/search?q=albert+einstein&tbm=isch` → HTTP 200
but final URL `https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dalbert%2Beinstein%26safe%3Dactive%26udm%3D2…`
— "Our systems have detected unusual traffic from your computer network",
IP `2a04:4e41:14:45b3::4333:c5b3`, 2026-11-18T20:41:07Z. The SafeSearch
param (`safe=active`, `udm=2`) is present in the `continue=` URL, which
proves the DNR rule fired; no image results were ever served, so no
detection counts exist for Google Images. **Stopped there — no CAPTCHA
attempted, no challenge interaction.** Screenshot:
`merged-google-images.png` (the /sorry page).

## H. dogfood.py — PASS (green)

Exit 0, `DOGFOOD TEST COMPLETE`. Register → device + 6-digit code → active;
wrong code → clean 404; domain checks (facebook block, wikipedia allow,
pornhub block, khanacademy allow, bbc.com allow unlisted-open); classify
example.com approved 0.95, httpbin.org review; heartbeat online
`filter_active=True`; dashboard HTTP 200. (The only "fail" string in the
log is the intentional wrong-code step, step 3b.)

## Screenshots (extension/verify/)

- `merged-standard-testpage.png`, `merged-cover-testpage.png`,
  `merged-strict-testpage.png` — test page in the three modes
- `merged-facebook-blocked.png` — Yiddish block page (visually checked)
- `merged-doubleclick-blocked.png` — ads-on block page
- `merged-google-images.png` — Google /sorry page
- `merged-wikipedia.png` — Main Page with covered images (visually checked)
- `merged-bbc.png`, `merged-commons.png` — real-site pages as scanned

## What is still missing / unverified

1. **Person detection on real sites** — see §D. The detector works on
   same-origin images only; on real sites everything is covered as
   uncertain. Needs a cross-origin fetch design decision.
2. **Commons Featured pictures** — only 2 footer-logo `<img>` in the DOM in
   this run; the galleries never rendered. Not a real Commons measurement.
3. **Google Images** — /sorry bot-check; unverified in headless Chromium.
   Needs a real (non-headless / residential-IP) browser or a different
   image-search target.
4. **BBC lazy images** — 109/127 `<img>` skipped (not loaded at scan time);
   a scrolled, longer-settle BBC run would scan more, but every scanned one
   would still be uncertain-covered per §D.
5. **Strict-mode non-image behavior** — strict ≡ cover for images by design;
   if strict is meant to do more (e.g. video), that behavior is not in this
   build and was not tested.
6. **YouTube Restricted Mode** — not enforced by the extension (known,
   needs DNS/CNAME); YouTube loads normally and was not broken by the
   extension.
7. No extension bug found in the merged build. One harness note: the
   multi-statement cleanup SELECT in `verify-merged.js` fails
   (`fpsql.py` = one statement); cleanup was verified with single
   statements instead and the JSON updated accordingly.
