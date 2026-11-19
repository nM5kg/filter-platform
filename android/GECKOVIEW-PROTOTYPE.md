# GeckoView browser prototype — Filter Platform

Own browser app + own filtering engine, built on **GeckoView (stable)**.
Decision 2026-11-18 (Yakob): the browser base is GeckoView, STABLE release
channel (not Nightly) — own Browser App + own Filtering Engine, using
Mozilla Android Components where they help, NOT a ready-made foreign
browser UI. Cromite is not the base (GPLv3); raw Chromium is backup only
if GeckoView cannot meet the technical requirements.

> **Honest status (2026-11-18): the prototype is written, its Kotlin
> compiles, its unit tests pass 22/22, and a signed debug APK containing
> GeckoView was built and verified here. It has NEVER RUN. No Android
> device or emulator exists on this VM, so GeckoView startup, extension
> install, content-script injection, the native bridge round-trip, and
> cover behaviour on real sites inside GeckoView are NOT proven here.
> The device checklist below is what still has to be checked on a real
> phone.**

## GeckoView version pinned

- **Version: `160.0.20261116130455`** (release / stable channel).
- Source: <https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml>
  (release 160.0.20261116130455; beta is 161.x, nightly is 162.x).
- AAR:
  <https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.aar>
  (244,578,463 bytes, downloaded with curl 2026-11-18).
- Firefox 160 released 2026-11-10. POM `scm` =
  `hg.mozilla.org/releases/mozilla-release` (the release branch).
- License: **MPL-2.0** (GeckoView; verify again before commercial
  shipment, along with every dependency in the closure — see
  `manual-build/libs/geckoview/DEPENDENCIES.md`, 59 resolved artifacts).
- The AAR declares `minCompileSdk=37`, `minCompileMinorSdk=2`
  (`META-INF/com/android/build/gradle/aar-metadata.properties`). That
  single fact is why a Gradle build cannot work yet — see below.

## What the prototype contains

### Browser Activity with own UI

- `app/src/main/java/com/filterplatform/app/BrowserActivity.kt` —
  framework `Activity` (no Firefox UI, no AppCompat): address bar, back /
  forward / reload buttons, loading progress bar, filter-status line
  (`covered • allowed • blocked` + policy name). The `GeckoView` is added
  programmatically into `app/src/main/res/layout/activity_browser.xml`
  (`R.id.geckoContainer`). Home page is the live filter dashboard
  (`https://filter-platform-dashboard.pages.dev`). Reached from the main
  screen's "Open filter browser" button (`MainActivity.openBrowser()`).
- Every top-level navigation passes through
  `FilterEngine.shouldBlockNavigation` (blocklist hosts + unknown schemes
  such as `intent:` / `javascript:` are refused; `http(s)`, `file:`,
  `about:`, `data:`, `resource:` are allowed through).
- Policy: the device's server policy when registered
  (`ApiClient.getPolicy`); otherwise `FilterEngine.DEFAULT_POLICY`
  (block images, cover, threshold 0.70) — fail closed, never fails the
  browser open.

### FilterEngine hooks (pure Kotlin, unit-tested)

- `app/src/main/java/com/filterplatform/app/FilterEngine.kt` — no
  GeckoView, no Android framework imports. Decides every visual element
  the content script reports:
  - `ContentType`: HTML_IMAGE, CSS_BACKGROUND, CANVAS, SVG, WEBGL,
    VIDEO_FRAME, LIVE_STREAM, DYNAMIC.
  - `Verdict`: ALLOW (only on a positive NO_PERSON at/above the policy
    threshold, with pixels actually checked), COVER, BLOCK (policy
    `cover_images=false`), REVIEW (treated exactly like COVER).
  - Fail-closed order: policy not filtering images → ALLOW (explicit
    operator choice only); no thumbnail (cross-origin / tainted / WebGL /
    live stream) → REVIEW; PERSON → COVER/BLOCK; NO_PERSON below
    threshold → REVIEW; UNKNOWN → REVIEW.
  - Wire format: content script sends
    `{"type":"scan","pageUrl":...,"findings":[{id,kind,source,thumb,playing}]}`;
    native replies `{"type":"decisions","decisions":[{id,verdict}]}` with
    REVIEW sent as `"cover"` (the content script has no review state).
  - Unknown `kind` values are kept as DYNAMIC — never dropped, still
    covered. A malformed scan message throws and the caller replies
    nothing, so the content script keeps everything covered.
- `PersonDetector` interface + `StubPersonDetector`: **the prototype
  ships NO on-device model** — `detect()` always returns UNKNOWN, so
  every finding is REVIEW and stays covered. Plugging in a real model
  (e.g. a MediaPipe/TFLite model — see the scanner's EfficientDet-Lite0
  work) means implementing `PersonDetector` and swapping it at the one
  call site in `BrowserActivity.onCreate` (`FilterEngine(StubPersonDetector())`).
  Nothing else changes, and no verdict is ever faked: there is no code
  path that returns ALLOW without a detector saying NO_PERSON above
  threshold.

