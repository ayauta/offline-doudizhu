#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:?Usage: scripts/inspect-android-apk.sh APK PACKAGE VERSION}"
expected_package="${2:?Usage: scripts/inspect-android-apk.sh APK PACKAGE VERSION}"
expected_version="${3:?Usage: scripts/inspect-android-apk.sh APK PACKAGE VERSION}"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"

if [[ ! -f "$apk_path" ]]; then
  echo "APK not found: $apk_path" >&2
  exit 1
fi
if [[ -z "$sdk_root" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME is required." >&2
  exit 1
fi

aapt2_path="$(find "$sdk_root/build-tools" -mindepth 2 -maxdepth 2 -type f -name aapt2 -print | sort -V | tail -n 1)"
apksigner_path="$(find "$sdk_root/build-tools" -mindepth 2 -maxdepth 2 -type f -name apksigner -print | sort -V | tail -n 1)"
if [[ -z "$aapt2_path" || -z "$apksigner_path" ]]; then
  echo "Android Build Tools with aapt2 and apksigner are required." >&2
  exit 1
fi

badging="$($aapt2_path dump badging "$apk_path")"
grep -Fq "package: name='$expected_package'" <<<"$badging"
grep -Fq "versionName='$expected_version'" <<<"$badging"
grep -Fq "minSdkVersion:'29'" <<<"$badging"
grep -Fq "targetSdkVersion:'36'" <<<"$badging"
if grep -Fq "uses-permission:" <<<"$badging"; then
  echo "APK unexpectedly requests Android permissions." >&2
  exit 1
fi

unzip -Z1 "$apk_path" | grep -Fxq "assets/embedded.html"
"$apksigner_path" verify --verbose --print-certs "$apk_path"
echo "APK inspection passed for $expected_package $expected_version (zero permissions; embedded entry; valid signature)."
