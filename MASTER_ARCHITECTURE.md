# Filter Platform — Master Architecture Plan (updated)

**Status:** updated 2026-11-18 ~12:54 EST per Yakob's five decisions (see
Decisions log below). Updated 2026-11-19: tech list folded in from
`TECH-STACK.md` (Yakob's authoritative list, 2026-11-19) and the model
choice decided — **RF-DETR is the officially agreed model** (Yakob,
2026-11-19 ~02:28–02:30 EST, "אונזער נייע אפמאך. אפיציעלע"), pending
CPU measurements. This is the single authoritative plan for the whole
platform. Where an older doc disagrees with this file, **this file wins** —
the older doc is marked stale in place where noted. Corrected 2026-11-18
~19:15 EST: decision 4 (the `other_tcp` setting does not exist — nothing
for Yakob to do) and the extension bullets (now v1.2.0) updated.

**Precedence rule (Yakob, 2026-11-19):** ALWAYS use this updated plan
first. Where it does NOT cover something, use the LATEST version of the
original Master Technical Architecture (the document re-sent 2026-11-19,
including its testing plan in `TESTING-PLAN.md`). If the two ever
disagree, this updated plan wins — and the disagreement must be flagged,
not silently picked. Known disagreements flagged: (1) the original says
"Browser Foundation: Chromium" (§3, §15) — this plan says GeckoView
Stable (decision 1). (2) The original lists a longer stack (Chromium,
OpenVINO, Hugging Face, PyTorch, Queues, R2, WAF, Turnstile) — the
authoritative tech list is now `TECH-STACK.md` (Yakob, 2026-11-19; see
"Technology list" below): those are the **chosen** technologies, and
only GitHub / Cloudflare / Neon (+ Playwright as test tooling) are
**live-connected** today; Queues/R2 are deferred until the scanner
becomes a deployed service, WAF/Turnstile until production hardening;
GeckoView/Kotlin are the app stack (phone work parked); OpenVINO/ONNX/
OpenCV/OMZ/Hugging Face/PyTorch are model tooling and research sources,
not accounts to connect.

**What this plan covers:** the free kosher internet filter platform —
own Android browser app + own Filtering Engine, AI Visual Protection
Engine, pre-rendering website scanner, Phase 1 Core API (Cloudflare +
Neon), browser extension, dashboards, device management, production.
Stack: **GitHub + Cloudflare + Neon**, as few vendors as possible;
Cloudflare for CPU/compute where it makes sense. CPU-first (no GPU in v1).
Target: 10,000+ customers; Android phones first, then iPhone and computers
(cross-platform — the shared engine serves every device).

**Docs that make up the plan (read together):**
- This file — decisions, browser base, scanner rework, sequencing.
- `ARCHITECTURE.md` — Phase 1 Core Platform (API, schema, classifier,
  dashboard). Still current, except where this file says otherwise.
- `ARCHITECTURE-DIAGRAM.md` — system diagram + module split. Still current,
  except its "browser-base decision open" lines, which this file closes.
- `android/GECKOVIEW-RESEARCH.md` — pinned GeckoView/AC versions, licenses,
  Gradle snippets, WebExtension research (primary sources, read live
  2026-11-18). The version pins in §1 below come from there.
- `CHROMIUM_ANDROID_ASSESSMENT.md` — why raw Chromium and Cromite were
  assessed and set aside (raw Chromium ~100 GB build, 2–4 h+, permanent
  rebase treadmill; Cromite GPLv3, lags upstream).
- `scanner/README.md` + `scanner/SCAN_REPORT.md` — the Playwright/Chromium
  scanner prototype v0.2.0. It proved the pipeline; it does **not** prove
  what the Android browser sees (see Scanner rework below).
- `extension/` — MV3 browser extension (desktop Chrome/Edge; Android via
  Vivaldi 8.2+ until the own browser ships).

---

## Decisions log — Yakob, 2026-11-18 ~12:54 EST

All five were decided by Yakob in one message that day; they replace the
open items they name. Nothing below is Muse's invention.

### 1. Browser Foundation: GeckoView (main candidate)

- **GeckoView is the browser base** for our own Android Browser App.
- Use GeckoView with the needed **Mozilla Android Components** where they
  help build the Browser UI and Browser Functions.
- **Own Browser App + own Filtering Engine** — not a ready-made foreign
  browser UI.
- Use the **Stable release, not Nightly**, for the first production version.
- Check the **exact version and all licenses** of the components.
- **Cromite is NOT the main base** (GPLv3). **Raw Chromium stays backup
  only** if GeckoView cannot meet the technical requirements.

**Pinned versions (verified live from Mozilla Maven, 2026-11-18 — see
`android/GECKOVIEW-RESEARCH.md` §1–§3):**

| Piece | Pin | Channel |
|---|---|---|
| GeckoView | `160.0.20261116130455` (Firefox 160.0.1 build, 2026-11-16) | Stable |
| Mozilla Android Components | `160.0.1` (its `browser-engine-gecko` POM depends on exactly that GeckoView build) | Stable |
| Minimum Android | API 26 (Android 8.0) — skeleton already uses `minSdk = 26` | — |

**License:** GeckoView and all Android Components are **MPL-2.0**
(file-level copyleft only — our own app code can stay closed; modified
MPL files stay MPL-2.0 with source available). Cromite/GPLv3 would have
forced the browser app itself open-source — that is the license reason it
was rejected. A full license review of the final dependency tree is still
required before commercial shipment (not legal advice).

**Why GeckoView, in one line:** current (Stable 160, updates ~every
2 weeks) and MPL-2.0; Chrome is now 158 (16 Nov) and Chrome 157 fixed
CVE-2026-125350, actively exploited and on CISA's list — a fork lagging
upstream is concretely exposed, and Cromite's current Chromium version
could not even be verified that day (in October it was 4 behind: 153 vs
157).

### 2. Person-detection model — DECIDED 2026-11-19: RF-DETR (official agreement)

- **RF-DETR is the officially agreed model** (Yakob, 2026-11-19
  ~02:28–02:30 EST: "אונזער נייע אפמאך. אפיציעלע"). Apache 2.0, free
  for commercial use; weights run on our own hardware; **no API
  credits, no per-image or per-customer payment**; Nano, Small, Base,
  Medium and Large versions; CPU + ONNX support. One shared AI server
  serves all 10,000 customers — the server, electricity and
  infrastructure still cost money; only the model/API is $0.
  Roboflow's own hosted inference is **NOT** used — self-hosted only.
  Not every model in Roboflow's system has the same license: RF-DETR's
  own license must be verified from its own repo (see
  `scanner/models/PRODUCTION-MODELS.md` §3 — repo LICENSE + README
  already verified Apache 2.0 there on 2026-11-18; the CPU benchmark
  re-verifies it from the repo and records hashes).
- **CPU proof DONE 2026-11-19 (measured, not claimed):** RF-DETR Nano
  + Small benchmarked on CPU on the 16-photo labeled set (ONNX Runtime,
  2 threads, this VM): **Nano — 327 ms infer / 422 ms end-to-end,
  2.37 img/s, recall 1.000 @0.50 / 0.909 @0.70, precision 1.000,
  0.71 GB peak RSS; Small — 572 ms / 658 ms, 1.52 img/s, recall
  1.000 @0.50 / 0.727 @0.70, precision 1.000.** Both beat the
  EfficientDet-Lite0 baseline (recall 0.727 @0.50 / 0.455 @0.70) with
  zero false positives; Nano fixes the baseline's worst gap (the two
  back-view photos score 0.974 and 0.832). **Nano is the recommendation**
  — Small costs 1.75× the compute for no gain here. Honest capacity:
  one Nano stream ≈ 2.4 img/s; a 20-image page is ~8.5 s single-stream,
  ~2–3 s with 4 workers — fine for cover-until-decided still-image
  scanning with caching/dedup, not live video. Full numbers, sources,
  hashes: `scanner/models/RF-DETR-BENCHMARK.md`. Limits: n=16 only;
  no real-site validation yet; INT8, batching, video not tested.
