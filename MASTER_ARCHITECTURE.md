# Filter Platform — Master Architecture Plan (updated)

**Status:** updated 2026-11-18 ~12:54 EST per Yakob's five decisions (see
Decisions log below). This is the single authoritative plan for the whole
platform. Where an older doc disagrees with this file, **this file wins** —
the older doc is marked stale in place where noted.

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

### 2. EfficientDet-Lite0: prototype and first testing ONLY

- Keep EfficientDet-Lite0 for **prototype and first testing**.
- **Do NOT confirm it as the production model** until the exact model
  weights, hash, source and license are confirmed.
- For production, research **Intel Person Detection** and other
  clearly-licensed models.
- Check **all upstream dependencies AND model weights**, not just the
  program license.

**Current evidence (2026-11-18):** Google's own docs name the model but
give no weights license — there is no Google page to confirm from. Three
independent second sources say **Apache 2.0** (pub.dev: files byte-for-byte
identical to Google's official builds; PitchOverlay; KTag SBOM). The
TF Hub page itself cannot be read (redirects to Kaggle behind a wall).
Record it as Apache 2.0 on the second sources, verify before commercial
sale — or plan the Intel transition for the commercial version. Intel OMZ
person-detection-0202 is **Apache 2.0, verified**, but not chosen (IR-only,
needs an ONNX/TFLite path). YOLO is **excluded** (AGPL-3.0).

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

### 4. Muse Build Permission — `other_tcp` on Ask

- The `other_tcp` permission is set to **Ask**, so Gradle can download
  the needed build dependencies.
- **Only Yakob can do this step** — in the Muse app: Settings →
  Permissions → Direct network protocols → **Ask**.
- Until then `./gradlew assembleDebug` stays blocked on this VM
  (sandbox blocks all TCP from JVM processes — proven, nothing in the
  project needs to change) and Android builds continue via the manual
  build path (`android/manual-build/build.sh`, verified: 848,343-byte
  signed debug APK, 7/7 unit tests pass).

### 5. Further work — prototype first, no rebuild

- **Do NOT rebuild the whole project.**
- First make a **GeckoView Browser Prototype with the Visual Filter
  integrated**.
- Then **prove the scanner detects people on real sites, including
  Canvas and video**, and then continue with the whole platform.
- This file is the Master Architecture Plan updated per these decisions.

**Prototype sequence (next steps, in order):**
1. Yakob sets `other_tcp` to Ask (decision 4 — his step, blocks Gradle).
2. Apply the GeckoView/AC pins to the Android skeleton
   (`android/GECKOVIEW-RESEARCH.md` §5 has the Gradle snippets, not yet
   applied to any build file) and run the first Gradle sync — confirm
   `compileSdk`/`targetSdk` for GeckoView 160 (skeleton is at 34,
   unverified for 160).
3. Minimal GeckoView browser UI from Android Components (toolbar, tabs,
   session — own UI, no ready-made browser UI).
4. Built-in filter extension inside GeckoView (content scripts + native
   bridge; MV2 first — the documented path; MV3 support in GeckoView 160
   is unverified, test explicitly before committing).
5. Re-prove the test matrix (§3) inside GeckoView on real sites,
   including Canvas and video; unreviewed stays covered.
6. Only then continue with the rest of the platform (Phases 5–6).

---

## What stays unchanged

- **Phase 1 Core Platform** (`ARCHITECTURE.md`): Neon + Cloudflare Worker
  + Pages dashboard, 13 tables, default Standard policy (block images +
  explicit words, rest open), auto-decide threshold 0.70, uncertain stays
  blocked. All verified live; dogfood green.
- **Browser extension** (`extension/`): MV3, policy fetch, DNR blocklist
  (domains 1000+, ads 5000+ gated on `filter_ads`), on-device face
  detection, block/cover/strict. The desktop/Android-via-Vivaldi path
  until the own browser ships. Person detection lives in the scanner
  only, not yet in the extension.
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

## Open items / caveats (carried over — do not lose these)

1. EfficientDet weights license unconfirmed from Google (second sources
   say Apache 2.0); production-model research (Intel + others) still open.
2. Person-detection recall 0.455 — back views and distant walkers missed.
3. Google Images unverified — Google serves `/sorry` (bot-check) to
   headless Chromium; needs a real browser test (the GeckoView prototype
   is the natural place to try it).
4. DNR shows the browser block page, not a Yiddish block page — still to fix.
5. SafeSearch enforcement in extension/device is config + display only
   (Worker endpoints + dashboard exist; no URL rewriting or DNS yet).
6. Person detection in the extension is scanner-only.
7. Built-in extension signing exemption (`installBuiltIn` vs `install`)
   and MV3 support in GeckoView 160 are not confirmed from a primary
   source — test in the prototype.
8. `compileSdk`/`targetSdk` for GeckoView 160 unverified (skeleton at 34).
9. Cloudflare Queues/R2 not wired (scanner is still a local prototype,
   not a service). Phase 5 (device apps/MDM) and Phase 6 (production)
   not started.
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
- `scanner/README.md` framing of the scanner as the proof of what users
  see — it proves the server-side pipeline; the in-browser proof now
  belongs to the GeckoView prototype (decision 3).
