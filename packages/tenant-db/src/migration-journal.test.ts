import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const journalPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle/meta/_journal.json',
)

describe('tenant migration journal', () => {
	// Drizzle applies a migration only when its `when` is greater than the
	// newest applied one, so a lower value is skipped on existing databases.
	it('has strictly increasing `when` values in idx order', () => {
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ idx: number; when: number; tag: string }>
		}
		journal.entries.forEach((entry, index) => {
			expect(entry.idx).toBe(index)
			if (index > 0) {
				const previous = journal.entries[index - 1]!
				expect(
					entry.when,
					`${entry.tag} must be later than ${previous.tag}`,
				).toBeGreaterThan(previous.when)
			}
		})
	})
})
