#!/usr/bin/env bash
#
# Runs the tenant app in the iOS Simulator: build → boot → install → launch.
#
# `xcodebuild build` only compiles; it never installs or starts the app, which is
# why a plain build appears to "finish" with nothing on screen.
#
# Usage:
#   bash scripts/run-simulator.sh [device name]
#   SIM_DEVICE="iPhone 17" bash scripts/run-simulator.sh
#
# macOS only (needs Xcode + the iOS Simulator runtime).
set -euo pipefail

cd "$(dirname "$0")/.."

SCHEME="EpicTenantApp"
CONFIG="${CONFIGURATION:-Debug}"
DERIVED="build/DerivedData"
APP="$DERIVED/Build/Products/${CONFIG}-iphonesimulator/${SCHEME}.app"

log() { printf '▸ %s\n' "$*"; }
die() { printf '✖ %s\n' "$*" >&2; exit 1; }

command -v xcodebuild >/dev/null || die "xcodebuild not found — install Xcode from the App Store."
command -v xcrun >/dev/null || die "xcrun not found — install the Xcode command line tools."

# The project is generated, so make sure it exists (and pick up config changes).
if [ ! -d "${SCHEME}.xcodeproj" ] || [ -n "${REGENERATE:-}" ]; then
	if command -v xcodegen >/dev/null; then
		log "Generating ${SCHEME}.xcodeproj (xcodegen)"
		xcodegen generate
	elif [ ! -d "${SCHEME}.xcodeproj" ]; then
		die "xcodegen not found — install it with: brew install xcodegen"
	fi
fi

# Find a simulator to use: the requested one, else the first available iPhone.
device="${1:-${SIM_DEVICE:-iPhone 17}}"
available_iphone() {
	xcrun simctl list devices available |
		sed -n 's/^ *\(iPhone[^(]*[^ (]\) ([0-9A-F-]\{36\}) (.*/\1/p' |
		head -1
}

if ! xcrun simctl list devices available | grep -q "    ${device} ("; then
	fallback="$(available_iphone)"
	[ -n "$fallback" ] || die "No iOS Simulator devices available. Install an iOS runtime in Xcode → Settings → Components."
	log "Simulator '${device}' not available; using '${fallback}'"
	device="$fallback"
fi

log "Building ${SCHEME} (${CONFIG}) for ${device}"
xcodebuild \
	-project "${SCHEME}.xcodeproj" \
	-scheme "$SCHEME" \
	-configuration "$CONFIG" \
	-destination "platform=iOS Simulator,name=${device}" \
	-derivedDataPath "$DERIVED" \
	build

[ -d "$APP" ] || die "Built app not found at ${APP}"

bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${APP}/Info.plist")"
display_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "${APP}/Info.plist" 2>/dev/null || echo "$SCHEME")"

log "Booting ${device}"
xcrun simctl bootstatus "$device" -b >/dev/null
open -a Simulator

log "Installing ${display_name} (${bundle_id})"
xcrun simctl install "$device" "$APP"

log "Launching"
xcrun simctl launch "$device" "$bundle_id"

printf '\n✓ %s is running on %s\n' "$display_name" "$device"
printf '  Logs:     xcrun simctl spawn %s log stream --level debug --predicate %s\n' "$device" "'process == \"${SCHEME}\"'"
printf '  Terminate: xcrun simctl terminate %s %s\n' "$device" "$bundle_id"
