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

android_api="$(adb -e shell getprop ro.build.version.sdk | tr -d '\r')"
if [[ "$android_api" -ge 33 ]]; then
  adb -e shell cmd overlay enable-exclusive --category \
    com.android.internal.systemui.navbar.gestural
fi
adb -e shell input keyevent KEYCODE_WAKEUP
adb -e shell wm dismiss-keyguard

(
  cd android
  ./gradlew connectedDebugAndroidTest --no-daemon
)
scripts/android-emulator-smoke.sh "$apk_path" "$package_id"
