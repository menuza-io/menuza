import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = join(import.meta.dirname, '..', '..')

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return sourceFiles(path)
		return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
	})
}

/**
 * Location scope reaches the regional tokens and every scoped loader through
 * one resolver (#374). A tag only widens access safely if no other file reads
 * the grant tables itself, because a second reader would not know about tags.
 */
describe('location scope guards', () => {
	const allowed = new Set([
		// The one resolver.
		'utils/location/member-scope.server.ts',
		// Admin screen that edits and lists the stored grants (never resolves access).
		'utils/staffing/restaurant/location-scope.server.ts',
	])

	it('only the shared resolver and the grant editor read the member grant tables', () => {
		const offenders = sourceFiles(APP_ROOT)
			.map((file) => relative(APP_ROOT, file))
			.filter((file) => {
				const text = readFileSync(join(APP_ROOT, file), 'utf8')
				return (
					/\bUserOrganizationLocation(Tag)?\b/.test(text) && !allowed.has(file)
				)
			})
		expect(offenders).toEqual([])
	})

	it('no module keeps its own copy of the grant lookup', () => {
		// A job posting has its own "selected locations" list; it is not a member scope.
		const unrelated = new Set(['utils/hiring/job-posting-form.ts'])
		const offenders = sourceFiles(APP_ROOT)
			.map((file) => relative(APP_ROOT, file))
			.filter((file) => {
				const text = readFileSync(join(APP_ROOT, file), 'utf8')
				return (
					/locationScope === 'selected'|locationScope !== 'selected'/.test(text) &&
					file !== 'utils/location/member-scope.server.ts' &&
					!unrelated.has(file)
				)
			})
		expect(offenders).toEqual([])
	})
})
