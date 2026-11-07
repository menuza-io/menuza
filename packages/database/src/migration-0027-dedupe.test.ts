import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0027 removes duplicate PlatformMarketingMessage rows before it
 * adds the (campaignId, userId) unique index. This runs it on a database
 * migrated to 0026 and seeded with duplicates.
 */

const drizzleDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle',
)

type Journal = { entries: Array<{ idx: number; tag: string }> }

/** A copy of the migrations folder whose journal stops at `lastTag`. */
function migrationsUpTo(tempDir: string, lastTag: string) {
	const folder = path.join(tempDir, 'drizzle-partial')
	fs.cpSync(drizzleDir, folder, { recursive: true })
	const journalPath = path.join(folder, 'meta/_journal.json')
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
	const last = journal.entries.findIndex((entry) => entry.tag === lastTag)
	expect(last).toBeGreaterThan(-1)
	journal.entries = journal.entries.slice(0, last + 1)
	fs.writeFileSync(journalPath, JSON.stringify(journal))
	return folder
}

async function rows(client: Client, query: string) {
	return (await client.execute(query)).rows.map((row) => ({ ...row }))
}

describe('migration 0027 (concurrency guards)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-0027-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, '0026_sso_identity'),
		})

		await client.executeMultiple(`
			INSERT INTO User (id, email, username, createdAt, updatedAt) VALUES
				('u1', 'u1@example.com', 'u1', 1, 1),
				('u2', 'u2@example.com', 'u2', 1, 1),
				('u3', 'u3@example.com', 'u3', 1, 1);
			INSERT INTO PlatformMarketingCampaign (id, name, channel, content, createdAt, updatedAt) VALUES
				('k1', 'Launch', 'email', 'Hi', 1, 1),
				('k2', 'Later', 'email', 'Hi', 1, 1);
			INSERT INTO PlatformMarketingMessage (id, campaignId, userId, status, createdAt) VALUES
				-- u1: three rows, the clicked one is kept.
				('m-failed', 'k1', 'u1', 'Failed', 100),
				('m-sent', 'k1', 'u1', 'Sent', 200),
				('m-clicked', 'k1', 'u1', 'Clicked', 300),
				-- u2: an unknown outcome beats a failure, though it is newer.
				('m-u2-failed', 'k1', 'u2', 'Failed', 100),
				('m-u2-processing', 'k1', 'u2', 'Processing', 200),
				-- u3: two sent rows, the oldest is kept.
				('m-u3-old', 'k1', 'u3', 'Sent', 100),
				('m-u3-new', 'k1', 'u3', 'Sent', 200),
				-- Another campaign is a different message.
				('m-other', 'k2', 'u1', 'Failed', 100);
		`)

		await migrate(drizzle(client), { migrationsFolder: drizzleDir })
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('keeps the most engaged message per campaign and user', async () => {
		expect(
			await rows(client, 'SELECT id FROM PlatformMarketingMessage ORDER BY id'),
		).toEqual(
			['m-clicked', 'm-other', 'm-u2-processing', 'm-u3-old'].map((id) => ({
				id,
			})),
		)
	})

	it('archives every removed message with its data', async () => {
		expect(
			await rows(
				client,
				'SELECT id, campaignId, userId, status, createdAt FROM __archived_PlatformMarketingMessage_0027 ORDER BY id',
			),
		).toEqual([
			{
				id: 'm-failed',
				campaignId: 'k1',
				userId: 'u1',
				status: 'Failed',
				createdAt: 100,
			},
			{
				id: 'm-sent',
				campaignId: 'k1',
				userId: 'u1',
				status: 'Sent',
				createdAt: 200,
			},
			{
				id: 'm-u2-failed',
				campaignId: 'k1',
				userId: 'u2',
				status: 'Failed',
				createdAt: 100,
			},
			{
				id: 'm-u3-new',
				campaignId: 'k1',
				userId: 'u3',
				status: 'Sent',
				createdAt: 200,
			},
		])
	})

	it('adds the unique index', async () => {
		await expect(
			client.execute(
				"INSERT INTO PlatformMarketingMessage (id, campaignId, userId, status, createdAt) VALUES ('dup', 'k1', 'u1', 'Sent', 1)",
			),
		).rejects.toThrow(/UNIQUE/)
	})
})
