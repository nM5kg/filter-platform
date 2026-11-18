# Filter Platform — Android app (skeleton, Android-first)

Kotlin Android app for the free kosher filter platform. It is the **device
side** of the Phase 1 API: a customer registers this phone, the phone gets a
policy from the server, and the phone reports that it is online and filtering.

> **Status 2026-11-18:** the app is written, its Kotlin compiles, its unit
> tests pass (22/22: 7 `ApiClientTest` + 15 `FilterEngineTest`), and a
> signed debug APK with GeckoView was built and verified here
> (200,066,826 bytes, arm64-v8a, v2+v3 signatures). The **GeckoView
> browser prototype is built** — decision 2026-11-18 (Yakob): GeckoView
> STABLE 160.0.20261116130455, own browser UI + own filter engine; see
> [GECKOVIEW-PROTOTYPE.md](GECKOVIEW-PROTOTYPE.md). **Gradle cannot
> build this module anywhere right now**: the sandbox still intercepts
> all TCP data from JVM processes on this VM (proven byte-for-byte
> 2026-11-18), AND SDK platform 37 — required by the GeckoView AAR's
> `minCompileSdk=37` — does not exist for download (Google lists at most
> platform-36). The installed Gradle 8.5 binary itself runs fine; only
> `./gradlew`'s distribution download fails. There is NO "other_tcp"
> setting to enable — it does not exist. On this VM the build is
> `manual-build/build.sh`. The APK has never run: no Android device or
> emulator exists here.

## What the app does

One activity, three screens (all real API calls, no demo/fake data — a failed
call shows the real server error, never a fake success):

1. **Setup** — API base URL (default
   `https://filter-platform-api.gavhah-copy.workers.dev`) + API token, plus
   the customer name/email. The token is typed in by the user and stored in
   `EncryptedSharedPreferences` (AES256-GCM); it is **never** hardcoded and
   never leaves the phone except as a `Bearer` header. Saving setup creates
   the customer on the server (`POST /api/v1/customers`).
2. **Register this device** — enter a device name → `POST /api/v1/devices`
   (`platform: "android"`, default policy applied by the server) → the
   6-digit activation code is shown on screen → enter the code →
   `POST /api/v1/devices/register` → device becomes **active**. A wrong or
   already-used code returns the server's 404 ("Invalid or already-used
   activation code") and is shown as-is.
3. **Your filter** — policy card (`GET /api/v1/policies/:id`: name,
   block_images, cover_images, filter_ads, force_safesearch,
   auto_decide_threshold, require_approval_for_new_sites), a **Check status**
   button (sends `POST /api/v1/devices/:id/heartbeat` with
   `status: "online", filter_active: true`, then reads
   `GET /api/v1/devices/:id/status` and shows online / filter_active /
   policy_version / last checked), and an **Open web dashboard** button
   (opens `https://filter-platform-dashboard.pages.dev` in the browser).
   A **Reset** button forgets the phone (clears the encrypted store).

`ApiClient.kt` also has `checkDomain()` (`GET /api/v1/domains/check`) for
later use; the UI does not call it yet.

## Project layout

```
android/
  settings.gradle.kts          root project "filter-platform", include :app
  build.gradle.kts             AGP 8.3.2 + Kotlin 1.9.23 (plugin versions)
  gradle.properties            org.gradle.jvmargs=-Xmx1024m (see below)
  gradlew / gradlew.bat        standard Gradle 8.5 wrapper (generated)
  gradle/wrapper/              gradle-wrapper.jar + .properties (Gradle 8.5)
  local.properties             sdk.dir — LOCAL ONLY, gitignored, VM-specific
  .gitignore                   local.properties, .gradle/, build/, *.apk
  app/
    build.gradle.kts           minSdk 26, targetSdk 34, compileSdk 34
                               deps: security-crypto 1.1.0-alpha06 only
                               (+ junit 4.13.2 for unit tests)
    src/main/AndroidManifest.xml
    src/main/java/com/filterplatform/app/
      MainActivity.kt          the three screens + background-thread API calls
      BrowserActivity.kt       GeckoView browser prototype (own UI + filter bridge)
      FilterEngine.kt          pure-Kotlin filter engine (fail closed, unit-tested)
      ApiClient.kt             HttpURLConnection client + JSON parsing
      SecureStore.kt           EncryptedSharedPreferences wrapper
    src/main/assets/filter-extension/
      manifest.json, background.js, content.js   built-in WebExtension (MV2)
    src/main/res/layout/activity_browser.xml
    src/test/java/com/filterplatform/app/ApiClientTest.kt   (7 unit tests)
    src/test/java/com/filterplatform/app/FilterEngineTest.kt (15 unit tests)
  GECKOVIEW-PROTOTYPE.md       GeckoView prototype: version, build, device checklist
  test-pages/                  8 test pages (01–08) + index + README for the 8 content types
  gradle-inprocess.sh          runs Gradle WITHOUT a daemon (see below)
  manual-build/
    build.sh                   builds the debug APK without Gradle (see below)
    libs/                      curl-downloaded AARs/JARs (NOT committed to git
                               — see the header comment in build.sh)
    out/                       build outputs: app-debug.apk, test classes
```

