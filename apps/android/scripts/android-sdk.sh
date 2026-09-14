#!/usr/bin/env bash
# Shared Android SDK discovery, sourced by scripts/gradle.sh and
# scripts/run-app.sh.
#
# `android_sdk_root` prints the SDK path when one can be found (from
# ANDROID_SDK_ROOT / ANDROID_HOME, `local.properties`, or the usual install
# locations) and returns non-zero when it cannot, so callers print their own
# guidance.

android_sdk_root() {
	local sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
	if [ -n "$sdk" ]; then
		printf '%s' "$sdk"
		return 0
	fi

	if [ -f local.properties ]; then
		sdk="$(sed -n 's/^sdk\.dir=//p' local.properties | head -1)"
		if [ -n "$sdk" ]; then
			printf '%s' "$sdk"
			return 0
		fi
	fi

	local candidate
	for candidate in \
		"$HOME/android-sdk" \
		"$HOME/Library/Android/sdk" \
		"/usr/local/lib/android/sdk" \
		"/opt/android-sdk"; do
		if [ -d "$candidate" ]; then
			printf '%s' "$candidate"
			return 0
		fi
	done

	return 1
}

# Exports ANDROID_SDK_ROOT / ANDROID_HOME / PATH when an SDK exists.
export_android_sdk() {
	local sdk
	if ! sdk="$(android_sdk_root)"; then
		return 1
	fi
	export ANDROID_SDK_ROOT="$sdk"
	export ANDROID_HOME="$sdk"
	case ":$PATH:" in
	*":$sdk/platform-tools:"*) ;;
	*) export PATH="$sdk/platform-tools:$PATH" ;;
	esac
	return 0
}