- Keep EfficientDet-Lite0 for **prototype and first testing ONLY**.
  **Do NOT confirm it as the production model** until the exact model
  weights, hash, source and license are confirmed.
- Intel person-detection-0202 stays a **candidate** (Apache 2.0
  verified from the repo, but published checksums do not match the
  served files and Intel recommends written confirmation before
  commercial shipment).
- Check **all upstream dependencies AND model weights**, not just the
  program license.

**Current evidence (2026-11-18):** Google's own docs name the model but
give no weights license — there is no Google page to confirm from. Two
second sources say **Apache 2.0** (pub.dev: files byte-for-byte
identical to Google's official builds — strictly the float32 build, not
our float16 file; PitchOverlay). A third claimed source ("KTag SBOM")
could not be located at all and is treated as non-existent. The
TF Hub page itself cannot be read (redirects to Kaggle behind a wall).
Record it as Apache 2.0 on the second sources, verify before commercial
sale — moot for production now that RF-DETR is agreed, unless RF-DETR
fails on CPU. Intel OMZ person-detection-0202 is **Apache 2.0,
verified**, but not chosen (IR-only, needs an ONNX/TFLite path). YOLO is
**excluded** (AGPL-3.0).

**Measured today (scanner v0.2.0, labeled test set of 16 real photos):**
precision 1.000, recall 0.455 (face-only would be 0.18); 3 missed outright
to ALLOW (back views, distant walker). Real sites: Commons 4/4 blocked,
Wikipedia 4/4, BBC 20/20, example.com ALLOW. Recall is the known gap —
the production-model research must weigh recall as well as license.

