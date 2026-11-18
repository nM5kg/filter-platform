# Cross-origin refetch verification — Filter Platform MV3 extension (2026-11-18)

Verifies the v1.2.0 fix for the merged-build §D finding: person detection
never ran on real sites because `content.js` short-circuited every
cross-origin `<img>` without CORS straight to "uncertain". The fix
re-fetches the image bytes from the extension side and runs the existing
person+face detection on the re-fetched pixels.

- **Harness:** `harness/verify-crossorigin.js` (new; Playwright 1.65.1,
  headless Chromium 159, `--load-extension`, egress relay
  `127.0.0.1:18080` spawned by the harness, `--ignore-certificate-errors`;
  local servers :8123 test page, :8124 photos, :8125 test set)
- **Run:** 2026-11-18 ~21:30–22:07 EST (28 min). Extension id in this run:
  `keibjodbjaonlckfkaejiiefaikphdfg`. Manifest version confirmed live via
  `chrome.runtime.getManifest()` in the run: **1.1.0** (the manifest was
  NOT bumped — see "Version note" below; the code comments/README call
  this change v1.2.0).
- **Results JSON:** `extension/verify/results-crossorigin-2026-11-18.json`
  (full per-image logs, audits, refetch matching)
- **Baseline for comparison:** the same harness was run once BEFORE the
  iframe-fetch change (content-script fetch only), same day ~20:40–21:10
  EST — its numbers are quoted as "baseline (content-fetch)" below. That
  baseline run's JSON was not kept (it wrote the same results file, which
  the final run overwrote); its console log is `/tmp/xorigin-run.log`.

## Verdict table

