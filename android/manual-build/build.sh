#!/bin/bash
# Manual debug-APK build for the Filter Platform Android app (with GeckoView).
#
# WHY THIS EXISTS: this VM's sandbox intercepts ALL TCP data from JVM
# processes (proven byte-for-byte 2026-11-18: a Java Socket connect()
# succeeds, but the first bytes read back are the 193-byte interceptor
# message "muse: Other TCP connections is turned off..."; the same bytes
# from curl/python/C reach the real host — verified again 2026-11-18
# ~13:30 EST for direct, egress-proxy and 127.0.0.1-relay connections).
# That breaks Gradle three ways:
#   1. daemon mode: "Could not receive a message from the daemon"
#      (loopback JVM<->JVM data is intercepted too — the client reads
#      type tag 109, i.e. 'm' for "muse: ...", from the daemon socket);
#   2. --no-daemon: still forks a single-use daemon -> same error;
#   3. in-process (gradle-inprocess.sh): runs, but plugin/dependency
#      downloads fail ("Plugin com.android.application 8.3.2 was not found").
# The installed Gradle 8.5 binary itself runs fine (gradle --version:
# Gradle 8.5 / JVM 17.0.21); only the wrapper's distribution download
# fails on the same interception — use the installed binary, never
# ./gradlew. There is NO egress CA to import: the current egress proxy
# does plain CONNECT tunneling (openssl shows a normal Let's Encrypt
# chain), and the failure happens before TLS anyway — the JVM never
# receives TLS bytes. A second, independent Gradle blocker: GeckoView
# 160's AAR declares minCompileSdk=37, but SDK platform 37 does not
# exist for download (dl.google.com repository2-1.xml lists at most
# platform-36; platform-37 zip is a 404, checked 2026-11-18). So even
# with working JVM networking, ./gradlew assembleDebug could not build
# this module until Google publishes platform 37 (or the GeckoView pin
# changes). Do NOT tell anyone to enable an "other_tcp" setting: no such
# setting exists anywhere. See android/GECKOVIEW-PROTOTYPE.md for the
# exact errors.
#
# This script builds the SAME sources with the SAME SDK tools Gradle would
# use (aapt2, zipalign, apksigner from build-tools 34.0.0; d8 from
# build-tools 36.0.0 — the 34.0.0 d8 crashes on androidx.collection 1.7.0,
# see below; kotlinc 2.4.21), with every dependency downloaded by curl
# (which works) via manual-build/fetch-deps.py. It proves the Kotlin sources compile, the
# resources link, the GeckoView native libraries package, and the APK signs.
# It does NOT replace ./gradlew assembleDebug — on any normal machine run
# that instead (with the installed Gradle binary if the wrapper's TLS
# download fails there too), once SDK platform 37 exists to download:
# until then a Gradle build of this module fails everywhere, not just here.
#
# Usage: ./build.sh [arm64-v8a]   (from android/manual-build/)
#   GV_ABIS="arm64-v8a armeabi-v7a x86_64" ./build.sh   (all ABIs; ~520 MB APK)
# Output: out/app-debug.apk (signed with a generated debug key, NOT a release key)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
OUT="$ROOT/manual-build/out"
LIBS="$ROOT/manual-build/libs"
SDK="${ANDROID_HOME:-$HOME/Android/sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}"
KOTLINC="${KOTLINC:-$HOME/downloads/kotlin-2.4.21/kotlinc/bin/kotlinc}"
if [ ! -x "$KOTLINC" ]; then
  # Fall back to the 1.9.23 compiler the skeleton used (stdlib mismatch is
  # only a warning for the code here; GeckoView was built against 2.4.21).
  KOTLINC="${KOTLINC:-$HOME/downloads/kotlin/kotlinc/bin/kotlinc}"
fi
AAPT2="$SDK/build-tools/34.0.0/aapt2"
# d8 MUST come from build-tools 36.0.0 (R8 8.10.9): the 34.0.0 d8 (8.2.2)
# crashes with an internal NPE on androidx.collection 1.7.0
# (ArrayMap$EntrySet.class — jspecify type-use annotations it cannot read),
# while 8.10.9 dexes it cleanly. Verified 2026-11-18.
D8="$SDK/build-tools/36.0.0/d8"
ZIPALIGN="$SDK/build-tools/34.0.0/zipalign"
APKSIGNER="$SDK/build-tools/34.0.0/apksigner"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
# GeckoView ABIs to package. Default arm64-v8a only: it covers ~all modern
# phones (incl. the user's BLU B1680V, arm64-v8a) and keeps the APK ~190 MB
# instead of ~360 MB (arm64+armeabi) or ~520 MB (all three).
GV_ABIS="${GV_ABIS:-arm64-v8a}"
GV_VERSION="160.0.20261116130455"