**Weights on disk:** `scanner/models/efficientdet_lite0.tflite`, 7,254,339
bytes, SHA-256 `4b591000…80993` (see `scanner/models/LICENSES.md`).

### 3. Visual Scanner — reworked for GeckoView (important change)

- The scanner must be **reworked per GeckoView**. Do NOT assume a
  Playwright Chromium scanner always sees exactly the same content as
  our Android browser.
- Build a **prototype that checks visual content INSIDE GeckoView**.
- Use **built-in privileged WebExtensions, content scripts and a native
  bridge**.
- Test **separately**: HTML Images, CSS Backgrounds, Canvas, SVG, WebGL,
  Video Frames, Live Streams, Dynamic Content.
- **Unreviewed visual content stays COVERED until the decision is ready.**

**How it works in GeckoView (researched, not yet built — see
`android/GECKOVIEW-RESEARCH.md` §7):** a bundled (built-in) extension
ships inside the APK under `/assets/`, installed via
`WebExtensionController.installBuiltIn` / `ensureBuiltIn`
(`resource://android/assets/...`). Native messaging via
`GeckoRuntime.sendNativeMessage` / `connectNative`; the privileged
permissions `geckoViewAddons` and `nativeMessagingFromContent` are only
available to built-in extensions — `nativeMessagingFromContent` is what
lets a content script talk to the app directly. Test the narrower
background-script-only design first; add the content-script permission
only if the design requires it.

**Test matrix for the GeckoView prototype** (each row proven separately
on real content; a row is not "done" on a Chromium result):

| # | Content type | What must be proven | Chromium result to re-prove |
|---|---|---|---|
| 1 | HTML Images | person in `<img>` detected → COVER/BLOCK | 4/4 Commons, 4/4 Wikipedia, 20/20 BBC |
| 2 | CSS Backgrounds | `background-image` detected | covered by scanner v0.2.0 collection |
| 3 | Canvas | `drawImage` + animated frames detected | BLOCK (verified on real media) |
| 4 | SVG | inline/external SVG imagery detected | not yet verified anywhere |
| 5 | WebGL | WebGL-rendered imagery handled (cover if unanalysable) | unanalysable in Chromium scanner |
| 6 | Video Frames | paused + playing frames detected | BLOCK (Obama video, paused + playing) |
| 7 | Live Streams | stream frames sampled + decided | not yet verified anywhere |
| 8 | Dynamic Content | lazy-loaded / MutationObserver-added content caught | extension covers via MutationObserver |

