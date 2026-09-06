#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:?Usage: scripts/android-emulator-smoke.sh APK PACKAGE}"
package_id="${2:?Usage: scripts/android-emulator-smoke.sh APK PACKAGE}"

node scripts/android-emulator-smoke.mjs "$apk_path" "$package_id"