### Built-in privileged WebExtension + content script

- `app/src/main/assets/filter-extension/` (bundled in the APK under
  `assets/`; installed with
  `runtime.webExtensionController.installBuiltIn("resource://android/assets/filter-extension/")`):
  - `manifest.json` — `manifest_version: 2`, `content_scripts` with
    `matches: ["<all_urls>", "file:///*"]`, `all_frames: true`,
    `run_at: "document_start"`; background script; permission
    `<all_urls>`.
  - `content.js` — covers FIRST (overlay `Filtered — image covered`,
    `z-index: 2147483647`) and reports second; never the other way round.
    Scans `<img>` / `<input type=image>`, CSS `background-image`
    (whole-tree computed-style walk), `<canvas>`, inline `<svg>`,
    `<video>` / MediaStream-fed `<video>`. Sends downscaled JPEG
    thumbnails (max 320 px) only when pixels could actually be read;
    cross-origin / tainted / WebGL (no `preserveDrawingBuffer`) / live
    streams yield `thumb: null`, and a blank (single-colour) thumbnail is
    dropped the same way — blank must never read as "clean". Covered
    videos are paused (no audio from a hidden video). CSS-background
    elements keep their text readable (only the background image is
    stripped). `MutationObserver` catches dynamic content (new nodes,
    `src`/`style`/`class`/`data-src` changes, lazy images, carousels,
    infinite scroll); playing video / streams are re-sampled every 3 s.
    If the native side is unreachable, everything stays covered and the
    script retries (10×, 1 s apart). If the extension fails to install,
    the status line says so loudly — the browser never silently browses
    unfiltered.
  - `background.js` — relay only: `runtime.sendMessage` →
    `runtime.sendNativeMessage("filter-platform", …)` → native reply
    back as the `sendMessage` response.
- Native bridge: `WebExtension.MessageDelegate.onMessage` in
  `BrowserActivity` parses the scan, runs `engine.decideAll`, updates
  the status-line counters on the UI thread, and returns the decisions
  JSON. Any non-scan or malformed message returns `null` (content script
  keeps everything covered).

### Known prototype gaps (not bugs to fix silently — record on device)

- CSS backgrounds are reported without a thumbnail (the URL would have
  to be re-fetched); they stay covered until a detector can check them.
- Closed shadow-DOM content is not traversed.
- A live stream is sampled as single frames; one clean frame does not
  decide a stream — streams are re-reported while playing and stay
  covered in this prototype (no detector runs on device yet).
- No `PermissionDelegate` yet: camera (`getUserMedia`) will probably be
  denied — record the denial as a finding, not a pass (see test page 07).
- `BrowserActivity.onBackPressed` uses the deprecated framework override
  (kotlinc warning only, behaviour unchanged).

### Manifest / build wiring

- `app/src/main/AndroidManifest.xml` — `BrowserActivity` (not exported),
  `WAKE_LOCK` + `MODIFY_AUDIO_SETTINGS` (required by GeckoView),
  OpenGL ES 2.0 feature, `android:zygotePreloadName="org.mozilla.gecko.process.ZygotePreload"`.
- `manual-build/merge_manifest.py` reproduces Gradle's manifest merger
  for the manual build: merged manifest has **90 services** (GeckoView's
  child-process services) + its clipboard provider.
- `app/build.gradle.kts` — `compileSdk = 37` (forced by the AAR),
  `minSdk = 26`, `targetSdk = 34`;
  `implementation("org.mozilla.geckoview:geckoview:160.0.20261116130455")`
  plus `androidx.security:security-crypto:1.1.0-alpha06`.
- `settings.gradle.kts` — Mozilla Maven repo added
  (`https://maven.mozilla.org/maven2/`).
- `manual-build/fetch-deps.py` — resolves + downloads the GeckoView
  dependency closure with curl + POM parsing (no JVM): 59 artifacts
  under `manual-build/libs/geckoview/` (AARs extracted to
  `manual-build/libs/extracted/`), auditable in
  `manual-build/libs/geckoview/DEPENDENCIES.md`.

## How to run it

### On a normal machine (once SDK platform 37 exists)

```bash
cd android
~/gradle-8.5/bin/gradle assembleDebug   # installed Gradle 8.5; do NOT use ./gradlew
# APK: app/build/outputs/apk/debug/app-debug.apk
~/gradle-8.5/bin/gradle testDebugUnitTest
```

`./gradlew` fails on its distribution download (see below); the installed
binary is the build to use. Note: a Gradle build of this module fails
**everywhere** right now, not just on this VM, because SDK platform 37
does not exist for download yet (see "Why Gradle cannot build this").

