#!/bin/bash
# Unit tests for the Filter Platform Android app — without Gradle.
#
# WHY: Gradle cannot complete a build on this VM (verified 2026-11-18):
# the sandbox still intercepts ALL TCP data from JVM processes (a Java
# Socket to repo1.maven.org:443 or to the 127.0.0.1 egress relay receives
# the 193-byte "muse: Other TCP connections is turned off..." interceptor
# message; curl/Python get the real reply), so the daemon loopback socket
# fails and every dependency download fails. The installed Gradle 8.5
# binary itself runs (gradle --version works); the wrapper's distribution
# download fails on the same interception — use the installed binary,
# never ./gradlew. See manual-build/build.sh header and
# android/GECKOVIEW-PROTOTYPE.md for the exact errors.
# The tests are pure JVM code (JsonParsing, FilterEngine — no Android
# framework, no GeckoView runtime), so kotlinc + JUnitCore run them
# directly. The full-app compile (all sources incl. BrowserActivity) is
# covered by manual-build/build.sh step 3.
# On a normal machine these same tests run via the installed Gradle 8.5
# binary (~/gradle-8.5/bin/gradle testDebugUnitTest), not ./gradlew.
#
# Usage: ./run-tests.sh   (from android/manual-build/)
# Uses the real org.json implementation (libs/json-20240303.jar) because
# android.jar's org.json classes are stubs that throw at runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
LIBS="$ROOT/manual-build/libs"
OUT="$ROOT/manual-build/out"
JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}"
KOTLINC="${KOTLINC:-$HOME/downloads/kotlin-2.4.21/kotlinc/bin/kotlinc}"
[ -x "$KOTLINC" ] || KOTLINC="$HOME/downloads/kotlin/kotlinc/bin/kotlinc"

export PATH="$JAVA_HOME/bin:$PATH"
mkdir -p "$OUT/test-classes"
# kotlinc does not bundle the stdlib (no -include-runtime), so it must be
# on both the compile and the runtime classpath. Use the same 2.4.21 the
# app ships (GeckoView was built against it).
STDLIB="$LIBS/geckoview/kotlin-stdlib-2.4.21.jar"
[ -f "$STDLIB" ] || STDLIB="$(dirname "$KOTLINC")/../lib/kotlin-stdlib.jar"

echo "== compile tests (kotlinc) =="
"$KOTLINC" -d "$OUT/test-classes" \
  -cp "$STDLIB:$LIBS/json-20240303.jar:$LIBS/junit-4.13.2.jar:$LIBS/hamcrest-core-1.3.jar" \
  -jvm-target 17 \
  "$APP/src/main/java/com/filterplatform/app/ApiClient.kt" \
  "$APP/src/main/java/com/filterplatform/app/FilterEngine.kt" \
  "$APP/src/test/java/com/filterplatform/app/ApiClientTest.kt" \
  "$APP/src/test/java/com/filterplatform/app/FilterEngineTest.kt"

echo "== run tests (JUnitCore) =="
java -cp "$OUT/test-classes:$STDLIB:$LIBS/json-20240303.jar:$LIBS/junit-4.13.2.jar:$LIBS/hamcrest-core-1.3.jar" \
  org.junit.runner.JUnitCore \
  com.filterplatform.app.ApiClientTest \
  com.filterplatform.app.FilterEngineTest
