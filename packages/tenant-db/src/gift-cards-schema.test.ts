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

describe('gift cards tenant schema (0047_gift_cards)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-gift-cards-schema-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		return { client, db }
	}

	async function insertCard(
		client: Client,
		id: string,
		options: { status?: string; code?: string | null; external?: string | null } = {},
	) {
		await client.execute({
			sql: `INSERT INTO gift_cards (id, code_hash, external_number_hash, last4, currency, status, source)
				VALUES (?, ?, ?, 'ABCD', 'USD', ?, 'pos')`,
			args: [
				id,
				options.code === undefined ? `hash_${id}` : options.code,
				options.external ?? null,
				options.status ?? 'active',
			],
		})
	}

	async function insertEntry(
		client: Client,
		id: string,
		cardId: string,
		kind: string,
		amount: number,
		extra: { ref?: string; reason?: string } = {},
	) {
		await client.execute({
			sql: `INSERT INTO gift_card_ledger (id, card_id, kind, amount_minor, source_type, channel, idempotency_key, ref_entry_id, reason)
				VALUES (?, ?, ?, ?, 'system', 'system', ?, ?, ?)`,
			args: [id, cardId, kind, amount, `key_${id}`, extra.ref ?? null, extra.reason ?? null],
		})
	}

	async function balance(client: Client, cardId: string) {
		const result = await client.execute({
			sql: 'SELECT COALESCE(SUM(amount_minor), 0) AS total FROM gift_card_ledger WHERE card_id = ?',
			args: [cardId],
		})
		return Number(result.rows[0]!.total)
	}

	it('creates the tables and the order column, and re-running is a no-op', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gift_card%' ORDER BY name",
		)
		expect(tables.rows.map((row) => String(row.name))).toEqual([
			'gift_card_attempts',
			'gift_card_batches',
			'gift_card_idempotency_keys',
			'gift_card_import_runs',
			'gift_card_ledger',
			'gift_card_purchase_attempts',
			'gift_card_show_tokens',
			'gift_cards',
		])
		const columns = await client.execute('PRAGMA table_info(restaurant_orders)')
		expect(columns.rows.map((row) => String(row.name))).toContain('gift_card_cents')
	})

	it('keeps the ledger append-only: no delete, no change to a fact', async () => {
		const { client } = await openMigratedDb()
		await insertCard(client, 'c1')
		await insertEntry(client, 'e1', 'c1', 'issue', 5000)
		await expectRejectsWith(
			client.execute("DELETE FROM gift_card_ledger WHERE id = 'e1'"),
			'gift_card_ledger rows are kept',
		)
		await expectRejectsWith(
			client.execute("UPDATE gift_card_ledger SET amount_minor = 9999 WHERE id = 'e1'"),
			'gift_card_ledger facts are fixed',
		)
		// Erasure may clear the operator note.
		await client.execute("UPDATE gift_card_ledger SET note = NULL WHERE id = 'e1'")
	})

	it('refuses a ledger sign that does not match its kind', async () => {
		const { client } = await openMigratedDb()
		await insertCard(client, 'c1')
		await insertEntry(client, 'seed', 'c1', 'issue', 5000)
		await expectRejectsWith(insertEntry(client, 'bad1', 'c1', 'issue', -100), 'chk_gift_card_ledger_sign')
		await expectRejectsWith(insertEntry(client, 'bad2', 'c1', 'redeem', 100), 'chk_gift_card_ledger_sign')
		await expectRejectsWith(insertEntry(client, 'bad3', 'c1', 'adjust', 100), 'chk_gift_card_ledger_adjust_reason')
		await insertEntry(client, 'ok', 'c1', 'adjust', 100, { reason: 'goodwill' })
	})

	it('never lets the balance go below zero, even past the application lock', async () => {
		const { client } = await openMigratedDb()
		await insertCard(client, 'c1')
		await insertEntry(client, 'e1', 'c1', 'issue', 5000)
		await insertEntry(client, 'r1', 'c1', 'redeem', -3000)
		await expectRejectsWith(
			insertEntry(client, 'r2', 'c1', 'redeem', -2500),
			'gift card balance would go negative',
		)
		await insertEntry(client, 'r3', 'c1', 'redeem', -2000)
		expect(await balance(client, 'c1')).toBe(0)
	})

	it('refuses to redeem a card that is not active', async () => {
		const { client } = await openMigratedDb()
		for (const status of ['inactive', 'held', 'frozen', 'voided', 'expired', 'pending']) {
			await insertCard(client, `c_${status}`, { status })
			await insertEntry(client, `i_${status}`, `c_${status}`, 'issue', 1000)
			await expectRejectsWith(
				insertEntry(client, `r_${status}`, `c_${status}`, 'redeem', -100),
				'gift card is not active',
			)
		}
	})

	it('refuses a refund past the redemption it points at', async () => {
		const { client } = await openMigratedDb()
		await insertCard(client, 'c1')
		await insertEntry(client, 'e1', 'c1', 'issue', 5000)
		await insertEntry(client, 'r1', 'c1', 'redeem', -3000)
		await insertEntry(client, 'f1', 'c1', 'refund', 2000, { ref: 'r1' })
		await expectRejectsWith(
			insertEntry(client, 'f2', 'c1', 'refund', 1500, { ref: 'r1' }),
			'gift card refund exceeds charge',
		)
		await insertEntry(client, 'f3', 'c1', 'refund', 1000, { ref: 'r1' })
		expect(await balance(client, 'c1')).toBe(5000)
	})

	it('needs a code hash or an original number, and each is unique', async () => {
		const { client } = await openMigratedDb()
		await expectRejectsWith(
			insertCard(client, 'c0', { code: null, external: null }),
			'chk_gift_cards_number',
		)
		await insertCard(client, 'c1', { code: 'h1', external: 'x1' })
		await expectRejectsWith(insertCard(client, 'c2', { code: 'h1' }), 'UNIQUE')
		await expectRejectsWith(insertCard(client, 'c3', { code: 'h3', external: 'x1' }), 'UNIQUE')
		await insertCard(client, 'c4', { code: null, external: 'x4' })
	})

	it('keeps the idempotency key unique across the ledger', async () => {
		const { client } = await openMigratedDb()
		await insertCard(client, 'c1')
		await insertEntry(client, 'e1', 'c1', 'issue', 100)
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO gift_card_ledger (id, card_id, kind, amount_minor, source_type, channel, idempotency_key)
					VALUES ('e2', 'c1', 'issue', 100, 'system', 'system', 'key_e1')`,
				args: [],
			}),
			'UNIQUE',
		)
	})
})