### On this VM — manual build (the working path)

```bash
cd android/manual-build
./build.sh            # arm64-v8a only, ~191 MB APK
GV_ABIS="arm64-v8a armeabi-v7a x86_64" ./build.sh   # all ABIs, ~520 MB
```

Output: `manual-build/out/app-debug.apk` (signed with a generated debug
key, `storepass android` — never a release key).

**Verified 2026-11-18 18:34 UTC** (rerun to completion after the previous
agent's run was cut off at 18:22 UTC during the d8 step):

```
== 1. aapt2 compile resources ==   OK
== 2. aapt2 link (merged manifest + resources, R.java) ==   OK
== 3. kotlinc (app sources + generated R.java) ==   OK (1 deprecation warning, onBackPressed)
== 4. d8 dex (app + library classes, min-api 26) ==   OK (classes.dex 10,229,084 + classes2.dex 8,609,760 bytes)
== 5. add dex + GeckoView .so libs (arm64-v8a) ==   OK (libxul.so 154,611,616 bytes, stored)
== 6. zipalign + sign (generated debug key) ==   OK
== 7. verify ==
   Verified using v1 scheme (JAR signing): false
   Verified using v2 scheme (APK Signature Scheme v2): true
   Verified using v3 scheme (APK Signature Scheme v3): true
   Number of signers: 1
package: name='com.filterplatform.app' versionCode='1' versionName='0.1.0'
sdkVersion:'26' targetSdkVersion:'34' compileSdkVersion:'34'
launchable-activity: name='com.filterplatform.app.MainActivity'
uses-permission: INTERNET, ACCESS_NETWORK_STATE, WAKE_LOCK, MODIFY_AUDIO_SETTINGS
```

APK: `manual-build/out/app-debug.apk`, **200,066,826 bytes**. Contents
verified with `unzip -l` + `dexdump`: `assets/omni.ja` (15,252,607),
`assets/filter-extension/{manifest.json, background.js, content.js}`,
`lib/arm64-v8a/libxul.so`, `BrowserActivity` / `FilterEngine` /
`StubPersonDetector` and all model classes in `classes.dex`, GeckoView
classes in `classes2.dex`.

### Unit tests

```bash
cd android/manual-build
./run-tests.sh   # kotlinc + JUnitCore, no Gradle
```

**Verified 2026-11-18: `OK (22 tests)`** — 7 `ApiClientTest` + 15
`FilterEngineTest` (fail-closed property, scan/decisions wire format,
navigation hook). The full-app compile (all sources incl.
`BrowserActivity`) is covered by `manual-build/build.sh` step 3.

## Why Gradle cannot build this (verified 2026-11-18, exact errors)

Two independent blockers. Either one alone stops a Gradle build.

### Blocker 1 — the sandbox still intercepts ALL TCP data from JVM processes

The coordinator's 2026-11-18 ~13:11 EST check ("JVM TCP now works") was
a **connect-only** test. Data transfer from a JVM is still intercepted,
proven byte-for-byte three ways on 2026-11-18 ~13:30 EST:

- A Java `Socket` to `repo.maven.apache.org:443` connects, but the first
  `read()` returns **193 bytes**:
  `muse: Other TCP connections is turned off for this assistant. To allow
  it, ask the user to open Muse settings -> Permissions -> Direct network
  protocols and switch other_tcp from Deny to Ask.`
  The same bytes from Python / C / curl reach the real host.
- A Java `Socket` to the **127.0.0.1:18081 egress relay** (a Node process,
  restarted for this test; curl through it returns 200) receives the
  same 193-byte message. Python to the same relay receives the real
  `HTTP/1.1 200 Connection Established`.
- Consequences, each with its own exact error:
  - **Daemon mode** (`gradle assembleDebug`): the daemon starts, the
    client connects, and the client reads the interceptor message off
    the loopback socket:
    `Could not receive a message from the daemon.` /
    `Caused by: java.lang.IllegalArgumentException: Unexpected type tag 109 found.`
    (109 = `0x6D` = `'m'`, the first byte of `muse: ...`.)
  - **Direct JVM HTTPS** (`HttpsURLConnection`, no proxy):
    `javax.net.ssl.SSLException: Unsupported or unrecognized SSL message`
    (the interceptor's plain text is not TLS).
  - **JVM HTTPS via proxy** (egress proxy with auth, or the 18081 relay):
    `java.lang.RuntimeException: java.util.NoSuchElementException`
    (Java's CONNECT-response parser chokes on the interceptor text).
  - **In-process Gradle** (`gradle-inprocess.sh`, no daemon socket):
    runs, but every download fails:
    `Plugin [id: 'com.android.application', version: '8.3.2', apply: false]
    was not found in any of the following sources: ... Searched in ...
    Google / MavenRepo / Gradle Central Plugin Repository`.
- The installed Gradle 8.5 binary itself runs fine
  (`gradle --version` → Gradle 8.5 / JVM 17.0.21, exit 0). Only the
  **wrapper** fails: `./gradlew` dies downloading the distribution in
  the SSL handshake (Broken pipe) — same interception. Use the installed
  binary, never `./gradlew`.
- **No CA import can fix this.** There is no egress CA to import: the
  current egress proxy does plain CONNECT tunneling — `openssl s_client`
  via the proxy shows a normal public chain (`issuer=C = US, O = Let's
  Encrypt, CN = YE1`). The failure happens before TLS anyway: the JVM
  never receives TLS bytes.
- **Do NOT tell anyone to enable an "other_tcp" setting.** The setting
  does not exist anywhere (checked 2026-11-18 ~13:11 EST: it appears
  neither in the Permissions screen nor in the full permissions list).
  There is no permission card to bring up, and nothing pending.

### Blocker 2 — SDK platform 37 does not exist for download

GeckoView 160's AAR declares `minCompileSdk=37`, so a Gradle build needs
`compileSdk 37`. But Google has no platform-37 package:
`https://dl.google.com/android/repository/platform-37_r01.zip` → **404**,
and `repository2-1.xml` lists at most `platform-36-ext18_r01.zip`
(checked 2026-11-18). Pre-downloading Maven artifacts with curl into the
Gradle cache cannot fix this one. Until Google publishes platform 37
(or the GeckoView pin changes), `./gradlew assembleDebug` / `gradle
assembleDebug` fails on every machine, not just this VM. The manual
build sidesteps it by compiling against the already-installed
`android.jar` 34 (aapt2 `--min-sdk-version 26 --target-sdk-version 34`
with the merged manifest) — that is a prototype-only compromise, not a
production build: the APK reports `compileSdkVersion: 34` while the
GeckoView AAR asks for 37.

## The 8 test pages

`android/test-pages/` — self-contained pages for the 8 content types,
served over HTTP (realistic path; `file://` also matches the extension):

```bash
cd android/test-pages
python3 -m http.server 8130 --bind 0.0.0.0
# In the Filter Browser (MainActivity -> "Open filter browser"), open:
#   http://<computer-ip>:8130/index.html
```

All media is real (copies of the scanner's labeled test set + the Obama
video), so expected verdicts are known in advance. In THIS prototype
there is no on-device person detector yet, so the only correct outcome
on every page is: **everything visual is covered** (dark overlay reading
"Filtered — image covered") and the browser status line shows
`covered: N, allowed: 0, blocked: 0`. A page where anything visual is
visible uncovered is a filter failure — record which element and how it
got through. (When a real detector lands, the landscape controls —
`l1-glacier-lake.jpg` — are the elements that should become ALLOW.)

| Page | What it exercises |
|---|---|
| `01-html-images.html` | `<img>`, `<picture>`/srcset, `loading=lazy`, `data-src` set by JS at 1 s, `<input type=image>` |
| `02-css-backgrounds.html` | `background-image` (person, crowd, landscape), sprite via `background-position`, `data:` URI background, background set by JS, text over a background |
| `03-canvas.html` | Canvas 2D `drawImage` (person + landscape), animated canvas fed by video frames, `<img>`/`<video>` controls |
| `04-svg.html` | Inline `<svg>` with embedded raster photo, shapes-only SVG, `<img src="*.svg">`, SVG as CSS background |
| `05-webgl.html` | WebGL canvas with a person photo as texture; WebGL canvas with a procedural shader |
| `06-video-frames.html` | Video paused at 5 s, autoplaying muted loop, video with a person-photo poster |
| `07-live-streams.html` | `canvas.captureStream()` feeding a `<video>` (no permission needed); optional camera via `getUserMedia` |
| `08-dynamic-content.html` | Image added at 2 s, images/divs/canvas added by buttons, carousel swapping `src` every 3 s, infinite scroll appending images |

Assets (`test-pages/assets/`): `p1-huang-portrait.jpg` (person — expect
COVER), `d1-crowd-funeral.jpg` (crowd — expect COVER),
`l1-glacier-lake.jpg` (landscape, no person — control; covered in this
prototype, ALLOW once a detector exists), `obama-chile-480p.webm`
(person in frame throughout — expect COVER), `person.svg` (SVG with
embedded photo) / `shapes.svg` (shapes-only).

## Real-device checklist (do this on a phone — none of it is proven yet)

Install `manual-build/out/app-debug.apk` (arm64-v8a; needs a phone with
that ABI — incl. the BLU B1680V) and open the Filter Browser. For each
page below, load it from the HTTP server above and record: what is
visible uncovered (must be: nothing), what the status line counts say,
and anything that flashes uncovered before being covered.

1. **HTML images (01)** — Load the page, scroll to the lazy image,
   wait past 1 s for the `data-src` image. Expect: every image covered
   incl. the late-appearing one and the `<input type=image>`; status
   `allowed: 0`. Fail if the data-src image is ever visible uncovered.
2. **CSS backgrounds (02)** — Expect: every box covered; the card's
   text stays readable while its background is stripped (background
   `none`, text untouched); the sprite box and the JS-set background
   covered too; the `data:` URI background covered.
3. **Canvas (03)** — Expect: both `drawImage` canvases (person +
   landscape) covered; the animated canvas stays covered as frames
   change; the `<img>`/`<video>` controls on the page covered.
4. **SVG (04)** — Expect: the photo inside the inline SVG does not show
   through; the shapes-only SVG is covered too in this prototype (no
   detector — everything is covered); `<img src="*.svg">` and the
   SVG-as-CSS-background covered.
5. **WebGL (05)** — Expect: both WebGL canvases covered. `toDataURL` on
   a WebGL canvas without `preserveDrawingBuffer` returns blank — the
   filter must treat blank as "cannot check", never as clean. Fail if
   either canvas is visible.
6. **Video frames (06)** — Expect: paused video, autoplaying loop and
   poster all covered; covered videos are paused by the filter — listen:
   no audio from a hidden video. Scrub the paused video; the frame must
   stay covered.
7. **Live streams (07)** — Expect: the `captureStream()` video covered
   and re-sampled while playing (stays covered). Camera via
   `getUserMedia`: expect a denial (no `PermissionDelegate` yet) —
   record the denial as a finding, not a pass; if a permission prompt
   appears, note exactly what it asks.
8. **Dynamic content (08)** — Expect: nothing flashes uncovered when it
   appears — the 2 s image, button-added images/divs/canvas, every
   carousel swap (3 s), and infinite-scroll appends must all be covered
   on arrival. Watch the carousel for a full cycle (≥ 3 swaps).
9. **Real sites (beyond the test pages)** — Open `example.com` (expect:
   ALLOW/covered per engine — no images, nothing to cover), `wikipedia.org`
   and `bbc.com` (expect: person photos covered, status line counting
   up as the content script reports). Record any image visible
   uncovered, and any page where the status line stays at `covered: 0`
   while images are visible (that would mean the content script never
   ran — check extension install in the status line first).
10. **Extension / bridge health** — On first launch the status line must
    say `Filter extension installed — covering unreviewed content.` If
    it instead reports `FILTER EXTENSION FAILED TO INSTALL`, stop: the
    browser is running without the visual filter. Note the exact error
    text.
11. **Navigation blocking** — Try opening `facebook.com` (only blocks if
    the server policy lists it — with the local default policy it loads;
    do not record that as a failure). Try an `intent:` link if a page
    offers one: the navigation must be refused by the engine.

## What is NOT verified (needs a real Android device)

- The APK has never been installed or launched anywhere. GeckoView
  startup, the `zygotePreloadName` child processes, extension install,
  content-script injection, the native bridge round-trip, and cover
  behaviour on the 8 content types are all unproven until the checklist
  above is run on a phone.
- Person detection on device is bundled (0.2.0, see below) but NOT
  proven — the scanner's and the desktop extension's EfficientDet-Lite0
  results do not transfer automatically: the detector must be re-proven
  inside GeckoView per content type, per the checklist.
- Real device registration end-to-end from the app UI (create customer →
  create device → code → register → heartbeat) was verified against the
  live API by the Phase 1 dogfood script, but never from this app's UI.
- A Gradle build of this module (any machine) until SDK platform 37
  exists — see Blocker 2 above.
- Google Images behaviour inside GeckoView (Google serves `/sorry`
  bot-checks to headless Chromium; unknown for GeckoView) — try it on
  the device and record the result.

## 0.1.1 launch-crash fix (2026-11-18 ~14:17 EST)

0.1.0 installed on the user's BLU phone but died at launch with only
Android's "Filter Platform keeps stopping" dialog — no UI ever appeared.
Three defects were found by inspecting the shipped APK (no logcat was
available on the phone):

1. **omni.ja in the wrong folder (definite bug).** build.sh extracted
   `assets/omni.ja` from the GeckoView AAR with `zipfile.extract`, which
   creates `assets-staging/assets/omni.ja` → APK asset
   `assets/assets/omni.ja`. GeckoView reads `assets/omni.ja`, so
   `GeckoRuntime.create()` could never find it and the browser crashed.
   Fixed: read the bytes and write them flat to `assets-staging/omni.ja`.
2. **Gecko zygote preload (prime suspect for the launch crash).**
   The app manifest carried
   `android:zygotePreloadName="org.mozilla.gecko.process.ZygotePreload"`
   from the GeckoView AAR. The preload runs at process start, before any
   Activity, and can kill the process if it fails — matching the symptom
   exactly. It is only a startup optimisation; GeckoView works without
   it. Removed.
3. **Encrypted storage with no fallback.** `SecureStore` built
   `EncryptedSharedPreferences` in its constructor, called from
   `MainActivity.onCreate`. If the device keystore refuses, the app dies
   before any UI can report it. Now falls back to plain
   `SharedPreferences` on any exception (prototype token only).

Diagnostics added so the next failure reports itself instead of
guessing: `MainActivity.onCreate` catches startup exceptions and shows
the class + message + first 12 stack frames on screen;
`BrowserActivity` catches a `GeckoRuntime.create()` failure and shows it
in the status line instead of crashing.

0.1.1 (versionCode 2): rebuild with the fixed build.sh, verify
`assets/omni.ja` sits at the assets root (no `assets/assets/`),
`apksigner verify` v2+v3, badging versionCode 2. Install over 0.1.0
(same debug key) or uninstall first; the Drive link is unchanged
(the file is replaced in place).

## 0.2.0 — real v1.2.0 engine in the app (2026-11-19 ~01:58 EST)

Yakob asked to put the work done so far onto the app, so the app
filters with the real engine instead of the stub. 0.2.0 ports the
proven online-first extension v1.2.0 into the GeckoView prototype.
versionCode 5 (3 and 4 were used by the minimal-test and nogecko-test
APKs with the same package — 5 is the next free code and upgrades over
anything installed), versionName 0.2.0, 211,176,487 bytes. Same Drive
link as before (file replaced in place).

### What changed

- **Real person detector (stub replaced).** The built-in extension now
  bundles the MediaPipe ObjectDetector EfficientDet-Lite0
  (`assets/filter-extension/models-mediapipe/efficientdet_lite0.tflite`,
  sha256 `4b591000…80993`, 7,254,339 bytes) + the tasks-vision runtime
  + WASM (`vendor-mediapipe/`, ~15 MB), running in a hidden
  extension-origin iframe (`detector.html` + `detector-page.js`,
  bridged by `detector.js`) exactly like the desktop extension v1.2.0.
  PROTOTYPE-ONLY weights: the EfficientDet weights license is still
  unverified (see `models-mediapipe/LICENSES.md`) — do not treat this
  model as production-licensed.
- **Face fallback.** `vendor/face-api.js` + `models/` (tinyFaceDetector)
  run in the content script, same as v1.2.0. Person OR face counts as
  human; both failing means uncertain → covered.
- **Detection numbers, native decisions.** The content script computes
  detection NUMBERS only (`persons`, `personBest`, `faces`, `faceBest`,
  `detected`, `detectError`) and sends them to native; `FilterEngine`
  decides with the new `JsReportedPersonDetector` (mirrors the
  extension's `detectImg`, with the policy threshold in place of its
  hardcoded 0.50). `StubPersonDetector` is tests-only now. Threshold
  comes from the policy (`autoDecideThreshold`, default 0.70 — Yakob's
  0.50-vs-0.70 decision is still open).
- **Cross-origin images are actually checked now.** The content script
  refetches cross-origin images through the detector iframe (extension-
  origin fetch, not CORS-gated — same mechanism as v1.2.0), with a
  direct content-script fetch as fallback; verdicts cached per URL
  (max 500). CSS backgrounds, canvas, video frames and SVG are
  detected on probe images the same way. Anything unreadable stays
  covered (fail closed).
- **Yiddish block page.** A top-level navigation to a blocked host no
  longer just dies: `BrowserActivity` denies it and loads the Yiddish
  block page (`filter-extension/blocked.html`, domain + policy name
  substituted by Kotlin) as a `data:` URL.
- **SafeSearch enforcement.** `BrowserActivity` rewrites search
  navigations when the policy enforces SafeSearch (Google `safe=active`,
  Bing `adlt=strict`, DuckDuckGo `kp=1`; idempotent, pure function
  `FilterEngine.rewriteSafeSearch`, unit-tested). YouTube Restricted
  Mode still needs DNS — not attempted.
- **Extension manifest is MV2, version 0.2.0**, with
  `web_accessible_resources: ["detector.html"]` and
  `content_security_policy: "script-src 'self' 'unsafe-eval';
  object-src 'self'"` (WASM needs `unsafe-eval`).

### What is still a stub / not done

- Nothing is a stub any more in the engine path — but **none of this
  has run on a phone**. See "What is NOT verified" above.
- Ad/tracker *subresource* blocking (DNR in the desktop extension) has
  no equivalent in the app yet — the app blocks only top-level
  navigations to blocked hosts. Subresource ads still load.
- The 0.1.1 crash fixes are all kept: `assets/omni.ja` flat at the
  assets root, `zygotePreloadName` count 0 in the merged manifest,
  `SecureStore` plain-prefs fallback, `MainActivity.onCreateSafe`,
  `BrowserActivity` try/catch around GeckoView startup.

### Verification (this VM, 2026-11-19)

- Unit tests: `run-tests.sh` → **OK (37 tests)** (22 existing + 15
  new: detector mapping incl. 0.50/0.70 boundaries, SafeSearch rewrite,
  block-host matching, scan-message parsing).
- Manual build: exit 0; `apksigner verify` v2 true, v3 true, 1 signer;
  badging versionCode 5 / versionName 0.2.0; `lib/arm64-v8a/libxul.so`
  present; `assets/omni.ja` at root only; `zygotePreloadName` 0; all 16
  filter-extension assets in the APK (incl. the .tflite, the 14.7 MB
  WASM, face-api.js, detector files, block page); `JsReportedPersonDetector`,
  `showBlockPage`, `rewriteSafeSearch` present in `classes.dex`;
  no secrets found in the APK's text assets.
- Drive: file replaced in place, size verified 211,176,487 bytes =
  the built APK.

### How Yakob tests it on his phone

1. **Uninstall the old app first** (0.1.1, or the minimal/nogecko test
   APK if that is what is installed — same package name).
2. Install from the same Drive link as before
   (`FilterPlatform-GeckoView-prototype.apk`, now 0.2.0).
3. Open the app. If it opens, tap **"Open filter browser"**.
4. The browser home page is the filter dashboard. Type a real site in
   the address bar — e.g. `bbc.com`, `wikipedia.org` — and watch the
   status line: it counts covered / allowed / blocked.
   - A page with people in photos should show images covered (dark
     overlays); a page with no people (e.g. `example.com`) should show
     its content uncovered.
   - If EVERYTHING stays covered on every page, the detector is probably
     down on the device (WASM/CSP) — the engine fails closed, which is
     safe but means no real detection is happening. Report exactly that.
   - Try `facebook.com`: the Yiddish block page should appear instead
     of the site.
   - Try a Google search: the URL should gain `safe=active`.
5. Report back: does the app open? Does the browser open? What does
   the status line say on bbc.com / wikipedia.org / example.com? Does
   the facebook block page appear? Anything that kicks out or shows an
   on-screen error — copy the exact text.

---

## Web demo (added 2026-11-19 — web-demo child; do not rewrite the sections above)

The same browser is ALSO usable on the web, so it can be tested here
without Yakob's phone. This does **not** replace the phone test above —
it cannot prove the GeckoView app launches on the phone.

- **Demo shell:** https://filter-platform-dashboard.pages.dev/browser.html
  (address bar, back / forward / reload, filter-status line in Yiddish,
  one-click links to the 8 test pages + Wikipedia / BBC / example.com /
  Google & Bing SafeSearch tests / facebook block test).
- **Proxy Worker:** `filter-platform-web-browser`
  (https://filter-platform-web-browser.gavhah-copy.workers.dev) —
  fetches the target, strips its CSP, rewrites links/forms/images/
  scripts to stay inside the proxy (`/browse?u=…`), injects the shim +
  the SAME `content.js` / `detector.js` / `detector-page.js` / models
  the app ships (served from `public/browser-assets/`), enforces the
  SafeSearch rewrite (port of `FilterEngine.rewriteSafeSearch`), and
  checks the domain server-side against the filter API (service binding
  to `filter-platform-api`; the API token never leaves the Worker).
  SSRF guard ported from `scanner/scanner.js` (same IP ranges; DNS
  resolved via Cloudflare DoH because Workers have no DNS API).
- **In-page engine:** a direct JS translation of
  `FilterEngine.decide` + `JsReportedPersonDetector` + `DEFAULT_POLICY`
  (block images, cover, threshold 0.70; PERSON → cover, NO_PERSON ≥ 0.70
  → allow, UNKNOWN → cover, fail closed). Status counts reach the shell
  via `postMessage` from the iframe.
- **What it proves (verified live 2026-11-19, Playwright headless
  Chromium — `harness/verify-web-demo.js` 8/8 PASS,
  `harness/verify-web-demo-testpages.js` 5/5 PASS):** the filter
  pipeline, the EfficientDet JS detector, SafeSearch, and the Yiddish
  block page all work on real pages — Wikipedia 23 scanned (20 covered,
  3 allowed), BBC 257 scanned (187 covered, 70 allowed), test page 01
  person/crowd covered + landscape allowed, canvas + video covered with
  videos paused, WebGL covered (pixels unreadable → fail closed),
  facebook.com → Yiddish block page, Google search gains `safe=active`
  (Google itself bot-checks headless Chromium to `/sorry`), Bing gains
  `adlt=strict`, slow-3G first counts in ~1 s, detector ready in ~2 s
  warm (~5 s on first load incl. the one-time 15 MB WASM + 7 MB model
  download). Test pages live at `/test-pages/` on the Pages site.
- **What it does NOT prove:** the GeckoView app launching on Yakob's
  phone (phone test still needed); Gecko-specific behaviour (this runs
  in Chromium); the native RF-DETR Kotlin path (phone-only — the web
  demo runs the EfficientDet JS detector); logins/cookies on proxied
  sites (mostly broken through the proxy); phone performance.
- **Files:** `public/browser.html`, `public/browser-assets/` (copies of
  the app's filter-extension files), `public/test-pages/` (copies of
  `android/test-pages/`), `web-browser-worker.js`,
  `web_browser_deploy.py`, `harness/verify-web-demo*.js` +
  results JSON. `pages_deploy.py` now deploys `public/` recursively.
- **Known quirks (2026-11-19):** (1) Worker-to-Worker fetch to
  `*.workers.dev` returns Cloudflare error 1042 even with the subdomain
  enabled — the domain check therefore uses a service binding to
  `filter-platform-api`. (2) Cloudflare error 1010 blocks non-browser
  User-Agents on `*.workers.dev` — the Worker sends a browser UA on its
  API calls. (3) `<input type=image>` has no `naturalWidth`, so the
  content script cannot read its pixels — it stays covered (fail
  closed), even for a landscape picture. (4) On test page 02 one extra
  overlay was counted vs the status line (6 overlays, 5 covered / 1
  allowed) — likely a re-report timing artifact; nothing that should be
  covered was shown uncovered.

## 0.2.1-test — launch-crash diagnostic build (2026-11-19, versionCode 6)
- Same app as 0.2.0 plus crash reporting: catches `Throwable` (not just `Exception`) in the launch path, writes checkpoints + full crash (class, message, stack) to `startup-report.txt`, and shows a previous-crash screen on the next launch so Yakob can photograph it.
- APK: `manual-build/out/FilterPlatform-diagnostic-0.2.1-test.apk`, 211,176,487 bytes, sha256 `9b5bd6887eb9083f89736bcd1e6e7c439dc3d0c21a1f1ab7e1e3f27df4d90e62`, apksigner v2+v3 true.
- Drive (separate file, main APK untouched): file id `1hwlBJDmb7Tn1m2LoWmAQoAeYZDvO2hPR` — https://drive.google.com/file/d/1hwlBJDmb7Tn1m2LoWmAQoAeYZDvO2hPR/view?usp=drivesdk
- Phone test (uninstall the old app first, then install, then tap): (a) opens to setup = launch works; (b) crash-report screen appears = photograph it before tapping anything; (c) only "keeps stopping" with no report screen = report that exactly.

## 0.2.2 — RF-DETR Nano in the app (2026-11-19, versionCode 7)
- RF-DETR Nano ONNX (`app/src/main/assets/rfdetr-nano.onnx`, 116,607,449 bytes, sha256 `26728b72…bee0851`, matches the benchmarked file) + ONNX Runtime 1.32.0 (CPU, arm64 `.so` files packed stored/uncompressed). New code: `RfDetrOrtBackend.kt` (lazy OrtSession, inference on the background thread, never the UI thread), `RfDetrPersonDetector` + `CombinedPersonDetector` in `FilterEngine.kt` — PERSON if either detector says person, NO_PERSON only if all say clean, else UNKNOWN (stays covered). Threshold still flows from policy (0.50 vs 0.70 still Yakob's decision). Face-api fallback kept as a complementary signal.
- Behaviour change: a photo the JS detectors could not thumbnail (cross-origin, WebGL, live stream) used to be allow-able on the JS clean verdict alone; now it stays covered, because RF-DETR answers UNKNOWN with no thumbnail and one UNKNOWN vetoes a clean verdict. That only ever keeps content covered, never uncovers anything unchecked.
- APK: `manual-build/out/app-debug.apk`, 364,289,292 bytes (~348 MB), sha256 `78becf7355e54c67d24a3b4ff034c2d7ad5a5a46ef9ab217609639ee13350420`, apksigner v2+v3 true, badging versionCode 7 / versionName 0.2.2. Tests 59/59 pass (37 existing + 22 new).
- NOT uploaded to Drive yet — the parent decides which build goes to Yakob; 0.2.1-test remains the current phone test. Only the phone can prove: ORT native libs loading on the BLU, on-device inference speed, real detection on phone photos, memory use with GeckoView + ORT together, and whether the app still launches at all with the extra ~150 MB. This build has never run on a device.
- Known wart: the failure screen still says "diagnostic build 0.2.1-test" — it should say 0.2.2 someday.
