import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTenantMigrations } from './migrations.ts'
import * as schema from './schema.ts'

const LOYALTY_TABLES = [
	'loyalty_approvals',
	'loyalty_audit_log',
	'loyalty_balances',
	'loyalty_idempotency_keys',
	'loyalty_ledger',
	'loyalty_member_bindings',
	'loyalty_member_codes',
	'loyalty_members',
	'loyalty_outbox',
	'loyalty_program_versions',
	'loyalty_programs',
	'loyalty_purchases',
	'loyalty_rate_counters',
	'loyalty_redemptions',
	'loyalty_refunds',
	'loyalty_reward_versions',
	'loyalty_rewards',
] as const

const LOYALTY_TRIGGERS = [
	'loyalty_audit_log_no_delete',
	'loyalty_audit_log_no_update',
	'loyalty_balances_no_delete',
	'loyalty_ledger_no_delete',
	'loyalty_ledger_no_update',
	'loyalty_member_codes_single_use',
	'loyalty_members_customer_fixed',
	'loyalty_members_erased_final',
	'loyalty_members_no_delete',
	'loyalty_program_versions_no_delete',
	'loyalty_program_versions_no_update',
	'loyalty_programs_currency_locked',
	'loyalty_programs_no_delete',
	'loyalty_purchases_identity_fixed',
	'loyalty_purchases_no_delete',
	'loyalty_redemptions_born_open',
	'loyalty_redemptions_fixed',
	'loyalty_redemptions_no_delete',
	'loyalty_redemptions_transition',
	'loyalty_refunds_no_delete',
	'loyalty_refunds_no_update',
	'loyalty_reward_versions_no_delete',
	'loyalty_reward_versions_no_update',
	'loyalty_rewards_no_delete',
] as const

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