| # | Case | Result |
|---|---|---|
| A | Test page, block mode — cross-origin Einstein now detected | **PASS** (7 human blocked, 0 uncertain; was 6 + 1 uncertain) |
| A | Test page, cover mode — same verdicts, covered not blocked | **PASS** (7 covered, 0 uncertain) |
| B | 16-photo test set — precision/recall unchanged | **PASS** (1.000 / 0.727, identical to pre-fix) |
| C | Wikipedia Main Page — detection runs, matches scanner's people | **PASS** (4 human blocked, 0 uncertain; scanner's 3 still-present people all found) |
| C | BBC home — detection runs on all loaded images | **PASS** (44 human blocked, 2 uncertain weak-signal only; 0 CORS-uncertain) |
| C | Commons Featured pictures — detection runs | **PASS with caveat** (13 human blocked, 0 CORS-uncertain; first scan never finished in 420 s — see §C) |
| D | Exfiltration audit — extension fetches only image URLs the page loads | **PASS** (see §D for the cache-served nuance and the 3 false positives) |
| E | Fail-closed preserved — every refetch failure still ends covered | **PASS** (0 refetch failures in this run; the failure path is the same code as the baseline run's 2 failures, both covered) |

## A. What changed (and the one finding that reshaped the design)

**Files edited:** `extension/content.js`, `extension/detector.js`,
`extension/detector-page.js` (only). `background.js`, `popup.js`,
`blocked.html`, `blocked.js` untouched. `manifest.json` untouched — no
new permission is needed (`host_permissions` already cover
`http://*/*` `https://*/*`). `extension/README.md` updated (new
"Cross-origin refetch (v1.2.0)" section + `detector.js` file entry).
New harness `harness/verify-crossorigin.js`.

**Design as first implemented (content-script fetch):** for a cross-origin
`<img>` without CORS, `fetch(url)` from the content script → blob →
object URL → probe `Image` → existing `detectImg` (person+face). Verdicts
cached per URL (max 500, oldest evicted); 8 MiB cap (Content-Length fast
path + streaming reader that aborts past the cap); 15 s fetch timeout;
credentials omitted; any failure → uncertain → covered.

**The finding (verified live, not guessed):** a content-script `fetch()`
is subject to the page's CORS rules — `host_permissions` do NOT exempt
it. Evidence from the baseline run: Wikipedia (`thumb.wikimedia.org`,
sends `Access-Control-Allow-Origin: *`) refetched 19/19 with 0 failures,
BBC (`ichef.bbci.co.uk`, also ACAO:*) 71/71 with 0 failures — but the
test page's `:8124` image (python http.server, no CORS headers) and the
facebook favicon (no ACAO) both failed with `refetch failed: Failed to
fetch` (a CORS TypeError; the pages' own `<img>` loads of the same URLs
succeeded, so the network path was fine). So the content-script fetch
only works where the host already sends ACAO:* — exactly the hosts that
least need the fix.

**Design as shipped:** the fetch moved into the **detector iframe**
(`detector.html`, an extension-origin page). Its fetch runs with the
extension's `host_permissions` and is NOT CORS-gated, so it reads any
http(s) image the page loads. New bridge call `FpPersonDetector.fetchImage(url)`
(`detector.js`: `ensureIframe()` extracted from `ensure()`, `fp-fetch-image` /
`fp-fetch-result` messages, 20 s round-trip timeout) and a
`fp-fetch-image` handler in `detector-page.js` (same 8 MiB / 15 s /
image-only / credentials-omit caps, returns the bytes as an
`ArrayBuffer` over `postMessage`). `content.js` keeps the content-script
fetch only as a fallback for when the iframe itself is unavailable (page
CSP blocks `chrome-extension://` iframes) — it still helps for
CORS-enabled hosts on such pages, and lets face detection run there. If
the iframe fetch fails for a fetch reason (HTTP/network/size/type), the
direct path is NOT retried (it would fail the same way) — fail closed.
`via` in the log now records `refetch-iframe` / `refetch-direct` /
`refetch-cache` / `direct` / `short-circuit`, and the DOM stats mirror
carries the last 500 log entries (was 100) so large pages keep a full log
for verification.

**Same-origin path untouched.** Probe images are `blob:` object URLs
never added to the DOM, so the MutationObserver/scan never sees them —
no detection loops (verified: no `blob:` image is ever scanned; the only
`blob:` requests are the probe loads themselves).

## B. Test page (demo block + cover, relay context)

| Mode | found / scanned | human | blocked | covered | uncertain | no-human | bg found / bg human | skipped | personHits | refetched / failed / cache |
|---|---|---|---|---|---|---|---|---|---|---|
| block | 10 / 11 | **7** | 7 | 0 | **0** | 4 | 1 / 1 (blocked) | 2 | 7 | 2 / 0 / 0 |
| cover | 10 / 11 | **7** | 0 | 7 | **0** | 4 | 1 / 1 (covered) | 2 | 7 | 2 / 0 / 0 |

Baseline (content-fetch, same demo modes): 10/11, 6 human, 2 covered,
2 uncertain, 3 no-human, refetched 2 / failed 2. The fix moves both
uncertain images to real verdicts:

- `img-xorigin-local` (`http://127.0.0.1:8124/person-einstein.jpg`, the
  cross-origin no-CORS Einstein — the merged report's 1 uncertain-covered
  image): now `via: refetch-iframe`, person 0.935 + face 0.956 →
  `person+face`, **human, blocked** (block) / covered (cover). This is the
  exact case the task asked to be "properly detected".
- facebook favicon probe (`https://www.facebook.com/favicon.ico`): now
  `via: refetch-iframe`, person 0 / face 0 → **no-human, left alone**
  (was uncertain-covered). In demo mode there are no DNR rules, so the
  favicon loads; in policy mode it would still be DNR-blocked.
- Background Einstein: person 0.935 + face 0.956 → blocked/covered as before.
- `img-xorigin` (Wikimedia `Special:FilePath`, `crossorigin="anonymous"`):
  **still never loads** (request fails even via the relay), counted in
  `skipped`, never left visible as cleared. Same as the merged run.
- The other `skipped` entry is a transient skip (lazy/dynamic image
  skipped once, then processed later — `skipped` counts it once).
- No `[fp]` console errors on the test page in either mode.

## C. 16-photo test set + real sites

### Test set (block mode) — PASS, identical to pre-fix

| TP / FP / FN / TN | Precision | Recall | Uncertain on person imgs | Missed to ALLOW |
|---|---|---|---|---|
| 8 / 0 / 3 / 5 | **1.000** | **0.727** | 0 | 3 (b1, b2, d3) |

Same-origin set, so the refetch path is not involved (`via: direct` on
all 16). Per-image scores match the merged run exactly (b3 0.885, d1
0.617, d2 0.627, g1 7 persons 0.661 + 1 face, g2 0.882, g3 10 persons
0.734, p1 0.968, p2 0.980; all 5 no-person images `no-human`). Scan
25,055 ms. The fix changes nothing where detection already worked.

### Real sites (demo block, relay, scanner-style scroll pass + settle wait)

| Site | imgs in DOM at read | found / scanned | human | blocked | covered | uncertain | no-human | skipped | personHits | refetched / failed / cache |
|---|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org/wiki/Main_Page | 20 | 24 / 24 | **4** | 4 | 0 | **0** | 20 | 15 | 4 | 19 / 0 / 0 |
| www.bbc.com/ | 35 | 136 / 136 | **44** | 44 | 2 | **2** | 90 | 74 | 43 | 67 / 0 / 69 |
| commons.wikimedia.org/wiki/Commons:Featured_pictures | 227 | 238 / 242 | **13** | 13 | 2 | **2** | 227 | 103 | 13 | 151 / 0 / 83 |

Scanner v0.2.0 on the same URLs (40-candidate cap): Wikipedia 4 people /
4 blocked, BBC 20 / 20, Commons 4 / 4. **The extension now detects on
real sites instead of covering everything unreadable** — 0 uncertain from
CORS on all three sites (the 2 uncertain on BBC and Commons are weak
0.40–0.50 signals, fail-closed covered, not fetch failures).

**Wikipedia — matches the scanner's people.** Human (all
`via: refetch-iframe`): Gilbert 0.853 (person), Jensen Huang 0.964
(person+face), Khrushchev 0.975 (person+face) — 3 of the scanner's 4.
The scanner's 4th, Bunlet Harcourt 1937, is **no longer on the live
page** (verified: not among the 24 scanned images; the Main Page's
featured content rotates daily) — not a miss. The 4th human is a **false
positive**: the Wikibooks logo SVG detected as a person at 0.581
(person-only). The microscope, Przewalski's horse, party photo and
flycatcher are now correctly `no-human` (they were uncertain-covered in
the merged run). `via: direct 5, refetch-iframe 19`. Settled: yes.

