#!/usr/bin/env node
/**
 * CI guard (exclusion layer 4): the Cloudflare production bundle must not
 * contain the local payment emulators or their routes.
 *
 *   node scripts/check-no-payment-mocks.mjs [dir ...]   (default: apps/app/build)
 *
 * Run it after `npm run build:cf -w app`. It exits 1 and lists every match when
 * the sentinel, the emulator hosts or tables, or the mock route ids are found.
 * The Node build used for Playwright keeps the mock on purpose; do not point
 * this script at it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MOCK_NEEDLES = [
	'__MENUZA_PAYMENTS_MOCK__',
	'checkout-com.mock.invalid',
	'__mock_pay_',
	'mock-payments+',
	'mock-email+',
	'/mock-payments/',
]

const SKIPPED_EXTENSIONS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.avif',
	'.ico',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.mp4',
	'.webm',
	'.wasm',
])

function* walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue
			yield* walk(path)
		} else if (entry.isFile()) {
			yield path
		}
	}
}

/** Every file under `directory` that contains a mock needle. */
export function findMockLeaks(directory, needles = MOCK_NEEDLES) {
	const leaks = []
	for (const file of walk(directory)) {
		const extension = file.slice(file.lastIndexOf('.')).toLowerCase()
		if (SKIPPED_EXTENSIONS.has(extension)) continue
		const content = readFileSync(file)
		for (const needle of needles) {
			if (content.includes(needle)) leaks.push({ file, needle })
		}
	}
	return leaks
}

function main(argv) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	const targets = (argv.length > 0 ? argv : ['apps/app/build']).map((target) =>
		resolve(process.cwd(), target),
	)
	let failed = false
	for (const target of targets) {
		if (!existsSync(target) || !statSync(target).isDirectory()) {
			console.error(
				`check-no-payment-mocks: ${relative(root, target)} does not exist. Run "npm run build:cf -w app" first.`,
			)
			failed = true
			continue
		}
		const leaks = findMockLeaks(target)
		if (leaks.length === 0) {
			console.log(
				`check-no-payment-mocks: ${relative(root, target)} is clean (${MOCK_NEEDLES.length} needles).`,
			)
			continue
		}
		failed = true
		console.error(
			`check-no-payment-mocks: the production bundle contains payment mock code:`,
		)
		for (const leak of leaks) {
			console.error(`  ${relative(root, leak.file)}  ->  ${leak.needle}`)
		}
	}
	process.exit(failed ? 1 : 0)
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2))
}
