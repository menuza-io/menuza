#!/usr/bin/env bash
# Runs Gradle with the Android SDK and JDK this machine actually has.
#
#   npm run android:build -w android          # debug APK
#   npm run android:test -w android           # unit tests
#   npm run android:bundle -w android         # release AAB
#
# SDK discovery order: ANDROID_HOME / ANDROID_SDK_ROOT, `local.properties`, then
# the usual install locations (Android Studio, this repo's orb setup).
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_ROOT"

if ! command -v java >/dev/null 2>&1 && [ -z "${JAVA_HOME:-}" ]; then
	cat >&2 <<'MSG'
✖ No JDK found. Install JDK 17+ and/or set JAVA_HOME, for example:
    macOS:   brew install --cask temurin@17
    Debian:  sudo apt-get install -y openjdk-17-jdk-headless
MSG
	exit 1
fi

# shellcheck source=scripts/android-sdk.sh
source "$APP_ROOT/scripts/android-sdk.sh"
if ! export_android_sdk; then
	cat >&2 <<'MSG'
✖ No Android SDK found. Either install Android Studio, or:
    1. download the command line tools from https://developer.android.com/studio
    2. sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
    3. export ANDROID_HOME=<sdk path>   (or write sdk.dir into local.properties)
MSG
	exit 1
fi

exec ./gradlew "$@"
