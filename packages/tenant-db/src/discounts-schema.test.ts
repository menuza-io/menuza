import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTenantMigrations } from './migrations.ts'
import * as schema from './schema.ts'

async function expectRejectsWith(
	promise: Promise<unknown>,
	substring: string,
): Promise<void> {
	let caught: unknown
	try {
		await promise
	} catch (error) {
		caught = error
	}
	expect(caught, `expected a failure containing "${substring}"`).toBeDefined()
	const text =
		caught instanceof Error
			? `${caught.message} ${String((caught as { cause?: unknown }).cause ?? '')}`
			: String(caught)
	expect(text).toContain(substring)
}

describe('discounts tenant schema (0026_discounts)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-discounts-schema-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		return { client, db }
	}

	async function insertRedemption(
		client: Client,
		id: string,
		options: { state?: string; discountId?: string; sourceId?: string } = {},
	) {
		await client.execute({
			sql: `INSERT INTO discount_redemptions (id, discount_id, discount_version, source_type, source_id, customer_id, state, amount_minor, allocation, snapshot, local_day, local_week)
				VALUES (?, ?, 1, 'order', ?, 'cust_1', ?, 500, '[]', '{}', '2026-10-30', '2026-W44')`,
			args: [
				id,
				options.discountId ?? 'd1',
				options.sourceId ?? `o_${id}`,
				options.state ?? 'reserved',
			],
		})
	}

	it('creates the tables, columns and triggers, and re-running is a no-op', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'discount_%' ORDER BY name",
		)
		expect(tables.rows.map((row) => String(row.name))).toEqual([
			'discount_code_attempts',
			'discount_issued_codes',
			'discount_redemptions',
		])
		const triggers = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'discount_%' ORDER BY name",
		)
		expect(triggers.rows.map((row) => String(row.name))).toEqual([
			'discount_issued_codes_fixed',
			'discount_redemptions_born_reserved',
			'discount_redemptions_fixed',
			'discount_redemptions_no_delete',
			'discount_redemptions_transition',
		])
		const orderColumns = await client.execute(
			'PRAGMA table_info(restaurant_orders)',
		)
		expect(orderColumns.rows.map((row) => String(row.name))).toEqual(
			expect.arrayContaining([
				'discount_cents',
				'delivery_discount_cents',
				'discounts',
			]),
		)
	})

	it('allows one redemption per discount and source', async () => {
		const { client } = await openMigratedDb()
		await insertRedemption(client, 'r1', { sourceId: 'o1' })
		await expectRejectsWith(
			insertRedemption(client, 'r2', { sourceId: 'o1' }),
			'UNIQUE',
		)
		await insertRedemption(client, 'r3', { sourceId: 'o1', discountId: 'd2' })
	})

	it('starts reserved and only moves reserved to consumed or released, consumed to refunded', async () => {
		const { client } = await openMigratedDb()
		await expectRejectsWith(
			insertRedemption(client, 'r0', { state: 'consumed' }),
			'start reserved',
		)
		await insertRedemption(client, 'r1')
		await expectRejectsWith(
			client.execute(
				"UPDATE discount_redemptions SET state = 'refunded' WHERE id = 'r1'",
			),
			'transition not allowed',
		)
		await client.execute(
			"UPDATE discount_redemptions SET state = 'consumed' WHERE id = 'r1'",
		)
		await client.execute(
			"UPDATE discount_redemptions SET state = 'refunded' WHERE id = 'r1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE discount_redemptions SET state = 'consumed' WHERE id = 'r1'",
			),
			'transition not allowed',
		)
		await insertRedemption(client, 'r2')
		await client.execute(
			"UPDATE discount_redemptions SET state = 'released' WHERE id = 'r2'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE discount_redemptions SET state = 'consumed' WHERE id = 'r2'",
			),
			'transition not allowed',
		)
		await expectRejectsWith(
			client.execute("UPDATE discount_redemptions SET state = 'bogus'"),
			'',
		)
	})

	it('freezes the snapshot, amounts and allocation, but lets erasure clear the customer', async () => {
		const { client } = await openMigratedDb()
		await insertRedemption(client, 'r1')
		for (const change of [
			'amount_minor = 1',
			'delivery_amount_minor = 5',
			"allocation = '[{}]'",
			'snapshot = \'{"x":1}\'',
			"discount_id = 'other'",
			"customer_id = 'cust_2'",
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE discount_redemptions SET ${change} WHERE id = 'r1'`,
				),
				'facts are fixed',
			)
		}
		await client.execute(
			"UPDATE discount_redemptions SET customer_id = NULL WHERE id = 'r1'",
		)
		await expectRejectsWith(
			client.execute('DELETE FROM discount_redemptions'),
			'rows are kept',
		)
	})
	it('keeps an issued marketing code fixed, except for unlinking its customer', async () => {
		const { client } = await openMigratedDb()
		await client.execute({
			sql: `INSERT INTO discount_issued_codes
				(id, discount_id, code, normalized_code, source_type, source_id, customer_id, expires_at)
				VALUES ('i1', 'd1', 'HI-ABCDEFGH', 'HIABCDEFGH', 'campaign', 'c1', 'cust1', 1)`,
			args: [],
		})
		await expectRejectsWith(
			client.execute(
				"UPDATE discount_issued_codes SET expires_at = 99 WHERE id = 'i1'",
			),
			'only lose their customer',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE discount_issued_codes SET customer_id = 'cust2' WHERE id = 'i1'",
			),
			'only lose their customer',
		)
		await client.execute(
			"UPDATE discount_issued_codes SET customer_id = NULL WHERE id = 'i1'",
		)
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO discount_issued_codes
					(id, discount_id, code, normalized_code, source_type, source_id, expires_at)
					VALUES ('i2', 'd1', 'HI-ABCDEFGH', 'HIABCDEFGH', 'journey', 'r1:n1', 1)`,
				args: [],
			}),
			'UNIQUE',
		)
	})
})
