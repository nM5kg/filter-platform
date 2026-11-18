# GeckoView — Version, License & Gradle Research

**Project:** Free Kosher Filter Platform — Android browser base (own Browser App + own Filtering Engine)
**Decision this serves:** Yakob, 2026-11-18 ~12:55 EST — browser base is **GeckoView, Stable channel, NOT Nightly**; Mozilla Android Components where they help; NOT a ready-made foreign browser UI; Cromite is NOT the main base (GPLv3); raw Chromium is backup only.
**Researched:** 2026-11-18 (all version numbers below were read live from Mozilla's own Maven repository that day, not from memory or secondary round-ups).
**Scope note:** this file is research only. It does not change any build file. Nothing was pushed to GitHub. No secrets were read.

---

## 1. Verdict — what to pin

| Piece | Pin this | Channel | Why |
|---|---|---|---|
| GeckoView | `160.0.20261116130455` | **Stable** | Latest release on the stable artifact; build timestamp 2026-11-16 13:04:55 UTC; corresponds to Firefox **160.0.1** |
| Mozilla Android Components (AC) | `160.0.1` | **Stable** (plain `X.0.1`, no `b` suffix) | Its `browser-engine-gecko` POM depends on exactly `geckoview-omni 160.0.20261116130455` — the pairing is proven by the POM, not guessed |
| Minimum Android | API 26 (Android 8.0) | — | MozillaWiki, latest revision 2026-04-13: "GeckoView, Fenix, and Focus all require Android 8.0 (Oreo, API 26) or later" |

**Do NOT use:** `161.0b5` (that is the newest AC version in Maven metadata, but it is a **Beta** for the next train), `geckoview-beta` (latest `161.0.20261118090429`), or `geckoview-nightly` (latest `162.0.20261118115927`).

---

## 2. GeckoView stable version — primary-source proof

### 2.1 The stable artifact

- **Group / artifact:** `org.mozilla.geckoview:geckoview`
- **Latest stable version:** `160.0.20261116130455`
- **Build timestamp in the version string:** `20261116 130455` = **2026-11-16, 13:04:55 UTC**
- **Source:** Mozilla Maven metadata, read live 2026-11-18:
  - `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml`
  - `<latest>160.0.20261116130455</latest>` and `<release>160.0.20261116130455</release>`, metadata `lastUpdated 20261117222840`.
- **AAR confirmed present:** `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.aar` → HTTP 200.
- **POM:** `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.pom` — packaging `aar`, url `https://geckoview.dev`, SCM `scm:hg:https://hg.mozilla.org/releases/mozilla-release`, tag `b1145b0710192f716be5f59f5b2dfeed650d5294`.

### 2.2 Why this is Stable and not Beta/Nightly

Mozilla publishes the three channels as **three separate artifacts** on the same Maven host, so the channel is visible in the artifact name itself (verified live 2026-11-18 from each artifact's `maven-metadata.xml`):

| Artifact | Latest version on 2026-11-18 | Channel |
|---|---|---|
| `org.mozilla.geckoview:geckoview` | `160.0.20261116130455` | **Stable** |
| `org.mozilla.geckoview:geckoview-beta` | `161.0.20261118090429` | Beta |
| `org.mozilla.geckoview:geckoview-nightly` | `162.0.20261118115927` | Nightly |

Stable = major version 160, Beta = 161, Nightly = 162. The version numbers step in lockstep with Firefox desktop/Android releases.

### 2.3 Release date — Firefox 160 / 160.0.1

- **Firefox 160.0 released 2026-11-10** (MozillaWiki `Releases` page; multiple contemporaneous reports agree).
  - The first 160 stable GeckoView build was `160.0.20261104181552` (build 2026-11-04, published 2026-11-10 per mvnrepository).
- **Firefox 160.0.1 released 2026-11-16** (MozillaWiki `Releases` page: "Firefox 160.0.1 — Released on 2026-11-16", based on Gecko 160).
  - The GeckoView build pinned here, `160.0.20261116130455`, was built 2026-11-16 13:04:55 UTC — the 160.0.1 build. It supersedes the 160.0 build.
  - Small caveat: Wikipedia's Firefox article dates 160.0.1 to 2026-11-17; MozillaWiki says 2026-11-16, which matches the build timestamp. The **build date (2026-11-16) is the hard fact**; the exact publication day differs by source by one day and does not affect the pin.
- **Release cadence:** a new major version reaches Stable roughly every 4 weeks, following the Firefox release calendar (MozillaWiki `Mobile/GeckoView`).
  - Next stable (161) was expected around 2026-11-20 per a secondary release-calendar site — **not verified from a Mozilla primary source; treat as "watch for", not fact**.

### 2.4 `geckoview` vs `geckoview-omni`

- Both artifacts exist at the same version `160.0.20261116130455`.
- **Direct GeckoView consumers** (no Android Components) use plain `org.mozilla.geckoview:geckoview`.
- **Android Components' `browser-engine-gecko`** depends on `org.mozilla.geckoview:geckoview-omni` (see §3.2). The `-omni` variant is the one AC is built and tested against.
- **Rule: depend on one or the other, never both.** If the app uses AC's engine, let AC bring `geckoview-omni` and pin the version explicitly (Gradle snippet in §5 does this) so a transitive bump cannot silently change the engine.

### 2.5 System requirements (MozillaWiki, latest revision 2026-04-13)

- Android **8.0 (Oreo, API 26) or later**.
- CPU: 32-bit ARMv7-A, 64-bit ARMv8-A (ARM64), 32-bit x86, or x86_64.
- Minimum device guidance: quad-core 1.2 GHz, 2 GB RAM.
- Source: `https://wiki.mozilla.org/Mobile/GeckoView` ("Minimum System Requirements").
- The existing skeleton (`android/app/build.gradle.kts`) already uses `minSdk = 26`, which matches. **Caveat:** whether GeckoView 160 needs a higher `compileSdk`/`targetSdk` than the skeleton's current 34 is **not stated in the POM** and was not verified from a primary source — confirm at the first Gradle sync (Firefox for Android itself targets a current SDK; be prepared to raise `compileSdk`).

---

## 3. Matching Android Components version

### 3.1 The version: `160.0.1` (stable)

All Android Components share **one version number** across every artifact. The stable release matching GeckoView 160 is **`160.0.1`**.

**How the pairing is proven (POM dependencies, read live from `maven.mozilla.org`):**

| AC version | Its `browser-engine-gecko` POM depends on | Meaning |
|---|---|---|
| `159.0.1` | `geckoview-omni 159.0.20261102144711` | Previous stable train (159) |
| `160.0` | `geckoview-omni 160.0.20261104181552` | Firefox 160.0 |
| **`160.0.1`** | **`geckoview-omni 160.0.20261116130455`** | **Firefox 160.0.1 — the pinned GeckoView** |
| `160.0b5` | `geckoview-beta-omni 160.0.20261104021706` | Beta — note the `-beta-omni` dependency, the tell-tale sign of a beta AC release |

So: **AC `160.0.1` + GeckoView `160.0.20261116130455` are the matched stable pair.** If you bump one, bump the other to the pair shown by the next AC release's POM.

**Trap to avoid:** `maven-metadata.xml` for every AC artifact currently reports `<latest>161.0b5</latest>`. That is the newest *published* version, but it is a **beta** (`b5`). Stable AC releases are the plain `X.0` / `X.0.1` versions without a `b` suffix. When checking for updates, ignore any version containing `b` (beta) or `a` (alpha) — see §6.

**Date caveat (stated plainly):** no primary-source publication date for AC `160.0.1` itself was found on 2026-11-18 — mvnrepository had not indexed a `160.0.1` page for these artifacts at research time (its URL returned 404), and Mozilla's Maven metadata carries no per-version date. The date is therefore **inferred, not directly dated**: AC `160.0.1` depends on the GeckoView build of 2026-11-16 13:04 UTC, and Firefox 160.0.1 was released 2026-11-16. The pairing itself is hard fact (POM); only the calendar date of the AC publication is inferred.

### 3.2 Components relevant to building the browser UI

Every artifact below was checked live on 2026-11-18: its `160.0.1` POM exists on Mozilla Maven (HTTP 200). All are `org.mozilla.components`, all MPL-2.0 (§4). The "core" set is what the prototype needs first; the "later" set is useful as the browser grows.

**Core — needed for a minimal browser UI:**

| Artifact (Maven coordinate) | What it is | License |
|---|---|---|
| `org.mozilla.components:browser-state:160.0.1` | Centralized browser state (tabs, sessions) — the store every other component reads/writes | MPL-2.0 |
| `org.mozilla.components:browser-engine-gecko:160.0.1` | Engine implementation based on GeckoView; binds AC to the pinned GeckoView | MPL-2.0 |
| `org.mozilla.components:concept-engine:160.0.1` | Abstract engine layer (lets code talk to "an engine", not GeckoView directly) | MPL-2.0 |
| `org.mozilla.components:browser-toolbar:160.0.1` | Customizable toolbar (URL bar) for browsers | MPL-2.0 |
| `org.mozilla.components:feature-tabs:160.0.1` | Tabs feature (open/close/select, tab list behaviour) | MPL-2.0 |
| `org.mozilla.components:feature-session:160.0.1` | Connects an engine implementation with the session/state module | MPL-2.0 |
| `org.mozilla.components:lib-state:160.0.1` | Generic state-store library underneath `browser-state` | MPL-2.0 |
| `org.mozilla.components:support-base:160.0.1` | Base building blocks/interfaces for components | MPL-2.0 |
| `org.mozilla.components:support-webextensions:160.0.1` | AC helpers for installing/managing WebExtensions — **directly relevant to the privileged filter extension (§7)** | MPL-2.0 |

**Useful next — navigation, prompts, downloads, content features:**

| Artifact | What it is | License |
|---|---|---|
| `org.mozilla.components:feature-downloads:160.0.1` | Download handling | MPL-2.0 |
| `org.mozilla.components:feature-prompts:160.0.1` | Prompt dialogs from web content (alert, login, permissions, …) | MPL-2.0 |
| `org.mozilla.components:feature-search:160.0.1` | Search (engines, search UI wiring) | MPL-2.0 |
| `org.mozilla.components:feature-contextmenu:160.0.1` | Long-press context menu | MPL-2.0 |
| `org.mozilla.components:feature-findinpage:160.0.1` | Find-in-page — **note the spelling: `feature-findinpage`, no hyphens** (`feature-find-in-page` returns 404) | MPL-2.0 |
| `org.mozilla.components:feature-readerview:160.0.1` | Reader view | MPL-2.0 |
| `org.mozilla.components:feature-sitepermissions:160.0.1` | Site permission prompts/storage | MPL-2.0 |
| `org.mozilla.components:feature-media:160.0.1` | Media session / media notifications | MPL-2.0 |
| `org.mozilla.components:feature-tab-collections:160.0.1` | Tab collections | MPL-2.0 |
| `org.mozilla.components:feature-awesomebar:160.0.1` | Awesomebar (address-bar suggestions) | MPL-2.0 |
| `org.mozilla.components:feature-top-sites:160.0.1` | Top sites | MPL-2.0 |
| `org.mozilla.components:feature-recentlyclosed:160.0.1` | Recently closed tabs | MPL-2.0 |
| `org.mozilla.components:feature-logins:160.0.1` | Logins / password storage hooks | MPL-2.0 |
| `org.mozilla.components:browser-menu:160.0.1` | Customizable browser menu | MPL-2.0 |
| `org.mozilla.components:browser-domains:160.0.1` | Localized/customizable domain lists for auto-completion | MPL-2.0 |
| `org.mozilla.components:browser-session-storage:160.0.1` | Saving/restoring browser state (not in the 2026-11-18 HTTP sweep, but a standard AC component at the same version — verify with a POM fetch before adding) | MPL-2.0 |
| `org.mozilla.components:ui-colors:160.0.1` | Shared colours | MPL-2.0 |
| `org.mozilla.components:ui-icons:160.0.1` | Shared browser icons | MPL-2.0 |
| `org.mozilla.components:ui-widgets:160.0.1` | Shared widgets | MPL-2.0 |

**Later / only if needed:**

| Artifact | What it is | License |
|---|---|---|
| `org.mozilla.components:feature-accounts:160.0.1` | Firefox Accounts integration | MPL-2.0 |
| `org.mozilla.components:feature-push:160.0.1` | Push notifications | MPL-2.0 |
| `org.mozilla.components:feature-serviceworker:160.0.1` | Service-worker feature | MPL-2.0 |
| `org.mozilla.components:feature-webcompat:160.0.1` | Web-compat interventions | MPL-2.0 |
| `org.mozilla.components:feature-webnotifications:160.0.1` | Web notifications | MPL-2.0 |
| `org.mozilla.components:concept-fetch:160.0.1` | Abstract HTTP client layer | MPL-2.0 |
| `org.mozilla.components:concept-storage:160.0.1` | Abstract storage layer | MPL-2.0 |
| `org.mozilla.components:service-glean:160.0.1` | Glean telemetry — **do not add without a decision; telemetry is off the table unless Yakob explicitly wants it** | MPL-2.0 |

In total **35 AC artifacts were verified at `160.0.1`** (HTTP 200 on their POMs) on 2026-11-18, including the ones in the tables above.

**What AC does NOT give you:** AC is a set of UI/engine building blocks, not a finished browser. There is no ready-made "Firefox UI" to drop in — the app must compose its own toolbar, tab UI, menu and settings from these components (which is exactly the "own Browser App + own Filtering Engine" decision). Mozilla's own reference consumer is Firefox for Android (Fenix), which is built from the same components.

---

## 4. Licenses

### 4.1 License table

| Component | License | Exact license text / declaration — primary source |
|---|---|---|
| GeckoView (`org.mozilla.geckoview:geckoview` and `:geckoview-omni`) | **MPL-2.0** (Mozilla Public License, v. 2.0) | POM of `160.0.20261116130455`: `<license><name>The Mozilla Public License, v. 2.0</name><url>http://mozilla.org/MPL/2.0/</url></license>` — `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.pom` |
| Android Components — every `org.mozilla.components:*` artifact | **MPL-2.0** | POM of `browser-engine-gecko:160.0.1` and `browser-state:160.0.1` (read directly 2026-11-18): `<license><name>MPL-2.0</name><url>https://www.mozilla.org/en-US/MPL/2.0/</url></license>` — e.g. `https://maven.mozilla.org/maven2/org/mozilla/components/browser-engine-gecko/160.0.1/browser-engine-gecko-160.0.1.pom` |
| Android Components — repo level | **MPL-2.0** | Each component README carries the MPL header: "This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/" — e.g. `https://github.com/mozilla-mobile/android-components/blob/main/components/browser/toolbar/README.md` and `.../components/support/base/README.md` |
| License text itself | MPL-2.0 | `https://www.mozilla.org/en-US/MPL/2.0/` (also `http://mozilla.org/MPL/2.0/`) |

### 4.2 Verification scope — read this before quoting the table

- **Directly read at the pinned versions:** the license blocks in the POMs of GeckoView `160.0.20261116130455`, AC `browser-engine-gecko:160.0.1`, and AC `browser-state:160.0.1`.
- **Spot-checked at older versions (same license, same publisher):** POMs of `support-images:96.0.1`, `ui-icons:101.0.1`, `support-utils:57.0.4`, `lib-publicsuffixlist:105.0.5` — all declare MPL-2.0.
- **Not individually opened:** the license block inside every one of the 35 POMs at `160.0.1` (their existence was verified, HTTP 200, but not each `<licenses>` block). AC publishes all components under the same license and the same repo; the risk of a single component differing is negligible, but a one-line script that greps `<name>MPL-2.0</name>` out of each POM at build time is cheap insurance before a production release.
- **Nothing here is GPL, LGPL, or Apache.** In particular this is the license reason Cromite (GPLv3) was rejected and GeckoView was chosen: MPL-2.0 is a **file-level (weak) copyleft** — see §4.3.

### 4.3 What MPL-2.0 means for this project (summary, not legal advice)

- The app may be **closed-source / commercial**: MPL-2.0 permits use in proprietary products. Only the MPL-licensed *files themselves* are copyleft — if you modify a GeckoView or AC source file, that modified file must stay MPL-2.0 and its source made available; your own app code, and new files you add, can be under any license.
- **Attribution/notices:** keep the MPL headers and license notices in the distributed code; include a copy of / link to the MPL-2.0 text and a notice that the product contains MPL-licensed Mozilla code.
- **Patent grant:** MPL-2.0 includes a patent license from contributors.
- **No "disclose your whole app" clause** (unlike GPLv3): using GeckoView/AC as libraries does not force the filter app's own code open.
- **Before commercial shipment:** get a proper license review of (a) the final dependency tree (transitive deps can carry other licenses), (b) any model/weights shipped in the app — the EfficientDet-Lite0 weights question is separate and still open per the 2026-11-18 decisions, and (c) the exact MPL notice text in the app's About screen. This research does not replace that review.

---

## 5. Pinning the versions in Gradle (Kotlin DSL)

The project skeleton already uses Kotlin DSL (`build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`). The snippet below fits that setup. It is a **template to paste and sync** — it was not applied to any build file by this research task.

### 5.1 Add Mozilla's Maven repository — `settings.gradle.kts`

Mozilla's artifacts are **not** on Maven Central; they live on Mozilla's own Maven host. Without this repository Gradle cannot resolve them.

```kotlin
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // Mozilla Maven — GeckoView + Android Components (NOT Maven Central).
        maven("https://maven.mozilla.org/maven2/")
    }
}
```

### 5.2 Version catalog — `gradle/libs.versions.toml`

One place for both versions, so a bump is a two-line change:

```toml
[versions]
geckoview = "160.0.20261116130455"
androidComponents = "160.0.1"

[libraries]
# GeckoView engine (stable). The -omni variant is the one Android
# Components' browser-engine-gecko is built against — pin it explicitly
# so a transitive bump cannot silently change the engine.
geckoview-omni = { group = "org.mozilla.geckoview", name = "geckoview-omni", version.ref = "geckoview" }

# Android Components — all share the single version androidComponents.
android-components-browser-state = { group = "org.mozilla.components", name = "browser-state", version.ref = "androidComponents" }
android-components-browser-engine-gecko = { group = "org.mozilla.components", name = "browser-engine-gecko", version.ref = "androidComponents" }
android-components-concept-engine = { group = "org.mozilla.components", name = "concept-engine", version.ref = "androidComponents" }
android-components-browser-toolbar = { group = "org.mozilla.components", name = "browser-toolbar", version.ref = "androidComponents" }
android-components-feature-tabs = { group = "org.mozilla.components", name = "feature-tabs", version.ref = "androidComponents" }
android-components-feature-session = { group = "org.mozilla.components", name = "feature-session", version.ref = "androidComponents" }
android-components-lib-state = { group = "org.mozilla.components", name = "lib-state", version.ref = "androidComponents" }
android-components-support-base = { group = "org.mozilla.components", name = "support-base", version.ref = "androidComponents" }
android-components-support-webextensions = { group = "org.mozilla.components", name = "support-webextensions", version.ref = "androidComponents" }
# Add more from §3.2 as the UI grows, same pattern, same version.ref.
```

### 5.3 Dependencies — `app/build.gradle.kts`

```kotlin
dependencies {
    // GeckoView engine (stable 160.0.1 train). Pinned explicitly even though
    // browser-engine-gecko would bring it transitively — the pin is the proof
    // that the engine and the components match.
    implementation(libs.geckoview.omni)

    // Android Components 160.0.1 — core browser UI set.
    implementation(libs.android.components.browser.state)
    implementation(libs.android.components.browser.engine.gecko)
    implementation(libs.android.components.concept.engine)
    implementation(libs.android.components.browser.toolbar)
    implementation(libs.android.components.feature.tabs)
    implementation(libs.android.components.feature.session)
    implementation(libs.android.components.lib.state)
    implementation(libs.android.components.support.base)
    implementation(libs.android.components.support.webextensions)
}
```

### 5.4 If the app uses GeckoView directly, without Android Components

```kotlin
dependencies {
    // Plain (non-omni) GeckoView, stable. Use this OR the -omni variant
    // via browser-engine-gecko above — never both.
    implementation("org.mozilla.geckoview:geckoview:160.0.20261116130455")
}
```

### 5.5 Rules for bumping later

1. Bump **both** versions together, as a pair proven by the new AC release's POM (§3.1): read the new AC `browser-engine-gecko` POM and take the `geckoview-omni` version it declares.
2. Never use a version with `b` (beta) or `a` (alpha) in it for a production build.
3. Never use a floating version (`160.+`, `latest.release`) — the pin is the point.
4. After a bump, run `./gradlew :app:dependencies --configuration releaseRuntimeClasspath` and confirm only one GeckoView version appears in the tree.

---

## 6. How to check for newer stable versions later

Run from any shell (no Gradle needed). These read Mozilla's own metadata, the same source this research used:

```bash
# --- GeckoView stable: the <latest>/<release> of the plain artifact IS the stable build ---
curl -s https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml \
  | grep -o '<latest>[^<]*</latest>'

# --- Android Components: <latest> is the newest published version, which is
#     usually a BETA. List all 16x versions and take the highest WITHOUT a 'b'/'a' suffix ---
curl -s https://maven.mozilla.org/maven2/org/mozilla/components/browser-state/maven-metadata.xml \
  | grep -o '<version>[^<]*</version>' \
  | grep -v '[ab][0-9]' \
  | sort -V | tail -5

# --- Confirm the pairing: the new AC browser-engine-gecko POM names its GeckoView ---
curl -s https://maven.mozilla.org/maven2/org/mozilla/components/browser-engine-gecko/<NEW_AC_VERSION>/browser-engine-gecko-<NEW_AC_VERSION>.pom \
  | grep -A2 'geckoview-omni'
```

Other places to watch:

- Firefox release calendar / releases: `https://wiki.mozilla.org/Release_Management/Calendar` and `https://wiki.mozilla.org/Releases` — a new Firefox major version means a new GeckoView major version the same week.
- GeckoView docs home: `https://geckoview.dev` and `https://firefox-source-docs.mozilla.org/mobile/android/geckoview/`.
- Mozilla security advisories (`https://www.mozilla.org/en-US/security/advisories/`) — when a new Firefox point release (e.g. 160.0.1) ships for security fixes, a matching GeckoView build ships with it; that is exactly how the 2026-11-16 build arose. Keeping the GeckoView dependency up to date is, per MozillaWiki, "the most effective way to incorporate security fixes".

---

## 7. WebExtensions in GeckoView — built-in / privileged extension support

This is the mechanism the filter's Visual Protection Engine will use inside the browser (content scripts + native bridge to the Kotlin app). Sources: Mozilla Firefox Source Docs, "Interacting with Web content and WebExtensions" (`https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/web-extensions.html`), and the `WebExtensionController` Javadoc (`https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/WebExtensionController.html`).

### 7.1 What exists

- **GeckoView supports WebExtensions** through `WebExtensionController` / `WebExtension`. Mozilla's docs call extensions "the preferred way to interact with Web content".
- **Bundled (built-in) extensions:** an extension can ship inside the APK under `/assets/`, addressed as `resource://android/assets/<folder>/`. It needs a `manifest.json` with an `id` and a `version`.
  ```java
  runtime.getWebExtensionController()
      .installBuiltIn("resource://android/assets/messaging/");
  // or, install only if not already installed (extensions persist across restarts):
  runtime.getWebExtensionController()
      .ensureBuiltIn("resource://android/assets/messaging/", "messaging@example.com");
  ```
- **Lifetime:** an installed extension **persists even when the app / `GeckoRuntime` is restarted**. Install once (or `ensureBuiltIn` at every start — installing repeatedly "could be slow").
- **Lifecycle API** (`WebExtensionController`): `install`, `installBuiltIn`, `ensureBuiltIn`, `uninstall`, `enable`, `disable`, `list`, `update`, `setAllowedInPrivateBrowsing`, `setTabActive`.
- **Native messaging (app ↔ extension):** `GeckoRuntime.sendNativeMessage` (one-off) and `connectNative` (port-based, two-way). The app receives messages via `WebExtension.MessageDelegate` (`extension.setMessageDelegate(delegate, "browser")`); content-script messages arrive via `SessionController.setMessageDelegate`. The `nativeApp` identifier is any string matching `[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*` (Mozilla's examples use `"browser"`); no desktop-style native-messaging host manifest file is needed in GeckoView.

### 7.2 The privileged part — why our filter extension qualifies

- The permissions `geckoViewAddons` and `nativeMessagingFromContent` are **"only available to privileged extensions such as built-in extensions"** and are **not documented on MDN** (Mozilla's own words in the docs page above).
- `nativeMessagingFromContent` is what lets a **content script** (running in the web page, in an isolated environment) call `runtime.sendNativeMessage` / `connectNative` to talk to the app. Without it, only the background script can message the app.
- Manifest example from Mozilla's docs (note: `manifest_version: 2` in their example — see §7.3):
  ```json
  {
    "manifest_version": 2,
    "name": "messaging",
    "version": "1.0",
    "browser_specific_settings": { "gecko": { "id": "messaging@example.com" } },
    "content_scripts": [{ "matches": ["*://*.twitter.com/*"], "js": ["messaging.js"] }],
    "permissions": ["nativeMessaging", "nativeMessagingFromContent", "geckoViewAddons"]
  }
  ```
- Mozilla's guidance: **do not set `nativeMessagingFromContent` unless content scripts really need to talk to the app directly**, to avoid unnecessary API exposure in web-content processes. Our scanner design (content script reporting what it sees / asking the native side for verdicts) is exactly the case where it is needed — but the prototype should still test the narrower design first (background-script-only messaging) and only add the content-script permission if the design requires it.

### 7.3 Limitations / differences vs desktop Firefox — verify at prototype time

- **No add-ons manager UI:** GeckoView has no built-in AMO store, no user-facing extension install/enable UI. The embedder (our app) must implement install/enable/disable itself through `WebExtensionController`. Users cannot install arbitrary extensions unless the app builds that flow.
- **Signing:** the `WebExtensionController` Javadoc states that extensions installed via `install()` "need to be signed by Mozilla, see Distributing your add-on". That signing requirement is stated for `install()`, **not** for `installBuiltIn()` — the built-in path is the documented way to ship our own extension in the APK. This distinction was **not** confirmed with a dedicated primary-source quote for `installBuiltIn` being signature-exempt; confirm it in the prototype (install the unsigned bundled extension on a debug build and check it loads).
- **Manifest version:** Mozilla's GeckoView docs example still shows `manifest_version: 2`. Whether MV3 is supported by GeckoView 160, and whether the privileged permissions behave the same under MV3, was **not verified from a primary source** in this research. Test MV2 first (the documented path); test MV3 explicitly before committing to it.
- **API surface is a subset:** GeckoView exposes the WebExtension APIs its embedders need plus `WebExtension.Action` (browser/page action icons and popups via `ActionDelegate`); it is not the full desktop-Firefox extension API set. Any API the filter needs (tabs, webRequest/webNavigation, content-script DOM access) must be checked against the GeckoView Javadoc for the pinned version, not assumed from desktop Firefox.
- **Extension process:** `WebExtensionController.enableExtensionProcessSpawning` exists in recent Javadoc; extension-process behaviour is managed by GeckoView and "we intentionally do not expose our process model to embedders" (GeckoView architecture docs).
- **The scanner must live inside GeckoView:** per the 2026-11-18 decision, the Playwright/Chromium scanner prototype does **not** prove what the Android browser sees. The visual check must be re-proven inside GeckoView via this built-in extension (content scripts + native bridge), separately for HTML images, CSS backgrounds, Canvas, SVG, WebGL, video frames, live streams and dynamic content; unreviewed visual content stays COVERED until decided.

### 7.4 Javadoc for the pinned version

- Stable-channel Javadoc is published per build; the live index is `https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/WebExtensionController.html` (mozilla-central = Nightly docs; the class/methods above are long-stable API, present since GV 73–78). For the exact 160 API, use the matching release Javadoc once the prototype starts, or read the API from the AAR's sources in Android Studio.

---

## 8. Sources (primary first)

1. Mozilla Maven — GeckoView stable metadata: `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml`
2. Mozilla Maven — GeckoView beta metadata: `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview-beta/maven-metadata.xml`
3. Mozilla Maven — GeckoView nightly metadata: `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview-nightly/maven-metadata.xml`
4. GeckoView 160 POM (license + SCM): `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.pom`
5. GeckoView 160 AAR: `https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/160.0.20261116130455/geckoview-160.0.20261116130455.aar`
6. Mozilla Maven — AC `browser-state` metadata: `https://maven.mozilla.org/maven2/org/mozilla/components/browser-state/maven-metadata.xml`
7. AC `browser-engine-gecko:160.0.1` POM (license + GeckoView pairing): `https://maven.mozilla.org/maven2/org/mozilla/components/browser-engine-gecko/160.0.1/browser-engine-gecko-160.0.1.pom`
8. AC `browser-state:160.0.1` POM (license): `https://maven.mozilla.org/maven2/org/mozilla/components/browser-state/160.0.1/browser-state-160.0.1.pom`
9. AC `browser-engine-gecko:160.0` POM (pairing, 160.0 train): `https://maven.mozilla.org/maven2/org/mozilla/components/browser-engine-gecko/160.0/browser-engine-gecko-160.0.pom`
10. MozillaWiki — GeckoView (channels, cadence, system requirements, Maven repo): `https://wiki.mozilla.org/Mobile/GeckoView`
11. MozillaWiki — Releases (Firefox 160.0 on 2026-11-10; 160.0.1 on 2026-11-16): `https://wiki.mozilla.org/Releases`
12. Firefox Source Docs — WebExtensions in GeckoView: `https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/web-extensions.html`
13. Firefox Source Docs — GeckoView architecture: `https://firefox-source-docs.mozilla.org/mobile/android/geckoview/contributor/geckoview-architecture.html`
14. GeckoView Javadoc — `WebExtensionController`: `https://mozilla.github.io/geckoview/javadoc/mozilla-central/org/mozilla/geckoview/WebExtensionController.html`
15. MPL-2.0 text: `https://www.mozilla.org/en-US/MPL/2.0/`
16. Android Components repo (READMEs carry the MPL header): `https://github.com/mozilla-mobile/android-components`
17. mvnrepository (secondary, used only for cross-checking publication dates): `https://mvnrepository.com/artifact/org.mozilla.geckoview/geckoview` and `https://mvnrepository.com/artifact/org.mozilla.components/browser-engine-gecko/160.0b2`

## 9. Open items / caveats (do not lose these)

1. **AC `160.0.1` publication date is inferred, not directly dated** (§3.1). The pairing is hard fact; the date is not.
2. **License blocks were read directly for 3 POMs at the pinned versions** (GeckoView 160, AC `browser-engine-gecko` + `browser-state` at 160.0.1); the other 32 components were verified to exist at 160.0.1, not each license block. Grep all POMs for `MPL-2.0` before a production release.
3. **`compileSdk`/`targetSdk` for GeckoView 160 not verified** — skeleton is at 34; confirm at first Gradle sync.
4. **Built-in extension signing exemption and MV3 support not confirmed from a primary source** — test in the prototype: unsigned bundled extension via `installBuiltIn`, then MV3 if wanted.
5. **Firefox 161 stable expected ~2026-11-20** is from a secondary calendar site only. When it lands, re-run §6 and bump the pair (AC `161.0.x` + its declared `geckoview-omni`).
6. **Transitive licenses:** the final Gradle dependency tree (Kotlin stdlib, AndroidX, Play services FIDO, etc.) must be license-checked before commercial shipment; this research covers only Mozilla's own artifacts.
