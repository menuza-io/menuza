import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const journalPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle/meta/_journal.json',
)

/**
 * Entry 4 shipped with a `when` older than entry 3's, before this rule existed,
 * and is already applied everywhere. `migration-chain.test.ts` keeps the same
 * exception.
 */
const HISTORIC_UNORDERED_IDX = 4

describe('tenant migration journal', () => {
	// Drizzle applies a migration only when its `when` is greater than the
	// newest applied one, so a lower value is skipped on existing databases.
	it('has strictly increasing `when` values in idx order', () => {
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ idx: number; when: number; tag: string }>
		}
		journal.entries.forEach((entry, index) => {
			expect(entry.idx).toBe(index)
			if (index > 0 && entry.idx !== HISTORIC_UNORDERED_IDX) {
				const previous = journal.entries[index - 1]!
				expect(
					entry.when,
					`${entry.tag} must be later than ${previous.tag}`,
				).toBeGreaterThan(previous.when)
			}
		})
	})
})
