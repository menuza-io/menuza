import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0030 (upstream 0018) removes duplicate journey runs and broadcast
 * messages before it adds the unique indexes. This runs it on a database
 * migrated to 0029 (upstream 0017) and seeded with duplicates and child rows.
 */

const drizzleDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'../drizzle',
)

type Journal = { entries: Array<{ idx: number; tag: string }> }

/** A copy of the migrations folder whose journal stops after `lastIdx`. */
function migrationsUpTo(tempDir: string, lastIdx: number) {
	const folder = path.join(tempDir, `drizzle-${lastIdx}`)
	fs.cpSync(drizzleDir, folder, { recursive: true })
	const journalPath = path.join(folder, 'meta/_journal.json')
	const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
	journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx)
	fs.writeFileSync(journalPath, JSON.stringify(journal))
	return folder
}

async function rows(client: Client, query: string) {
	return (await client.execute(query)).rows.map((row) => ({ ...row }))
}

describe('migration 0018 (concurrency guards)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-0018-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await client.execute('PRAGMA foreign_keys = ON')
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, 29),
		})

		await client.executeMultiple(`
			INSERT INTO customers (id, name) VALUES ('c1', 'One'), ('c2', 'Two');
			INSERT INTO marketing_journeys (id, name) VALUES ('j1', 'Welcome');
			INSERT INTO marketing_campaigns (id, name) VALUES ('k1', 'Launch');

			-- c1 was enrolled three times by a once-per-customer trigger.
			INSERT INTO journey_runs (id, journey_id, customer_id, trigger_event, status, created_at) VALUES
				('run-failed-oldest', 'j1', 'c1', 'phone_verified', 'failed', 100),
				('run-completed', 'j1', 'c1', 'phone_verified', 'completed', 200),
				('run-running', 'j1', 'c1', 'phone_verified', 'running', 300),
				-- c2: two cancelled runs, so the oldest wins.
				('run-c2-old', 'j1', 'c2', 'profile_completed', 'cancelled', 100),
				('run-c2-new', 'j1', 'c2', 'profile_completed', 'cancelled', 200),
				-- Manual runs may repeat and are left alone.
				('run-manual-1', 'j1', 'c1', 'manual', 'completed', 100),
				('run-manual-2', 'j1', 'c1', 'manual', 'completed', 200);

			INSERT INTO journey_step_executions (id, run_id, journey_id, customer_id, node_id, status) VALUES
				('step-of-failed', 'run-failed-oldest', 'j1', 'c1', 'email-1', 'completed'),
				('step-of-completed', 'run-completed', 'j1', 'c1', 'email-1', 'completed'),
				('step-of-running', 'run-running', 'j1', 'c1', 'delay-1', 'pending');

			INSERT INTO marketing_messages (id, campaign_id, journey_step_execution_id, customer_id, status, sent_at) VALUES
				-- A journey email sent by a run that is removed.
				('msg-journey', NULL, 'step-of-failed', 'c1', 'Sent', 100),
				-- Broadcast duplicates for c1: the clicked one is kept.
				('msg-failed', 'k1', NULL, 'c1', 'Failed', 100),
				('msg-sent', 'k1', NULL, 'c1', 'Sent', 200),
				('msg-clicked', 'k1', NULL, 'c1', 'Clicked', 300),
				-- c2: both outcomes unknown, so the oldest is kept.
				('msg-processing', 'k1', NULL, 'c2', 'Processing', 200),
				('msg-unknown', 'k1', NULL, 'c2', 'Unknown', 100);
		`)

		await migrate(drizzle(client), { migrationsFolder: drizzleDir })
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('keeps the best journey run per customer and archives the others', async () => {
		expect(
			await rows(client, 'SELECT id FROM journey_runs ORDER BY id'),
		).toEqual(
			['run-c2-old', 'run-completed', 'run-manual-1', 'run-manual-2'].map(
				(id) => ({ id }),
			),
		)
		expect(
			await rows(
				client,
				'SELECT id, status FROM __archived_journey_runs_0018 ORDER BY id',
			),
		).toEqual([
			{ id: 'run-c2-new', status: 'cancelled' },
			{ id: 'run-failed-oldest', status: 'failed' },
			{ id: 'run-running', status: 'running' },
		])
	})

	it('archives and removes the step executions of removed runs', async () => {
		expect(
			await rows(client, 'SELECT id FROM journey_step_executions ORDER BY id'),
		).toEqual([{ id: 'step-of-completed' }])
		expect(
			await rows(
				client,
				'SELECT id, run_id FROM __archived_journey_step_executions_0018 ORDER BY id',
			),
		).toEqual([
			{ id: 'step-of-failed', run_id: 'run-failed-oldest' },
			{ id: 'step-of-running', run_id: 'run-running' },
		])
	})

	it('keeps a journey message whose step was removed, unlinked, and archives the link', async () => {
		expect(
			await rows(
				client,
				"SELECT journey_step_execution_id FROM marketing_messages WHERE id = 'msg-journey'",
			),
		).toEqual([{ journey_step_execution_id: null }])
		expect(
			await rows(
				client,
				"SELECT id, journey_step_execution_id, archive_reason FROM __archived_marketing_messages_0018 WHERE id = 'msg-journey'",
			),
		).toEqual([
			{
				id: 'msg-journey',
				journey_step_execution_id: 'step-of-failed',
				archive_reason: 'journey_step_unlinked',
			},
		])
	})

	it('keeps the most engaged broadcast message per customer and archives the others', async () => {
		expect(
			await rows(
				client,
				"SELECT id FROM marketing_messages WHERE campaign_id = 'k1' ORDER BY id",
			),
		).toEqual([{ id: 'msg-clicked' }, { id: 'msg-unknown' }])
		expect(
			await rows(
				client,
				"SELECT id, status FROM __archived_marketing_messages_0018 WHERE archive_reason = 'duplicate_broadcast' ORDER BY id",
			),
		).toEqual([
			{ id: 'msg-failed', status: 'Failed' },
			{ id: 'msg-processing', status: 'Processing' },
			{ id: 'msg-sent', status: 'Sent' },
		])
	})

	it('adds the unique indexes and leaves no foreign key broken', async () => {
		const indexes = await rows(
			client,
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('uniq_journey_runs_once_per_customer', 'uniq_marketing_messages_campaign_customer') ORDER BY name",
		)
		expect(indexes).toHaveLength(2)
		expect(await rows(client, 'PRAGMA foreign_key_check')).toEqual([])
	})
})
