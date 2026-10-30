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

describe('order refunds tenant schema (0025_loyalty)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-order-refunds-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		await client.execute('PRAGMA foreign_keys = ON')
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		return { client, db }
	}

	async function insertOrder(client: Client, id: string, totalCents = 1000) {
		await client.execute({
			sql: `INSERT INTO restaurant_orders (id, org_id, number, payment_method, payment_status, fulfillment, location_id, location_name, contact_name, contact_phone, currency, subtotal_cents, tax_cents, total_cents, lines, idempotency_key, request_hash, receipt_token_hash)
				VALUES (?, 'org_test', ?, 'online', 'paid', 'pickup', 'loc_1', 'Main', 'Ada', '+15550000001', 'USD', ?, 0, ?, '[]', ?, 'hash', ?)`,
			args: [id, `N-${id}`, totalCents, totalCents, `idem-${id}`, `rcpt-${id}`],
		})
	}

	async function insertRefund(
		client: Client,
		input: { id: string; orderId: string; amount: number; key: string },
	) {
		await client.execute({
			sql: `INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, note, actor_id, idempotency_key, request_hash)
				VALUES (?, ?, ?, 'USD', 'Cold food', 'user_1', ?, 'hash')`,
			args: [input.id, input.orderId, input.amount, input.key],
		})
	}

	it('creates the refunds table, its triggers and the refunded total, and re-running is a no-op', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restaurant_order_refunds'",
		)
		expect(tables.rows).toHaveLength(1)
		const triggers = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'restaurant_order_refunds_%' OR name LIKE 'restaurant_orders_%') ORDER BY name",
		)
		expect(triggers.rows.map((row) => String(row.name))).toEqual([
			'restaurant_order_refunds_no_delete',
			'restaurant_order_refunds_no_update',
			'restaurant_orders_refunded_cents_guard',
		])
		await insertOrder(client, 'o_1')
		const order = await client.execute(
			"SELECT refunded_cents FROM restaurant_orders WHERE id = 'o_1'",
		)
		expect(Number(order.rows[0]!.refunded_cents)).toBe(0)
	})

	it('keeps refunds append-only, allowing only erasure of the note', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 250,
			key: 'k1',
		})
		const created = await client.execute(
			"SELECT created_at FROM restaurant_order_refunds WHERE id = 'rf_1'",
		)
		// Milliseconds, like the loyalty tables.
		expect(Number(created.rows[0]!.created_at)).toBeGreaterThan(1e12)

		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET amount_cents = 5 WHERE id = 'rf_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET note = 'Something else' WHERE id = 'rf_1'",
			),
			'append-only',
		)
		await client.execute(
			"UPDATE restaurant_order_refunds SET note = NULL WHERE id = 'rf_1'",
		)
		await expectRejectsWith(
			client.execute("DELETE FROM restaurant_order_refunds WHERE id = 'rf_1'"),
			'append-only',
		)
		// The order cannot go while it has refunds.
		await expectRejectsWith(
			client.execute("DELETE FROM restaurant_orders WHERE id = 'o_1'"),
			'FOREIGN KEY',
		)
	})

	it('refuses empty amounts, a reused key on the same order and unknown orders', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertOrder(client, 'o_2')
		await expectRejectsWith(
			insertRefund(client, {
				id: 'rf_0',
				orderId: 'o_1',
				amount: 0,
				key: 'k0',
			}),
			'chk_restaurant_order_refunds_amount',
		)
		await insertRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 100,
			key: 'k1',
		})
		await expectRejectsWith(
			insertRefund(client, {
				id: 'rf_2',
				orderId: 'o_1',
				amount: 100,
				key: 'k1',
			}),
			'UNIQUE',
		)
		// Keys are per order.
		await insertRefund(client, {
			id: 'rf_3',
			orderId: 'o_2',
			amount: 100,
			key: 'k1',
		})
		await expectRejectsWith(
			insertRefund(client, {
				id: 'rf_4',
				orderId: 'o_missing',
				amount: 100,
				key: 'k4',
			}),
			'FOREIGN KEY',
		)
	})

	it('lets the refunded total only grow, never past the order total', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1', 1000)
		await client.execute(
			"UPDATE restaurant_orders SET refunded_cents = 400 WHERE id = 'o_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_orders SET refunded_cents = 300 WHERE id = 'o_1'",
			),
			'only add up to the total',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_orders SET refunded_cents = 1001 WHERE id = 'o_1'",
			),
			'only add up to the total',
		)
		await client.execute(
			"UPDATE restaurant_orders SET refunded_cents = 1000 WHERE id = 'o_1'",
		)
		// Other order updates never trip the guard.
		await client.execute(
			"UPDATE restaurant_orders SET status = 'completed' WHERE id = 'o_1'",
		)
		const order = await client.execute(
			"SELECT refunded_cents, status FROM restaurant_orders WHERE id = 'o_1'",
		)
		expect(order.rows[0]).toMatchObject({
			refunded_cents: 1000,
			status: 'completed',
		})
	})
})
