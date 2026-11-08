import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0019 settles broadcasts saved as scheduled `Draft` rows before the
 * dispatcher existed: future ones become `Scheduled`; past ones stay `Draft`,
 * which is never sent, so an old campaign never goes out late.
 */

const drizzleDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle',
)

type Journal = { entries: Array<{ idx: number; tag: string }> }

function migrationsUpTo(tempDir: string, lastIdx: number) {
	const folder = path.join(tempDir, `drizzle-${lastIdx}`)
	fs.cpSync(drizzleDir, folder, { recursive: true })
	const journalPath = path.join(folder, 'meta/_journal.json')
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
	journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx)
	fs.writeFileSync(journalPath, JSON.stringify(journal))
	return folder
}

describe('migration 0019 (legacy scheduled drafts)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-0019-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, 18),
		})
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('schedules future drafts and leaves past ones as drafts', async () => {
		const now = Math.floor(Date.now() / 1000)
		await client.execute({
			sql: `INSERT INTO marketing_campaigns (id, name, status, scheduled_at) VALUES
				('future', 'Future', 'Draft', ?),
				('past', 'Past', 'Draft', ?),
				('plain-draft', 'Plain', 'Draft', NULL),
				('done', 'Done', 'Completed', ?)`,
			args: [now + 3600, now - 3600, now - 3600],
		})

		await migrate(drizzle(client), { migrationsFolder: drizzleDir })

		const rows = (
			await client.execute(
				'SELECT id, status FROM marketing_campaigns ORDER BY id',
			)
		).rows.map((row) => ({ ...row }))
		expect(rows).toEqual([
			{ id: 'done', status: 'Completed' },
			{ id: 'future', status: 'Scheduled' },
			{ id: 'past', status: 'Draft' },
			{ id: 'plain-draft', status: 'Draft' },
		])
	})
})