**BBC — detection runs on everything loaded.** 136 scanned (the scanner
capped at 40 candidates; the extension scans all loaded images). 44
human blocked (43 by person, 1 by face-only — 3 human entries are
face-only detections where the person detector found 0). The 2 uncertain
are weak signals 0.466 / 0.478 (fail-closed covered). `via:
refetch-iframe 67, refetch-cache 69` — every BBC image is cross-origin,
so 100% of verdicts came through the refetch path. Settled: yes (210 s;
the baseline run never settled in 420 s — BBC's homepage churns, and
counts move between runs: baseline today was 127 scanned / 48 human, so
BBC numbers are NOT comparable across runs; what is comparable is that
CORS-uncertain is 0 in both). One unattributed page error during BBC:
`Uncaught (in promise) Error: invalid callback function` — appears once
per BBC run, has no `[fp]` marker, and the string occurs NOWHERE in the
extension's code (grep over content/detector/detector-page/background +
vendor bundles: 0 hits); a no-extension control run of BBC in the same
headless Chromium also throws BBC's own uncaught errors (a `_consent`
TypeError + a permissions-policy violation in 45 s). Attributed to BBC's
own JS, not the extension; the scan completed with full stats in both
runs.

**Commons — detection runs, with a scale caveat.** 13 human blocked,
including The Terror of War (10 persons, 0.720), Claudia Jones 1948
(0.888), Helga Dernesch (0.979), Marit Stiles (0.953), Olivia O'Brien
(0.794). The 2 uncertain are weak signals 0.489 / 0.480. `via: direct 4
(+ 4 background entries with no via), refetch-iframe 151,
refetch-cache 83`. **Caveat: `scanDone: false`, `settled: false`** — the
first scan never finished within the 420 s wait (242 images sequential
at ~1.1–1.3 s each + fetch, plus re-scans as lazy images load), and stats
were still moving when the 420 s settle wait expired. The 242 scanned /
13 human counts are a snapshot at timeout, not a stable final count —
the scanner's 4/4 was a 40-candidate cap on an earlier snapshot, so the
13 vs 4 gap is coverage (242 vs 40 images), not a detector disagreement.
Background images: 4 found, 0 human (the merged run's bg Einstein case
is a test-page case, not a Commons one).

