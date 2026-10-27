import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Print shop core has no business-type vocabulary: a vertical (see
 * `docs/print-shop-verticals.md`) brings its own words. This fails when a
 * core source names one, or the platform's brand. Vertical code lives in
 * `restaurant/`-style folders and the three registration files, which this
 * skips.
 */

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../../..',
)

const CORE = [
	'packages/common/src/print-shop.ts',
	'apps/app/app/utils/print',
	'apps/app/app/components/print',
	'apps/app/app/routes/_app+/$orgSlug_+/marketing+',
	'apps/app/app/routes/resources+',
	'apps/admin/app/routes/_admin+',
]

/** Registration files pick the vertical, so they name it. */
const REGISTRATION = new Set([
	'apps/app/app/utils/print/vertical.server.ts',
	'apps/app/app/components/print/vertical-ui.tsx',
])

const WORDS =
	/\b(restaurants?|menus?|dish(es)?|tables?|locations?|reservations?|diners?|guests?|kitchens?|dine[- ]in|waiters?|seating|menuza)\b/i

/** UI kit table components are layout, not vocabulary. */
const ALLOWED =
	/<\/?Table\w*|\bTable(Row|Cell|Head|Body|Header|Footer|Caption)?,|['"]@repo\/ui\/table['"]|window\.location/g

function files(entry: string): string[] {
	const full = path.join(ROOT, entry)
	if (statSync(full).isFile()) return [entry]
	return readdirSync(full, { withFileTypes: true }).flatMap((child) => {
		const relative = `${entry}/${child.name}`
		if (child.isDirectory()) {
			return child.name === 'restaurant' ? [] : files(relative)
		}
		return [relative]
	})
}

function coreSources() {
	return CORE.flatMap(files).filter(
		(file) =>
			/\.(ts|tsx)$/.test(file) &&
			!/\.test\.tsx?$/.test(file) &&
			!REGISTRATION.has(file) &&
			// Only print files in shared route folders.
			(!file.includes('/routes/') || /\/print[.-]|jobs\.print-/.test(file)),
	)
}

describe('Print shop core vocabulary', () => {
	it('finds the core sources', () => {
		expect(coreSources().length).toBeGreaterThan(20)
	})

	it('names no business type or brand', () => {
		const hits: string[] = []
		for (const file of coreSources()) {
			const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n')
			lines.forEach((line, index) => {
				const match = line.replace(ALLOWED, '').match(WORDS)
				if (match) hits.push(`${file}:${index + 1} "${match[0]}"`)
			})
		}
		expect(hits).toEqual([])
	})
})
