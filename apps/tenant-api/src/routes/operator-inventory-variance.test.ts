import { varianceMovementsSchema, varianceSchema } from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCounts,
	invMovements,
	invRecipeLines,
	invRecipes,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { computeFoodCost } from '../services/inventory-food-cost.ts'
import {
	BASE,
	COST,
	cid,
	makeClient,
	mintToken,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Expected versus actual use by item between approved full counts (#509): per
 * item the opening, deliveries, waste, closing, actual and expected use and
 * the gap in quantity and money; items no recipe uses show actual use only;
 * the totals are exactly actual food cost minus expected food cost; a trend of
 * the last periods; the movements behind a row; money needs the cost grant.
 */

const ORG = 'org_inv_variance'
const LOC = 'loc_variance'
const EMPTY = 'loc_variance_empty'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

let env: ReturnType<typeof setupTenantEnv>
const features = { recipes: true }
let full: string
let noCost: string
let noRecipes: string
const world = { flour: '', spice: '', idle: '' }

const HOUR = 3600_000
// Three counts a week apart: two periods.
const T0 = Date.UTC(2026, 9, 1, 20, 0, 0)
const T1 = T0 + 7 * 24 * HOUR
const T2 = T1 + 7 * 24 * HOUR

beforeAll(async () => {
	env = setupTenantEnv('inv-variance')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	const grants = [READ, UPDATE, COST, RECIPE]
	full = await mintToken(ORG, { grants, features })
	noCost = await mintToken(ORG, { grants: [READ, UPDATE], features })
	noRecipes = await mintToken(ORG, { grants, features: { recipes: false } })
	for (const [key, name] of [
		['flour', 'Flour'],
		['spice', 'Secret spice'],
		['idle', 'Idle item'],
	] as const) {
		const made = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name,
				category: 'dry_goods',
				kind: 'bought',
				baseUnit: 'g',
			},
		})
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		world[key] = made.body.id
	}
	const db = await getTenantDb(ORG)
	// Flour is in a recipe; the spice and the idle item are in none.
	await db.insert(invRecipes).values({
		id: 'rec_var_dish',
		ownerKind: 'menu_item',
		ownerId: 'dish_var',
		version: 1,
		effectiveFrom: 1,
		createdByKind: 'system',
	})
	await db.insert(invRecipeLines).values({
		recipeId: 'rec_var_dish',
		itemId: world.flour,
		quantity: 100_000,
	})
	const count = (id: string, at: number) => ({
		id,
		locationId: LOC,
		status: 'approved' as const,
		businessDate: new Date(at).toISOString().slice(0, 10),
		startedByKind: 'operator' as const,
		approvedAt: at,
		createdAt: at - 1000,
	})
	await db
		.insert(invCounts)
		.values([count('v0', T0), count('v1', T1), count('v2', T2)])
	let n = 0
	const move = (
		itemId: string,
		kind: 'count' | 'delivery' | 'sale' | 'waste' | 'batch_made',
		quantity: number,
		valueMinor: number,
		createdAt: number,
	) => {
		n += 1
		return {
			locationId: LOC,
			itemId,
			quantity,
			valueMinor,
			currency: 'SAR',
			kind,
			sourceType: kind,
			sourceId: `var-${n}`,
			eventKey: `var:${n}`,
			businessDate: new Date(createdAt).toISOString().slice(0, 10),
			actorKind: 'operator' as const,
			createdAt,
		}
	}
	await db.insert(invMovements).values([
		// Count 0: 4 kg of flour at SAR 3/kg.
		move(world.flour, 'count', 4_000_000, 1200, T0),
		// Period one (T0, T1]: 8 kg delivered, 2 kg sold by recipes, nothing off.
		move(world.flour, 'delivery', 8_000_000, 2400, T0 + HOUR),
		move(world.flour, 'sale', -2_000_000, -600, T0 + 2 * HOUR),
		// Period two (T1, T2]: 5 kg delivered, 8 kg sold, 0.5 kg logged as waste,
		// and the closing count finds another 0.5 kg missing.
		move(world.flour, 'delivery', 5_000_000, 1500, T1 + HOUR),
		move(world.flour, 'sale', -8_000_000, -2400, T1 + 2 * HOUR),
		move(world.flour, 'waste', -500_000, -150, T1 + 3 * HOUR),
		move(world.flour, 'count', -500_000, -150, T2),
		// The spice: 1 kg at SAR 5 before the opening count, 0.3 kg gone by the closing one.
		move(world.spice, 'count', 1_000_000, 5000, T1),
		move(world.spice, 'count', -300_000, -1500, T2),
	])
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

const get = (path: string, token = full) =>
	call('GET', `${BASE}${path}`, { token })

describe('use against recipes between two counts (#509)', () => {
	it('shows each item its actual and expected use and the gap, worst first, and items no recipe uses with actual use only', async () => {
		const res = await get(`/variance?locationId=${LOC}`)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const view = varianceSchema.parse(res.body)
		expect(view.state).toBe('ok')
		expect(view.period).toMatchObject({
			openingCountId: 'v1',
			closingCountId: 'v2',
		})
		expect(view.periods.map((p) => p.closingCountId)).toEqual(['v2', 'v1'])

		const flour = view.rows.find((r) => r.itemId === world.flour)!
		// Opening 10 kg + 5 kg delivered - 6 kg counted at the end = 9 kg used,
		// against the 8 kg sales and recipes took: 1 kg gone, 0.5 kg of it logged as waste.
		expect(flour).toMatchObject({
			opening: 10_000_000,
			delivered: 5_000_000,
			waste: 500_000,
			closing: 6_000_000,
			actualUse: 9_000_000,
			expectedUse: 8_000_000,
			gapQuantity: 1_000_000,
			noRecipe: false,
			actualUseMinor: 2700,
			expectedUseMinor: 2400,
			gapMinor: 300,
		})
		const spice = view.rows.find((r) => r.itemId === world.spice)!
		// No recipe uses it: its use is shown, its gap is not.
		expect(spice).toMatchObject({
			noRecipe: true,
			actualUse: 300_000,
			expectedUse: null,
			gapQuantity: null,
			actualUseMinor: 1500,
		})
		expect(spice.gapMinor).toBeUndefined()
		// Items with nothing happening are left out; the worst gap is first.
		expect(view.rows.some((r) => r.itemId === world.idle)).toBe(false)
		expect(view.rows.map((r) => r.itemId)).toEqual([world.flour, world.spice])
		// A trend per item across the periods, oldest first: no gap, then 1 kg.
		expect(
			flour.trend.map((p) => [p.closingCountId, p.gapQuantity, p.gapMinor]),
		).toEqual([
			['v1', 0, 0],
			['v2', 1_000_000, 300],
		])
	})

	it('adds up: the total gap is actual food cost minus expected food cost', async () => {
		const view = varianceSchema.parse(
			(await get(`/variance?locationId=${LOC}`)).body,
		)
		const db = await getTenantDb(ORG)
		const cost = await computeFoodCost(db, { locationId: LOC, targetBp: 3000 })
		const actualFoodCost =
			cost.openingMinor! + cost.purchasesMinor! - cost.closingMinor!
		// What the recipes say sales and batches used, from the ledger's sale movements.
		const expectedFoodCost = 2400
		expect(view.totals).toMatchObject({
			actualMinor: actualFoodCost,
			expectedMinor: expectedFoodCost,
			gapMinor: actualFoodCost - expectedFoodCost,
			noRecipeUseMinor: 1500,
			wasteMinor: 150,
		})
		// 2700 (flour) + 1500 (spice) actual, less 2400 expected.
		expect(view.totals!.gapMinor).toBe(1800)
		expect(view.totals!.gapBpOfSales).toBeNull()
		const earlier = varianceSchema.parse(
			(await get(`/variance?locationId=${LOC}&closingCountId=v1`)).body,
		)
		expect(earlier.period).toMatchObject({
			openingCountId: 'v0',
			closingCountId: 'v1',
		})
		// The first period: flour balances (4 + 8 - 2 = 10 kg counted); the 1 kg of
		// spice the count at its end found out of nowhere is a gap of SAR 50 the
		// other way, and it sits in the totals though its row shows no gap.
		expect(earlier.totals).toMatchObject({
			actualMinor: -4400,
			expectedMinor: 600,
			gapMinor: -5000,
			noRecipeUseMinor: -5000,
		})
	})

	it('shows the movements behind a row, newest first', async () => {
		const res = await get(
			`/variance/movements?locationId=${LOC}&itemId=${world.flour}`,
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const view = varianceMovementsSchema.parse(res.body)
		expect(view.movements.map((m) => [m.kind, m.quantity])).toEqual([
			['count', -500_000],
			['waste', -500_000],
			['sale', -8_000_000],
			['delivery', 5_000_000],
		])
		expect(view.movements[0]!.valueMinor).toBe(-150)
		const plain = await get(
			`/variance/movements?locationId=${LOC}&itemId=${world.flour}`,
			noCost,
		)
		expect(JSON.stringify(plain.body)).not.toMatch(/valueMinor|currency/)
	})

	it('hides money without the cost grant and is off without the recipes flag', async () => {
		const plain = varianceSchema.parse(
			(await get(`/variance?locationId=${LOC}`, noCost)).body,
		)
		expect(plain.totals).toBeUndefined()
		expect(plain.salesMinor).toBeUndefined()
		expect(JSON.stringify(plain)).not.toMatch(/Minor|currency/)
		// Quantities still tell the story.
		expect(plain.rows[0]).toMatchObject({
			gapQuantity: 1_000_000,
			noRecipe: false,
		})
		const off = await get(`/variance?locationId=${LOC}`, noRecipes)
		expect([off.status, off.body.code]).toEqual([403, 'feature_disabled'])
	})

	it('needs two approved full counts', async () => {
		const res = await get(`/variance?locationId=${EMPTY}`)
		expect(res.status).toBe(200)
		expect(varianceSchema.parse(res.body)).toMatchObject({
			state: 'need_two_counts',
			rows: [],
		})
		const missing = await get(`/variance?locationId=${LOC}&closingCountId=nope`)
		expect(missing.status).toBe(404)
	})
})
