#!/bin/bash
# Manual debug-APK build for the Filter Platform Android app.
#
# WHY THIS EXISTS: this VM's sandbox blocks ALL TCP connections made by JVM
# processes (proven byte-for-byte: identical CONNECT requests succeed from
# curl/python/C/Node and are intercepted for any java binary, any path,
# any argv[0]). That breaks Gradle two ways: the daemon protocol (loopback
# TCP) and all dependency downloads. See android/README.md for the full
# evidence. Until the "Direct network protocols / other_tcp" permission is
# enabled in Muse settings, Gradle cannot run here at all.
#
# This script builds the SAME sources with the SAME SDK tools Gradle would
# use (aapt2, d8, zipalign, apksigner from build-tools 34.0.0, kotlinc
# 1.9.23), with every dependency downloaded by curl (which works).
# It proves the Kotlin sources compile, the resources link, and the APK
# packages and signs. It does NOT replace ./gradlew assembleDebug — on any
# normal machine (or this VM once the permission is on) run that instead.
#
# Usage: ./build.sh   (from android/manual-build/)
# Output: out/app-debug.apk (signed with a generated debug key, NOT a release key)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
OUT="$ROOT/manual-build/out"
LIBS="$ROOT/manual-build/libs"
SDK="${ANDROID_HOME:-$HOME/Android/sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}"
KOTLINC="${KOTLINC:-$HOME/downloads/kotlin/kotlinc/bin/kotlinc}"
AAPT2="$SDK/build-tools/34.0.0/aapt2"
D8="$SDK/build-tools/34.0.0/d8"
ZIPALIGN="$SDK/build-tools/34.0.0/zipalign"
APKSIGNER="$SDK/build-tools/34.0.0/apksigner"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"

export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$OUT/generated" "$OUT/classes" "$OUT/dex"

CP_LIBS="$LIBS/extracted/security-crypto/classes.jar:$LIBS/annotation-1.1.0.jar:$LIBS/collection-1.1.0.jar:$LIBS/tink-android-1.8.0.jar:$LIBS/gson-2.8.9.jar"

echo "== 1. aapt2 compile resources =="
"$AAPT2" compile -o "$OUT/compiled-res.zip" \
  "$APP/src/main/res/layout/activity_main.xml" \
  "$APP/src/main/res/values/strings.xml"

echo "== 2. aapt2 link (manifest + resources, generates R.java) =="
"$AAPT2" link -o "$OUT/app-unaligned.apk" \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  -R "$OUT/compiled-res.zip" \
  --java "$OUT/generated" \
  --auto-add-overlay \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code 1 --version-name 0.1.0

echo "== 3. kotlinc (app sources + generated R.java) =="
find "$APP/src/main/java" -name '*.kt' > "$OUT/sources.txt"
"$KOTLINC" -d "$OUT/app-classes.jar" \
  -cp "$ANDROID_JAR:$CP_LIBS" \
  -jvm-target 17 \
  @"$OUT/sources.txt" \
  "$OUT/generated/com/filterplatform/app/R.java"

echo "== 4. d8 dex (app + library classes, min-api 26) =="
"$D8" --lib "$ANDROID_JAR" \
  --min-api 26 \
  --output "$OUT/dex" \
  "$OUT/app-classes.jar" \
  "$LIBS/extracted/security-crypto/classes.jar" \
  "$LIBS/annotation-1.1.0.jar" \
  "$LIBS/collection-1.1.0.jar" \
  "$LIBS/tink-android-1.8.0.jar" \
  "$LIBS/gson-2.8.9.jar"

echo "== 5. add classes.dex to the APK =="
cp "$OUT/app-unaligned.apk" "$OUT/app-debug.apk"
python3 - "$OUT/app-debug.apk" "$OUT/dex/classes.dex" <<'EOF'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('added classes.dex')
EOF

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

echo "== 7. verify =="
"$APKSIGNER" verify --verbose "$OUT/app-debug.apk"
"$AAPT2" dump badging "$OUT/app-debug.apk" | head -8
ls -la "$OUT/app-debug.apk"
echo "BUILD OK: $OUT/app-debug.apk"
