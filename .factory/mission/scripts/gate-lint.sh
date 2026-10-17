#!/usr/bin/env bash
# Milestone gate: lint. oxlint (root), ESLint for the smaller workspaces that have
# a lint script, then App ESLint against its 59-error baseline. Runs every step
# and prints a summary.
set -uo pipefail
REPO=/home/factory-user/repos/menuza
MISSION=/home/factory-user/.factory/missions/165ab51b-48a5-4632-8938-101be7ea8500
cd "$REPO"
failed=()

echo ">>> oxlint"
npm run lint:oxc || failed+=(oxlint)

small=(sites admin @repo/marketing-workflow @repo/payments @repo/ui @repo/notifications)
while IFS= read -r name; do
	[ -n "$name" ] && small+=("$name")
done < <(bash "$MISSION/scripts/mission-packages.sh" lint)
args=()
for f in "${small[@]}"; do args+=("--filter=$f"); done
echo ">>> ESLint: ${small[*]}"
NODE_OPTIONS=--max-old-space-size=4096 npx turbo run lint "${args[@]}" --concurrency=2 --continue --output-logs=errors-only || failed+=(eslint-workspaces)

echo ">>> App ESLint (baseline gate)"
bash "$MISSION/scripts/app-eslint-gate.sh" || failed+=(eslint-app)

bash "$MISSION/scripts/clean-generated.sh" >/dev/null
if [ "${#failed[@]}" -gt 0 ]; then
	echo "LINT GATE FAILED: ${failed[*]}"
	exit 1
fi
echo "LINT GATE PASSED"