**Fail-closed rule (unchanged):** person OR face = human; unreviewed or
unanalysable visual content stays **COVERED** until decided. Never ALLOW
on a miss.

**What the Chromium scanner still is:** the server-side pre-rendering
scanner (Playwright + headless Chromium, `scanner/`) stays as the
approval-engine / server-side check. It is no longer the proof for what
the Android browser sees — that proof now lives inside GeckoView.

### 4. Muse Build Permission — `other_tcp` (checked: the setting does not exist)

- Yakob's decision was to set the `other_tcp` permission to **Ask**,
  so Gradle could download the needed build dependencies.
- **Correction 2026-11-18 ~13:42 EST:** checked on every Permissions
  screen and in the full permissions list — there is **no**
  "Direct network protocols" / `other_tcp` setting anywhere in Muse,
  and no permission card exists to bring up. There is **nothing for
  Yakob to do here**; do not send him hunting for it.
- `./gradlew` stays blocked on this VM (JVM data transfer is
  intercepted — proven byte-for-byte; the Gradle daemon dies on the
  loopback socket), and a Gradle build of this module fails on **every**
  machine until Google publishes SDK platform 37 (GeckoView 160 needs
  `minCompileSdk=37`; highest published is platform-36, re-checked
  2026-11-18 ~14:53 EST). Android builds continue via the manual
  build path (`android/manual-build/build.sh`, verified: signed debug
  APK, 7/7 unit tests pass).

### 5. Further work — prototype first, no rebuild

- **Do NOT rebuild the whole project.**
- First make a **GeckoView Browser Prototype with the Visual Filter
  integrated**.
- Then **prove the scanner detects people on real sites, including
  Canvas and video**, and then continue with the whole platform.
- This file is the Master Architecture Plan updated per these decisions.

**Prototype sequence (next steps, in order):**
1. Gradle is blocked (decision 4 — the `other_tcp` setting does not
   exist, and SDK platform 37 is unpublished); the prototype continues
   on the manual build path until both blockers clear.
2. Apply the GeckoView/AC pins to the Android skeleton
   (`android/GECKOVIEW-RESEARCH.md` §5 has the Gradle snippets, not yet
   applied to any build file) and run the first Gradle sync — confirm
   `compileSdk`/`targetSdk` for GeckoView 160 (skeleton is at 34,
   unverified for 160).
3. Minimal GeckoView browser UI from Android Components (toolbar, tabs,
   session — own UI, no ready-made browser UI).
4. Built-in filter extension inside GeckoView (content scripts + native
   bridge; MV2 first — the documented path; MV3 support in GeckoView 160
   is unverified, test explicitly before committing). DONE in app 0.2.0
   (2026-11-19): the real v1.2.0 engine is in the app — EfficientDet
   person detector + face fallback in the built-in extension, Yiddish
   block page, SafeSearch rewrite; see
   `android/GECKOVIEW-PROTOTYPE.md` §0.2.0. Still unproven on a real
   device (step 5 is the device test).
5. Re-prove the test matrix (§3) inside GeckoView on real sites,
   including Canvas and video; unreviewed stays covered.
6. Only then continue with the rest of the platform (Phases 5–6).

---

## Technology list — chosen vs live-connected (Yakob, 2026-11-19)

Source: `TECH-STACK.md` — Yakob's authoritative tech list (latest
version, 2026-11-19). **Nuance he stressed: these are the CHOSEN
technologies, NOT all confirmed active connections or paid accounts.**
Do not claim a live connection for anything in the "chosen" column.

