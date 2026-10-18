import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { setupIssueTab } from './setup-issue-target.ts'

const SETTINGS_ROUTE = path.resolve(
	import.meta.dirname,
	'../../routes/_app+/$orgSlug_+/reservations+/settings.tsx',
)

/** The leaf routes of the five-group settings navigation, from `settings.tsx`. */
function settingsLeafSuffixes(): string[] {
	const source = fs.readFileSync(SETTINGS_ROUTE, 'utf8')
	return [...source.matchAll(/leaf\(\s*'[^']+',\s*[^,]+,\s*'\/([^']+)'/g)].map(
		(match) => match[1]!,
	)
}

describe('setup issue targets', () => {
	it('sends every issue to a tab that exists in the settings navigation', () => {
		const leaves = settingsLeafSuffixes()
		expect(leaves).toEqual(
			expect.arrayContaining([
				'policies',
				'services',
				'special-days',
				'tables',
				'sections',
				'floor-plan',
				'messages',
				'waitlist',
			]),
		)
		for (const code of [
			'duplicate_table_label',
			'combination_missing_table',
			'service_invalid_window',
			'turn_time_bucket_gap',
			'policy_unknown_service',
			'block_unknown_table',
		]) {
			const tab = setupIssueTab(code)
			expect(tab).not.toBeNull()
			expect(leaves).toContain(tab)
		}
	})

	it('maps table combinations to the floor tab, not nowhere', () => {
		// "combination" does not contain "combo": a keyword match missed these.
		expect(setupIssueTab('combination_cross_area')).toBe('tables')
		expect(setupIssueTab('combination_too_few_members')).toBe('tables')
	})

	it('sends payment policy issues to payment policies, not services', () => {
		expect(setupIssueTab('policy_unknown_service')).toBe('policies')
		expect(setupIssueTab('policy_invalid_window')).toBe('policies')
	})

	it('keeps general settings issues on the Booking rules page', () => {
		expect(setupIssueTab('invalid_interval_min')).toBeNull()
		expect(setupIssueTab('pacing_cap_below_min_party')).toBeNull()
		expect(setupIssueTab('something_new')).toBeNull()
	})
})
