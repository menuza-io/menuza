import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const journalPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle/meta/_journal.json',
)

/**
 * Entries up to this one shipped before this rule existed: `0052` has a `when`
 * older than `0051`'s and is already on main. Every later entry is held to it.
 */
const LAST_UNCHECKED_IDX = 52

describe('control-plane migration journal', () => {
	// Drizzle applies a migration only when its `when` is greater than the
	// newest one already applied, so a lower value is skipped on an existing
	// database (a local LibSQL file, a test base database) without any error.
	it('gives every new migration a `when` later than all before it', () => {
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ idx: number; when: number; tag: string }>
		}
		let newest = 0
		journal.entries.forEach((entry, index) => {
			expect(entry.idx).toBe(index)
			if (entry.idx > LAST_UNCHECKED_IDX) {
				expect(
					entry.when,
					`${entry.tag} must be later than every earlier migration (${newest})`,
				).toBeGreaterThan(newest)
			}
			newest = Math.max(newest, entry.when)
		})
	})
})
