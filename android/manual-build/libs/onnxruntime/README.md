# onnxruntime-android 1.32.0 (ONNX Runtime for the RF-DETR Nano person detector)
#
# What: com.microsoft.onnxruntime:onnxruntime-android:1.32.0, MIT license.
#   AAR minSdk 24 (app minSdk is 26), minCompileSdk 1 (no Gradle blocker
#   like GeckoView's minCompileSdk=37). Latest release at fetch time
#   (2026-11-19, per Maven Central metadata: latest/release 1.32.0).
#   Chosen deliberately: latest stable, matches the onnxruntime 1.32.0
#   used for the CPU benchmark (scanner/models/RF-DETR-BENCHMARK.md),
#   and no concrete reason was found to pin an older version.
#
# Files:
#   onnxruntime-android-1.32.0.aar  (59,335,382 bytes, sha256 below)
#   -> libs/extracted/onnxruntime-android/classes.jar  (classpath + dex)
#   -> libs/extracted/onnxruntime-android/AndroidManifest.xml
#      (merged by merge_manifest.py: adds INTERNET / ACCESS_NETWORK_STATE
#       permissions and the ai.onnxruntime.TelemetryInitializer provider;
#       ${applicationId} is substituted by the merger)
#   -> the arm64-v8a .so files (libonnxruntime.so + libonnxruntime4j_jni.so)
#      are added to the APK by manual-build/build.sh step 5, stored
#      uncompressed, arm64-v8a only (same pattern as the GeckoView .so).
#
# Reproduce (exact command; also what fetch-deps.py --onnxruntime-only does):
#   curl -sL -o onnxruntime-android-1.32.0.aar \
#     https://repo.maven.apache.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/1.32.0/onnxruntime-android-1.32.0.aar
#   sha256sum onnxruntime-android-1.32.0.aar   # must be:
#   8e8dbb412ed4939675a157702f0c1e3621b436a645af7f7244536ac20bfad628
#   unzip -o -q onnxruntime-android-1.32.0.aar classes.jar AndroidManifest.xml \
#     -d ../extracted/onnxruntime-android/
#
# Gradle equivalent (for a normal machine, once SDK 37 exists):
#   implementation("com.microsoft.onnxruntime:onnxruntime-android:1.32.0")
#   (also in app/build.gradle.kts)