| Technology | Role | Status today |
|---|---|---|
| GitHub | Code, versions, tests, CI/CD | **Live-connected** (nM5kg/filter-platform) |
| Cloudflare | Workers, DNS, Queues, R2, WAF, security | **Live-connected** (Workers + Pages; Queues/R2/WAF/Turnstile deferred — see below) |
| Neon | Postgres — customers, policies, settings, logs | **Live-connected** (filter DB) |
| Playwright | Automated website tests | **Live-connected as test tooling** (in use) |
| Mozilla GeckoView | Foundation of the own Android browser | **Chosen app stack** — phone work parked; computer first |
| Kotlin | Building the Android app + browser | **Chosen app stack** — phone work parked |
| OpenVINO | Optimizing AI models on CPU | Model tooling / research source, not an account |
| ONNX Runtime | Running AI models | Model tooling (runtime for the RF-DETR ONNX export) |
| OpenCV | Image processing | Model tooling / research source, not an account |
| Intel Open Model Zoo | Trying open-source models | Research source (person-detection-0202 candidate) |
| Hugging Face | Finding and checking models | Research source (model cards / weights) |
| PyTorch | Training or adapting models, if needed | Model tooling, not an account |

How it fits together: own Android browser (Kotlin + GeckoView); our own
Filter Engine (DNS + Website Scanner + AI Visual Filter + Ad Filter);
Cloudflare for infrastructure and security; Neon for the database;
GitHub for the code and development. Stay with GeckoView — do not build
an own browser engine from scratch (Mozilla confirms GeckoView is made
for building own Android browsers).

**Still open (2026-11-19):** which CPU server will run the models;
which model licenses are safe for commercial use (RF-DETR's own license
is verified from its repo; commercial-use confirmation still prudent);
the final GeckoView tests. The exact AI model question is **decided**
(RF-DETR, decision 2 above) — what remains is proving it on CPU.

---

---

## Distribution — own website Download Center (decided by Yakob, 2026-11-19 ~02:39 EST)

**Our own website is the central Download Center. NO Chrome Web Store,
NO Google Play. Do NOT open those accounts — this saves the $5
(Chrome Web Store developer account, one-time) + $25 (Google Play
developer account, one-time). Cost of both stores: $0, because neither
is used.** Distribution is: extension ZIP + (later) Android APK, served
from our own site, with `public/versions.json` as the version manifest.

**Version / update-check design:** the site knows the current version.
`public/versions.json` lists each product (extension, android) with
`version`, `status`, `download_url` (or `null` when not downloadable),
`sha256`, `size_bytes` and a Yiddish note. The extension and (later) the
app check against `versions.json` to learn the current version — no store
does the update check for us. The extension ZIP (`public/our-filter-
extension-1.2.1.zip`, ~11 MB) is served from Cloudflare Pages, which
allows it; the APK is not (see hosting below).

**Release-signing rule:** a debug key is **NOT** for distribution. Only
a release-signed build is distributed. The current Android test build
(0.2.0, versionCode 5) is signed with a self-generated debug key
(`CN=Filter Platform Debug, OU=Dev, O=Filter Platform`, RSA 2048,
self-signed, created by `android/manual-build/build.sh` step 6) — it
must never be offered as a public download. Before the app ships, a
separate release key is created and kept safe, the app is rebuilt and
signed with it, and the Download Center publishes that build's SHA-256
and size. Until then the Android section of the Download Center shows
"test build — not for public download yet" and no download button points
at the debug APK. Android section content lives in
`public/download-android-snippet.html` (Yiddish RTL, incl. the
"Install unknown apps" steps for a non-technical customer).

