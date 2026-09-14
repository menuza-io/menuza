#!/usr/bin/env bash
# Builds, installs, and launches the debug app on the connected emulator/device.
#
#   npm run android:run -w android
#
# Extra arguments are passed to Gradle, which is how a physical device picks the
# `adb reverse` endpoints:
#
#   adb reverse tcp:3001 tcp:3001 && adb reverse tcp:3007 tcp:3007
#   npm run android:run -w android -- -PdevHost=localhost
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

# ---------------------------------------------------------------- find adb --
# shellcheck source=scripts/android-sdk.sh
source "$APP_ROOT/scripts/android-sdk.sh"
export_android_sdk || true

adb_bin="$(command -v adb || true)"
if [ -z "$adb_bin" ] && [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -x "$ANDROID_SDK_ROOT/platform-tools/adb" ]; then
	adb_bin="$ANDROID_SDK_ROOT/platform-tools/adb"
fi
if [ -z "$adb_bin" ]; then
	echo "✖ adb not found. Install the Android platform tools (they come with Android Studio)." >&2
	exit 1
fi

# ------------------------------------------------------------ device check --
devices="$("$adb_bin" devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
if [ -z "$devices" ]; then
	cat >&2 <<'MSG'
✖ No emulator or device is connected.

  Emulator (Android Studio): Device Manager → ▶
  Emulator (CLI):
      emulator -list-avds
      emulator -avd <name> &
  Physical device: enable USB debugging, plug it in, then `adb devices`
MSG
	exit 1
fi

device="$(printf '%s\n' "$devices" | head -1)"
count="$(printf '%s\n' "$devices" | wc -l | tr -d ' ')"
if [ "$count" -gt 1 ]; then
	echo "• $count devices connected; using $device"
fi

# ------------------------------------------------------- install + launch --
bash scripts/gradle.sh installDebug "$@"

package="$(sed -n 's/^applicationId=//p' app/tenant.properties 2>/dev/null | head -1)"
package="${package:-com.epicstartup.tenant}"
activity="$package/com.epicstartup.tenant.ui.MainActivity"

"$adb_bin" -s "$device" shell am start -n "$activity" >/dev/null

cat <<MSG

✓ Installed and launched $package on $device

  In the app: type your organization's slug (App → Website → the slug in the URL)
  and press Connect. The verification code is printed by the dev server:

      tenant-api:dev: [SMS MOCK] To: +1... | Message: Your verification code is: 123456

  App logs:  $adb_bin -s $device logcat --pid=\$($adb_bin -s $device shell pidof -s $package)
MSG
