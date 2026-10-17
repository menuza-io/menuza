#!/usr/bin/env bash
# Milestone gate: tests, in the approved order. Runs every step even after a
# failure, keeps full logs in /tmp/menuza-gate/, prints the tail of each failing
# log and a summary. About 12 minutes when warm (App tests alone take ~7.5 min).
# Run it alone: no App build, typecheck, lint or Playwright run at the same time.
set -uo pipefail
REPO=/home/factory-user/repos/menuza
MISSION=/home/factory-user/.factory/missions/165ab51b-48a5-4632-8938-101be7ea8500
LOGDIR=/tmp/menuza-gate
mkdir -p "$LOGDIR"
cd "$REPO"

summary=()
failed=()

step() {
	local name="$1"
	shift
	local log="$LOGDIR/test-${name//[^A-Za-z0-9._-]/_}.log"
	local start
	start=$(date +%s)
	echo ">>> $name"
	("$@") >"$log" 2>&1
	local code=$?
	local secs=$(($(date +%s) - start))
	summary+=("$(printf '%-36s exit=%-3s %5ss' "$name" "$code" "$secs")")
	if [ "$code" -ne 0 ]; then
		failed+=("$name")
		echo "!!! $name failed (exit $code). Last 80 lines of $log:"
		tail -n 80 "$log"
	fi
}

# 1. Small suites (existing workspaces the mission touches, then new mission packages).
fast=(
	sites admin jobs-cron voice-agent
	@repo/staffing @repo/staffing-restaurant @repo/tenant-db
	@repo/phone-agent @repo/phone-agent-restaurant
	@repo/reports @repo/marketing-workflow @repo/marketing
	@repo/database @repo/auth @repo/payments @repo/email @repo/common
)
while IFS= read -r name; do
	[ -n "$name" ] && fast+=("$name")
done < <(bash "$MISSION/scripts/mission-packages.sh" test)
for w in "${fast[@]}"; do
	step "test:$w" env CI=true npm run test -w "$w"
done

# 2. tenant-api, then 3. App (alone; CI=true gives maxWorkers 2).
step "test:tenant-api" env CI=true npm run test -w tenant-api
step "test:app" env CI=true npm run test -w app

# 4. Android: unit tests, debug build, release build and byte budget; then stop Gradle.
android_env='export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_SDK_ROOT=$HOME/android-sdk ANDROID_HOME=$HOME/android-sdk; export PATH=$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH; cd apps/android'
step "android:test" bash -c "$android_env && npm run android:test"
step "android:build" bash -c "$android_env && npm run android:build"
step "android:size" bash -c "$android_env && node scripts/generate-tenant.mjs --tenant ci --no-api && bash scripts/gradle.sh assembleRelease bundleRelease && npm run android:size"
bash -c "$android_env && ./gradlew --stop" >/dev/null 2>&1 || true

# 5. iOS (TenantKit builds and tests on Linux).
step "ios:build" bash -c 'cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift build'
step "ios:test" bash -c 'cd apps/ios && PATH=$HOME/swift/usr/bin:$PATH swift test'

# 6. Lingui catalogs complete across apps.
step "lingui:check" npm run lingui:check

echo
echo "===== TEST GATE SUMMARY (logs in $LOGDIR) ====="
printf '%s\n' "${summary[@]}"
echo "--- git status after cleanup ---"
bash "$MISSION/scripts/clean-generated.sh"
if [ "${#failed[@]}" -gt 0 ]; then
	echo "TEST GATE FAILED: ${failed[*]}"
	exit 1
fi
echo "TEST GATE PASSED"
