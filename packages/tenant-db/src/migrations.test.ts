import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTenantMigrations, tenantMigrationsFolder } from './migrations.ts'
import * as schema from './schema.ts'

describe('legacy POS migration recovery', () => {
	const dirs: string[] = []
	const clients: ReturnType<typeof createClient>[] = []

	afterEach(() => {
		for (const client of clients.splice(0)) client.close()
		for (const dir of dirs.splice(0))
			fs.rmSync(dir, { recursive: true, force: true })
	})

	async function openLegacyDb() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-legacy-pos-'))
		dirs.push(dir)
		const folder = path.join(dir, 'drizzle')
		fs.cpSync(tenantMigrationsFolder(), folder, { recursive: true })
		const journalPath = path.join(folder, 'meta', '_journal.json')
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
		journal.entries = journal.entries.slice(0, 21)
		fs.writeFileSync(journalPath, JSON.stringify(journal))
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		clients.push(client)
		const db = drizzle(client, { schema })
		await migrate(db, { migrationsFolder: folder })
		// The original POS baseline and phone-pickup delta predate the
		// consolidated 0020 migration, but together have the same schema.
		await client.execute(
			'DELETE FROM __drizzle_migrations WHERE created_at >= 1792641527810',
		)
		await client.execute({
			sql: 'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?), (?, ?)',
			args: [
				'1cbfd042f5883967d978a68feb796b1dded0f95461c72ce97e633656eee059e8',
				1792632749463,
				'92e35c595cb9e5bafb77886da47a1da11606fb821c974710d9ef35b825e05230',
				1792640118613,
			],
		})
		await client.execute(`
			INSERT INTO pos_devices (id, label, terminal_code, secret_hash, paired_by)
			VALUES ('terminal', 'Test terminal', 'TEST', 'test-hash', 'operator')
		`)
		return { client, db }
	}

	it('preserves a paired terminal and applies later migrations only once', async () => {
		const { client, db } = await openLegacyDb()
		await applyTenantMigrations(db, 'org_test')
		await applyTenantMigrations(db, 'org_test')

		const device = await client.execute(
			"SELECT id, secret_hash, timeclock_enabled, reservations_enabled FROM pos_devices WHERE id = 'terminal'",
		)
		expect(device.rows).toMatchObject([
			{
				id: 'terminal',
				secret_hash: 'test-hash',
				timeclock_enabled: 0,
				reservations_enabled: 0,
			},
		])
		const columns = await client.execute('PRAGMA table_info(pos_zatca_units)')
		expect(columns.rows.map((row) => row.name)).toEqual(
			expect.arrayContaining(['seller', 'auth_failed_at', 'revoked_at']),
		)
		const ledger = await client.execute(
			'SELECT count(*) AS count FROM __drizzle_migrations WHERE created_at = 1792641527810',
		)
		expect(ledger.rows[0]!.count).toBe(1)
	})

	it.each([
		'DROP TABLE pos_held_uploads',
		'ALTER TABLE pos_orders DROP COLUMN pickup_time_zone',
		'DROP INDEX idx_pos_orders_business_date',
		'DROP TRIGGER pos_payments_no_update',
		"UPDATE __drizzle_migrations SET hash = 'unknown' WHERE created_at = 1792640118613",
	])(
		'does not baseline an incomplete or unknown schema: %s',
		async (change) => {
			const { client, db } = await openLegacyDb()
			await client.execute(change)
			await expect(applyTenantMigrations(db, 'org_test')).rejects.toThrow(
				'already exists',
			)
			const ledger = await client.execute(
				'SELECT count(*) AS count FROM __drizzle_migrations WHERE created_at = 1792641527810',
			)
			expect(ledger.rows[0]!.count).toBe(0)
		},
	)
})
