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
- No person detection runs on device yet (stub detector only). Detecting
  people on real sites inside GeckoView is NOT proven — the scanner's
  EfficientDet-Lite0 results (Playwright + headless Chromium) do not
  transfer automatically: the prototype must be re-proven inside
  GeckoView per content type, per the checklist.
- Real device registration end-to-end from the app UI (create customer →
  create device → code → register → heartbeat) was verified against the
  live API by the Phase 1 dogfood script, but never from this app's UI.
- A Gradle build of this module (any machine) until SDK platform 37
  exists — see Blocker 2 above.
- Google Images behaviour inside GeckoView (Google serves `/sorry`
  bot-checks to headless Chromium; unknown for GeckoView) — try it on
  the device and record the result.
