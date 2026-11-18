# Chromium-based Android browser — build assessment

Written 2026-11-18 (overnight build). Question from the master architecture:
own Chromium-based Android browser app (Kotlin) for the filter platform —
is a custom Chromium Android build realistic, and what does it cost?
**Do NOT start the full browser build overnight** — this file is the
assessment only. Sources: Chromium's own Android build docs, the Aerium
single-developer Chromium Android fork (updated Oct 2026), a WebView
maintainer's answer (Jan 2026), and Cromite release listings (2026).

## Verdict up front

- A **raw Chromium Android build from source is real but heavy**: it needs a
  dedicated build machine, ~100 GB disk, hours per build, and a person
  rebasing onto every Chromium security release (~every 4 weeks) or the
  browser ships known vulnerabilities. It is not an overnight job and not a
  one-person side task.
- The **practical shortcut is to base the browser on Cromite** (active
  Bromite successor, GPL v3) with a small patch set — but Cromite itself lags
  upstream by 3–4 major versions at times, and GPL v3 means the browser app
  itself must be open source (the filter backend/SaaS can stay closed, but
  the browser code cannot be closed).
- **Plain Android WebView is NOT the browser** (per Yakob): it is an embedded
  view, not a browser — no control over rendering/networking, no extensions,
  and it cannot put the Visual Shield inside other apps. It can only be an
  embedded viewer inside a larger app, not the product.
- **GeckoView is the serious alternative**: Mozilla-maintained, MPL-2.0,
  Firefox-extension support, ~90 MB AAR, updated every 2 weeks. It is not
  Chromium, so it is a different engine bet.
- Recommended order: prove the filtering with the Phase 2 extension +
  scanner engine first (in progress), then take an architecture decision
  (Cromite base vs GeckoView vs raw Chromium) with Yakob before writing any
  browser code.

## 1. Raw Chromium Android build (from source)

From Chromium's Android build instructions and the awChromium build doc:

- **Checkout**: `fetch android` — 30 minutes on a fast connection, "many
  hours on slower ones". Needs Git + Python + depot_tools, Linux 64-bit only
  (building the Android client on Windows/Mac is not supported).
- **Disk**: at least 100 GB free (source tree + build artifacts).
- **RAM**: 8 GB minimum, 16 GB+ highly recommended; 30 GB to avoid build
  termination from memory exhaustion.
- **Build time** (release, autoninja): 12-core CPU / 32 GB RAM / SSD → 2–4 h;
  8-core / 30 GB / SSD → 4–6 h; 4-core / 30 GB / HDD → 8–12 h.
- **Real-world single-dev experience (Aerium, Oct 2026)**: a full Chromium
  compile takes roughly **30 hours** and does not fit inside a free GitHub
  Actions job (6 h limit) — the pipeline chains jobs, each restoring the
  previous job's build tree from an artifact; one run spent 1 h 59 m just
  unpacking the tree before compiling. Patches are pinned to a single
  Chromium version in one file, one feature per patch.
- **No library consumption**: per a WebView maintainer (Jan 2026), there is
  NO supported way to use Chromium's `//content` module as a library inside
  an existing Android app — no AAR target, no API-stability guarantee. The
  app must be rebuilt *as* a Chromium embedder (`chrome_public_apk` target),
  rewriting the parts that touch Chromium from scratch.
- **Security-update treadmill**: Chromium ships a major release about every
  4 weeks plus emergency security patches. A fork must rebase its patch stack
  onto each release or ship known CVEs. This is the permanent cost — it never
  ends.

## 2. Base on an existing fork: Cromite (active Bromite successor)

- **What it is**: Chromium on Android with ad/tracker blocking built in,
  Google services stripped at compile time. GPL v3. Android 10+, arm64 /
  arm / x86_64 APKs.
- **Size**: arm64 APK ~163–189 MB (up to ~309 MB in some listings);
  installed size larger.
- **Cadence (the problem)**: Aug 2026 Cromite was on Chromium 148 while
  Chrome for Android was on 151 — 3 versions behind. Oct 2026 Cromite was
  on 153 while Google rolled out Chrome 157 — 4 versions behind. Each gap
  is unpatched vulnerabilities. Volunteer maintenance can go dormant
  (Bromite itself went dormant in 2022).
- **Distribution**: NOT on Google Play — sideload from GitHub releases or
  F-Droid; no Play auto-update (it has its own in-app updater).
- **Extensions**: Android extensions are experimental and unsupported on
  Cromite — incomplete compatibility.
- **License consequence**: GPL v3 covers the browser. For a closed
  commercial SaaS this is workable ONLY if the browser app itself is open
  source (GPL) while the filter service (API, scanner, lists, dashboards)
  stays a separate closed backend. That split must be deliberate.

## 3. The alternative engine: GeckoView (Mozilla)

- **What it is**: Firefox's engine as an embeddable Android component
  (used by Firefox, IronFox, Mullvad browser, and others).
- **Size**: ~90 MB AAR; roughly +90–190 MB to the APK.
- **Maintenance**: Mozilla publishes a new GeckoView every 2 weeks
  (e.g. 153.0.2, Sep 2026); the app pins a Maven version — no source
  build, no rebase treadmill.
- **License**: MPL-2.0 — permissive for a closed commercial app (file-level
  copyleft only).
- **Extensions**: runs Firefox-compatible extensions (real extension
  runtime, unlike WebView) — our Phase 2 MV3 extension logic could be
  adapted rather than rewritten.
- **Costs**: GeckoView's main process runs inside the app; profile/process/
  activity lifecycles become app-owned concerns; WebView state does not
  migrate; compatibility can regress when GeckoView changes.

## 4. Plain WebView — why it is not the answer

- Android's system WebView IS Chromium, updated by Google via the Play
  Store — zero maintenance for us. But: it is an embedded view inside an
  app, not a browser. It gives no control over navigation, networking, or
  rendering beyond a narrow API, hosts no extensions, and cannot filter
  content inside *other* apps. A filter product built on it would be a
  viewer, not a browser, and the Visual Shield could only run inside our
  own app's pages.
- Verdict: usable as an embedded viewer component later; not the browser.

## 5. Recommendation

1. **Now**: finish Phase 2 (MV3 extension, desktop + Kiwi on Android) and
   the pre-rendering scanner — they prove the filtering engine with no
   browser build at all.
2. **Decision needed from Yakob** (not an overnight job): Cromite base
   (Chromium, GPL v3 browser, lags upstream) vs GeckoView shell
   (MPL-2.0, Mozilla-maintained, extension-ready) vs raw Chromium
   (maximum control, maximum maintenance). The decision gates all browser
   work.
3. **Do not** start a raw Chromium checkout or a browser app until that
   decision is made — the checkout alone is ~100 GB and the first build is
   a multi-hour job on a machine we do not have.
