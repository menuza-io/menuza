#!/usr/bin/env bash
# Milestone gate: typecheck every workspace this mission touches, plus the new
# mission packages once they exist. Needs a 4 GB heap (App runs out at the V8
# default). Never run this at the same time as the App ESLint run.
set -uo pipefail
REPO=/home/factory-user/repos/menuza
MISSION=/home/factory-user/.factory/missions/165ab51b-48a5-4632-8938-101be7ea8500
cd "$REPO"
export NODE_OPTIONS=--max-old-space-size=4096

filters=(
	tenant-api app sites admin jobs-cron voice-agent
	@repo/tenant-db @repo/staffing @repo/staffing-restaurant
	@repo/phone-agent @repo/phone-agent-restaurant
	@repo/reports @repo/marketing-workflow @repo/marketing
	@repo/database @repo/auth @repo/payments @repo/email @repo/common
	@repo/test-utils @repo/notifications @repo/ui @repo/sms
)
while IFS= read -r name; do
	[ -n "$name" ] && filters+=("$name")
done < <(bash "$MISSION/scripts/mission-packages.sh" typecheck)

args=()
for f in "${filters[@]}"; do args+=("--filter=$f"); done

echo "Typecheck gate: ${#filters[@]} workspaces"
npx turbo run typecheck "${args[@]}" --concurrency=2 --continue --output-logs=errors-only
status=$?
bash "$MISSION/scripts/clean-generated.sh" >/dev/null
if [ "$status" -ne 0 ]; then
	echo "TYPECHECK GATE FAILED (exit $status)"
else
	echo "TYPECHECK GATE PASSED"
fi
exit "$status"
