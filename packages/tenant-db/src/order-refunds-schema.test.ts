import fs, { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
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

describe('order refunds tenant schema (0025_loyalty, 0044)', () => {
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
			'restaurant_order_refunds_valid_insert',
			'restaurant_orders_cancel_fields_valid',
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

	async function insertProviderRefund(
		client: Client,
		input: {
			id: string
			orderId: string
			amount: number
			key: string
			status?: string
			processor?: string | null
			sessionId?: string | null
		},
	) {
		await client.execute({
			sql: `INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, note, actor_id, idempotency_key, request_hash, kind, status, origin, processor, session_id)
				VALUES (?, ?, ?, 'USD', 'Cold food', 'user_1', ?, 'hash', 'provider', ?, 'operator', ?, ?)`,
			args: [
				input.id,
				input.orderId,
				input.amount,
				input.key,
				input.status ?? 'pending',
				input.processor === undefined ? 'connect' : input.processor,
				input.sessionId === undefined ? 'cs_test_1' : input.sessionId,
			],
		})
	}

	async function refundRow(client: Client, id: string) {
		const result = await client.execute({
			sql: 'SELECT * FROM restaurant_order_refunds WHERE id = ?',
			args: [id],
		})
		return result.rows[0]!
	}

	it('reads a record refund without the new columns as record, succeeded, operator', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 250,
			key: 'k1',
		})
		expect(await refundRow(client, 'rf_1')).toMatchObject({
			kind: 'record',
			status: 'succeeded',
			origin: 'operator',
			processor: null,
			session_id: null,
			provider_refund_id: null,
			failure_code: null,
			settled_at: null,
		})
	})

	it('refuses new rows that break the kind and status rules', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		// A record is always succeeded and never names a provider.
		await expectRejectsWith(
			client.execute(
				`INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, actor_id, idempotency_key, request_hash, kind, status)
				VALUES ('rf_x', 'o_1', 100, 'USD', 'user_1', 'kx', 'hash', 'record', 'pending')`,
			),
			'invalid new refund',
		)
		await expectRejectsWith(
			client.execute(
				`INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, actor_id, idempotency_key, request_hash, processor, session_id)
				VALUES ('rf_y', 'o_1', 100, 'USD', 'user_1', 'ky', 'hash', 'connect', 'cs_1')`,
			),
			'invalid new refund',
		)
		// A provider refund starts pending, with its processor and payment.
		await expectRejectsWith(
			insertProviderRefund(client, {
				id: 'rf_a',
				orderId: 'o_1',
				amount: 100,
				key: 'ka',
				status: 'succeeded',
			}),
			'invalid new refund',
		)
		await expectRejectsWith(
			insertProviderRefund(client, {
				id: 'rf_b',
				orderId: 'o_1',
				amount: 100,
				key: 'kb',
				processor: null,
			}),
			'invalid new refund',
		)
		await expectRejectsWith(
			insertProviderRefund(client, {
				id: 'rf_c',
				orderId: 'o_1',
				amount: 100,
				key: 'kc',
				processor: 'paypal',
			}),
			'invalid new refund',
		)
		await expectRejectsWith(
			insertProviderRefund(client, {
				id: 'rf_d',
				orderId: 'o_1',
				amount: 100,
				key: 'kd',
				sessionId: null,
			}),
			'invalid new refund',
		)
		await expectRejectsWith(
			client.execute(
				`INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, actor_id, idempotency_key, request_hash, origin)
				VALUES ('rf_e', 'o_1', 100, 'USD', 'user_1', 'ke', 'hash', 'robot')`,
			),
			'invalid new refund',
		)
	})

	it('allows one pending provider refund per order, beside any number of records', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertOrder(client, 'o_2')
		await insertProviderRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 100,
			key: 'k1',
		})
		await expectRejectsWith(
			insertProviderRefund(client, {
				id: 'rf_2',
				orderId: 'o_1',
				amount: 100,
				key: 'k2',
			}),
			'UNIQUE',
		)
		// Records and other orders are not limited.
		await insertRefund(client, {
			id: 'rf_3',
			orderId: 'o_1',
			amount: 50,
			key: 'k3',
		})
		await insertProviderRefund(client, {
			id: 'rf_4',
			orderId: 'o_2',
			amount: 100,
			key: 'k4',
			sessionId: 'cs_test_2',
		})
		// Once settled, the next one may start.
		await client.execute(
			"UPDATE restaurant_order_refunds SET status = 'failed', failure_code = 'card_expired', settled_at = 1, updated_at = 1 WHERE id = 'rf_1'",
		)
		await insertProviderRefund(client, {
			id: 'rf_5',
			orderId: 'o_1',
			amount: 100,
			key: 'k5',
		})
		const pending = await client.execute(
			"SELECT id FROM restaurant_order_refunds WHERE status = 'pending' ORDER BY id",
		)
		expect(pending.rows.map((row) => String(row.id))).toEqual(['rf_4', 'rf_5'])
	})

	it('settles a pending provider refund once, keeping everything else immutable', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertProviderRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 300,
			key: 'k1',
		})
		// The provider's id may arrive before the final status.
		await client.execute(
			"UPDATE restaurant_order_refunds SET provider_refund_id = 're_1', updated_at = 5 WHERE id = 'rf_1'",
		)
		// ...but never changes once set.
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET provider_refund_id = 're_2' WHERE id = 'rf_1'",
			),
			'append-only',
		)
		// Settling needs a settle time; a success carries no failure code.
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET status = 'succeeded' WHERE id = 'rf_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET status = 'succeeded', failure_code = 'x', settled_at = 9 WHERE id = 'rf_1'",
			),
			'append-only',
		)
		// Amount, order, kind and payment stay as booked.
		for (const change of [
			'amount_cents = 1',
			"order_id = 'o_1x'",
			"kind = 'record'",
			"session_id = 'cs_other'",
			"processor = 'checkout'",
			"origin = 'system'",
			"status = 'unknown', settled_at = 9",
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE restaurant_order_refunds SET ${change} WHERE id = 'rf_1'`,
				),
				'append-only',
			)
		}
		await client.execute(
			"UPDATE restaurant_order_refunds SET status = 'succeeded', settled_at = 9, updated_at = 9 WHERE id = 'rf_1'",
		)
		expect(await refundRow(client, 'rf_1')).toMatchObject({
			status: 'succeeded',
			provider_refund_id: 're_1',
			settled_at: 9,
			amount_cents: 300,
		})
		// Final: neither back to pending nor over to failed.
		for (const change of [
			"status = 'pending', settled_at = NULL",
			"status = 'failed', failure_code = 'x'",
			'settled_at = 10',
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE restaurant_order_refunds SET ${change} WHERE id = 'rf_1'`,
				),
				'append-only',
			)
		}
		// Erasure may still clear the note, and only the note.
		await client.execute(
			"UPDATE restaurant_order_refunds SET note = NULL WHERE id = 'rf_1'",
		)
		await expectRejectsWith(
			client.execute("DELETE FROM restaurant_order_refunds WHERE id = 'rf_1'"),
			'append-only',
		)
	})

	it('fails a pending refund without a provider id, and keeps a failure final', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertProviderRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 300,
			key: 'k1',
		})
		await client.execute(
			"UPDATE restaurant_order_refunds SET status = 'failed', failure_code = 'provider_error', settled_at = 7, updated_at = 7 WHERE id = 'rf_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET status = 'succeeded', failure_code = NULL WHERE id = 'rf_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET provider_refund_id = 're_late' WHERE id = 'rf_1'",
			),
			'append-only',
		)
		// A record can never be moved either.
		await insertRefund(client, {
			id: 'rf_2',
			orderId: 'o_1',
			amount: 50,
			key: 'k2',
		})
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET status = 'failed', settled_at = 1 WHERE id = 'rf_2'",
			),
			'append-only',
		)
	})

	it('keeps provider refund ids unique', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await insertOrder(client, 'o_2')
		await insertProviderRefund(client, {
			id: 'rf_1',
			orderId: 'o_1',
			amount: 100,
			key: 'k1',
		})
		await insertProviderRefund(client, {
			id: 'rf_2',
			orderId: 'o_2',
			amount: 100,
			key: 'k2',
		})
		await client.execute(
			"UPDATE restaurant_order_refunds SET provider_refund_id = 're_1' WHERE id = 'rf_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE restaurant_order_refunds SET provider_refund_id = 're_1' WHERE id = 'rf_2'",
			),
			'UNIQUE',
		)
	})

	it('validates cancel, reject and dispute values on orders', async () => {
		const { client } = await openMigratedDb()
		await insertOrder(client, 'o_1')
		await client.execute(
			"UPDATE restaurant_orders SET status = 'pending_acceptance', acceptance_deadline_at = 100 WHERE id = 'o_1'",
		)
		await client.execute(
			"UPDATE restaurant_orders SET status = 'cancelled', cancel_reason = 'not_accepted_in_time', rejected_reason = 'not_accepted_in_time', cancelled_by = 'system', dispute_status = 'open', disputed_at = 5 WHERE id = 'o_1'",
		)
		for (const change of [
			"cancel_reason = 'bored'",
			"rejected_reason = 'bored'",
			"cancelled_by = 'robot'",
			"dispute_status = 'maybe'",
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE restaurant_orders SET ${change} WHERE id = 'o_1'`,
				),
				'invalid cancel or dispute value',
			)
		}
		const order = await client.execute(
			"SELECT status, cancel_reason, cancelled_by, rejected_reason, dispute_status FROM restaurant_orders WHERE id = 'o_1'",
		)
		expect(order.rows[0]).toMatchObject({
			status: 'cancelled',
			cancel_reason: 'not_accepted_in_time',
			cancelled_by: 'system',
			rejected_reason: 'not_accepted_in_time',
			dispute_status: 'open',
		})
	})
})

describe('migration 0044 on refunds recorded before it', () => {
	const drizzleDir = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		'../drizzle',
	)
	let tempDir: string

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it('reads existing refunds as record, succeeded, operator and keeps them append-only', async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), 'tenant-db-0044-'))
		const folder = path.join(tempDir, 'drizzle-43')
		fs.cpSync(drizzleDir, folder, { recursive: true })
		const journalPath = path.join(folder, 'meta/_journal.json')
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
			entries: Array<{ idx: number }>
		}
		journal.entries = journal.entries.filter((entry) => entry.idx <= 43)
		fs.writeFileSync(journalPath, JSON.stringify(journal))

		const client = createClient({
			url: `file:${path.join(tempDir, 'tenant.db')}`,
		})
		try {
			await migrate(drizzle(client), { migrationsFolder: folder })
			await client.execute(
				`INSERT INTO restaurant_orders (id, org_id, number, payment_method, payment_status, fulfillment, location_id, location_name, contact_name, contact_phone, currency, subtotal_cents, tax_cents, total_cents, lines, idempotency_key, request_hash, receipt_token_hash)
				VALUES ('o_old', 'org_test', 'N-1', 'online', 'paid', 'pickup', 'loc_1', 'Main', 'Ada', '+15550000001', 'USD', 1000, 0, 1000, '[]', 'idem', 'hash', 'rcpt')`,
			)
			await client.execute(
				`INSERT INTO restaurant_order_refunds (id, order_id, amount_cents, currency, note, actor_id, idempotency_key, request_hash)
				VALUES ('rf_old', 'o_old', 400, 'USD', 'Late', 'user_1', 'k1', 'hash')`,
			)
			await client.execute(
				"UPDATE restaurant_orders SET refunded_cents = 400 WHERE id = 'o_old'",
			)

			await migrate(drizzle(client), { migrationsFolder: drizzleDir })

			const refund = await client.execute(
				"SELECT kind, status, origin, amount_cents, settled_at FROM restaurant_order_refunds WHERE id = 'rf_old'",
			)
			expect(refund.rows[0]).toMatchObject({
				kind: 'record',
				status: 'succeeded',
				origin: 'operator',
				amount_cents: 400,
				settled_at: null,
			})
			const order = await client.execute(
				"SELECT refunded_cents, cancel_reason, dispute_status FROM restaurant_orders WHERE id = 'o_old'",
			)
			expect(order.rows[0]).toMatchObject({
				refunded_cents: 400,
				cancel_reason: null,
				dispute_status: null,
			})
			await expectRejectsWith(
				client.execute(
					"UPDATE restaurant_order_refunds SET status = 'failed', settled_at = 1 WHERE id = 'rf_old'",
				),
				'append-only',
			)
			await expectRejectsWith(
				client.execute(
					"UPDATE restaurant_orders SET refunded_cents = 100 WHERE id = 'o_old'",
				),
				'only add up to the total',
			)
		} finally {
			client.close()
		}
	})
})

describe('QR tab refunds (0044)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openWithTab() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-tab-refunds-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		await client.execute('PRAGMA foreign_keys = ON')
		await applyTenantMigrations(drizzle(client, { schema }), 'org_test')
		await client.execute(
			"INSERT INTO qr_tables (id, location_id, label) VALUES ('tbl_1', 'loc_1', 'T1')",
		)
		await client.execute(
			"INSERT INTO qr_tabs (id, table_id, location_id, table_label, tab_number, opened_day, currency) VALUES ('tab_1', 'tbl_1', 'loc_1', 'T1', '1', '2026-11-14', 'USD')",
		)
		await client.execute(
			"INSERT INTO qr_tab_payments (id, tab_id, session_id, processor, amount_cents, currency) VALUES ('tp_1', 'tab_1', 'pay_1', 'checkout', 900, 'USD')",
		)
		return client
	}

	async function insertTabRefund(
		client: Client,
		input: {
			id: string
			key: string
			status?: string
			tabPaymentId?: string | null
		},
	) {
		await client.execute({
			sql: `INSERT INTO qr_tab_refunds (id, tab_id, tab_payment_id, amount_cents, currency, actor_id, origin, status, processor, session_id, idempotency_key, request_hash)
				VALUES (?, 'tab_1', ?, 500, 'USD', 'user_1', 'operator', ?, 'checkout', 'pay_1', ?, 'hash')`,
			args: [
				input.id,
				input.tabPaymentId === undefined ? 'tp_1' : input.tabPaymentId,
				input.status ?? 'pending',
				input.key,
			],
		})
	}

	it('books tab refunds pending, one at a time, settled once and never deleted', async () => {
		const client = await openWithTab()
		await expectRejectsWith(
			insertTabRefund(client, { id: 'tr_0', key: 'k0', status: 'succeeded' }),
			'invalid new refund',
		)
		await insertTabRefund(client, { id: 'tr_1', key: 'k1' })
		await expectRejectsWith(
			insertTabRefund(client, { id: 'tr_2', key: 'k2', tabPaymentId: null }),
			'UNIQUE',
		)
		await client.execute(
			"UPDATE qr_tab_refunds SET provider_refund_id = 'rfd_1' WHERE id = 'tr_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE qr_tab_refunds SET amount_cents = 1 WHERE id = 'tr_1'",
			),
			'append-only',
		)
		await client.execute(
			"UPDATE qr_tab_refunds SET status = 'succeeded', settled_at = 3, updated_at = 3 WHERE id = 'tr_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE qr_tab_refunds SET status = 'failed', settled_at = 4 WHERE id = 'tr_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM qr_tab_refunds WHERE id = 'tr_1'"),
			'append-only',
		)
		await expectRejectsWith(
			insertTabRefund(client, {
				id: 'tr_4',
				key: 'k4',
				tabPaymentId: 'tp_missing',
			}),
			'FOREIGN KEY',
		)
		// The tab's own payment (no review row) may be refunded next.
		await insertTabRefund(client, { id: 'tr_3', key: 'k3', tabPaymentId: null })
		client.close()
	})
})
