#!/usr/bin/env bash
# Varlock rewrites tracked `src/env.ts` files without Prettier formatting whenever
# tests, typecheck or dev servers run (reports, security, auth, email, ...).
# Prettier restores the committed form exactly, and it keeps genuine schema
# changes (for example a worker adding an env var) intact, so never `git checkout`
# these files blindly. Prints `git status --porcelain` afterwards.
set -uo pipefail
cd /home/factory-user/repos/menuza
files=$(git ls-files -m | grep -E '(^|/)src/env\.ts$' || true)
if [ -n "$files" ]; then
	# shellcheck disable=SC2086
	npx prettier --write $files >/dev/null 2>&1 || true
fi
git status --porcelain