## D. Exfiltration audit — PASS

Method (fixed vs the baseline run, whose audit misclassified
blocked-then-removed images): requests captured at **context** level (so
the detector iframe's fetches are seen too); reference URL set = nav-time
DOM image URLs **plus every src in the extension log** (a blocked image
leaves the DOM when `blockImg` replaces it); reference hosts = every host
the page itself references. Two checks: (1) every fetch/xhr to an image
host must be a URL in the log/nav set; (2) every URL the log says was
refetched must have a matching fetch request — **except cache-served
refetches (see below)**. Non-GET requests are listed with hosts; the
extension's code issues only GETs (both fetch sites audited by reading
the code: `fetch(url, {mode:'cors', credentials:'omit'})`, no body).

| Site | UNEXPECTED | non-GET | refetch URLs | refetch w/o visible fetch req | fetch to img host not in log |
|---|---|---|---|---|---|
| test page block | **0** | **0** | 2 | 1 (favicon, cache-served) | 0 |
| test page cover | **0** | **0** | 2 | 1 (favicon, cache-served) | 0 |
| Wikipedia | 2 | 2 | 19 | 5 (cache-served) | 0 |
| BBC | 265 | 167 | 67 | 0 | 0 |
| Commons | 12 | 9 | 151 | 90 (cache-served) | 3 (false positives, see below) |

- **No data leaves the browser.** Every fetch the extension makes is a
  GET of a URL the page already loads (a DOM `<img>` src or a redirect
  descendant of one). No new third-party hosts: the only hosts the
  extension contacts are the pages' own image hosts
  (`thumb.wikimedia.org`, `ichef.bbci.co.uk`, `static.files.bbci.co.uk`,
  `127.0.0.1:8124`) plus `chrome-extension://` (bundled model/WASM/weights
  files) and the local test servers. No request bodies anywhere from the
  extension; no POSTs from the extension at all.
- **Cache-served refetches (the "without fetch" column).** For 1/2 test
  page, 5/19 Wikipedia and 90/151 Commons refetches, no network request
  event exists — yet the bytes were definitely obtained (a real verdict
  was computed with ms ~1.1 s, not a failure/uncertain). Mechanism: the
  page's own `<img>` load populates the browser HTTP cache (Wikimedia and
  facebook send long `Cache-Control`), and the iframe's refetch is then
  served from cache without a network request event. That is the
  *better* outcome (zero extra network traffic) and is consistent with
  the README's "often a cache hit" note. BBC shows 0/67 because
  `ichef.bbci.co.uk` responses are not long-cached the same way.
