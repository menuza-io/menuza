#!/usr/bin/env bash
# App ESLint gate. On the mission's base commit (05741ca5) App ESLint reports 59
# pre-existing errors, all design-system rules in six menu files. This fails on
# any error outside that per-file baseline. Warnings never fail.
# Needs a 4 GB heap (peak about 4.1 GB): never run it beside the App typecheck.
set -uo pipefail
cd /Users/zama/menuza/apps/app
out=/tmp/menuza-app-eslint.json
rm -f "$out"
NODE_OPTIONS=--max-old-space-size=4096 npx eslint . -f json -o "$out"
code=$?
if [ "$code" -gt 1 ] || [ ! -s "$out" ]; then
	echo "App ESLint crashed (exit $code). If it says 'Cannot find native binding', run scripts/add-linux-bindings.sh."
	exit 2
fi
node - "$out" <<'NODE'
const fs = require('fs')
const path = require('path')
const baseline = {
	'app/components/menu/option-form.tsx': 23,
	'app/components/menu/menu-form.tsx': 16,
	'app/components/menu/category-form.tsx': 8,
	'app/components/menu/modifier-guest-preview.tsx': 7,
	'app/routes/_app+/$orgSlug_+/menu+/modifiers._index.tsx': 3,
	'app/routes/_app+/$orgSlug_+/menu+/options._index.tsx': 2,
}
const results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let total = 0
const fresh = []
for (const r of results) {
	if (!r.errorCount) continue
	const rel = path.relative(process.cwd(), r.filePath)
	total += r.errorCount
	const allowed = baseline[rel] ?? 0
	if (r.errorCount > allowed) {
		fresh.push({
			rel,
			count: r.errorCount,
			allowed,
			messages: r.messages
				.filter((m) => m.severity === 2)
				.map((m) => `${m.line}:${m.column} ${m.ruleId} ${m.message}`),
		})
	}
}
console.log(`App ESLint errors: ${total} (pre-existing baseline: 59)`)
if (fresh.length) {
	console.log('NEW App ESLint errors (not in the baseline):')
	for (const f of fresh) {
		console.log(`- ${f.rel}: ${f.count} errors (baseline allows ${f.allowed})`)
		for (const m of f.messages.slice(0, 25)) console.log(`    ${m}`)
	}
	process.exit(1)
}
console.log('No new App ESLint errors.')
NODE
