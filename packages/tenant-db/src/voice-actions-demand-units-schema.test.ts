import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from './schema.ts'

const MIGRATION = '0019_reservations'
const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const drizzleDir = path.join(pkgRoot, 'drizzle')

describe('migration 0019 (reservations): voice call actions and demand units', () => {
	let tempDir: string
	let client: ReturnType<typeof createClient>

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-0019-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
	})

	afterEach(() => {
		try {
			client.close()
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup errors
		}
	})

	/** Everything before 0019 applied, so there is data to backfill. */
	async function migrateBefore0019() {
		const folder = path.join(tempDir, 'before')
		fs.cpSync(drizzleDir, folder, { recursive: true })
		const journalPath = path.join(folder, 'meta', '_journal.json')
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ tag: string }>
		}
		journal.entries = journal.entries.filter((e) => e.tag !== MIGRATION)
		fs.writeFileSync(journalPath, JSON.stringify(journal))
		await migrate(drizzle(client, { schema }), { migrationsFolder: folder })
	}

	it('is the last journal entry and additive only', () => {
		const journal = JSON.parse(
			fs.readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8'),
		) as { entries: Array<{ tag: string }> }
		expect(journal.entries.map((e) => e.tag)).toContain(MIGRATION)
		const sql = fs.readFileSync(
			path.join(drizzleDir, `${MIGRATION}.sql`),
			'utf8',
		)
		expect(sql).not.toMatch(/\bDROP\b/i)
	})

	it('adds the action log with the (call_id, action) index', async () => {
		await migrate(drizzle(client, { schema }), { migrationsFolder: drizzleDir })
		const columns = await client.execute(
			'PRAGMA table_info(voice_call_actions)',
		)
		expect(columns.rows.map((r) => r.name)).toEqual([
			'id',
			'call_id',
			'action',
			'outcome',
			'dry_run',
			'created_at',
		])
		const indexes = await client.execute(
			'PRAGMA index_list(voice_call_actions)',
		)
		const indexName = indexes.rows.find(
			(r) => r.name === 'idx_voice_call_actions_call_action',
		)?.name
		expect(indexName).toBeDefined()
		const indexed = await client.execute(
			'PRAGMA index_info(idx_voice_call_actions_call_action)',
		)
		expect(indexed.rows.map((r) => r.name)).toEqual(['call_id', 'action'])
	})

	it('backfills the orders standards without losing them', async () => {
		await migrateBefore0019()
		await client.execute(
			`INSERT INTO labor_scope_settings (scope_id, orders_per_labor_hour) VALUES ('loc1', '{"cook":12.5,"server":20}'), ('loc2', '{}')`,
		)
		const sql = fs
			.readFileSync(path.join(drizzleDir, `${MIGRATION}.sql`), 'utf8')
			.split('--> statement-breakpoint')
		for (const statement of sql) await client.execute(statement)

		const rows = await client.execute(
			'SELECT scope_id, orders_per_labor_hour, demand_per_labor_hour FROM labor_scope_settings ORDER BY scope_id',
		)
		expect(JSON.parse(String(rows.rows[0]!.demand_per_labor_hour))).toEqual({
			orders: { cook: 12.5, server: 20 },
		})
		expect(rows.rows[0]!.orders_per_labor_hour).toBe(
			'{"cook":12.5,"server":20}',
		)
		expect(JSON.parse(String(rows.rows[1]!.demand_per_labor_hour))).toEqual({
			orders: {},
		})
	})
})
