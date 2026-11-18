import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every loader and action of the multi-location tools (compare and edit, chain
 * defaults, tags and import, Status) opens with its access check before it
 * reads anything. Location scope and head-office checks are server rules, so a
 * new route must be added here.
 */
const ROUTES: Array<{ file: string; guard: RegExp; exports: string[] }> = [
	{
		file: 'settings+/locations.compare.tsx',
		guard: /await requireLocationManager\(/,
		exports: ['loader', 'action'],
	},
	{
		file: 'settings+/locations.defaults.tsx',
		guard: /await requireHeadOffice\(/,
		exports: ['loader', 'action'],
	},
	{
		file: 'settings+/locations.tags.tsx',
		guard: /await requireHeadOffice\(/,
		exports: ['loader', 'action'],
	},
	{
		file: 'status.tsx',
		guard: /await requireAnyUserWithOrganizationPermission\(/,
		exports: ['loader'],
	},
]

function body(text: string, name: string) {
	const start = text.indexOf(`export async function ${name}(`)
	expect(start, `${name} exists`).toBeGreaterThan(-1)
	const open = text.indexOf('{\n', text.indexOf(')', start))
	const next = text.indexOf('\nexport ', open)
	return text.slice(open, next === -1 ? undefined : next)
}

describe('multi-location route guards', () => {
	for (const route of ROUTES) {
		for (const name of route.exports) {
			it(`${route.file} ${name} checks access before anything else`, () => {
				const text = readFileSync(
					join(import.meta.dirname, '..', route.file),
					'utf8',
				)
				const fn = body(text, name)
				const firstGuard = fn.search(route.guard)
				expect(firstGuard).toBeGreaterThan(-1)
				// Nothing before the guard reads the database or the request body.
				const before = fn.slice(0, firstGuard)
				expect(before).not.toMatch(
					/await request\.formData|db\.|loadChainDefaults|loadLocation|listLocationTags/,
				)
			})
		}
	}

	it('the Locations list gates each multi-location intent', () => {
		const text = readFileSync(
			join(import.meta.dirname, 'locations._index.tsx'),
			'utf8',
		)
		const action = body(text, 'action')
		const bulk = action.indexOf("intent === 'bulk-ordering'")
		expect(action.slice(bulk, bulk + 200)).toContain('requireMenuWrite(')
		const copy = action.indexOf("intent === 'preview-copy'")
		const settingsGuard = action.indexOf('ORG_PERMISSIONS.UPDATE_SETTINGS_ANY')
		expect(settingsGuard).toBeGreaterThan(-1)
		expect(settingsGuard).toBeLessThan(copy)
		expect(action.slice(copy)).toContain('resolveMemberLocationIds(')
	})
})
