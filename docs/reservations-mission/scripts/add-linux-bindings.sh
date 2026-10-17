#!/usr/bin/env bash
# package-lock.json (generated on macOS) has no linux-x64-gnu entries for these
# two native resolvers, so every `npm install` prunes them and ESLint
# (eslint-import-resolver via unrs-resolver) crashes with "Cannot find native
# binding". Re-run this after every `npm install`. It writes only into
# node_modules and never touches tracked files.
set -euo pipefail
repo="${1:-/home/factory-user/repos/menuza}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
for spec in @unrs/resolver-binding-linux-x64-gnu@1.12.2 @oxc-resolver/binding-linux-x64-gnu@11.24.2; do
	name="${spec%@*}"
	if [ -f "$repo/node_modules/$name/package.json" ]; then
		continue
	fi
	tarball="$(npm pack "$spec" --silent)"
	mkdir -p "$repo/node_modules/$name"
	tar -xzf "$tarball" -C "$repo/node_modules/$name" --strip-components=1
	echo "added $name"
done
cd "$repo"
node -e "require('unrs-resolver');require('oxc-resolver');console.log('native resolver bindings OK')"
