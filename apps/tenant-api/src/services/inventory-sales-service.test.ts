import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	invItemCosts,
	invItems,
	invMovements,
	invOutbox,
	invRecipeLines,
	invRecipes,
	invSaleUsage,
	invWaste,
	posOrders,
	provisionTenantDb,
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { runInventoryTickForOrg } from './inventory-tick-service.ts'
import { updateOperatorOrder } from './order-service.ts'
import {
	inventoryOutboxBackoffMs,
	inventorySaleQueue,
	parsePosVoids,
	processInventoryOutbox,
	pruneInventoryOutbox,
	queueInventorySaleInTx,
	settleInventorySource,
} from './inventory-sales-service.ts'
import {
	insertOrder,
	insertPosSale,
	insertQrTable,
	insertTab,
	LOC_1,
	NOW,
} from './loyalty-test-fixture.ts'

const ORG = 'org_inv_sales_test'
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

const ON = {
	enabled: true,
	purchasing: false,
	recipes: true,
	prep: false,
	transfers: false,
}

type Seed = { chicken: string; bun: string; milk: string }

function posLine(
	itemId: string,
	quantity: number,
	options: { optionId: string; quantity: number }[] = [],
) {
	return {
		id: `line_${itemId}`,
		itemId,
		name: 'Dish',
		variantId: null,
		variantLabel: null,
		quantity,
		baseCents: 1000,
		instructions: '',
		options: options.map((option) => ({
			groupId: 'g1',
			groupName: 'Extras',
			optionId: option.optionId,
			optionName: 'Extra',
			quantity: option.quantity,
			unitCents: 0,
			taxable: true,
		})),
	}
}

function webLine(itemId: string, quantity: number) {
	return {
		itemId,
		itemName: '{"en":"Dish"}',
		variantId: null,
		quantity,
		unitPriceCents: 1000,
		taxableUnitCents: 1000,
		totalCents: 1000 * quantity,
		taxableCents: 1000 * quantity,
		instructions: null,
		baseUnitCents: 0,
		categoryIds: [],
		options: [],
	}
}

