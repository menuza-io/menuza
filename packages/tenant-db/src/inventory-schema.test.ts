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
	'inv_alert_log',
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
	'inv_order_lines',
	'inv_orders',
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
	'inv_deliveries_facts_fixed',
	'inv_deliveries_photo_type_insert',
	'inv_deliveries_photo_type_update',
	'inv_delivery_lines_no_delete',
	'inv_delivery_lines_no_update',
	'inv_item_units_size_fixed',
	'inv_items_base_unit_fixed',
	'inv_movements_no_delete',
	'inv_movements_no_update',
	'inv_order_lines_draft_delete',
	'inv_order_lines_draft_insert',
	'inv_order_lines_draft_update',
	'inv_orders_closed_final',
	'inv_orders_identity_fixed',
	'inv_orders_no_delete',
	'inv_orders_status_forward',
	'inv_waste_no_delete',
	'inv_waste_no_update',
	'inv_waste_reversal_matches',
	'inv_waste_source_valid',
]

describe('inventory tenant schema (0033_inventory, 0034_inventory_orders)', () => {
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

	async function insertSupplier(client: Client) {
		await client.execute(
			"INSERT INTO inv_suppliers (id, name, currency) VALUES ('s1', 'Al Watania', 'SAR')",
		)
	}

	async function insertOrder(
		client: Client,
		id: string,
		number: number,
		status = 'draft',
	) {
		await client.execute({
			sql: `INSERT INTO inv_orders (id, number, client_id, location_id, supplier_id, status, created_by_kind, created_by_id, closed_at)
				VALUES (?, ?, ?, 'main', 's1', ?, 'operator', 'user_1', ?)`,
			args: [
				id,
				number,
				`client_${id}`,
				status,
				status === 'received' || status === 'cancelled' ? 1 : null,
			],
		})
	}

	async function insertOrderLine(client: Client, id: string, orderId: string) {
		await client.execute({
			sql: `INSERT INTO inv_order_lines (id, order_id, item_id, pack_name, pack_base_quantity, packs, quantity, price_minor)
				VALUES (?, ?, 'i1', 'Box', 10000000, 2000, 20000000, 28000)`,
			args: [id, orderId],
		})
	}

	it('creates a draft order with numbered, idempotent, checked rows', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertSupplier(client)
		await insertOrder(client, 'o1', 1)
		await expectRejectsWith(insertOrder(client, 'o2', 1), 'UNIQUE')
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO inv_orders (id, number, client_id, location_id, supplier_id, created_by_kind)
					VALUES ('o3', 2, 'client_o1', 'main', 's1', 'operator')`,
				args: [],
			}),
			'UNIQUE',
		)
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO inv_orders (id, number, client_id, location_id, supplier_id, status, created_by_kind)
					VALUES ('o4', 3, 'c4', 'main', 's1', 'received', 'operator')`,
				args: [],
			}),
			'chk_inv_orders_closed',
		)
		await expectRejectsWith(
			client.execute({
				sql: `INSERT INTO inv_orders (id, number, client_id, location_id, supplier_id, sent_via, created_by_kind)
					VALUES ('o5', 4, 'c5', 'main', 's1', 'fax', 'operator')`,
				args: [],
			}),
			'chk_inv_orders_sent_via',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_order_lines (id, order_id, item_id, pack_name, pack_base_quantity, packs, quantity) VALUES ('x', 'o1', 'i1', 'Box', 1000, 0, 0)",
			),
			'chk_inv_order_lines_amounts',
		)
		await insertOrderLine(client, 'ol1', 'o1')
		await insertOrderLine(client, 'ol2', 'o1')
		await client.execute("DELETE FROM inv_order_lines WHERE id = 'ol2'")
	})

	it('freezes order lines once the order is sent, and keeps order identity', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertSupplier(client)
		await insertOrder(client, 'o1', 1)
		await insertOrderLine(client, 'ol1', 'o1')
		await client.execute(
			"UPDATE inv_order_lines SET packs = 3000, quantity = 30000000 WHERE id = 'ol1'",
		)
		await expectRejectsWith(
			client.execute("UPDATE inv_orders SET number = 9 WHERE id = 'o1'"),
			'inventory order identity is fixed',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_orders SET supplier_id = 's2' WHERE id = 'o1'",
			),
			'inventory order identity is fixed',
		)
		await client.execute(
			"UPDATE inv_orders SET status = 'sent', sent_at = 5, sent_via = 'email', version = 2 WHERE id = 'o1'",
		)
		for (const sql of [
			"UPDATE inv_order_lines SET packs = 1000 WHERE id = 'ol1'",
			"DELETE FROM inv_order_lines WHERE id = 'ol1'",
		]) {
			await expectRejectsWith(
				client.execute(sql),
				'inventory order lines are frozen',
			)
		}
		await expectRejectsWith(
			insertOrderLine(client, 'ol3', 'o1'),
			'inventory order lines are frozen',
		)
		await expectRejectsWith(
			client.execute("UPDATE inv_orders SET status = 'draft' WHERE id = 'o1'"),
			'inventory order cannot go back',
		)
		await expectRejectsWith(
			client.execute("UPDATE inv_orders SET sent_at = 6 WHERE id = 'o1'"),
			'inventory order cannot go back',
		)
		await expectRejectsWith(
			client.execute("DELETE FROM inv_orders WHERE id = 'o1'"),
			'inventory order is kept',
		)
		// Expected date and note stay editable on a sent order; so do forward moves.
		await client.execute(
			"UPDATE inv_orders SET expected_date = '2026-11-12', note = 'gate 2' WHERE id = 'o1'",
		)
		await client.execute(
			"UPDATE inv_orders SET status = 'received', closed_at = 9 WHERE id = 'o1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_orders SET status = 'cancelled' WHERE id = 'o1'",
			),
			'inventory order is closed',
		)
		await expectRejectsWith(
			client.execute("UPDATE inv_orders SET note = 'late' WHERE id = 'o1'"),
			'inventory order is closed',
		)
		// A draft can be deleted once its lines are gone.
		await insertOrder(client, 'o2', 2)
		await client.execute("DELETE FROM inv_orders WHERE id = 'o2'")
	})

	it('lets a quantity-only delivery be priced exactly once and nothing else change', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await insertSupplier(client)
		await insertOrder(client, 'o1', 1)
		await insertOrderLine(client, 'ol1', 'o1')
		await client.execute(
			"INSERT INTO inv_deliveries (id, location_id, supplier_id, order_id, currency, received_by_kind, received_at, business_date, source, quantity_only, late_sync) VALUES ('d1', 'main', 's1', 'o1', 'SAR', 'staff', 1, '2026-11-08', 'station', 1, 0)",
		)
		await client.execute(
			"INSERT INTO inv_delivery_lines (id, delivery_id, item_id, order_line_id, quantity, pack_name, pack_base_quantity, packs, line_total_minor) VALUES ('l1', 'd1', 'i1', 'ol1', 20000000, 'Box', 10000000, 2000, 0)",
		)
		const line = await client.execute(
			'SELECT priced_at FROM inv_delivery_lines',
		)
		expect(line.rows[0]!.priced_at).toBeNull()
		for (const change of [
			'quantity = 1',
			'order_line_id = NULL',
			'created_at = 1',
		]) {
			await expectRejectsWith(
				client.execute(
					`UPDATE inv_delivery_lines SET ${change} WHERE id = 'l1'`,
				),
				'inv_delivery_lines is append-only',
			)
		}
		// A price change without priced_at is still refused.
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_delivery_lines SET price_minor = 28000, line_total_minor = 56000 WHERE id = 'l1'",
			),
			'inv_delivery_lines is append-only',
		)
		await client.execute(
			"UPDATE inv_delivery_lines SET price_minor = 28000, line_total_minor = 56000, priced_at = 7 WHERE id = 'l1'",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_delivery_lines SET price_minor = 1, priced_at = 8 WHERE id = 'l1'",
			),
			'inv_delivery_lines is append-only',
		)
		await expectRejectsWith(
			client.execute('DELETE FROM inv_delivery_lines'),
			'inv_delivery_lines is append-only',
		)
		// Delivery facts: confirm once, never relink or flip quantity-only.
		await client.execute(
			"UPDATE inv_deliveries SET prices_confirmed_at = 7, paid_at = 7, version = 2 WHERE id = 'd1'",
		)
		for (const change of [
			'prices_confirmed_at = 8',
			'prices_confirmed_at = NULL',
			'order_id = NULL',
			'quantity_only = 0',
			"source = 'operator'",
			'late_sync = 1',
			'supplier_id = NULL',
		]) {
			await expectRejectsWith(
				client.execute(`UPDATE inv_deliveries SET ${change} WHERE id = 'd1'`),
				'inventory delivery facts are fixed',
			)
		}
		// A priced delivery's line never gets the exception, even with priced_at null.
		await client.execute(
			"INSERT INTO inv_deliveries (id, location_id, currency, received_by_kind, received_at, business_date) VALUES ('d2', 'main', 'SAR', 'operator', 1, '2026-11-08')",
		)
		await client.execute(
			"INSERT INTO inv_delivery_lines (id, delivery_id, item_id, quantity, line_total_minor) VALUES ('l2', 'd2', 'i1', 1000, 5)",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_delivery_lines SET line_total_minor = 6, priced_at = 1 WHERE id = 'l2'",
			),
			'inv_delivery_lines is append-only',
		)
	})

	it('checks invoice photo types, waste source and the alert log', async () => {
		const { client } = await openMigratedDb()
		await insertItem(client, 'i1')
		await client.execute(
			"INSERT INTO inv_deliveries (id, location_id, currency, received_by_kind, received_at, business_date, photo_content_type) VALUES ('d1', 'main', 'SAR', 'operator', 1, '2026-11-08', 'image/webp')",
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_deliveries SET photo_content_type = 'image/gif' WHERE id = 'd1'",
			),
			'invoice photo type not allowed',
		)
		await expectRejectsWith(
			client.execute(
				"INSERT INTO inv_deliveries (id, location_id, currency, received_by_kind, business_date, photo_content_type) VALUES ('d2', 'main', 'SAR', 'operator', '2026-11-08', 'application/pdf')",
			),
			'invoice photo type not allowed',
		)
		const waste = (id: string, source: string, deviceId: string | null) =>
			client.execute({
				sql: `INSERT INTO inv_waste (id, location_id, item_id, quantity, reason, actor_kind, client_id, business_date, source, device_id, late_sync)
					VALUES (?, 'main', 'i1', 1000, 'dropped', 'staff', ?, '2026-11-08', ?, ?, 1)`,
				args: [id, `c_${id}`, source, deviceId],
			})
		await waste('w1', 'station', 'dev_1')
		await expectRejectsWith(
			waste('w2', 'station', null),
			'waste source not allowed',
		)
		await expectRejectsWith(
			waste('w3', 'kiosk', 'dev_1'),
			'waste source not allowed',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_waste SET device_id = 'dev_2' WHERE id = 'w1'",
			),
			'inv_waste is append-only',
		)
		await expectRejectsWith(
			client.execute("UPDATE inv_waste SET late_sync = 0 WHERE id = 'w1'"),
			'inv_waste is append-only',
		)
		const defaults = await client.execute({
			sql: `INSERT INTO inv_waste (id, location_id, item_id, quantity, reason, actor_kind, client_id, business_date)
				VALUES ('w4', 'main', 'i1', 1000, 'dropped', 'operator', 'c4', '2026-11-08') RETURNING source, device_id, late_sync`,
			args: [],
		})
		expect(defaults.rows[0]).toMatchObject({
			source: 'operator',
			device_id: null,
			late_sync: 0,
		})

		const alert = (id: string, kind: string, key: string, count = 3) =>
			client.execute({
				sql: 'INSERT INTO inv_alert_log (id, kind, location_id, dedupe_key, count) VALUES (?, ?, ?, ?, ?)',
				args: [id, kind, 'main', key, count],
			})
		await alert('a1', 'inventory_low_stock', '2026-11-08')
		await expectRejectsWith(
			alert('a2', 'inventory_low_stock', '2026-11-08'),
			'UNIQUE',
		)
		await alert('a3', 'inventory_price_rise', '2026-11-08')
		await alert('a4', 'inventory_low_stock', '2026-11-09')
		await expectRejectsWith(
			alert('a5', 'inventory_other', 'k'),
			'chk_inv_alert_log_kind',
		)
		await expectRejectsWith(
			alert('a6', 'inventory_low_stock', 'k', 0),
			'chk_inv_alert_log_count',
		)
		await expectRejectsWith(
			client.execute(
				"UPDATE inv_alert_log SET status = 'done' WHERE id = 'a1'",
			),
			'chk_inv_alert_log_status',
		)
	})

	it('adds the phase 2 settings and terminal columns with safe defaults', async () => {
		const { client } = await openMigratedDb()
		await client.execute(
			"INSERT INTO inv_settings (id, unit_system) VALUES ('default', 'metric')",
		)
		const settings = await client.execute('SELECT * FROM inv_settings')
		expect(settings.rows[0]).toMatchObject({
			any_staff_can_receive: 0,
			next_order_number: 1,
		})
		await client.execute(
			"INSERT INTO pos_devices (id, label, terminal_code, secret_hash, paired_by) VALUES ('p1', 'Bar', 'T1', 'h', 'u')",
		)
		await client.execute(
			"INSERT INTO pos_pairing_codes (id, code_hash, label, terminal_code, created_by, expires_at) VALUES ('c1', 'h', 'Bar', 'T1', 'u', 1)",
		)
		const device = await client.execute('SELECT * FROM pos_devices')
		expect(device.rows[0]).toMatchObject({
			inventory_enabled: 0,
			inventory_disabled_at: null,
		})
		const code = await client.execute('SELECT * FROM pos_pairing_codes')
		expect(code.rows[0]).toMatchObject({ inventory_enabled: 0 })
	})
})