**Honest limitations (tell the customer, don't hide them):**
- Chrome "Load unpacked" (developer-mode) install of the extension
  shows Chrome's own warnings; that is the sideload path while there is
  no store listing.
- Android "Install unknown apps" warning: because the APK does not come
  from Google Play, Android asks the user to allow installs from the
  browser once. The Download Center explains the steps in Yiddish.
- No store means no store review, no store auto-update, no store trust
  badge — the site itself (versions.json + SHA-256 on the page) is the
  trust mechanism. Customers must download only from our site, never
  from a stranger's link.

**APK hosting path + status (measured 2026-11-19 ~02:41–02:45 EST):**
the APK is 211,176,487 bytes — Cloudflare Pages cannot serve it (25 MB
per-file limit), so Pages is out for the APK. Cloudflare R2 would fit
it (free tier 10 GB storage, $0 egress) but **R2 is not enabled on the
account**: both `GET /accounts/{id}/r2/buckets` and `POST` (bucket
create attempt) return 403 error 10042, "Please enable R2 through the
Cloudflare Dashboard." This is an **account capability, not a token
scope** — the same token returns 200 for accounts and Workers. There
is **no API path** to enable R2; it needs Yakob (account owner) in the
dashboard (dash.cloudflare.com → R2 → Enable/Purchase R2) and Cloudflare
requires a payment method (card/PayPal) on file to enable it, even for
the free tier ($0 charged inside the free tier). That is a Yakob
decision — no payment was made and no bucket was created.
**Recommended path: R2 once Yakob enables it** (own infrastructure,
$0 at our size). Until then the only copy is the private Google Drive
file (`FilterPlatform-GeckoView-prototype.apk`, id
`1kM62lnbYwCIf41f8gGhQ3ki5Ra_i2DMW`, owner-only — NOT publicly
shared; size 211,176,487 bytes and MD5
`948758d35de69213d708490df94a658e` verified identical to the local
build) — it is a backup, not a public download. GitHub Release asset
would also fit (2 GB limit) but needs a release created by hand / by
the coordinator (no GitHub token on this VM) and a public repo means a
public file, so only ever for a release-signed build.
**APK build facts (0.2.0, measured):** package `com.filterplatform.app`,
versionCode 5, versionName 0.2.0, minSdk 26, targetSdk 34; SHA-256
`a355e65353d53006d32eac78669c72636deabc314562368e7a378c1a22e1ea09`;
`apksigner verify`: v2 true, v3 true, v1 false; one signer, cert
SHA-256 `2363a49c3b052f4363b3d08f5634fba35a2f6397a435ba4914b21703428053b6`.
Phone work stays parked: 0.2.0 crashes on Yakob's phone ("same as
before") until the computer version is proper.

**`CHROME-WEB-STORE-PILOT.md` is SUPERSEDED by this decision** (kept in
the repo as a record, not deleted): its $5 account, review timeline and
submission checklist no longer describe the plan. Do not act on it
without a new decision from Yakob.

## What stays unchanged

- **Phase 1 Core Platform** (`ARCHITECTURE.md`): Neon + Cloudflare Worker
  + Pages dashboard, 13 tables, default Standard policy (block images +
  explicit words, rest open), auto-decide threshold 0.70, uncertain stays
  blocked. All verified live; dogfood green.
- **Browser extension** (`extension/`): v1.2.1, MV3, policy fetch, DNR
  blocklist (domains 1000+, ads 5000+ gated on `filter_ads`), on-device
  **person** detection (MediaPipe EfficientDet-Lite0 + face fallback,
  fail-closed), Yiddish block page, SafeSearch enforcement
  (Google/Bing/DuckDuckGo), own-website update check (v1.2.1, checks
  `versions.json`, popup banner). The desktop/Android-via-Vivaldi path
  until the own browser ships. Verified on real sites (BBC 41 human blocked,
  Wikipedia 4, test page 7).
- **Server-side scanner** (`scanner/`): stays as the pre-rendering /
  approval-engine check; its Chromium results no longer stand in for
  the Android browser.
- **Android skeleton** (`android/`): registration + policy + heartbeat;
  no browser-engine code in it yet — that is what the prototype adds.
- **Vendor rule:** GitHub + Cloudflare + Neon only; as few companies as
  possible.
- **Acceptance rule (Yakob, 2026-11-18):** it must work FULLY — Muse must
  use it end-to-end itself (register, code, check a real site, verdict,
  dashboard) before it counts as finished; REAL data, no sample or
  placeholder data.
- **Free AI must auto-decide APPROVE/REJECT on every website** — Yakob
  will not manually review thousands; uncertain stays blocked, review
  queue only for the small uncertain remainder. Who reviews that
  remainder (Yakob alone or a team) is still undecided.

## Testing plan — acceptance checklist (computer version first)

Source: `TESTING-PLAN.md` (from the re-sent Master Technical Architecture,
Yakob 2026-11-19). This is the acceptance checklist for the computer
version first, and later for the app. **Base note:** the re-sent document
still says "Browser Foundation: Chromium" (§3, §15) — decision 1 above
(GeckoView Stable) wins where it disagrees; GeckoView stays the base.

**Work instructions (§16 of the plan):** review the existing
GitHub/Cloudflare/Neon work first; do NOT rebuild what already exists;
do NOT create unnecessary second services; do NOT claim any feature is
finished until it is actually built and tested.

**What to test:** big websites, small websites, dynamic websites,
images, videos, Canvas, WebGL, CSS backgrounds, animations, lazy
loading, live content, slow internet, CPU overload, cache, 10,000
customer simulation.

**Measures for each test:** website load time, scan time, AI inference
time, CPU usage, RAM usage, detection accuracy, false positives, false
negatives, cache hit rate.

**Results so far (2026-11-19 — re-run done, see
`extension/verify/VERIFY-rereun-2026-11-19.md`):**
- Big websites (extension v1.2.1, re-verified 2026-11-19): Wikipedia
  23/23 scanned, 2 human blocked; BBC 134/134 scanned, **41 human
  blocked**; Commons **unmeasured this run** (only 2 footer logos
  rendered — galleries didn't load, flaky rendering, not a detector
  change); example.com ALLOW.
- Small websites: example.com ALLOW (v1.2.0/v1.2.1).
- 16-photo test set (extension): precision 1.000, recall **0.727** @0.50
  / 0.455 @0.70, 0 FP, 3 FN (back-view soldier, behind-back, lone beach
  walker — missed to ALLOW, as before).
- Images / video / Canvas (scanner v0.2.0, real media): Obama video
  BLOCK paused + playing; canvas drawImage + animated frames BLOCK;
  landscape control ALLOW. **Extension Canvas/video: NOT HANDLED —
  the largest gap found 2026-11-19.** The Huang portrait drawn with
  `drawImage` stays visible; the animated canvas and the Obama video
  (paused and playing) stay visible; only the same portrait as a plain
  `<img>` gets blocked. The extension has no canvas/video code at all.
  Needs a build decision from Yakob — not a re-test.
- Dynamic content: extension covers it via MutationObserver (Phase 2
  test page: dynamic + lazy images correct). CSS backgrounds: Einstein
  background-image blocked correctly. Per-case test page: all HTML
  images, CSS-background, dynamic and lazy cases correct.
- WebGL / live streams / animations: NO test page exists — recorded as
  gaps, nothing invented.
- Live content / live streams: not verified anywhere yet.
- Slow internet (slow-3G Wikipedia): page loads in 4.1 s, same verdicts
  as unthrottled (2 human blocked).
- CPU overload (4x-throttled BBC): verdicts byte-identical to
  unthrottled (41 human), just slower (model ready 27 s vs ~6.5 s).
  Inference ~1.1–1.8 s per image. Chromium ~1.2–1.8 GB total RSS
  (rough snapshot, not profiling).
- Cache: classify twice — first `cached: false`, second `cached: true`,
  same approve 0.95 verdict (example.com and example.org). The 24h
  cache works; repeat-classify hit rate 2/2.
- 10,000-customer simulation: not run yet — no load-test setup here,
  and hammering the live free-tier Worker + Neon would risk the real
  service. Needs a staged load-test plan with rate limits.
- Google Images: still unverified — Google serves `/sorry` (bot-check)
  to headless Chromium (HTTP 429 this run; no CAPTCHA attempted);
  needs a real-browser test.
- **RF-DETR CPU benchmark (2026-11-19, `scanner/models/
  RF-DETR-BENCHMARK.md`):** Nano 327 ms infer / 422 ms e2e, 2.37 img/s,
  recall 1.000 @0.50 / 0.909 @0.70, precision 1.000; Small 572 ms /
  658 ms, 1.52 img/s, recall 1.000 @0.50 / 0.727 @0.70. Both beat the
  EfficientDet baseline. **Nano recommended.**

## Open items / caveats (carried over — do not lose these)

1. **Model decision made 2026-11-19: RF-DETR is the officially agreed
   model** (decision 2 above). CPU proof DONE: Nano recommended
   (327 ms infer, recall 1.000 @0.50 / 0.909 @0.70, precision 1.000 —
   see `scanner/models/RF-DETR-BENCHMARK.md`). Still open: real-site
   validation of RF-DETR, INT8/batching/video, DINOv2 backbone
   provenance (not separately traced). EfficientDet weights license
   still unconfirmed from Google (second sources say Apache 2.0) —
   prototype-only, moot for production unless RF-DETR fails. Intel
   person-detection-0202 stays a candidate (written confirmation +
   hash mismatch still open).
2. **Extension Canvas + video NOT handled (found 2026-11-19 — the
   largest gap).** The scanner blocks canvas/video; the extension has
   no canvas/video code at all (drawImage portrait, animated canvas,
   Obama video paused + playing all stay visible). Needs a build
   decision from Yakob: frame sampling (canvas `toDataURL`, video
   frame grabs) + performance/correctness design — not a re-test.
2. Person-detection recall 0.455 — back views and distant walkers missed.
3. Google Images unverified — Google serves `/sorry` (bot-check) to
   headless Chromium; needs a real browser test (the GeckoView prototype
   is the natural place to try it).
4. Yiddish block page — DONE in extension v1.2.0 (facebook.com →
   blocked.html, verified).
5. SafeSearch enforcement — DONE in extension v1.2.0 (Google
   `safe=active`, Bing `adlt=strict`, DuckDuckGo `kp=1`); YouTube
   Restricted Mode still needs DNS/CNAME.
6. Person detection in the extension — DONE in v1.2.0 (EfficientDet
   via detector iframe + cross-origin refetch; recall 0.727 at 0.50,
   0.455 at 0.70 on the 16-photo set).
7. Built-in extension signing exemption (`installBuiltIn` vs `install`)
   and MV3 support in GeckoView 160 are not confirmed from a primary
   source — test in the prototype.
8. `compileSdk`/`targetSdk` for GeckoView 160 unverified (skeleton at 34).
9. Cloudflare Queues/R2 not wired (scanner is still a local prototype,
   not a service). **R2 status determined 2026-11-19:** not enabled on
   the account — API returns 403 error 10042 for both list and create;
   enabling needs Yakob in the dashboard + a payment method on file
   (free tier, $0 inside it); no API path. See "Distribution" above for
   the APK hosting path. Phase 5 (device apps/MDM) and Phase 6
   (production) not started.
10. Transitive-license check of the final Gradle dependency tree before
    commercial shipment; a lawyer's look at LICENSES.md before sale is
    the safer step (not legal advice).
11. Firefox 161 stable expected ~2026-11-20 per a secondary calendar
    site only — when it lands, re-check the pair (AC `161.0.x` + its
    declared `geckoview-omni`) and bump both together; never use a
    version with `b` (beta) or `a` (alpha) for production, never a
    floating version.

## Stale lines this file supersedes

- `ARCHITECTURE.md` "What is NOT built": "do not start the browser build
  before the Cromite-vs-GeckoView-vs-raw-Chromium decision" — **decided:
  GeckoView** (decision 1 above).
- `ARCHITECTURE-DIAGRAM.md`: "the filtering engine is the extension
  (Vivaldi) until the browser-base decision … is made" and "Full custom
  browser (base decision open with Yakob)" — **decided: GeckoView**;
  extension remains the interim path until the own browser ships.
- `android/README.md`: "the Cromite/GeckoView/raw-Chromium decision is
  still open with Yakob, so there is no WebView-based filtering here yet"
  — **decided: GeckoView**; no engine code in the app yet, prototype is
  the next step.
- `CHROME-WEB-STORE-PILOT.md` — the whole file is **SUPERSEDED**
  (decision 2026-11-19 ~02:39 EST): no Chrome Web Store, no Google Play;
  distribution is the own-website Download Center. Kept as a record, not
  deleted; do not act on its $5-account / submission checklist without a
  new decision from Yakob.
- `scanner/README.md` framing of the scanner as the proof of what users
  see — it proves the server-side pipeline; the in-browser proof now
  belongs to the GeckoView prototype (decision 3).
