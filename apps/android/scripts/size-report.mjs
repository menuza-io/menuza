#!/usr/bin/env node
/**
 * Reports the shipped size of the tenant Android app.
 *
 *   npm run android:size -w android
 *
 * Reads whatever `assembleRelease` / `bundleRelease` produced and prints the
 * per-artifact sizes plus the biggest entries inside the APK. For the number a
 * customer actually downloads from Play, feed the AAB to bundletool:
 *
 *   bundletool build-apks --bundle=app/build/outputs/bundle/release/app-release.aab \
 *     --output=/tmp/app.apks --mode=default
 *   bundletool get-size total --apks=/tmp/app.apks
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ARTIFACTS = [
	['debug APK', 'app/build/outputs/apk/debug/app-debug.apk'],
	['release APK', 'app/build/outputs/apk/release/app-release-unsigned.apk'],
	['release AAB', 'app/build/outputs/bundle/release/app-release.aab'],
]

function human(bytes) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function listApk(apkPath) {
	try {
		const output = execFileSync('unzip', ['-l', apkPath], { encoding: 'utf8' })
		return output
			.split('\n')
			.map((line) => line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/))
			.filter(Boolean)
			.map((match) => ({ bytes: Number(match[1]), name: match[2].trim() }))
			.filter((entry) => entry.bytes > 0)
			.sort((a, b) => b.bytes - a.bytes)
	} catch {
		return null
	}
}

let found = false
for (const [label, relative] of ARTIFACTS) {
	const path = join(APP_ROOT, relative)
	if (!existsSync(path)) continue
	found = true
	console.log(
		`${label.padEnd(12)} ${human(statSync(path).size).padStart(9)}   ${relative}`,
	)
}

if (!found) {
	console.error(
		'No build outputs found. Run `npm run android:apk -w android` (or android:bundle) first.',
	)
	process.exit(1)
}

const releaseApk = join(
	APP_ROOT,
	'app/build/outputs/apk/release/app-release-unsigned.apk',
)
const entries = listApk(releaseApk)
if (entries) {
	console.log('\nBiggest entries in the release APK:')
	for (const entry of entries.slice(0, 8)) {
		console.log(`  ${human(entry.bytes).padStart(9)}  ${entry.name}`)
	}
}

const budget = join(APP_ROOT, 'size-budget.json')
if (existsSync(budget)) {
	const limits = JSON.parse(readFileSync(budget, 'utf8'))
	console.log('\nBudget:')
	let overBudget = false
	for (const [label, relative] of ARTIFACTS) {
		const limit = limits[relative]
		if (!limit) continue
		const path = join(APP_ROOT, relative)
		const size = existsSync(path) ? statSync(path).size : 0
		const status = size <= limit ? 'ok' : 'OVER'
		if (status === 'OVER') overBudget = true
		console.log(
			`  ${status.padEnd(5)} ${label.padEnd(12)} ${human(size)} / ${human(limit)}`,
		)
	}
	if (overBudget) {
		// The workflow step (and the local `npm run android:size`) must fail, not
		// just print: a release that blows the budget is a release to look at.
		process.exitCode = 1
	}
}