export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$OUT/generated" "$OUT/classes" "$OUT/dex" "$OUT/assets-staging"

# --- 0. dependencies (curl, via fetch-deps.py) ------------------------------
if [ ! -f "$LIBS/geckoview-$GV_VERSION.aar" ]; then
  echo "== 0. downloading GeckoView + dependencies (curl) =="
  python3 "$ROOT/manual-build/fetch-deps.py"
fi

# --- 0b. classpath: every library jar, minus jars superseded by a newer
# version of the same artifact (what Gradle's highest-wins resolution
# would do). The skeleton's annotation 1.1.0 / collection 1.1.0 duplicate
# 59 / 8 classes of the GeckoView closure's annotation-jvm 1.11.0 /
# collection-jvm 1.7.0 — d8 fails on duplicate classes ("Program type
# already present"). The KMP root jars (annotation-1.11.0 etc.) contain no
# classes that clash with their -jvm variants (verified by scanning all
# jars for duplicate .class entries), so they stay.
SUPERSEDED="annotation-1.1.0.jar collection-1.1.0.jar"
CP_JARS=""
for jar in "$LIBS"/geckoview/*.jar "$LIBS"/*.jar; do
  base="$(basename "$jar")"
  case " $SUPERSEDED " in *" $base "*) echo "  skip superseded: $base"; continue;; esac
  CP_JARS="$CP_JARS:$jar"
done
for d in "$LIBS"/extracted/*/classes.jar; do CP_JARS="$CP_JARS:$d"; done
CP_JARS="${CP_JARS#:}"
echo "classpath jars: $(echo "$CP_JARS" | tr ':' '\n' | wc -l)"

# --- 0c. merged manifest (reproduces Gradle's manifest merger) -------------
echo "== 0c. merge library manifests =="
python3 "$ROOT/manual-build/merge_manifest.py" \
  "$APP/src/main/AndroidManifest.xml" \
  "$OUT/merged-AndroidManifest.xml" \
  "$LIBS/extracted"

# --- 0d. stage assets: app assets + GeckoView's omni.ja --------------------
rm -rf "$OUT/assets-staging" && mkdir -p "$OUT/assets-staging"
cp -r "$APP/src/main/assets/"* "$OUT/assets-staging/"
python3 - "$LIBS/geckoview-$GV_VERSION.aar" "$OUT/assets-staging" <<'EOF'
import sys, zipfile, os
aar, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(aar) as z:
    # NOTE (0.1.1 fix): zipfile.extract('assets/omni.ja', dest) creates
    # dest/assets/omni.ja -> APK asset "assets/assets/omni.ja", which
    # GeckoView never finds (it reads assets/omni.ja). 0.1.0 shipped it
    # nested, so GeckoRuntime.create() could not find omni.ja and the
    # browser crashed. Write the bytes FLAT into dest/omni.ja instead.
    data = z.read('assets/omni.ja')
    with open(os.path.join(dest, 'omni.ja'), 'wb') as f:
        f.write(data)
print('staged omni.ja at assets root (%d bytes)' % len(data))
EOF

# --- 1. aapt2 compile resources (app + every AAR that ships res/) -----------
echo "== 1. aapt2 compile resources =="
rm -f "$OUT/compiled-res.zip" "$OUT"/compiled-lib-*.zip
"$AAPT2" compile -o "$OUT/compiled-res.zip" \
  "$APP/src/main/res/layout/activity_main.xml" \
  "$APP/src/main/res/layout/activity_browser.xml" \
  "$APP/src/main/res/values/strings.xml"
EXTRA_PACKAGES=""
i=0
for resdir in "$LIBS"/extracted/*/res; do
  [ -d "$resdir" ] || continue
  pkg="$(python3 - "$resdir" <<'EOF'
import sys, os, xml.etree.ElementTree as ET
resdir = sys.argv[1]
aar_dir = os.path.dirname(resdir)
man = os.path.join(aar_dir, 'AndroidManifest.xml')
try:
    print(ET.parse(man).getroot().get('package'))
except Exception:
    print('')
EOF
)"
  # Only AARs whose manifest has a real package get an R class.
  if [ -n "$pkg" ]; then
    i=$((i+1))
    "$AAPT2" compile -o "$OUT/compiled-lib-$i.zip" "$resdir"/*/* 2>/dev/null || \
      "$AAPT2" compile -o "$OUT/compiled-lib-$i.zip" --dir "$resdir"
    EXTRA_PACKAGES="$EXTRA_PACKAGES --extra-packages $pkg"
  fi
