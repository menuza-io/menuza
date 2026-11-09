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

const INVENTORY_TABLES = [
	'inv_audit_log',
	'inv_count_entries',
	'inv_count_list_items',
	'inv_count_lists',
	'inv_counts',
	'inv_deliveries',
	'inv_delivery_lines',
	'inv_idempotency_keys',
	'inv_item_costs',
	'inv_item_place_areas',
	'inv_item_places',
	'inv_item_units',
	'inv_items',
	'inv_movements',
	'inv_settings',
	'inv_storage_areas',
	'inv_supplier_products',
	'inv_suppliers',
	'inv_waste',
]

const INVENTORY_TRIGGERS = [
	'inv_audit_log_no_delete',
	'inv_audit_log_no_update',
	'inv_count_entries_no_delete',
	'inv_count_entries_no_update',
	'inv_count_entries_open_count',
	'inv_counts_closed_final',
	'inv_delivery_lines_no_delete',
	'inv_delivery_lines_no_update',
	'inv_item_units_size_fixed',
	'inv_items_base_unit_fixed',
	'inv_movements_no_delete',
	'inv_movements_no_update',
	'inv_waste_no_delete',
	'inv_waste_no_update',
	'inv_waste_reversal_matches',
]

describe('inventory tenant schema (0033_inventory)', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true })
		}
	})

	async function openMigratedDb() {
		const dir = mkdtempSync(path.join(tmpdir(), 'tenant-inventory-schema-'))
		tempDirs.push(dir)
		const client = createClient({ url: `file:${path.join(dir, 'tenant.db')}` })
		const db = drizzle(client, { schema })
		await applyTenantMigrations(db, 'org_test')
		await client.execute('PRAGMA foreign_keys = ON')
		return { client, db }
	}

	async function insertItem(
		client: Client,
		id: string,
		options: { name?: string; baseUnit?: string; archivedAt?: number } = {},
	) {
		await client.execute({
			sql: 'INSERT INTO inv_items (id, name, base_unit, archived_at) VALUES (?, ?, ?, ?)',
			args: [
				id,
				options.name ?? `Item ${id}`,
				options.baseUnit ?? 'g',
				options.archivedAt ?? null,
			],
		})
	}

	async function insertMovement(client: Client, id: string, itemId: string) {
		await client.execute({
			sql: `INSERT INTO inv_movements (id, location_id, item_id, quantity, value_minor, currency, kind, source_type, source_id, business_date, actor_kind, actor_id, note)
				VALUES (?, 'main', ?, 1500000, 4200, 'SAR', 'delivery', 'delivery_line', 'dl1', '2026-11-08', 'operator', 'user_1', 'first box')`,
			args: [id, itemId],
		})
	}

	async function insertCount(client: Client, id: string, status = 'counting') {
		await client.execute({
			sql: `INSERT INTO inv_counts (id, location_id, status, business_date, started_by_kind, started_by_id, approved_at)
				VALUES (?, 'main', ?, '2026-11-08', 'staff', 'staff_1', ?)`,
			args: [id, status, status === 'approved' ? Date.now() : null],
		})
	}

	async function insertEntry(
		client: Client,
		id: string,
		countId: string,
		itemId: string,
	) {
		await client.execute({
			sql: `INSERT INTO inv_count_entries (id, count_id, item_id, quantity, entered_amount, entered_unit, counter_kind, counter_id, client_id)
				VALUES (?, ?, ?, 2500000, '2.5', 'kg', 'staff', 'staff_1', ?)`,
			args: [id, countId, itemId, `client_${id}`],
		})
	}

	async function insertWaste(
		client: Client,
		id: string,
		itemId: string,
		options: { reversesId?: string; quantity?: number } = {},
	) {
		await client.execute({
			sql: `INSERT INTO inv_waste (id, location_id, item_id, quantity, reason, note, value_minor, currency, actor_kind, actor_id, client_id, reverses_id, business_date)
				VALUES (?, 'main', ?, ?, 'expired', 'left out', 640, 'SAR', 'operator', 'user_1', ?, ?, '2026-11-08')`,
			args: [
				id,
				itemId,
				options.quantity ?? 2_300_000,
				`client_${id}`,
				options.reversesId ?? null,
			],
		})
	}

	it('creates the tables and triggers, and re-running is a no-op', async () => {
		const { client, db } = await openMigratedDb()
		await applyTenantMigrations(db, 'org_test')
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'inv\\_%' ESCAPE '\\' ORDER BY name",
		)
		expect(tables.rows.map((row) => String(row.name))).toEqual(INVENTORY_TABLES)
		const triggers = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'inv\\_%' ESCAPE '\\' ORDER BY name",
		)
		expect(triggers.rows.map((row) => String(row.name))).toEqual(
			INVENTORY_TRIGGERS,
		)
	})

	it('keeps settings to one row with valid values', async () => {
		const { client } = await openMigratedDb()
		await client.execute(
			"INSERT INTO inv_settings (id, unit_system) VALUES ('default', 'metric')",
		)
		const row = await client.execute('SELECT * FROM inv_settings')
		expect(row.rows[0]).toMatchObject({
			target_food_cost_bp: 3000,
			count_day_of_week: null,
			version: 1,
		})
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_settings (id, unit_system) VALUES ('other', 'metric')",
			),
			'chk_inv_settings_singleton',
		)
		for (const change of [
			'target_food_cost_bp = 10001',
			"unit_system = 'imperial'",
			'count_day_of_week = 7',
		]) {
			await expectRejectsWith(
				client.execute(`UPDATE inv_settings SET ${change}`),
				'CHECK',
			)
		}
	})

	it('keeps active names unique ignoring case, and frees a name once archived', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1', { name: 'Chicken thighs' })
		await expectRejectsWith(
			insertItem(client, 'i2', { name: 'CHICKEN THIGHS' }),
			'UNIQUE',
		)
		await client.execute("UPDATE inv_items SET archived_at = 1 WHERE id = 'i1'")
		await insertItem(client, 'i2', { name: 'CHICKEN THIGHS' })

		await client.execute(
			"INSERT INTO inv_storage_areas (id, location_id, name) VALUES ('a1', 'main', 'Walk-in')",
		)
		await client.execute(
			"INSERT INTO inv_storage_areas (id, location_id, name) VALUES ('a2', 'loc_2', 'Walk-in')",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_storage_areas (id, location_id, name) VALUES ('a3', 'main', 'walk-in')",
			),
			'UNIQUE',
		)
	})

	it('makes the movement ledger append-only, except for clearing a note', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertMovement(client, 'm1', 'i1')
		for (const change of [
			'quantity = 1',
			'value_minor = 1',
			"kind = 'waste'",
			"actor_id = 'someone'",
			"note = 'changed'",
		]) {
			await expectRejectsWith(
				client.execute(`UPDATE inv_movements SET ${change} WHERE id = 'm1'`),
				'inv_movements is append-only',
			)
		}
		await client.execute("UPDATE inv_movements SET note = NULL WHERE id = 'm1'")
		await expectRejectsWith(
			client.execute('DELETE FROM inv_movements'),
			'inv_movements is append-only',
		)
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO inv_movements (id, location_id, item_id, quantity, value_minor, kind, source_type, source_id, business_date, actor_kind)
					VALUES ('m2', 'main', 'i1', 1, 5, 'delivery', 'x', 'y', '2026-11-08', 'system')`,
				args: [],
			}),
			'chk_inv_movements_value_currency',
		)
	})

	it('allows one movement per event key', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		const insert = (id: string) =>
			client.execute({
				sql: `INSERT INTO inv_movements (id, location_id, item_id, quantity, kind, source_type, source_id, event_key, business_date, actor_kind)
					VALUES (?, 'main', 'i1', -1000, 'sale', 'pos_order', 'o1', 'sale:o1:i1:1', '2026-11-08', 'system')`,
				args: [id],
			})
		await insert('m1')
		await expectRejectsWith(insert('m2'), 'UNIQUE')
	})

	it('fixes an item’s base unit once it has a movement', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await client.execute(
			"UPDATE inv_items SET base_unit = 'ml' WHERE id = 'i1'",
		)
		await insertMovement(client, 'm1', 'i1')
		await expectRejectsWith(
			client.execute("UPDATE inv_items SET base_unit = 'g' WHERE id = 'i1'"),
			'inventory item unit is fixed',
		)
		await client.execute("UPDATE inv_items SET name = 'Milk' WHERE id = 'i1'")
	})

	it('freezes a named unit’s size once used', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await client.execute(
			"INSERT INTO inv_item_units (id, item_id, name, base_quantity) VALUES ('u1', 'i1', 'Box', 10000000)",
		)
		await client.execute(
			"UPDATE inv_item_units SET base_quantity = 12000000 WHERE id = 'u1'",
		)
		await client.execute(
			"UPDATE inv_item_units SET used_at = 1 WHERE id = 'u1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_item_units SET base_quantity = 10000000 WHERE id = 'u1'",
			),
			'inventory unit in use',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_item_units SET used_at = NULL WHERE id = 'u1'",
			),
			'inventory unit in use',
		)
		// Renaming and archiving stay possible.
		await client.execute(
			"UPDATE inv_item_units SET name = 'Box (12 kg)', archived_at = 2 WHERE id = 'u1'",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_item_units (id, item_id, name, base_quantity) VALUES ('u2', 'i1', 'Bag', 0)",
			),
			'chk_inv_item_units_size',
		)
	})

	it('takes count entries only while the count is open, never changes them, and de-duplicates by client id', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertCount(client, 'c1')
		await insertEntry(client, 'e1', 'c1', 'i1')
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO inv_count_entries (id, count_id, item_id, quantity, entered_amount, entered_unit, counter_kind, client_id)
					VALUES ('e2', 'c1', 'i1', 1, '1', 'g', 'staff', 'client_e1')`,
				args: [],
			}),
			'UNIQUE',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_count_entries SET quantity = 1 WHERE id = 'e1'",
			),
			'inv_count_entries is append-only',
		)
		await expectRejectsWith(
			client.execute('DELETE FROM inv_count_entries'),
			'inv_count_entries is append-only',
		)
		await client.execute(
			"UPDATE inv_counts SET status = 'in_review', sent_for_review_at = 1 WHERE id = 'c1'",
		)
		await insertEntry(client, 'e3', 'c1', 'i1')
		await client.execute(
			"UPDATE inv_counts SET status = 'approved', approved_at = 2, approved_by_id = 'user_1', version = 2 WHERE id = 'c1'",
		)
		await expectRejectsWith(
			insertEntry(client, 'e4', 'c1', 'i1'),
			'inventory count is closed',
		)
		await expectRejectsWith(
			insertEntry(client, 'e5', 'missing', 'i1'),
			'inventory count is closed',
		)
	})

	it('closes approved and cancelled counts for good', async () => {
		const { client } = await openMigratedDb()
		await insertCount(client, 'c1', 'approved')
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_counts SET status = 'counting' WHERE id = 'c1'",
			),
			'inventory count is closed',
		)
		await insertCount(client, 'c2', 'cancelled')
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_counts SET status = 'approved', approved_at = 1 WHERE id = 'c2'",
			),
			'inventory count is closed',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_counts (id, location_id, status, business_date, started_by_kind) VALUES ('c3', 'main', 'approved', '2026-11-08', 'operator')",
			),
			'chk_inv_counts_approved',
		)
	})

	it('makes waste append-only, and an undo must mirror its original, once', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertItem(client, 'i2')
		await insertWaste(client, 'w1', 'i1')
		await expectRejectsWith(
			client.execute("UPDATE inv_waste SET quantity = 1 WHERE id = 'w1'"),
			'inv_waste is append-only',
		)
		await client.execute("UPDATE inv_waste SET note = NULL WHERE id = 'w1'")
		await expectRejectsWith(
			client.execute('DELETE FROM inv_waste'),
			'inv_waste is append-only',
		)
		await expectRejectsWith(
			insertWaste(client, 'w2', 'i2', { reversesId: 'w1' }),
			'reversal does not match',
		)
		await expectRejectsWith(
			insertWaste(client, 'w2', 'i1', { reversesId: 'w1', quantity: 1 }),
			'reversal does not match',
		)
		await insertWaste(client, 'w2', 'i1', { reversesId: 'w1' })
		await expectRejectsWith(
			insertWaste(client, 'w3', 'i1', { reversesId: 'w1' }),
			'UNIQUE',
		)
		// An undo cannot itself be undone.
		await expectRejectsWith(
			insertWaste(client, 'w4', 'i1', { reversesId: 'w2' }),
			'reversal does not match',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_waste (id, location_id, quantity, reason, actor_kind, client_id, business_date) VALUES ('w5', 'main', 1, 'expired', 'staff', 'c5', '2026-11-08')",
			),
			'chk_inv_waste_what',
		)
	})

	it('makes delivery lines and the audit log append-only', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await client.execute(
			"INSERT INTO inv_deliveries (id, location_id, currency, received_by_kind, received_at, business_date) VALUES ('d1', 'main', 'SAR', 'operator', 1, '2026-11-08')",
		)
		await client.execute(
			"INSERT INTO inv_delivery_lines (id, delivery_id, item_id, quantity, pack_name, pack_base_quantity, packs, price_minor, line_total_minor) VALUES ('l1', 'd1', 'i1', 20000000, 'Box', 10000000, 2000, 28000, 56000)",
		)
		await expectRejectsWith(
			client.execute('UPDATE inv_delivery_lines SET price_minor = 1'),
			'inv_delivery_lines is append-only',
		)
		await expectRejectsWith(
			client.execute('DELETE FROM inv_delivery_lines'),
			'inv_delivery_lines is append-only',
		)
		// The delivery itself is mutable (paid, invoice facts).
		await client.execute(
			"UPDATE inv_deliveries SET paid_at = 5, version = 2 WHERE id = 'd1'",
		)

		await client.execute(
			"INSERT INTO inv_audit_log (id, actor_kind, actor_id, action, resource_type, resource_id, detail) VALUES ('a1', 'operator', 'user_1', 'settings.update', 'settings', 'default', '{}')",
		)
		await expectRejectsWith(
			client.execute('UPDATE inv_audit_log SET detail = \'{"x":1}\''),
			'inv_audit_log is append-only',
		)
		await expectRejectsWith(
			client.execute('DELETE FROM inv_audit_log'),
			'inv_audit_log is append-only',
		)
	})

	it('allows one preferred active way to buy an item, and checks money has a currency', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await client.execute(
			"INSERT INTO inv_suppliers (id, name, minimum_order_minor, currency) VALUES ('s1', 'Al Watania', 40000, 'SAR')",
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_suppliers (id, name, minimum_order_minor) VALUES ('s2', 'Fresh Farms', 100)",
			),
			'chk_inv_suppliers_minimum',
		)
		const product = (id: string, preferred: number) =>
			client.execute({
				sql: "INSERT INTO inv_supplier_products (id, supplier_id, item_id, pack_name, pack_base_quantity, price_minor, currency, preferred) VALUES (?, 's1', 'i1', 'Box', 10000000, 28000, 'SAR', ?)",
				args: [id, preferred],
			})
		await product('p1', 1)
		await product('p2', 0)
		await expectRejectsWith(product('p3', 1), 'UNIQUE')
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_supplier_products (id, supplier_id, item_id, pack_name, pack_base_quantity, price_minor) VALUES ('p4', 's1', 'i1', 'Bag', 1000, 5)",
			),
			'chk_inv_supplier_products_price',
		)
	})
})
