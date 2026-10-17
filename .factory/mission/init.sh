#!/usr/bin/env bash
# Reservations mission: per-session environment setup. Idempotent and quick.
# It never installs dependencies, migrates databases or starts services:
# see services.yaml (commands.install, commands.migrate_control_plane, services.*).
set -uo pipefail
REPO=/Users/zama/menuza
MISSION=/Users/zama/menuza/.factory/mission
cd "$REPO" || exit 1

warn() { echo "WARNING: $*"; }

# 1. Branch: all work is committed on pr/reservations.
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "pr/reservations" ]; then
	warn "on branch '$branch', expected 'pr/reservations'. Do not switch over uncommitted work; return to the orchestrator."
fi

# 2. Directories used by services, gates and the KSA node (all outside git or gitignored).
mkdir -p /tmp/menuza-logs /tmp/menuza-gate "$REPO/packages/database/db/ksa"

# 3. Linux ESLint native bindings. The macOS-generated lockfile lacks them, so every
#    npm install prunes them and ESLint crashes with "Cannot find native binding".
if [ ! -f node_modules/@unrs/resolver-binding-linux-x64-gnu/package.json ] ||
	[ ! -f node_modules/@oxc-resolver/binding-linux-x64-gnu/package.json ]; then
	bash "$MISSION/scripts/add-linux-bindings.sh"
fi

# 4. Dependencies and workspace links (a new workspace package needs commands.install).
if [ ! -d node_modules ]; then
	warn "node_modules is missing: run commands.install from services.yaml."
else
	node -e '
const fs = require("fs")
for (const base of ["packages", "apps"]) {
	for (const dir of fs.readdirSync(base)) {
		const file = `${base}/${dir}/package.json`
		if (!fs.existsSync(file)) continue
		const name = JSON.parse(fs.readFileSync(file, "utf8")).name
		if (name && !fs.existsSync(`node_modules/${name}`)) {
			console.log(`WARNING: workspace ${name} (${base}/${dir}) is not linked in node_modules: run commands.install (expect a ~14 min App cold start afterwards).`)
		}
	}
}'
fi

# 5. Lockfile drift guard. During planning an unexplained tooling run added an
#    extraneous @posthog/cli/node_modules/prettier entry.
if ! git diff --quiet -- package-lock.json; then
	warn "package-lock.json has uncommitted changes. If they are not your feature's intended dependency change, restore it with 'git checkout -- package-lock.json'."
fi

# 6. Formatting noise from Varlock-regenerated src/env.ts files (keeps real changes).
bash "$MISSION/scripts/clean-generated.sh" >/dev/null

# 7. Gitignored local files that must exist.
[ -f apps/app/.env ] || warn "apps/app/.env is missing. Return to the orchestrator; do not regenerate it."
[ -f apps/admin/.env ] || warn "apps/admin/.env is missing (Admin typecheck and dev fail). Return to the orchestrator."

# 8. Status summary.
echo "Branch: $branch ($(git rev-parse --short HEAD))"
changes=$(git status --porcelain)
if [ -n "$changes" ]; then
	echo "Uncommitted changes:"
	echo "$changes" | head -30
else
	echo "Working tree clean."
fi
listening=$(ss -Htlnp 2>/dev/null | grep -oE ':(3001|3005|3007|3008|3009|3101)\b' | sort -u | tr '\n' ' ')
echo "Mission ports in use: ${listening:-none}"
exit 0