done
echo "library resource zips: $i"

# --- 2. aapt2 link ------------------------------------------------------------
echo "== 2. aapt2 link (merged manifest + resources, generates R.java) =="
LINK_R_ARGS=()
for f in "$OUT"/compiled-lib-*.zip; do [ -f "$f" ] && LINK_R_ARGS+=(-R "$f"); done
# App resources last: with --auto-add-overlay, later -R files win a name
# conflict, and the app must win over libraries.
LINK_R_ARGS+=(-R "$OUT/compiled-res.zip")
# shellcheck disable=SC2086
"$AAPT2" link -o "$OUT/app-unaligned.apk" \
  --manifest "$OUT/merged-AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  "${LINK_R_ARGS[@]}" \
  --java "$OUT/generated" \
  $EXTRA_PACKAGES \
  -A "$OUT/assets-staging" \
  --auto-add-overlay \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code 5 --version-name 0.2.0

# --- 3. kotlinc ---------------------------------------------------------------
echo "== 3. kotlinc (app sources + generated R.java) =="
find "$APP/src/main/java" -name '*.kt' > "$OUT/sources.txt"
find "$OUT/generated" -name 'R.java' >> "$OUT/sources.txt"
"$KOTLINC" -d "$OUT/app-classes.jar" \
  -cp "$ANDROID_JAR:$CP_JARS" \
  -jvm-target 17 \
  @"$OUT/sources.txt"

# --- 4. d8 dex (app + all library classes, min-api 26, multi-dex) ------------
echo "== 4. d8 dex (app + library classes, min-api 26) =="
rm -rf "$OUT/dex" && mkdir -p "$OUT/dex"
D8_INPUTS=("$OUT/app-classes.jar")
for jar in $(echo "$CP_JARS" | tr ':' ' '); do D8_INPUTS+=("$jar"); done
"$D8" --lib "$ANDROID_JAR" \
  --min-api 26 \
  --output "$OUT/dex" \
  "${D8_INPUTS[@]}"
ls "$OUT/dex"

# --- 5. add dex + GeckoView native libs to the APK ----------------------------
echo "== 5. add dex + GeckoView .so libs ($GV_ABIS) to the APK =="
cp "$OUT/app-unaligned.apk" "$OUT/app-debug.apk"
GV_AAR="$LIBS/geckoview-$GV_VERSION.aar"
python3 - "$OUT/app-debug.apk" "$OUT/dex" "$GV_AAR" "$GV_ABIS" <<'EOF'
import sys, zipfile, os
apk, dexdir, aar, abis = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split()
dexes = sorted(f for f in os.listdir(dexdir) if f.endswith('.dex'))
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    for d in dexes:
        z.write(os.path.join(dexdir, d), d)
        print('added', d)
with zipfile.ZipFile(aar) as g:
    for abi in abis:
        for name in sorted(n for n in g.namelist() if n.startswith(f'jni/{abi}/')):
            so = name.split('/')[-1]
            dest = f'lib/{abi}/{so}'
            data = g.read(name)
            with zipfile.ZipFile(apk, 'a', zipfile.ZIP_STORED) as z:
                z.writestr(dest, data, compress_type=zipfile.ZIP_STORED)
            print(f'added {dest} ({len(data)} bytes, stored)')
EOF

# --- 6. zipalign + sign (generated debug key) ---------------------------------
echo "== 6. zipalign + sign (generated debug key) =="
KEYSTORE="$OUT/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" -alias debug \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android \
    -dname "CN=Filter Platform Debug, OU=Dev, O=Filter Platform" -noprompt
fi
"$ZIPALIGN" -f -p 4 "$OUT/app-debug.apk" "$OUT/app-debug-aligned.apk"
mv "$OUT/app-debug-aligned.apk" "$OUT/app-debug.apk"
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:android \
  --key-pass pass:android --ks-key-alias debug \
  --out "$OUT/app-debug-signed.apk" "$OUT/app-debug.apk"
mv "$OUT/app-debug-signed.apk" "$OUT/app-debug.apk"

# --- 7. verify ------------------------------------------------------------------
echo "== 7. verify =="
"$APKSIGNER" verify --verbose "$OUT/app-debug.apk"
"$AAPT2" dump badging "$OUT/app-debug.apk" | head -12
ls -la "$OUT/app-debug.apk"
echo "BUILD OK: $OUT/app-debug.apk"
