#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:?Usage: scripts/android-ci-test.sh APK PACKAGE}"
package_id="${2:?Usage: scripts/android-ci-test.sh APK PACKAGE}"
artifact_dir="${ANDROID_TEST_ARTIFACT_DIR:-test-results/android}"

mkdir -p "$artifact_dir"

collect_evidence() {
  adb -e logcat -d >"$artifact_dir/logcat.txt" 2>&1 || true
  adb -e exec-out screencap -p >"$artifact_dir/final-screen.png" 2>/dev/null || true
}

trap collect_evidence EXIT

(
  cd android
  ./gradlew connectedDebugAndroidTest --no-daemon
)
scripts/android-emulator-smoke.sh "$apk_path" "$package_id"
