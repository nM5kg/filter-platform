plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.filterplatform.app"
    // GeckoView 160's AAR declares minCompileSdk=37 (see its
    // META-INF/com/android/build/gradle/aar-metadata.properties), so a
    // Gradle build needs compileSdk 37 — but SDK platform 37 cannot be
    // downloaded: dl.google.com has no platform-37 package (repository2-1.xml
    // lists at most platform-36, checked 2026-11-18; platform-37 zip is a
    // 404). Gradle also cannot run a build on this VM at all: the sandbox
    // still intercepts ALL TCP data from JVM processes (proven byte-for-byte
    // 2026-11-18 — a Java Socket to repo1.maven.org:443 or to the 127.0.0.1
    // egress relay receives the 193-byte "muse: Other TCP connections is
    // turned off..." interceptor message; curl/Python get the real reply),
    // so the daemon loopback socket fails ("Unexpected type tag 109") and
    // every dependency download fails. The installed Gradle 8.5 binary
    // itself runs fine (gradle --version: Gradle 8.5 / JVM 17.0.21); only
    // the wrapper's distribution download fails on the same interception,
    // so use the installed binary, never ./gradlew. See README and
    // GECKOVIEW-PROTOTYPE.md for the exact errors.
    // The manual build (manual-build/build.sh) compiles against the
    // android.jar 34 already on this VM instead; see GECKOVIEW-PROTOTYPE.md.
    compileSdk = 37

    defaultConfig {
        applicationId = "com.filterplatform.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // Encrypted storage for the API token (user-entered at setup).
    // Deliberately no AppCompat/Material dependency: the skeleton uses the
    // framework Activity + Material theme, so the only library is
    // security-crypto (plus its Tink dependency, classes only, no resources).
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // GeckoView — the browser engine (Yakob's decision 2026-11-18: STABLE
    // release channel, NOT Nightly; own browser app + own filter engine).
    // Pinned version verified 2026-11-18 from Mozilla Maven metadata:
    // https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/maven-metadata.xml
    // (release 160.0.20261116130455; beta 161.x, nightly 162.x; Firefox 160
    // released 2026-11-10; POM scm = hg.mozilla.org/releases/mozilla-release).
    // License: MPL-2.0. See android/GECKOVIEW-PROTOTYPE.md.
    implementation("org.mozilla.geckoview:geckoview:160.0.20261116130455")

    testImplementation("junit:junit:4.13.2")
}