Deliberate simplifications (kept minimal on purpose):

- Framework `android.app.Activity` + `@android:style/Theme.Material.Light`
  instead of AppCompat — the skeleton uses no AppCompat APIs, so there is no
  AppCompat dependency to download, and no library resources to merge.
- No Compose, no coroutines, no OkHttp/Retrofit: plain
  `HttpURLConnection` + `org.json` + a background `thread {}`. Fewer moving
  parts, and the network code is fully visible in one file.

## Building on a normal machine

```bash
cd android
~/gradle-8.5/bin/gradle assembleDebug   # installed Gradle 8.5; do NOT use ./gradlew
# APK: app/build/outputs/apk/debug/app-debug.apk
~/gradle-8.5/bin/gradle testDebugUnitTest   # unit tests (22 tests)
~/gradle-8.5/bin/gradle lintDebug           # Android Lint
```

Requirements: JDK 17, Android SDK with `platforms;android-34` and
`build-tools;34.0.0`, Gradle 8.5 (installed binary — the wrapper's
distribution download fails behind this sandbox's egress). Set `sdk.dir`
in `local.properties` or `ANDROID_HOME`. **Caveat 2026-11-18: a Gradle
build of this module fails on every machine right now** — the GeckoView
AAR declares `minCompileSdk=37` and Google has no platform-37 package
for download (repository2-1.xml lists at most platform-36; the
platform-37 zip is a 404). Until platform 37 exists (or the GeckoView
pin changes), the manual build below is the only working build.

## Environment setup on THIS VM (what was actually installed, 2026-11-18)

Disk first: `df -h` showed 148 GB free on `/home/hatch`; `/tmp` is a
512 MB tmpfs — **do not unpack SDKs there** (the first attempt died with
"disk full" unpacking the command-line tools in `/tmp`).

1. **JDK 17 — Temurin tarball, not apt.**
   `apt-get update` hung behind the sandbox proxy (apt's HTTP method does
   not send `Proxy-Authorization` after a 407, same class of problem as
   Chromium in `harness/egress-relay.js`). Abandoned after ~6 min.
   Instead:
   ```bash
   curl -sL -o temurin17.tar.gz \
     "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
   mkdir -p ~/jdk17 && tar xzf temurin17.tar.gz -C ~/jdk17 --strip-components=1
   ~/jdk17/bin/java -version   # openjdk 17.0.21 (Temurin 17.0.21+9)
   ```
2. **Android command-line tools** (153 MB):
   ```bash
   curl -sL -o cmdtools.zip \
     "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
   unzip -q cmdtools.zip -d cmdtools-extract
   mkdir -p ~/Android/sdk/cmdline-tools/latest
   cp -r cmdtools-extract/cmdline-tools/* ~/Android/sdk/cmdline-tools/latest/
   ```
3. **SDK packages — NOT via `sdkmanager`.** `sdkmanager` fails on this VM:
   Java's `HttpURLConnection` tunneling throws `NoSuchElementException`
   parsing the egress relay's `HTTP/1.1 200 Connection Established` reply
   (see the blocker section — it is the same JVM-network block, not a
   sdkmanager bug). So the three packages were downloaded with `curl`
   (URLs taken from `repository2-1.xml`) and laid out by hand:
   ```bash
   curl -sL -o platform-34.zip \
     "https://dl.google.com/android/repository/platform-34-ext7_r03.zip"
   curl -sL -o build-tools34.zip \
     "https://dl.google.com/android/repository/build-tools_r34-linux.zip"
   curl -sL -o platform-tools.zip \
     "https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip"
   unzip -q platform-34.zip   -d ~/Android/sdk/platforms/
   unzip -q platform-tools.zip -d ~/Android/sdk/
   unzip -q build-tools34.zip  -d /tmp/bt && mv /tmp/bt/android-14 ~/Android/sdk/build-tools/34.0.0
   ```
   Licenses accepted by writing the standard hashes into
   `~/Android/sdk/licenses/android-sdk-license` (the two well-known
   `android-sdk-license` hashes). Total SDK size: **446 MB** (minimum only:
   cmdline-tools + platform-tools + platforms;android-34 +
   build-tools;34.0.0).
4. **Gradle 8.5** (132 MB):
   ```bash
   curl -sL -o gradle-8.5-bin.zip \
     "https://services.gradle.org/distributions/gradle-8.5-bin.zip"
   unzip -q gradle-8.5-bin.zip -d ~
   # ~/gradle-8.5/bin/gradle --version  -> Gradle 8.5, JVM 17.0.21
   ```
   The wrapper files (`gradlew`, `gradle-wrapper.jar`, properties) were
   generated with the stock `wrapper` task run in an empty directory
   (`./gradle-inprocess.sh wrapper`, see below) — the task's URL check
   needed `--gradle-distribution-url file:///home/hatch/downloads/gradle-8.5-bin.zip`
   because it downloads the distribution with Java networking (blocked).
   The committed `gradle-wrapper.properties` carries the standard
   `https://services.gradle.org/...` URL, not the file URL.
5. **Proxy for Gradle** (local only, NOT in the repo): Gradle's user home
   on this VM is `/home/hatch/.gradle` (Java's `user.home` here), NOT
   `/root/.gradle`. As of 2026-11-18 ~13:30 EST **no proxy is configured
   there** (`~/.gradle/gradle.properties` carries only a comment): direct
   JVM HTTPS and JVM-via-proxy both fail the same way (the sandbox
   intercepts all TCP data from JVM processes — see the blocker section),
   so proxy settings cannot make Gradle download anything on this VM.
   Two relays existed: the older one on `127.0.0.1:18080` (started by the
   Phase 2 agent) is **stale and dead**; a fresh instance of the same
   script (`harness/egress-relay.js`) was restarted on **`127.0.0.1:18081`**
   for the 2026-11-18 re-test — curl through it returns 200, but a Java
   Socket to it still receives the 193-byte interceptor message, so it
   does not help the JVM either. Gradle points at no proxy now.

## Why Gradle cannot build this (verified 2026-11-18)

Two independent blockers. Either one alone stops a Gradle build.

### Blocker 1 — the sandbox still intercepts ALL TCP data from JVM processes

**Root cause (proven, not guessed): the sandbox intercepts and blocks
every TCP connection's DATA made by a JVM process.** The message the
interceptor returns is:

> `muse: Other TCP connections is turned off for this assistant. To allow
> it, ask the user to open Muse settings -> Permissions -> Direct network
> protocols and switch other_tcp from Deny to Ask.`

**Correction 2026-11-18 ~13:30 EST: that setting does NOT exist.** It
appears neither in the Permissions screen nor in the full permissions
list (checked 2026-11-18 ~13:11 EST); there is no permission card to
bring up and nothing pending. Do NOT tell Yakob to enable it. There is
no one-line fix on this VM.

Also corrected: the 2026-11-18 ~13:11 EST check that "JVM TCP now
works" was a **connect-only** test. A TCP connect succeeds; the data
does not flow. Evidence (all 2026-11-18, re-verified ~13:30 EST):

- A Java program opening a raw socket to `repo.maven.apache.org:443`
  and reading gets the 193-byte interceptor message. The same bytes
  from Python, from a compiled C program, and from `curl` all reach the
  real host. Tested in the *same* exec call, back to back: Java blocked,
  Python allowed.
- A Java Socket to the **127.0.0.1:18081 egress relay** (Node process,
  restarted for this test; curl through it returns 200) receives the
  same 193-byte message; Python to the same relay receives the real
  `HTTP/1.1 200 Connection Established`.
- Consequences observed, each with its own log:
  1. **Gradle daemon:** the daemon starts fine, the client TCP-connects,
     dispatches the Build request — and the client reads the interceptor
     message off the loopback socket:
     `Could not receive a message from the daemon.` /
     `Caused by: java.lang.IllegalArgumentException: Unexpected type tag 109 found.`
     (109 = `0x6D` = `'m'`, the first byte of `muse: ...`.)
  2. **Direct JVM HTTPS:** `javax.net.ssl.SSLException: Unsupported or
     unrecognized SSL message` — the interceptor's plain text is not TLS.
  3. **JVM HTTPS via proxy** (egress proxy with auth, or the 18081
     relay): `java.lang.RuntimeException: java.util.NoSuchElementException`
     — Java's CONNECT-response parser chokes on the interceptor text.
     (`sdkmanager` fails the same way: `NoSuchElementException` in
     `HttpURLConnection.doTunneling0`.)
  4. **In-process Gradle** (`gradle-inprocess.sh`): runs — and then fails
     only on dependency downloads (`Plugin com.android.application 8.3.2
     was not found in any of the following sources: ... Google /
     MavenRepo / Gradle Central Plugin Repository`).
- **The installed Gradle 8.5 binary itself runs fine**
  (`gradle --version` → Gradle 8.5 / JVM 17.0.21, exit 0, daemon starts).
  Only the **wrapper** fails: `./gradlew` dies downloading the
  distribution in the SSL handshake (Broken pipe) — the same
  interception. Use the installed binary, never `./gradlew`, and do NOT
  claim `./gradlew` works.
- **No CA import can fix this.** There is no egress CA to import: the
  current egress proxy does plain CONNECT tunneling — `openssl s_client`
  via the proxy shows a normal public chain (`issuer=C = US, O = Let's
  Encrypt, CN = YE1`). The failure happens before TLS anyway: the JVM
  never receives TLS bytes. (The older note about a "Hatch Sandbox
  Egress CA" described a previous proxy setup; it does not apply now.)

**Workaround that DOES work — in-process Gradle:** if the launcher JVM is
started with exactly the JVM args Gradle would give the daemon
(`-Xmx1024m`, the seven `--add-opens`, `-Dfile.encoding=US-ASCII`,
`-Duser.country=US`, `-Duser.language=en`, `-Duser.variant`, **plus**
`-javaagent:<gradle>/lib/agents/gradle-instrumentation-agent-8.5.jar`),
Gradle re-uses the launcher JVM and never forks a daemon — no loopback
socket needed. That is `gradle-inprocess.sh` in this folder. (Found by
decompiling `BuildProcess.configureForBuild`: the reuse check fails without
the agent because the daemon is configured to apply the instrumentation
agent and the launcher JVM doesn't have it.) With this, Gradle *starts* a
build in-process — and then fails only on dependency downloads (blocker 1
above). So in-process Gradle + a fully offline dependency cache would work
for downloads; populating that cache by hand was out of scope for this task
(AGP's transitive closure is ~100 artifacts) — and blocker 2 below stops
a Gradle build regardless.

### Blocker 2 — SDK platform 37 does not exist for download

GeckoView 160's AAR declares `minCompileSdk=37`, so a Gradle build needs
`compileSdk 37`. But Google has no platform-37 package:
`https://dl.google.com/android/repository/platform-37_r01.zip` → **404**,
and `repository2-1.xml` lists at most `platform-36-ext18_r01.zip`
(checked 2026-11-18). Pre-downloading Maven artifacts with curl into the
Gradle cache cannot fix this one. Until Google publishes platform 37 (or
the GeckoView pin changes), a Gradle build of this module fails on every
machine, not just this VM. The manual build sidesteps it by compiling
against the already-installed `android.jar` 34 — a prototype-only
compromise: the APK reports `compileSdkVersion: 34` while the GeckoView
AAR asks for 37.

### Side fix shipped with this task: `harness/egress-relay.js`

While debugging, a real bug in the relay was found and fixed: Node's
`'connect'` handler ignored the `head` argument — bytes a client sends
right after the CONNECT headers (Java's HttpClient pipelines the TLS
ClientHello in the same flush; curl waits for the 200 first). Dropping
`head` silently broke the TLS handshake for pipelining clients. The fix
forwards `clientHead` upstream once the tunnel is established (named
`clientHead` because the data handler below declares its own local `head`
for the upstream response headers — the first version of the fix wrote the
upstream 200 response *into* the upstream socket and corrupted the tunnel;
the rename fixed that). Verified: curl through the fixed relay on 18081
returns 200 for Maven Central, Google Maven, and plugins.gradle.org.

## Verification (what was actually run, 2026-11-18)

### VERIFIED — manual debug-APK build with GeckoView (`manual-build/build.sh`)

Same sources, same SDK tools Gradle would use (aapt2, d8, zipalign,
apksigner from build-tools 34.0.0; d8 from build-tools 36.0.0 — the
34.0.0 d8 crashes on androidx.collection 1.7.0, see build.sh; kotlinc
2.4.21; every dependency downloaded by curl via
`manual-build/fetch-deps.py`). Result (rebuilt to completion 2026-11-18
18:34 UTC after the previous run was cut off at 18:22 UTC during d8):

```
== 1. aapt2 compile resources ==   OK
== 2. aapt2 link (merged manifest + resources, R.java) ==   OK
== 3. kotlinc (app sources + generated R.java) ==   OK (1 deprecation warning: onBackPressed)
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

Output: `manual-build/out/app-debug.apk` (**200,066,826 bytes**,
arm64-v8a only; `GV_ABIS="arm64-v8a armeabi-v7a x86_64" ./build.sh`
builds all ABIs, ~520 MB). Contents verified with `unzip -l` +
`dexdump`: `assets/omni.ja` (15,252,607),
`assets/filter-extension/{manifest.json, background.js, content.js}`,
`lib/arm64-v8a/libxul.so`, `BrowserActivity` / `FilterEngine` /
`StubPersonDetector` and all model classes in `classes.dex`, GeckoView
classes in `classes2.dex`. The old skeleton-only APK (848,343 bytes,
11:16 UTC) is replaced by this build. (The manual build compiles
against `android.jar` 34 while the GeckoView AAR asks for
`minCompileSdk=37` — a prototype-only compromise, see the Gradle
blockers above.)

Library versions used by the manual build (from the real POMs, curl):
security-crypto 1.1.0-alpha06 (AAR) + annotation 1.1.0 + collection 1.1.0
+ tink-android 1.8.0 (JAR — its POM says `<packaging>jar</packaging>`,
the `.aar` URL 404s) + gson 2.8.9, plus the full GeckoView 160 closure
(59 artifacts, `manual-build/libs/geckoview/DEPENDENCIES.md`). Note:
collection 1.1.0 is a JAR too, not an AAR. The manual-build `libs/`
folder is a build input, not committed source — delete it to
re-download.

### VERIFIED — unit tests, 22/22 pass

`ApiClientTest` (7) + `FilterEngineTest` (15) — pure JVM code (JSON
parsing, FilterEngine — no Android framework, no GeckoView runtime),
compiled with kotlinc 2.4.21 and run under JUnit 4.13.2 on the JVM (with
the real `org.json:json:20240303` implementation on the classpath,
because `android.jar`'s `org.json` classes are stubs that throw at
runtime):

```
JUnit version 4.13.2
......................
Time: 0.095
OK (22 tests)
```

Tests cover: pending device with activation code, registered device,
Standard policy fields, `auto_decide_threshold` returned as a **string**
(`"0.7000"` — that is what the live Worker actually returns; see below),
null status row, online status row, server error message extraction;
fail-closed engine property (stub detector never allows, no thumbnail
never allows, low-confidence never allows), person→cover/block,
confident no-person→allow, scan/decisions wire format (REVIEW sent as
"cover"), navigation blocklist + scheme blocking, `hostOf` parsing.
On a normal machine these same tests run via
`gradle testDebugUnitTest` (installed Gradle 8.5, not `./gradlew`).

### VERIFIED — live API, read-only (2026-11-18 ~11:16 UTC)

With the real API token (read from `api_token.txt`, never printed):

- `GET /health` → `{"service":"filter-platform-api","status":"ok",
  "database":"connected","phase":1}`.
- `GET /api/v1/domains/check?domain=example.com` → `allow /
  unlisted-open` (matches the app's `checkDomain()` parsing).
- `GET /api/v1/policies` → 1 policy, "Standard — block images +
  explicit words, rest open": `block_images=true, cover_images=false,
  filter_ads=false, force_safesearch=true,
  auto_decide_threshold="0.7000"` (string), `require_approval_for_new_sites=false`.
  All field names the app reads are present with these exact names.
- Same check without a token → `{"error":"Unauthorized"}` (the app's
  `ApiException` path).

### NOT verified (cannot be, on this VM)

- **A Gradle build** — blocked two ways (see above): the sandbox still
  intercepts all JVM TCP data on this VM, and SDK platform 37 does not
  exist for download anywhere yet. The Gradle project files are standard
  and complete, but no Gradle build has run to completion here.
- **Android Lint** (`gradle lintDebug`) — needs Gradle; not run.
- **Running the app on a phone** — no Android device or emulator exists
  on this VM. The APK is built, signed and verified, but it has never been
  installed or launched anywhere. In particular the GeckoView prototype
  (browser Activity, extension install, native bridge, cover behaviour on
  the 8 content types) is unproven until the checklist in
  [GECKOVIEW-PROTOTYPE.md](GECKOVIEW-PROTOTYPE.md) is run on a real phone.
- **Real device registration end-to-end from the app** — the registration
  flow (create customer → create device → code → register → heartbeat)
  was verified against the live API by the Phase 1 dogfood script, but
  never from this app's UI, because the app has never run.
- **The Kiwi/Vivaldi extension path below** — documented from public
  sources, not tested on a device.

## The Kiwi Browser path (documented, NOT tested on a device)

The Phase 2 MV3 extension (`../extension/`) can run on Android **today**,
without waiting for the custom browser — but read the warning first.

> **Warning — Kiwi is discontinued.** Kiwi Browser was discontinued in
> January 2025 and removed from Google Play; existing installs still run
> extensions but no longer receive browser security updates (correction
> published 10 October 2026, maketecheasier.com). The current alternative
> is **Vivaldi for Android 8.2+**, which installs Chrome Web Store
> extensions directly. The steps below are written for Kiwi because that
> is what the Phase 2 plan named; the same steps work in Vivaldi's
> extension page, and Vivaldi is the better choice for a new install.
> **None of this was tested on a device here** — there is no Android
> device on this VM. Treat it as documented-from-public-sources only.

Steps (from Kiwi's public documentation and the extension's own popup):

1. **Get the extension onto the phone.** Copy the `../extension/` folder
   (it must contain `manifest.json` at its root) to the phone, e.g. by
   USB, a file transfer, or a ZIP download from the repo
   (`github.com/nM5kg/filter-platform`, folder `extension/`).
2. **Install Kiwi Browser** (only if already installed / sideloaded —
   it is no longer on Google Play) **or Vivaldi for Android 8.2+** from
   the Play Store.
3. **Open the extensions page.** In Kiwi: tap the menu (⋮) → **Extensions**
   (also reachable at `chrome://extensions` / `kiwi://extensions`). In
   Vivaldi: menu → Extensions.
4. **Enable Developer mode** — toggle in the top-right of the extensions
   page (in Kiwi it is on by default).
5. **Load the extension.** Tap **+ (from .zip/.crx/.user.js)** (Kiwi) or
   the equivalent load option, and select the extension folder/ZIP
   (Kiwi's "Load unpacked" flow: choose the folder containing
   `manifest.json`). The extension appears as an enabled card; sideloaded
   extensions do **not** auto-update — repeat the load to update.
6. **Enter the token + device id in the popup.** Tap the extension's icon
   (or its card) to open the popup. It has two fields (see
   `../extension/popup.html` / `popup.js`): **API token** (paste the same
   token the dashboard uses) and **Device ID** (the device UUID — copy it
   from the dashboard's device list, or from this Android app after it
   registers). They are stored in `chrome.storage.local` on the phone
   only; nothing is bundled in the extension code.
7. **Use it.** The background script (`background.js`) fetches the
   device's policy and blocklist from the Phase 1 API, the content script
   scans images (face detection, block/cover/strict per policy), and
   navigation to blocked domains is stopped by the declarative rules.
   The popup shows the current status and stats.

What this does **not** do: it is the browser extension running inside
another company's browser, not our own filter browser, and it does not
filter other apps or system traffic. That is what the later device-app /
custom-browser phases are for.

## Secrets

- The app contains **no** API token, no database URL, no keys. The token
  is entered by the user at setup and kept in `EncryptedSharedPreferences`.
- `api_token.txt` / `database_url.txt` in the project root are 0600, never
  printed, never committed, and are not referenced by the app.
- `local.properties` (SDK path) is gitignored.
- The debug keystore in `manual-build/out/debug.keystore` is a throwaway
  debug key (`storepass android`) — never use it for a release build.
