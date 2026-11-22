import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	type InventoryAvailabilityRequest,
	type InventoryNotifyEvent,
	AUTO_SOLD_OUT_MAX_COUNT_AGE_MS,
	inventoryNotifyEventSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountEntries,
	invCounts,
	invItems,
	invMovements,
	invRecipeLines,
	invRecipes,
	invSoldOut,
	invSoldOutAlerts,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { type InventoryAvailabilityOutcome } from '../lib/inventory-availability.ts'
import { type InventoryNotifyOutcome } from '../lib/inventory-notify.ts'
import {
	dependentsOfItems,
	syncAutoSoldOut,
} from './inventory-auto-sold-out.ts'
import { listSoldOut, undoSoldOut } from './inventory-sold-out-service.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

const ORG = 'org_inv_soldout_test'
const LOC = 'loc_a'
// The undo and the write hook read the real clock, so the test lives in it too.
const NOW = Date.now()
const ON = {
	enabled: true,
	purchasing: false,
	recipes: true,
	prep: false,
	transfers: false,
}

describe('auto sold out', () => {
	let tempDir: string
	let db: TenantDatabase
	let posted: InventoryAvailabilityRequest[]
	/** What the App answers: by default it applies everything asked. */
	let answer: (
		request: InventoryAvailabilityRequest,
	) => InventoryAvailabilityOutcome

	const post = async (request: InventoryAvailabilityRequest) => {
		posted.push(request)
		return answer(request)
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-soldout-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		invalidateInventoryContext()
		seedInventoryContextForTest(ORG, ON)
		posted = []
		answer = (request) => ({
			status: 'applied',
			applied: request.changes.map((change) => change.entityId),
		})
		await seed()
	})

	afterEach(async () => {
		invalidateInventoryContext()
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function recipe(
		ownerKind: 'menu_item' | 'option' | 'made_item',
		ownerId: string,
		itemId: string,
		makesQuantity?: number,
	) {
		const id = `rec_${ownerKind}_${ownerId}`
		await db.insert(invRecipes).values({
			id,
			ownerKind,
			ownerId,
			version: 1,
			makesQuantity: makesQuantity ?? null,
			effectiveFrom: 1,
			createdByKind: 'system',
		})
		await db
			.insert(invRecipeLines)
			.values({ recipeId: id, itemId, quantity: 100_000 })
	}

	async function seed() {
		await db.insert(invItems).values([
			{ id: 'it_chicken', name: 'Chicken', baseUnit: 'g', autoSoldOut: true },
			{ id: 'it_rice', name: 'Rice', baseUnit: 'g', autoSoldOut: false },
			{ id: 'it_sauce', name: 'Sauce', baseUnit: 'ml', kind: 'made' },
		])
		await recipe('menu_item', 'burger', 'it_chicken')
		await recipe('option', 'opt_extra', 'it_chicken')
		await recipe('menu_item', 'plain_rice', 'it_rice')
		// A wrap uses the made sauce, which is made from chicken.
		await recipe('made_item', 'it_sauce', 'it_chicken', 1_000_000)
		await recipe('menu_item', 'wrap', 'it_sauce')
	}

	/** Stock of chicken: delivered, then used up (or not), counted `countedAt`. */
	async function stock(options: { onHand: number; countedAt: number | null }) {
		await db.insert(invMovements).values({
			locationId: LOC,
			itemId: 'it_chicken',
			quantity: 1_000_000,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: 'd1',
			businessDate: '2026-01-10',
			actorKind: 'system',
			createdAt: NOW - 1000,
		})
		const used = 1_000_000 - options.onHand
		if (used !== 0) {
			await db.insert(invMovements).values({
				locationId: LOC,
				itemId: 'it_chicken',
				quantity: -used,
				kind: 'sale',
				sourceType: 'pos_order',
				sourceId: 's1',
				businessDate: '2026-01-10',
				actorKind: 'system',
				createdAt: NOW - 500,
			})
		}
		if (options.countedAt !== null) {
			await db.insert(invCounts).values({
				id: 'c1',
				locationId: LOC,
				status: 'counting',
				businessDate: '2026-01-09',
				startedByKind: 'operator',
			})
			await db.insert(invCountEntries).values({
				countId: 'c1',
				itemId: 'it_chicken',
				quantity: 1_000_000,
				enteredAmount: '1000',
				enteredUnit: 'g',
				counterKind: 'operator',
				clientId: 'client_entry_1',
			})
			await db
				.update(invCounts)
				.set({ status: 'approved', approvedAt: options.countedAt })
				.where(eq(invCounts.id, 'c1'))
		}
	}

	const sync = () => syncAutoSoldOut(ORG, { now: NOW, post })

	it('finds the dishes and options an item feeds, through made items', async () => {
		const found = await dependentsOfItems(db, ['it_chicken', 'it_rice'])
		expect([...found.get('it_chicken')!].sort()).toEqual([
			'item:burger',
			'item:wrap',
			'modifier_option:opt_extra',
		])
		expect([...found.get('it_rice')!]).toEqual(['item:plain_rice'])
	})

	it('takes dependents off the menu when a counted item runs out, and gives them back with stock', async () => {
		await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
		const first = await sync()
		expect(first).toMatchObject({ soldOut: 3, restored: 0, deferred: false })
		expect(posted).toHaveLength(1)
		expect(posted[0]).toMatchObject({ orgId: ORG, locationId: LOC })
		expect(
			posted[0]!.changes
				.map(
					(change) =>
						`${change.entityType}:${change.entityId}:${change.available}`,
				)
				.sort(),
		).toEqual([
			'item:burger:false',
			'item:wrap:false',
			'modifier_option:opt_extra:false',
		])
		const rows = await db.select().from(invSoldOut)
		expect(rows).toHaveLength(3)
		expect(rows.every((row) => row.state === 'out')).toBe(true)

		// Nothing changed: nothing is posted again.
		await sync()
		expect(posted).toHaveLength(1)

		// A delivery brings stock back: the dishes are given back.
		await db.insert(invMovements).values({
			locationId: LOC,
			itemId: 'it_chicken',
			quantity: 500_000,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: 'd2',
			businessDate: '2026-01-10',
			actorKind: 'system',
			createdAt: NOW + 1,
		})
		const second = await sync()
		expect(second).toMatchObject({ soldOut: 0, restored: 3 })
		expect(posted[1]!.changes.every((change) => change.available)).toBe(true)
		expect(posted[1]!.changes[0]!.since).toBeTypeOf('number')
		expect(await db.select().from(invSoldOut)).toHaveLength(0)
	})

	it('never sells out on a drifting estimate: the item must have been counted this week', async () => {
		await stock({
			onHand: 0,
			countedAt: NOW - AUTO_SOLD_OUT_MAX_COUNT_AGE_MS - 1000,
		})
		expect(await sync()).toMatchObject({ soldOut: 0 })
		expect(posted).toHaveLength(0)
	})

	it('never counted means never sold out', async () => {
		await stock({ onHand: 0, countedAt: null })
		await sync()
		expect(posted).toHaveLength(0)
	})

	it('does nothing for an item that is not switched on', async () => {
		await db
			.update(invItems)
			.set({ autoSoldOut: false })
			.where(eq(invItems.id, 'it_chicken'))
		await stock({ onHand: 0, countedAt: NOW - 1000 })
		await sync()
		expect(posted).toHaveLength(0)
	})

	it('records only what the App confirmed, and never gives back what it did not take', async () => {
		await stock({ onHand: 0, countedAt: NOW - 1000 })
		// The wrap was already unavailable by hand: the App changes the rest only.
		answer = (request) => ({
			status: 'applied',
			applied: request.changes
				.map((change) => change.entityId)
				.filter((id) => id !== 'wrap'),
		})
		await sync()
		const rows = await db.select().from(invSoldOut)
		const byId = Object.fromEntries(
			rows.map((row) => [row.entityId, row.state]),
		)
		expect(byId).toEqual({
			burger: 'out',
			opt_extra: 'out',
			wrap: 'undone',
		})

		// Stock comes back: only the two dishes this took off are given back.
		await db.insert(invMovements).values({
			locationId: LOC,
			itemId: 'it_chicken',
			quantity: 500_000,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: 'd2',
			businessDate: '2026-01-10',
			actorKind: 'system',
			createdAt: NOW + 1,
		})
		answer = (request) => ({
			status: 'applied',
			applied: request.changes.map((change) => change.entityId),
		})
		await sync()
		expect(
			posted
				.at(-1)!
				.changes.map((change) => change.entityId)
				.sort(),
		).toEqual(['burger', 'opt_extra'])
		expect(await db.select().from(invSoldOut)).toHaveLength(0)
	})

	it('an App outage records nothing and asks again next time', async () => {
		await stock({ onHand: 0, countedAt: NOW - 1000 })
		answer = () => ({ status: 'retry', code: 'network_error' })
		expect(await sync()).toMatchObject({ soldOut: 0, deferred: true })
		expect(await db.select().from(invSoldOut)).toHaveLength(0)
		answer = (request) => ({
			status: 'applied',
			applied: request.changes.map((change) => change.entityId),
		})
		expect(await sync()).toMatchObject({ soldOut: 3, deferred: false })
	})

	it('flags off give every dish back; unreadable flags change nothing', async () => {
		await stock({ onHand: 0, countedAt: NOW - 1000 })
		await sync()
		expect(await db.select().from(invSoldOut)).toHaveLength(3)

		invalidateInventoryContext()
		// Nothing cached and no App to ask: unknown, nothing changes.
		await sync()
		expect(await db.select().from(invSoldOut)).toHaveLength(3)

		seedInventoryContextForTest(ORG, { ...ON, enabled: false })
		await sync()
		expect(await db.select().from(invSoldOut)).toHaveLength(0)
		expect(posted.at(-1)!.changes.every((change) => change.available)).toBe(
			true,
		)
	})

	describe('the manager can undo it', () => {
		const caller: InventoryCaller = {
			orgId: ORG,
			region: 'us',
			actor: { kind: 'operator', id: 'user_1' },
			locationIds: null,
			cost: false,
			purchasing: false,
		} as InventoryCaller

		it('lists what is out and keeps an undone dish on the menu while stock is at zero', async () => {
			await stock({ onHand: 0, countedAt: NOW - 1000 })
			await sync()
			const listed = await listSoldOut(db, { locationId: LOC })
			expect(listed.entries).toHaveLength(3)
			expect(listed.entries[0]).toMatchObject({
				causeItemId: 'it_chicken',
				causeItemName: 'Chicken',
				state: 'out',
			})
			const burger = listed.entries.find(
				(entry) => entry.entityId === 'burger',
			)!
			const undone = await undoSoldOut(caller, {
				id: burger.id,
				post,
			})
			expect(undone.state).toBe('undone')
			expect(posted.at(-1)!.changes).toEqual([
				{ entityType: 'item', entityId: 'burger', available: true },
			])

			// Stock is still zero: the burger is not taken off again.
			posted.length = 0
			await sync()
			expect(posted).toHaveLength(0)
			const states = (await db.select().from(invSoldOut)).map(
				(row) => `${row.entityId}:${row.state}`,
			)
			expect(states).toContain('burger:undone')

			// An undo again answers the same without asking the App.
			await undoSoldOut(caller, { id: burger.id, post })
			expect(posted).toHaveLength(0)
		})

		it('refuses an undo while the App cannot be reached', async () => {
			await stock({ onHand: 0, countedAt: NOW - 1000 })
			await sync()
			const [entry] = (await listSoldOut(db, { locationId: LOC })).entries
			answer = () => ({ status: 'retry', code: 'network_error' })
			await expect(
				undoSoldOut(caller, { id: entry!.id, post }),
			).rejects.toMatchObject({ code: 'inventory_unavailable' })
			expect(
				(await db.select().from(invSoldOut)).every((r) => r.state === 'out'),
			).toBe(true)
		})
	})

	describe('manager alerts (#478)', () => {
		const alerts: InventoryNotifyEvent[] = []
		let notifyOutcome: InventoryNotifyOutcome['status'] | 'skipped' =
			'delivered'
		const notify = async (event: InventoryNotifyEvent) => {
			if (notifyOutcome === 'retry')
				return { status: 'retry', code: 'x' } as const
			if (notifyOutcome === 'rejected') {
				return { status: 'rejected', code: 'http_400' } as const
			}
			alerts.push(event)
			return notifyOutcome === 'skipped'
				? ({ status: 'delivered', skipped: 'feature_off' } as const)
				: ({ status: 'delivered' } as const)
		}
		const run = (at: number) => syncAutoSoldOut(ORG, { now: at, post, notify })

		async function restock() {
			await db.insert(invMovements).values({
				locationId: LOC,
				itemId: 'it_chicken',
				quantity: 2_000_000,
				kind: 'delivery',
				sourceType: 'delivery',
				sourceId: 'd2',
				businessDate: '2026-01-11',
				actorKind: 'system',
				createdAt: NOW + 1,
			})
		}

		beforeEach(() => {
			alerts.length = 0
			notifyOutcome = 'delivered'
		})

		it('sends one grouped alert with the ingredient when dishes go off the menu', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			await run(NOW)
			expect(alerts).toHaveLength(1)
			const alert = alerts[0]!
			expect(inventoryNotifyEventSchema.parse(alert)).toMatchObject({
				orgId: ORG,
				kind: 'inventory_sold_out',
				locationId: LOC,
				count: 3,
			})
			expect(alert.soldOut!.map((entry) => entry.entityId).sort()).toEqual([
				'burger',
				'opt_extra',
				'wrap',
			])
			expect(
				new Set(alert.soldOut!.map((entry) => entry.ingredientName)),
			).toEqual(new Set(['Chicken']))
			// Ids, a count and the ingredient: nothing that names a guest.
			expect(Object.keys(alert).sort()).toEqual(
				['count', 'eventId', 'kind', 'locationId', 'orgId', 'soldOut'].sort(),
			)
			// Running again sends nothing more.
			await run(NOW + 1000)
			expect(alerts).toHaveLength(1)
		})

		it('sends a second alert when the dishes come back', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			await run(NOW)
			await restock()
			await run(NOW + 60_000)
			expect(alerts.map((alert) => alert.kind)).toEqual([
				'inventory_sold_out',
				'inventory_sold_out_back',
			])
			expect(alerts[1]).toMatchObject({ count: 3 })
			expect(alerts[1]!.soldOut![0]!.ingredientName).toBe('Chicken')
		})

		it('groups per location into one alert per 15 minutes', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			await run(NOW)
			expect(alerts).toHaveLength(1)
			// Another dish needs the same chicken a minute later.
			await recipe('menu_item', 'bowl', 'it_chicken')
			const held = await run(NOW + 60_000)
			expect(alerts).toHaveLength(1)
			expect(held.alertDueAt).toBe(NOW + 15 * 60_000)
			await run(NOW + 14 * 60_000)
			expect(alerts).toHaveLength(1)
			const later = await run(NOW + 16 * 60_000)
			expect(alerts).toHaveLength(2)
			expect(alerts[1]).toMatchObject({ kind: 'inventory_sold_out', count: 1 })
			expect(alerts[1]!.soldOut![0]!.entityId).toBe('bowl')
			expect(later.alertDueAt).toBeNull()
		})

		it('keeps an alert the App could not take and sends it on the next run', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			notifyOutcome = 'retry'
			const first = await run(NOW)
			expect(alerts).toHaveLength(0)
			expect(first.alertDueAt).toBe(NOW + 5 * 60_000)
			notifyOutcome = 'delivered'
			await run(NOW + 6 * 60_000)
			expect(alerts).toHaveLength(1)
		})

		it('says nothing about a dish that came back before anyone was told it went', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			notifyOutcome = 'retry'
			await run(NOW)
			await restock()
			await run(NOW + 60_000)
			notifyOutcome = 'delivered'
			await run(NOW + 120_000)
			expect(alerts).toHaveLength(0)
		})

		it('does not start the 15-minute window for an alert the App skipped', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			notifyOutcome = 'skipped'
			await run(NOW)
			expect(alerts).toHaveLength(1)
			notifyOutcome = 'delivered'
			// A new dish goes off a minute later: nobody was told before, so it is sent now.
			await recipe('menu_item', 'bowl', 'it_chicken')
			await run(NOW + 60_000)
			expect(alerts).toHaveLength(2)
			expect(alerts[1]).toMatchObject({ kind: 'inventory_sold_out', count: 1 })
		})

		it('keeps trying for an hour when the App refuses a kind it does not know yet', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			notifyOutcome = 'rejected'
			const first = await run(NOW)
			expect(first.alertDueAt).toBe(NOW + 5 * 60_000)
			notifyOutcome = 'delivered'
			await run(NOW + 10 * 60_000)
			expect(alerts).toHaveLength(1)
		})

		it('does not let a give-back cancel a sold-out that came after it', async () => {
			await stock({ onHand: 0, countedAt: NOW - 24 * 60 * 60 * 1000 })
			await db.insert(invSoldOutAlerts).values({
				id: 'a_back',
				locationId: LOC,
				kind: 'back',
				entityType: 'item',
				entityId: 'plain_rice',
				causeItemId: 'it_rice',
				createdAt: NOW - 2000,
			})
			await db.insert(invSoldOutAlerts).values({
				id: 'a_out',
				locationId: LOC,
				kind: 'out',
				entityType: 'item',
				entityId: 'plain_rice',
				causeItemId: 'it_rice',
				createdAt: NOW - 1000,
			})
			await run(NOW)
			const kinds = alerts.map((alert) => alert.kind).sort()
			expect(kinds).toContain('inventory_sold_out_back')
			expect(
				alerts
					.filter((alert) => alert.kind === 'inventory_sold_out')
					.flatMap((alert) => alert.soldOut!.map((entry) => entry.entityId)),
			).toContain('plain_rice')
		})
	})
})
