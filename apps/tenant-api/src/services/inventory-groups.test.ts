import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type InventoryAvailabilityRequest } from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountEntries,
	invCounts,
	invItemGroupMembers,
	invItemGroups,
	invItems,
	invMovements,
	invRecipeLines,
	invRecipes,
	invSaleUsage,
	invSoldOut,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { syncAutoSoldOut } from './inventory-auto-sold-out.ts'
import { listGroups } from './inventory-groups-service.ts'
import { listItems } from './inventory-items-service.ts'
import {
	queueInventorySaleInTx,
	settleInventorySource,
} from './inventory-sales-service.ts'
import { insertPosSale, LOC_1, NOW } from './loyalty-test-fixture.ts'

const ORG = 'org_inv_groups_test'
const DAY = 24 * 60 * 60 * 1000
const ON = {
	enabled: true,
	purchasing: false,
	recipes: true,
	prep: false,
	transfers: false,
}

function posLine(itemId: string, quantity: number) {
	return {
		id: `line_${itemId}`,
		itemId,
		name: 'Dish',
		variantId: null,
		variantLabel: null,
		quantity,
		baseCents: 1000,
		instructions: '',
		options: [],
	}
}

describe('ingredient groups (#495)', () => {
	let tempDir: string
	let db: TenantDatabase

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-inv-groups-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		invalidateInventoryContext()
		seedInventoryContextForTest(ORG, ON)
		// Olive oil: brand A (primary) and brand B, one group `oil`.
		await db.insert(invItems).values([
			{ id: 'oil_a', name: 'Oil A', baseUnit: 'ml' },
			{ id: 'oil_b', name: 'Oil B', baseUnit: 'ml' },
			{ id: 'oil', name: 'Olive oil', baseUnit: 'ml', autoSoldOut: true },
		])
		await db.insert(invItemGroups).values({ itemId: 'oil' })
		await db.insert(invItemGroupMembers).values([
			{ groupItemId: 'oil', memberItemId: 'oil_a', rank: 0 },
			{ groupItemId: 'oil', memberItemId: 'oil_b', rank: 1 },
		])
		await db.insert(invRecipes).values({
			id: 'rec_fries',
			ownerKind: 'menu_item',
			ownerId: 'fries',
			version: 1,
			effectiveFrom: NOW - DAY,
			createdByKind: 'system',
		})
		await db
			.insert(invRecipeLines)
			.values({ recipeId: 'rec_fries', itemId: 'oil', quantity: 100_000 })
	})

	afterEach(async () => {
		invalidateInventoryContext()
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function stock(itemId: string, quantity: number) {
		await db.insert(invMovements).values({
			locationId: LOC_1,
			itemId,
			quantity,
			kind: 'delivery',
			sourceType: 'delivery',
			sourceId: `d_${itemId}`,
			businessDate: '2026-01-10',
			actorKind: 'system',
			createdAt: NOW - 1000,
		})
	}

	async function sell(quantity: number) {
		const id = await insertPosSale(ORG, { lines: [posLine('fries', quantity)] })
		await db.transaction((tx) =>
			queueInventorySaleInTx(
				tx,
				{ type: 'pos_order', id, locationId: LOC_1 },
				NOW,
			),
		)
		await settleInventorySource(
			ORG,
			{ type: 'pos_order', id },
			{ now: NOW + 1000 },
		)
		return id
	}

	async function onHand(itemId: string) {
		const rows = await db
			.select({ quantity: invMovements.quantity })
			.from(invMovements)
			.where(eq(invMovements.itemId, itemId))
		return rows.reduce((sum, row) => sum + row.quantity, 0)
	}

	it('takes stock from the primary, then the next member', async () => {
		await stock('oil_a', 150_000)
		await stock('oil_b', 1_000_000)
		const id = await sell(3)
		expect(await onHand('oil_a')).toBe(0)
		expect(await onHand('oil_b')).toBe(1_000_000 - 150_000)
		// Usage is on the members, never on the group.
		const usage = await db
			.select()
			.from(invSaleUsage)
			.where(
				and(
					eq(invSaleUsage.sourceType, 'pos_order'),
					eq(invSaleUsage.sourceId, id),
				),
			)
		expect(
			Object.fromEntries(usage.map((row) => [row.itemId, row.quantity])),
		).toEqual({
			oil_a: 150_000,
			oil_b: 150_000,
		})
		expect(await onHand('oil')).toBe(0)
	})

	it('settling the same sale again changes nothing', async () => {
		await stock('oil_a', 150_000)
		await stock('oil_b', 1_000_000)
		const id = await sell(3)
		await db.transaction((tx) =>
			queueInventorySaleInTx(
				tx,
				{ type: 'pos_order', id, locationId: LOC_1 },
				NOW,
			),
		)
		await settleInventorySource(
			ORG,
			{ type: 'pos_order', id },
			{ now: NOW + 2000 },
		)
		expect(await onHand('oil_a')).toBe(0)
		expect(await onHand('oil_b')).toBe(850_000)
	})

	it('shows the group with the members total and each member on hand', async () => {
		await stock('oil_a', 200_000)
		await stock('oil_b', 300_000)
		const { groups } = await listGroups(db, { locationId: LOC_1, cost: false })
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({ id: 'oil', onHand: 500_000 })
		expect(groups[0]!.members.map((m) => [m.itemId, m.rank, m.onHand])).toEqual(
			[
				['oil_a', 0, 200_000],
				['oil_b', 1, 300_000],
			],
		)
		const list = await listItems(db, {
			query: {
				locationId: LOC_1,
				limit: 50,
				status: 'all',
				includeArchived: false,
				sort: 'name',
			},
			cost: false,
		})
		const group = list.items.find((item) => item.id === 'oil')!
		expect(group).toMatchObject({ isGroup: true, onHand: 500_000 })
		expect(list.items.find((item) => item.id === 'oil_a')).toMatchObject({
			groupId: 'oil',
			onHand: 200_000,
		})
	})

	describe('auto sold out', () => {
		const posted: InventoryAvailabilityRequest[] = []
		const post = async (request: InventoryAvailabilityRequest) => {
			posted.push(request)
			return {
				status: 'applied' as const,
				applied: request.changes.map((change) => change.entityId),
			}
		}

		async function counted() {
			await db.insert(invCounts).values({
				id: 'c1',
				locationId: LOC_1,
				status: 'counting',
				businessDate: '2026-01-09',
				startedByKind: 'operator',
			})
			let n = 0
			for (const itemId of ['oil_a', 'oil_b']) {
				n += 1
				await db.insert(invCountEntries).values({
					countId: 'c1',
					itemId,
					quantity: 0,
					enteredAmount: '0',
					enteredUnit: 'ml',
					counterKind: 'operator',
					clientId: `client_${n}_xx`,
				})
			}
			await db
				.update(invCounts)
				.set({ status: 'approved', approvedAt: NOW - DAY })
				.where(eq(invCounts.id, 'c1'))
		}

		it('keeps the dish on while any member has stock and takes it off only at group zero', async () => {
			posted.length = 0
			await counted()
			// Brand A at zero, brand B in stock: the dish stays.
			await stock('oil_a', 100)
			await db.insert(invMovements).values({
				locationId: LOC_1,
				itemId: 'oil_a',
				quantity: -100,
				kind: 'sale',
				sourceType: 'pos_order',
				sourceId: 's0',
				businessDate: '2026-01-10',
				actorKind: 'system',
				createdAt: NOW - 500,
			})
			await stock('oil_b', 500_000)
			await syncAutoSoldOut(ORG, { now: NOW, post })
			expect(posted).toHaveLength(0)
			expect(await db.select().from(invSoldOut)).toHaveLength(0)
			// Now brand B runs out too: the whole group is at zero.
			await db.insert(invMovements).values({
				locationId: LOC_1,
				itemId: 'oil_b',
				quantity: -500_000,
				kind: 'sale',
				sourceType: 'pos_order',
				sourceId: 's1',
				businessDate: '2026-01-10',
				actorKind: 'system',
				createdAt: NOW - 400,
			})
			await syncAutoSoldOut(ORG, { now: NOW, post })
			const rows = await db.select().from(invSoldOut)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				entityId: 'fries',
				causeItemId: 'oil',
				state: 'out',
			})
		})
	})
})
