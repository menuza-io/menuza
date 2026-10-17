#!/usr/bin/env bash
# Prints the workspace names of packages created by this mission (names containing
# "reservations" or "zoned-time") that define the npm script given as $1.
# Turbo fails on a --filter for a package that does not exist yet, so the gates
# add these only once they exist.
set -euo pipefail
cd /home/factory-user/repos/menuza
node -e '
const fs = require("fs")
const script = process.argv[1]
for (const dir of fs.readdirSync("packages")) {
	const file = `packages/${dir}/package.json`
	if (!fs.existsSync(file)) continue
	const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
	if (/^@repo\/.*(reservations|zoned-time)/.test(pkg.name) && pkg.scripts && pkg.scripts[script]) console.log(pkg.name)
}' "${1:?npm script name required}"