describe('inventory sales: used by sales', () => {
	let tempDir: string
	let db: TenantDatabase
	let seed: Seed

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-inv-sales-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		invalidateInventoryContext()
		seedInventoryContextForTest(ORG, ON)
		seed = await seedKitchen()
	})

	afterEach(async () => {
		invalidateInventoryContext()
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	/** Chicken (g), buns (piece), milk (ml); `burger` = 200 g chicken + 1 bun, `latte` = 150 ml milk. */
	async function seedKitchen(): Promise<Seed> {
		const ids: Seed = { chicken: 'it_chicken', bun: 'it_bun', milk: 'it_milk' }
		await db.insert(invItems).values([
			{ id: ids.chicken, name: 'Chicken', baseUnit: 'g' },
			{ id: ids.bun, name: 'Bun', baseUnit: 'piece' },
			{ id: ids.milk, name: 'Milk', baseUnit: 'ml' },
		])
		await db.insert(invItemCosts).values([
			// 2.8 minor units per gram, 50 minor units per bun.
			{
				itemId: ids.chicken,
				currency: 'SAR',
				lastCostMicro: 2_800_000,
				avgCostMicro: 2_800_000,
			},
			{
				itemId: ids.bun,
				currency: 'SAR',
				lastCostMicro: 50_000_000,
				avgCostMicro: 50_000_000,
			},
		])
		await recipe('burger', [
			{ itemId: ids.chicken, quantity: 200_000 },
			{ itemId: ids.bun, quantity: 1_000 },
		])
		await recipe('latte', [{ itemId: ids.milk, quantity: 150_000 }])
		return ids
	}

	async function recipe(
		ownerId: string,
		lines: { itemId: string; quantity: number }[],
		effectiveFrom = NOW - DAY,
	) {
		const id = `rec_${ownerId}`
		await db.insert(invRecipes).values({
			id,
			ownerKind: 'menu_item',
			ownerId,
			version: 1,
			effectiveFrom,
			createdByKind: 'system',
		})
		await db.insert(invRecipeLines).values(
			lines.map((line, index) => ({
				recipeId: id,
				itemId: line.itemId,
				quantity: line.quantity,
				sortOrder: index,
			})),
		)
	}

	async function queueSale(
		type: 'pos_order' | 'restaurant_order',
		id: string,
		at = NOW,
	) {
		return db.transaction((tx) =>
			queueInventorySaleInTx(tx, { type, id, locationId: LOC_1 }, at),
		)
	}

	async function settle(type: 'pos_order' | 'restaurant_order', id: string) {
		return settleInventorySource(ORG, { type, id }, { now: NOW + 1000 })
	}

	async function onHand(itemId: string): Promise<number> {
		const rows = await db
			.select({ quantity: invMovements.quantity })
			.from(invMovements)
			.where(eq(invMovements.itemId, itemId))
		return rows.reduce((sum, row) => sum + row.quantity, 0)
	}

	async function usage(sourceType: string, sourceId: string) {
		const rows = await db
			.select()
			.from(invSaleUsage)
			.where(
				and(
					eq(invSaleUsage.sourceType, sourceType as 'pos_order'),
					eq(invSaleUsage.sourceId, sourceId),
				),
			)
		return Object.fromEntries(rows.map((row) => [row.itemId, row.quantity]))
	}

	describe('a Station sale', () => {
		it('stamps sale movements at rungUpAt, not settle time', async () => {
			const rungUpAt = NOW - 2 * HOUR
			const settleAt = NOW + 60_000
			const id = await insertPosSale(ORG, {
				lines: [posLine('burger', 1)],
				rungUpAt,
				paidAt: settleAt,
			})
			await queueSale('pos_order', id, settleAt)
			await settleInventorySource(
				ORG,
				{ type: 'pos_order', id },
				{ now: settleAt },
			)
			const [move] = await db
				.select()
				.from(invMovements)
				.where(
					and(
						eq(invMovements.sourceType, 'pos_order'),
						eq(invMovements.sourceId, id),
					),
				)
			expect(move?.createdAt).toBe(rungUpAt)
			expect(move?.createdAt).toBeLessThan(settleAt - 1000)
		})

		it('takes the recipe out of stock, valued at average cost', async () => {
			const id = await insertPosSale(ORG, {
				lines: [posLine('burger', 2)],
			})
			expect(await queueSale('pos_order', id)).toBe(true)
			expect(await settle('pos_order', id)).toEqual({ status: 'settled' })

			expect(await onHand(seed.chicken)).toBe(-400_000)
			expect(await onHand(seed.bun)).toBe(-2_000)
			expect(await usage('pos_order', id)).toEqual({
				[seed.chicken]: 400_000,
				[seed.bun]: 2_000,
			})
			const [chicken] = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.itemId, seed.chicken))
			expect(chicken).toMatchObject({
				kind: 'sale',
				sourceType: 'pos_order',
				sourceId: id,
				quantity: -400_000,
				// 400 g at 2.8 = 1120.00 minor units, taken out.
				valueMinor: -1120,
				currency: 'SAR',
				actorKind: 'system',
				businessDate: '2026-01-10',
			})
			const [row] = await db.select().from(invOutbox)
			expect(row?.settledAt).not.toBeNull()
		})

		it('settles once: a replay posts nothing and a revision posts the difference', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 2)] })
			await queueSale('pos_order', id)
			await settle('pos_order', id)

			// The same source queued and settled again changes nothing.
			await queueSale('pos_order', id, NOW + 10)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(-400_000)

			// Revised to three burgers: only the extra one is taken out.
			await db
				.update(posOrders)
				.set({ lines: [posLine('burger', 3)] })
				.where(eq(posOrders.id, id))
			await queueSale('pos_order', id, NOW + 20)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(-600_000)
			expect(await usage('pos_order', id)).toEqual({
				[seed.chicken]: 600_000,
				[seed.bun]: 3_000,
			})
			const movements = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.itemId, seed.chicken))
			expect(
				movements.map((row) => row.quantity).sort((a, b) => a - b),
			).toEqual([-400_000, -200_000])
		})

		it('gives everything back when the sale is cancelled', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(-200_000)

			await db
				.update(posOrders)
				.set({ status: 'void' })
				.where(eq(posOrders.id, id))
			await queueSale('pos_order', id, NOW + 10)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(0)
			expect(await onHand(seed.bun)).toBe(0)
			expect(await usage('pos_order', id)).toEqual({})
		})

		it('uses nothing while the tab is open, and everything once paid', async () => {
			const id = await insertPosSale(ORG, {
				status: 'open',
				lines: [posLine('burger', 1)],
			})
			await queueSale('pos_order', id)
			expect(await settle('pos_order', id)).toEqual({ status: 'settled' })
			expect(await onHand(seed.chicken)).toBe(0)

			await db
				.update(posOrders)
				.set({ status: 'paid' })
				.where(eq(posOrders.id, id))
			await queueSale('pos_order', id, NOW + 10)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(-200_000)
		})

		it('a refund does not return stock: the food was made', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			await settle('pos_order', id)
			await db
				.update(posOrders)
				.set({ status: 'refunded', refundedCents: 1000 })
				.where(eq(posOrders.id, id))
			await queueSale('pos_order', id, NOW + 10)
			await settle('pos_order', id)
			expect(await onHand(seed.chicken)).toBe(-200_000)
		})

		it('a dish with no recipe adds nothing', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('mystery', 4)] })
			await queueSale('pos_order', id)
			expect(await settle('pos_order', id)).toEqual({ status: 'settled' })
			expect(await db.select().from(invMovements)).toHaveLength(0)
		})

		it('a quality void is waste of the dish, once; out of stock is only a signal', async () => {
			const id = await insertPosSale(ORG, {
				lines: [posLine('latte', 1)],
				lineVoids: [
					{
						id: 'void_quality',
						itemId: 'burger',
						name: 'Burger',
						variantLabel: null,
						quantity: 1,
						unitCents: 1000,
						at: new Date(NOW).toISOString(),
						by: null,
						approvedBy: null,
						reason: 'quality',
					},
					{
						id: 'void_stock',
						itemId: 'burger',
						name: 'Burger',
						variantLabel: null,
						quantity: 1,
						unitCents: 1000,
						at: new Date(NOW).toISOString(),
						by: null,
						approvedBy: null,
						reason: 'out_of_stock',
					},
					{
						id: 'void_mistake',
						itemId: 'burger',
						name: 'Burger',
						variantLabel: null,
						quantity: 1,
						unitCents: 1000,
						at: new Date(NOW).toISOString(),
						by: null,
						approvedBy: null,
						reason: 'mistake',
					},
				],
			})
			await queueSale('pos_order', id)
			await settle('pos_order', id)
			await queueSale('pos_order', id, NOW + 10)
			await settle('pos_order', id)

			const waste = await db.select().from(invWaste)
			expect(waste.map((row) => [row.itemId, row.quantity]).sort()).toEqual([
				[seed.bun, 1_000],
				[seed.chicken, 200_000],
			])
			expect(waste[0]).toMatchObject({
				reason: 'cancelled_after_cooking',
				actorKind: 'system',
				source: 'station',
			})
			// The sold latte used milk; the wasted burger took chicken and a bun
			// out once, as waste movements.
			expect(await onHand(seed.milk)).toBe(-150_000)
			expect(await onHand(seed.chicken)).toBe(-200_000)
			const wasteMoves = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.kind, 'waste'))
			expect(wasteMoves).toHaveLength(2)
			expect(await usage('pos_void', 'void_quality')).toEqual({
				[seed.chicken]: 200_000,
				[seed.bun]: 1_000,
			})
			expect(await usage('pos_void', 'void_stock')).toEqual({})
		})
	})

	describe('a web or QR order', () => {
		it('pay at pickup counts at once and a cancel returns it', async () => {
			const id = await insertOrder(ORG, {
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				lines: [webLine('burger', 2)],
				createdAt: new Date(NOW),
			})
			await queueSale('restaurant_order', id)
			await settle('restaurant_order', id)
			expect(await onHand(seed.chicken)).toBe(-400_000)

			await db
				.update(restaurantOrders)
				.set({ status: 'cancelled' })
				.where(eq(restaurantOrders.id, id))
			await queueSale('restaurant_order', id, NOW + 10)
			await settle('restaurant_order', id)
			expect(await onHand(seed.chicken)).toBe(0)
		})

		it('an online order uses stock only once it is paid', async () => {
			const id = await insertOrder(ORG, {
				status: 'accepted',
				paymentMethod: 'online',
				paymentStatus: 'pending',
				lines: [webLine('latte', 1)],
				createdAt: new Date(NOW),
			})
			await queueSale('restaurant_order', id)
			await settle('restaurant_order', id)
			expect(await onHand(seed.milk)).toBe(0)

			await db
				.update(restaurantOrders)
				.set({ paymentStatus: 'paid' })
				.where(eq(restaurantOrders.id, id))
			await queueSale('restaurant_order', id, NOW + 10)
			await settle('restaurant_order', id)
			expect(await onHand(seed.milk)).toBe(-150_000)
		})

		it('the rounds of a tab rung up on a Station till are left to that till sale', async () => {
			const tableId = await insertQrTable(ORG)
			const tabId = await insertTab(ORG, { tableId, rungUpOnStation: false })
			const round = await insertOrder(ORG, {
				status: 'completed',
				paymentMethod: 'handoff',
				paymentStatus: 'paid',
				tabId,
				lines: [webLine('latte', 1)],
				createdAt: new Date(NOW),
			})
			await queueSale('restaurant_order', round)
			await settle('restaurant_order', round)
			expect(await onHand(seed.milk)).toBe(-150_000)

			await db
				.update(qrTabs)
				.set({ rungUpOnStation: true })
				.where(eq(qrTabs.id, tabId))
			const queue = inventorySaleQueue()
			await db.transaction((tx) =>
				queue.queue(
					tx,
					{ type: 'restaurant_order', id: round, locationId: LOC_1 },
					NOW + 10,
				),
			)
			await queue.settle(ORG, { now: NOW + 1000 })
			expect(await onHand(seed.milk)).toBe(0)
		})
	})

	describe('recipe versions', () => {
		it('uses the version in force when the sale was made, not the newest', async () => {
			// burger v2 (effective now) halves the chicken; a sale from yesterday
			// keeps the old recipe.
			await db
				.update(invRecipes)
				.set({ supersededAt: NOW - 1000 })
				.where(eq(invRecipes.id, 'rec_burger'))
			await db.insert(invRecipes).values({
				id: 'rec_burger_2',
				ownerKind: 'menu_item',
				ownerId: 'burger',
				version: 2,
				effectiveFrom: NOW - 1000,
				createdByKind: 'system',
			})
			await db.insert(invRecipeLines).values({
				recipeId: 'rec_burger_2',
				itemId: seed.chicken,
				quantity: 100_000,
			})
			const old = await insertPosSale(ORG, {
				lines: [posLine('burger', 1)],
				rungUpAt: NOW - 2 * 60 * 60 * 1000,
			})
			const fresh = await insertPosSale(ORG, {
				lines: [posLine('burger', 1)],
				rungUpAt: NOW,
			})
			await queueSale('pos_order', old)
			await queueSale('pos_order', fresh)
			await settle('pos_order', old)
			await settle('pos_order', fresh)
			expect(await usage('pos_order', old)).toMatchObject({
				[seed.chicken]: 200_000,
			})
			expect(await usage('pos_order', fresh)).toEqual({
				[seed.chicken]: 100_000,
			})
		})
	})

	describe('queueing and the flags', () => {
		it('queues nothing for an organization without recipes', async () => {
			// Recipes are append-only: start over with an empty organization.
			await destroyTenantDb(ORG)
			await provisionTenantDb(ORG)
			db = await getTenantDb(ORG)
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			expect(await queueSale('pos_order', id)).toBe(false)
			expect(await db.select().from(invOutbox)).toHaveLength(0)
		})

		it('coalesces a source queued twice before it settles', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			await queueSale('pos_order', id, NOW + 5)
			const rows = await db.select().from(invOutbox)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.nextAttemptAt).toBe(NOW + 5)
		})

		it('flags off: closes the row without taking stock out', async () => {
			seedInventoryContextForTest(ORG, { ...ON, enabled: false })
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			expect(await settle('pos_order', id)).toEqual({ status: 'skipped' })
			expect(await db.select().from(invMovements)).toHaveLength(0)
			const [row] = await db.select().from(invOutbox)
			expect(row?.settledAt).not.toBeNull()
		})

		it('recipes flag off behaves like inventory off', async () => {
			seedInventoryContextForTest(ORG, { ...ON, recipes: false })
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			expect(await settle('pos_order', id)).toEqual({ status: 'skipped' })
		})

		it('a source that already took stock out still converges while the flag is off', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			await settle('pos_order', id)
			seedInventoryContextForTest(ORG, { ...ON, enabled: false })
			await db
				.update(posOrders)
				.set({ status: 'void' })
				.where(eq(posOrders.id, id))
			await queueSale('pos_order', id, NOW + 10)
			expect(await settle('pos_order', id)).toEqual({ status: 'settled' })
			expect(await onHand(seed.chicken)).toBe(0)
		})

		it('flags that cannot be read leave the row queued, then settle later', async () => {
			invalidateInventoryContext()
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			// No App to ask and nothing cached: unknown, so deferred.
			expect(await settle('pos_order', id)).toEqual({ status: 'deferred' })
			let [row] = await db.select().from(invOutbox)
			expect(row?.settledAt).toBeNull()
			expect(row?.attempts).toBe(0)

			seedInventoryContextForTest(ORG, ON)
			expect(await settle('pos_order', id)).toEqual({ status: 'settled' })
			;[row] = await db.select().from(invOutbox)
			expect(row?.settledAt).not.toBeNull()
			expect(await onHand(seed.chicken)).toBe(-200_000)
		})
	})

	describe('the outbox', () => {
		it('settles the due rows and reports what is left', async () => {
			const a = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			const b = await insertPosSale(ORG, { lines: [posLine('latte', 1)] })
			await queueSale('pos_order', a, NOW)
			// Not due yet.
			await queueSale('pos_order', b, NOW + 60 * 60 * 1000)

			const first = await processInventoryOutbox(ORG, { now: NOW + 1000 })
			expect(first).toMatchObject({ processed: 1, failed: 0, more: false })
			expect(first.nextDueAt).toBe(NOW + 60 * 60 * 1000)

			const second = await processInventoryOutbox(ORG, {
				now: NOW + 61 * 60 * 1000,
			})
			expect(second).toMatchObject({ processed: 1, failed: 0, nextDueAt: null })
			expect(await onHand(seed.milk)).toBe(-150_000)
		})

		it('a failing row backs off and never blocks the others', async () => {
			const broken = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			const fine = await insertPosSale(ORG, { lines: [posLine('latte', 1)] })
			await queueSale('pos_order', broken, NOW)
			await queueSale('pos_order', fine, NOW + 1)
			// Make the burger's stock write collide with an existing event key.
			const [row] = await db
				.select()
				.from(invOutbox)
				.where(eq(invOutbox.sourceId, broken))
			await db.insert(invMovements).values({
				locationId: LOC_1,
				itemId: seed.chicken,
				quantity: 1,
				kind: 'adjustment',
				sourceType: 'adjustment',
				sourceId: 'x',
				eventKey: `sale:${row!.id}:${LOC_1}:${seed.chicken}`,
				businessDate: '2026-01-10',
				actorKind: 'system',
			})

			const now = NOW + 1000
			const result = await processInventoryOutbox(ORG, { now })
			expect(result).toMatchObject({ processed: 1, failed: 1 })
			// The latte settled whatever happened to the other row.
			expect(await onHand(seed.milk)).toBe(-150_000)
			// The burger rolled back whole and waits, with a short machine reason.
			expect(await usage('pos_order', broken)).toEqual({})
			const [after] = await db
				.select()
				.from(invOutbox)
				.where(eq(invOutbox.sourceId, broken))
			expect(after).toMatchObject({ attempts: 1, settledAt: null })
			expect(after?.nextAttemptAt).toBe(now + 30_000)
			expect(after?.lastError).toBeTruthy()
			expect(after?.lastError?.length).toBeLessThanOrEqual(60)
			expect(result.nextDueAt).toBe(now + 30_000)
		})

		it('prunes settled rows after two weeks', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			await settle('pos_order', id)
			expect(await pruneInventoryOutbox(ORG, NOW + 3 * DAY)).toBe(0)
			expect(await pruneInventoryOutbox(ORG, NOW + 15 * DAY)).toBe(1)
			expect(await db.select().from(invOutbox)).toHaveLength(0)
		})

		it('backs off from 30 seconds up to an hour', () => {
			expect(inventoryOutboxBackoffMs(1)).toBe(30_000)
			expect(inventoryOutboxBackoffMs(2)).toBe(60_000)
			expect(inventoryOutboxBackoffMs(3)).toBe(120_000)
			expect(inventoryOutboxBackoffMs(30)).toBe(60 * 60 * 1000)
		})
	})

	describe('the order and tick call sites', () => {
		it('an operator cancelling an order gives its stock back', async () => {
			const id = await insertOrder(ORG, {
				status: 'accepted',
				paymentMethod: 'handoff',
				paymentStatus: 'unpaid',
				lines: [webLine('burger', 1)],
				createdAt: new Date(NOW),
			})
			await queueSale('restaurant_order', id)
			await settle('restaurant_order', id)
			expect(await onHand(seed.chicken)).toBe(-200_000)

			const result = await updateOperatorOrder(ORG, id, { status: 'cancelled' })
			expect(result.ok).toBe(true)
			expect(await onHand(seed.chicken)).toBe(0)
			expect(await onHand(seed.bun)).toBe(0)
		})

		it('the tick settles what failed to settle right after the sale', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id)
			const result = await runInventoryTickForOrg(ORG, {
				now: NOW + 5000,
				post: async () => ({ status: 'delivered' }),
			})
			expect(result).toMatchObject({ salesSettled: 1, needsFollowUp: false })
			expect(await onHand(seed.chicken)).toBe(-200_000)
		})

		it('a due failure keeps the tick asking for a follow-up', async () => {
			const id = await insertPosSale(ORG, { lines: [posLine('burger', 1)] })
			await queueSale('pos_order', id, NOW)
			const [row] = await db.select().from(invOutbox)
			await db.insert(invMovements).values({
				locationId: LOC_1,
				itemId: seed.chicken,
				quantity: 1,
				kind: 'adjustment',
				sourceType: 'adjustment',
				sourceId: 'x',
				eventKey: `sale:${row!.id}:${LOC_1}:${seed.chicken}`,
				businessDate: '2026-01-10',
				actorKind: 'system',
			})
			const now = NOW + 5000
			const result = await runInventoryTickForOrg(ORG, {
				now,
				post: async () => ({ status: 'delivered' }),
			})
			expect(result.salesSettled).toBe(0)
			expect(result.errors).toBe(1)
			expect(result.needsFollowUp).toBe(true)
			expect(result.nextDueAt).toBe(now + 30_000)
		})
	})

	describe('reading voids', () => {
		it('keeps well formed voids and drops the rest', () => {
			expect(
				parsePosVoids([
					{ id: 'v1', itemId: 'a', quantity: 2, reason: 'quality' },
					{ id: 'v2', itemId: 'a', quantity: 0, reason: 'quality' },
					{ id: 'v3', itemId: 'a', quantity: 1, reason: 'because' },
					{ id: '', itemId: 'a', quantity: 1, reason: 'mistake' },
					null,
					'x',
				]),
			).toEqual([{ id: 'v1', itemId: 'a', quantity: 2, reason: 'quality' }])
			expect(parsePosVoids('not json')).toEqual([])
			expect(parsePosVoids(undefined)).toEqual([])
		})
	})
})
