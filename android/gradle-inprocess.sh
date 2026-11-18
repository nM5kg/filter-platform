#!/bin/bash
# Runs Gradle IN-PROCESS (no daemon) because this sandbox blocks raw TCP
# loopback connections, which the Gradle daemon protocol needs.
# The launcher JVM args must match org.gradle.jvmargs in gradle.properties
# exactly (plus the instrumentation agent) or Gradle forks a daemon.
set -e
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
exec "$JAVA_HOME/bin/java" \
  -javaagent:"$HOME/gradle-8.5/lib/agents/gradle-instrumentation-agent-8.5.jar" \
  -XX:MaxMetaspaceSize=512m \
  --add-opens=java.base/java.util=ALL-UNNAMED \
  --add-opens=java.base/java.lang=ALL-UNNAMED \
  --add-opens=java.base/java.lang.invoke=ALL-UNNAMED \
  --add-opens=java.prefs/java.util.prefs=ALL-UNNAMED \
  --add-opens=java.base/java.nio.charset=ALL-UNNAMED \
  --add-opens=java.base/java.net=ALL-UNNAMED \
  --add-opens=java.base/java.util.concurrent.atomic=ALL-UNNAMED \
  -Xmx1024m -Dfile.encoding=US-ASCII -Duser.country=US -Duser.language=en -Duser.variant \
  -cp "$HOME/gradle-8.5/lib/gradle-launcher-8.5.jar" \
  org.gradle.launcher.GradleMain "$@" --no-daemon