- **The "UNEXPECTED" / non-GET rows are the pages' own traffic, not the
  extension's.** Wikipedia: `auth.wikimedia.org` CentralAutoLogin script
  (the page's own) + 2 POSTs (Wikipedia's own `…/v2/events` telemetry
  and Chrome's `odml.pa.googleapis.com/v1/log` on-device-ML telemetry).
  BBC: 265 unexpected / 167 non-GET are all BBC's own ad/tracker hosts
  (doubleverify, piano, mparticle, googletagmanager, chartbeat, teads,
  cxense, …) — the page loads them itself; the extension never requests
  them (0 fetches to an image host outside the log). Commons: 12
  unexpected / 9 non-GET are doubleverify (`maestro-*.tps.dv.tech`),
  `pagead2.googlesyndication.com`, `auth.wikimedia.org`, and the same
  Chrome `odml` POST. The `odml.pa.googleapis.com/v1/log` POST appears
  on all three real sites and is Chrome's own telemetry, not an
  extension request (the extension never POSTs).
- **The 3 Commons "fetch to img host not in log" are audit-heuristic
  false positives:** they are the page's own XHRs to
  `commons.wikimedia.org/w/api.php` (MediaWiki API — image annotator),
  `cls: page-own-origin`. The host doubles as an image host, so the
  heuristic flagged them; they are API calls, not image fetches, and
  0 fetch requests to `thumb.wikimedia.org` fall outside the ref-URL set.

## E. What is still missing / unverified

1. **Direct-path fallback (content-script fetch when the detector iframe
   is down) is NOT verified live.** No test page with a CSP blocking
   `chrome-extension://` iframes was run. The code path exists and is
   the same fetch the baseline run exercised (it works for ACAO:* hosts,
   fails closed otherwise), but the iframe-down → fallback → face-only
   chain was not demonstrated end to end.
2. **8 MiB cap / 15 s timeout / non-image content-type rejection are
   implemented, not live-tested.** No >8 MB image and no non-image URL
   occur in the test page, test set or real sites run. The caps are in
   both fetch sites (`detector-page.js` + `content.js`) with identical
   constants; a dedicated test (e.g. a local 20 MB file) would verify
   them.
3. **Commons never reaches a stable final count** in this environment
   (first scan >420 s, settle timeout). A longer budget or a
   scan-concurrency change would be needed for a settled Commons number;
   the 13 human / 0 CORS-uncertain snapshot is the honest result.
4. **BBC numbers move between runs** (homepage churn: 127/48 in the
   baseline run today vs 136/44 now). Do not quote a single BBC count as
   "the" BBC result; the stable claims are 0 CORS-uncertain and
   detection running on every loaded image.
5. **Wikibooks logo false positive** (person 0.581 on a book-logo SVG).
   Pre-existing detector behavior (EfficientDet on a small line-art
   logo), not caused by the refetch — the same pixels through the direct
   path would score the same. Worth a threshold/model note, not a
   refetch bug.
6. **`img-xorigin` (Wikimedia FilePath, `crossorigin="anonymous"`)
   still never loads**, even via the relay — counted in `skipped`, never
   left visible as cleared. The direct-path cross-origin case therefore
   has no live positive in this run (the refetch path covers the
   no-CORS case instead).
7. **Version note:** `manifest.json` still says 1.1.0 (not edited per
   instructions — no new permission is needed). The code comments and
   README call this change v1.2.0; bump the manifest version on merge.

## Screenshots (extension/verify/)

- `xorigin-block-testpage.png`, `xorigin-cover-testpage.png` — test page
  in block/cover mode (7 human blocked/covered, 0 uncertain)
- `xorigin-wikipedia.png`, `xorigin-bbc.png`, `xorigin-commons.png` —
  real-site pages as scanned

## Harness notes

- `harness/verify-crossorigin.js` is the new harness (test page block +
  cover, test set, real sites with scroll pass + settle wait, audit with
  nav snapshot + log-URL refetch matching). Reuse it for re-runs; it
  overwrites `results-crossorigin-2026-11-18.json` and the `xorigin-*`
  screenshots.
- A smoke check with the older harness (`verify-phase2-person.js block`,
  no relay, output to `/tmp/xorigin-smoke.json`) also passes with the new
  code: test page 7 human blocked / 0 uncertain / 0 covered, test set
  1.000 / 0.727. Its 1 "UNEXPECTED" request is the `blob:` probe-image
  load, which the new harness classifies as `inline` (expected).
- No API token was used (demo modes only); no GitHub upload; no temp
  policies/devices were created, so no cleanup was needed.
