import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Client, createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Migration 0045 makes `restaurant_orders.tip_percent` nullable without
 * rebuilding the table (a null percent is an exact tip amount, #118), and adds
 * the service fee columns (#123). Existing orders must keep their percent,
 * their other columns, and every index and trigger on the table.
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

const insertOrder = (
	id: string,
	tipCents: number,
	tipPercent: number | null,
) => ({
	sql: `INSERT INTO restaurant_orders (
		id, org_id, number, payment_method, payment_status, fulfillment,
		location_id, location_name, contact_name, contact_phone, currency,
		subtotal_cents, tax_cents, tip_cents, tip_percent, total_cents, lines,
		idempotency_key, request_hash, receipt_token_hash
	) VALUES (?, 'org', ?, 'online', 'paid', 'pickup', 'loc', 'Main', 'Ada', '+15550100',
		'USD', 2000, 160, ?, ?, 2460, '[]', ?, 'hash', 'rcpt')`,
	args: [id, `N-${id}`, tipCents, tipPercent, `key-${id}`],
})

describe('migration 0045 (tip percent and service fee)', () => {
	let tempDir: string
	let client: Client

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-0045-'))
		client = createClient({ url: `file:${path.join(tempDir, 'test.db')}` })
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, 44),
		})
	})

	afterEach(() => {
		client.close()
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('keeps every existing percent and lets a new order store null', async () => {
		await client.execute(insertOrder('a', 300, 15))
		await client.execute(insertOrder('b', 0, 0))
		const indexesBefore = (
			await client.execute(
				"SELECT name FROM sqlite_master WHERE tbl_name = 'restaurant_orders' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
		).rows.map((row) => String(row.name))

		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, 45),
		})

		const rows = (
			await client.execute(
				'SELECT id, tip_cents, tip_percent, service_fee_cents, service_fee_tax_cents, service_fee_label, total_cents FROM restaurant_orders ORDER BY id',
			)
		).rows.map((row) => ({ ...row }))
		expect(rows).toEqual([
			{
				id: 'a',
				tip_cents: 300,
				tip_percent: 15,
				service_fee_cents: 0,
				service_fee_tax_cents: 0,
				service_fee_label: null,
				total_cents: 2460,
			},
			{
				id: 'b',
				tip_cents: 0,
				tip_percent: 0,
				service_fee_cents: 0,
				service_fee_tax_cents: 0,
				service_fee_label: null,
				total_cents: 2460,
			},
		])

		await client.execute(insertOrder('c', 437, null))
		const custom = (
			await client.execute(
				"SELECT tip_cents, tip_percent FROM restaurant_orders WHERE id = 'c'",
			)
		).rows[0]
		expect({ ...custom }).toEqual({ tip_cents: 437, tip_percent: null })

		const indexesAfter = (
			await client.execute(
				"SELECT name FROM sqlite_master WHERE tbl_name = 'restaurant_orders' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
		).rows.map((row) => String(row.name))
		expect(indexesAfter).toEqual(indexesBefore)
	})

	it('adds the fee columns to tabs and refunds with zero defaults', async () => {
		await migrate(drizzle(client), {
			migrationsFolder: migrationsUpTo(tempDir, 45),
		})
		for (const [table, column] of [
			['qr_tabs', 'service_fee_cents'],
			['qr_tabs', 'service_fee_tax_cents'],
			['qr_tabs', 'service_fee_label'],
			['qr_tabs', 'payment_service_fee_cents'],
			['qr_tabs', 'payment_service_fee_tax_cents'],
			['qr_tabs', 'payment_service_fee_label'],
			['restaurant_order_refunds', 'service_fee_cents'],
		] as const) {
			const columns = (
				await client.execute(`PRAGMA table_info(${table})`)
			).rows.map((row) => String(row.name))
			expect(columns, `${table}.${column}`).toContain(column)
		}
	})
})