describe('loyalty tenant schema (0025_loyalty)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-loyalty-schema-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		await client.execute('PRAGMA foreign_keys = ON')
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		return { client, db }
	}

	async function seed(client: Client) {
		await client.execute(
			"INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Ada', '+15550000001')",
		)
		await client.execute(
			"INSERT INTO loyalty_programs (id, status, current_version, currency) VALUES ('default', 'draft', 1, 'USD')",
		)
		await client.execute(
			"INSERT INTO loyalty_program_versions (id, program_id, version, status, method, currency, config, effective_at) VALUES ('pv_1', 'default', 1, 'draft', 'spend', 'USD', '{}', 0)",
		)
		await client.execute(
			"INSERT INTO loyalty_rewards (id, kind, name, points_cost, currency) VALUES ('rw_1', 'order', 'Five off', 100, 'USD')",
		)
		await client.execute(
			"INSERT INTO loyalty_reward_versions (id, reward_id, version, status, currency, definition) VALUES ('rv_1', 'rw_1', 1, 'active', 'USD', '{}')",
		)
		await client.execute(
			"INSERT INTO loyalty_members (id, customer_id) VALUES ('m_1', 'cust_1')",
		)
		await client.execute(
			"INSERT INTO loyalty_balances (member_id, points) VALUES ('m_1', 0)",
		)
	}

	async function insertRedemption(
		client: Client,
		id: string,
		state: string,
		sourceId: string | null,
	) {
		await client.execute({
			sql: `INSERT INTO loyalty_redemptions (id, member_id, reward_id, reward_version, reward_name, reward_snapshot, points, state, channel, source_type, source_id, currency, cart_hash, discount_minor, allocation)
				VALUES (?, 'm_1', 'rw_1', 1, 'Five off', '{}', 100, ?, 'web', ?, ?, 'USD', 'hash', 500, '[]')`,
			args: [id, state, sourceId ? 'restaurant_order' : null, sourceId],
		})
	}

	it('creates every loyalty table and trigger, and re-running is a no-op', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'loyalty_%' ORDER BY name",
		)
		expect(tables.rows.map((row) => String(row.name))).toEqual([
			...LOYALTY_TABLES,
		])
		const triggers = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'loyalty_%' ORDER BY name",
		)
		expect(triggers.rows.map((row) => String(row.name))).toEqual([
			...LOYALTY_TRIGGERS,
		])
		const orderColumns = await client.execute(
			'PRAGMA table_info(restaurant_orders)',
		)
		expect(orderColumns.rows.map((row) => String(row.name))).toContain(
			'loyalty_discount_cents',
		)
		const tabColumns = await client.execute('PRAGMA table_info(qr_tabs)')
		expect(tabColumns.rows.map((row) => String(row.name))).toEqual(
			expect.arrayContaining(['loyalty_discount_cents', 'rung_up_on_station']),
		)
	})

	it('keeps the ledger append-only, allowing only erasure of the note', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, reason, note, actor_kind) VALUES ('l_1', 'm_1', 'adjust', 50, 'adjust:m_1:k1', 'goodwill', 'Called about a late order', 'operator')",
		)
		await expectRejectsWith(
			client.execute("UPDATE loyalty_ledger SET delta = 500 WHERE id = 'l_1'"),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_ledger SET note = 'rewritten' WHERE id = 'l_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_ledger WHERE id = 'l_1'"),
			'append-only',
		)
		await client.execute(
			"UPDATE loyalty_ledger SET note = NULL WHERE id = 'l_1'",
		)
		const row = await client.execute(
			"SELECT note, delta FROM loyalty_ledger WHERE id = 'l_1'",
		)
		expect(row.rows[0]).toMatchObject({ note: null, delta: 50 })
	})

	it('enforces entry signs, adjustment reasons and unique event keys', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_bad', 'm_1', 'earn', -5, 'earn:p_x', 'system')",
			),
			'chk_loyalty_ledger_delta_sign',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_bad2', 'm_1', 'redeem', 5, 'redeem:r_x', 'system')",
			),
			'chk_loyalty_ledger_delta_sign',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_bad3', 'm_1', 'adjust', 5, 'adjust:m_1:k9', 'operator')",
			),
			'chk_loyalty_ledger_adjust_reason',
		)
		await client.execute(
			"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_2', 'm_1', 'earn', 5, 'earn:p_1', 'system')",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_3', 'm_1', 'earn', 5, 'earn:p_1', 'system')",
			),
			'UNIQUE',
		)
	})

	it('allows only the planned redemption transitions', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await insertRedemption(client, 'r_1', 'reserved', null)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET state = 'consumed' WHERE id = 'r_1'",
			),
			'transition not allowed',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET state = 'bound' WHERE id = 'r_1'",
			),
			'chk_loyalty_redemptions_bound_source',
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'bound', source_type = 'restaurant_order', source_id = 'o_1' WHERE id = 'r_1'",
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'review' WHERE id = 'r_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET state = 'bound' WHERE id = 'r_1'",
			),
			'transition not allowed',
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'consumed' WHERE id = 'r_1'",
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'restored' WHERE id = 'r_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET state = 'consumed' WHERE id = 'r_1'",
			),
			'transition not allowed',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_redemptions WHERE id = 'r_1'"),
			'rows are kept',
		)
	})

	it('fixes what a bound redemption is for and keeps one reward per source', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await insertRedemption(client, 'r_1', 'bound', 'o_1')
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET discount_minor = 900 WHERE id = 'r_1'",
			),
			'facts are fixed',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET source_id = 'o_2' WHERE id = 'r_1'",
			),
			'facts are fixed',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_redemptions SET points = 1 WHERE id = 'r_1'",
			),
			'facts are fixed',
		)
		await expectRejectsWith(
			insertRedemption(client, 'r_2', 'bound', 'o_1'),
			'UNIQUE',
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'released', release_reason = 'cancelled' WHERE id = 'r_1'",
		)
		await insertRedemption(client, 'r_2', 'bound', 'o_1')
	})

	it('never revives an erased member or re-points a member at another customer', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO customers (id, name, phone) VALUES ('cust_2', 'Bo', '+15550000002')",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET customer_id = 'cust_2' WHERE id = 'm_1'",
			),
			'customer link is fixed',
		)
		await client.execute(
			"UPDATE loyalty_members SET status = 'erased', customer_id = NULL, erased_at = 1 WHERE id = 'm_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET status = 'active' WHERE id = 'm_1'",
			),
			'member is erased',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET customer_id = 'cust_1' WHERE id = 'm_1'",
			),
			'loyalty member',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_members WHERE id = 'm_1'"),
			'erased, not deleted',
		)
	})

	it('drops the customer link when the customer row is deleted', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute("DELETE FROM customers WHERE id = 'cust_1'")
		const row = await client.execute(
			"SELECT customer_id FROM loyalty_members WHERE id = 'm_1'",
		)
		expect(row.rows[0]?.customer_id).toBeNull()
	})

	it('locks the program currency once active and keeps one program row', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"UPDATE loyalty_programs SET currency = 'SAR' WHERE id = 'default'",
		)
		await client.execute(
			"UPDATE loyalty_programs SET status = 'active', activated_at = 1 WHERE id = 'default'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_programs SET currency = 'USD' WHERE id = 'default'",
			),
			'currency is locked',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_programs (id, current_version, currency) VALUES ('other', 1, 'USD')",
			),
			'chk_loyalty_programs_singleton',
		)
	})

	it('keeps program and reward versions immutable', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_program_versions SET config = '{\"x\":1}' WHERE id = 'pv_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_reward_versions WHERE id = 'rv_1'"),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_reward_versions SET definition = '{}' WHERE id = 'rv_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_rewards WHERE id = 'rw_1'"),
			'archived, not deleted',
		)
	})

	it('uses a member code once and never holds negative reserved points', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO loyalty_member_codes (id, member_id, code_hash, expires_at) VALUES ('c_1', 'm_1', 'h1', 9999999999999)",
		)
		await client.execute(
			"UPDATE loyalty_member_codes SET used_at = 1, used_by_device_id = 'dev_1' WHERE id = 'c_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_member_codes SET used_by_device_id = 'dev_2' WHERE id = 'c_1'",
			),
			'already used',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_balances SET reserved = -1 WHERE member_id = 'm_1'",
			),
			'chk_loyalty_balances_reserved',
		)
		// Points debt is allowed.
		await client.execute(
			"UPDATE loyalty_balances SET points = -40 WHERE member_id = 'm_1'",
		)
	})

	it('never records a till approval for no points or a negative discount', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		const insertApproval = (id: string, pointsCost: number, discount: number) =>
			client.execute({
				sql: `INSERT INTO loyalty_approvals (id, member_id, device_id, sale_id, reward_id, reward_version, reward_name, points_cost, currency, discount_minor, allocation, cart, cart_hash, expires_at)
					VALUES (?, 'm_1', 'dev_1', ?, 'rw_1', 1, 'Five off', ?, 'USD', ?, '[]', '{}', 'hash', 9999999999999)`,
				args: [id, `sale_${id}`, pointsCost, discount],
			})
		await expectRejectsWith(
			insertApproval('ap_1', 0, 500),
			'chk_loyalty_approvals_points',
		)
		await expectRejectsWith(
			insertApproval('ap_2', 100, -1),
			'chk_loyalty_approvals_discount',
		)
		await insertApproval('ap_3', 100, 0)
	})

	it('awards one visit per member per local day and one purchase per source', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, state, visit_date, visit_awarded) VALUES ('p_1', 'm_1', 'pos_order', 's_1', 'pos', 'USD', 'completed', '2026-10-27', 1)",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, state, visit_date, visit_awarded) VALUES ('p_2', 'm_1', 'restaurant_order', 'o_1', 'web', 'USD', 'completed', '2026-10-27', 1)",
			),
			'UNIQUE',
		)
		await client.execute(
			"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, state, visit_date, visit_awarded) VALUES ('p_2', 'm_1', 'restaurant_order', 'o_1', 'web', 'USD', 'completed', '2026-10-27', 0)",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency) VALUES ('p_3', 'm_1', 'pos_order', 's_1', 'pos', 'USD')",
			),
			'UNIQUE',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_purchases SET reversed_points = 10 WHERE id = 'p_1'",
			),
			'chk_loyalty_purchases_points',
		)
	})

	it('keeps refunds and the audit log append-only, allowing only redaction', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO loyalty_refunds (id, source_type, source_id, amount_minor, currency, note, actor_id, idempotency_key) VALUES ('rf_1', 'restaurant_order', 'o_1', 500, 'USD', 'Cold food', 'user_1', 'k1')",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_refunds SET amount_minor = 5 WHERE id = 'rf_1'",
			),
			'append-only',
		)
		await client.execute(
			"UPDATE loyalty_refunds SET note = NULL WHERE id = 'rf_1'",
		)
		await client.execute(
			"INSERT INTO loyalty_audit_log (id, actor_kind, action, entity_type, entity_id, changes) VALUES ('a_1', 'operator', 'reward.created', 'reward', 'rw_1', '{\"points\":100}')",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_audit_log SET action = 'x' WHERE id = 'a_1'",
			),
			'append-only',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_audit_log SET changes = NULL WHERE id = 'a_1'",
			),
			'append-only',
		)
		await client.execute(
			"UPDATE loyalty_audit_log SET changes = '{\"redacted\":true}' WHERE id = 'a_1'",
		)
		await expectRejectsWith(
			client.execute("DELETE FROM loyalty_audit_log WHERE id = 'a_1'"),
			'append-only',
		)
	})

	it('refuses a value outside an enum, even from a write that bypasses Drizzle', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET status = 'banned' WHERE id = 'm_1'",
			),
			'chk_loyalty_members_status',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, channel, actor_kind) VALUES ('l_bad', 'm_1', 'earn', 5, 'earn:bad', 'carrier_pigeon', 'system')",
			),
			'chk_loyalty_ledger_channel',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_outbox (source_type, source_id, status) VALUES ('qr_tab', 't_1', 'stuck')",
			),
			'chk_loyalty_outbox_status',
		)
		// A nullable enum column stays nullable.
		await client.execute(
			"INSERT INTO loyalty_ledger (id, member_id, type, delta, event_key, actor_kind) VALUES ('l_ok', 'm_1', 'earn', 5, 'earn:ok', 'system')",
		)
	})

	it('creates a redemption reserved or bound, never already finished', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await expectRejectsWith(
			insertRedemption(client, 'r_done', 'consumed', 'o_1'),
			'start reserved or bound',
		)
		await insertRedemption(client, 'r_1', 'reserved', null)
		await insertRedemption(client, 'r_2', 'bound', 'o_2')
	})

	it('freezes where a finished redemption happened, who approved it and its expiry', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await insertRedemption(client, 'r_1', 'reserved', null)
		await client.execute(
			"UPDATE loyalty_redemptions SET device_id = 'dev_1', location_id = 'loc_1', approval_id = 'ap_1', expires_at = 1000 WHERE id = 'r_1'",
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'bound', source_type = 'restaurant_order', source_id = 'o_1', expires_at = NULL WHERE id = 'r_1'",
		)
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'consumed' WHERE id = 'r_1'",
		)
		for (const change of [
			"device_id = 'dev_2'",
			"location_id = 'loc_2'",
			"approval_id = 'ap_2'",
			'expires_at = 5',
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE loyalty_redemptions SET ${change} WHERE id = 'r_1'`,
				),
				'facts are fixed',
			)
		}
		await client.execute(
			"UPDATE loyalty_redemptions SET state = 'restored' WHERE id = 'r_1'",
		)
	})

	it('keeps a purchase tied to its member and source', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"INSERT INTO loyalty_members (id, customer_id) VALUES ('m_2', NULL)",
		)
		await client.execute(
			"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency) VALUES ('p_1', 'm_1', 'restaurant_order', 'o_p1', 'web', 'USD')",
		)
		for (const change of [
			"member_id = 'm_2'",
			"source_id = 'o_other'",
			"source_type = 'qr_tab'",
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE loyalty_purchases SET ${change} WHERE id = 'p_1'`,
				),
				'identity is fixed',
			)
		}
		await client.execute(
			"UPDATE loyalty_purchases SET state = 'completed', awarded_points = 10 WHERE id = 'p_1'",
		)
	})

	it('needs the day on a visit award, so one visit per day cannot be dodged with NULL', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, visit_awarded) VALUES ('p_1', 'm_1', 'restaurant_order', 'o_1', 'web', 'USD', 1)",
			),
			'chk_loyalty_purchases_visit_date',
		)
		await client.execute(
			"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, visit_awarded, visit_date) VALUES ('p_1', 'm_1', 'restaurant_order', 'o_1', 'web', 'USD', 1, '2026-10-29')",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO loyalty_purchases (id, member_id, source_type, source_id, channel, currency, visit_awarded, visit_date) VALUES ('p_2', 'm_1', 'restaurant_order', 'o_2', 'web', 'USD', 1, '2026-10-29')",
			),
			'UNIQUE',
		)
	})

	it('keeps an erased member erased, including when they were erased', async () => {
		const { client } = await openMigratedDb()
		await seed(client)
		await client.execute(
			"UPDATE loyalty_members SET status = 'erased', customer_id = NULL, erased_at = 1000 WHERE id = 'm_1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET erased_at = NULL WHERE id = 'm_1'",
			),
			'loyalty member is erased',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE loyalty_members SET status = 'active' WHERE id = 'm_1'",
			),
			'loyalty member is erased',
		)
	})
})
