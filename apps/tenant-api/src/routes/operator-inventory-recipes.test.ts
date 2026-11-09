import {
	getRecipeQuerySchema,
	itemDetailSchema,
	recipeCostsResultSchema,
	recipeResultSchema,
	recordBatchResultSchema,
	dishesWithoutRecipeResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invRecipeLines,
	invRecipes,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	COST,
	makeClient,
	mintToken,
	PURCHASING,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Recipes, plate costs, dishes without a recipe, recording a batch and the
 * item recipe flags of `/operator/inventory`. The control plane is mocked and
 * every organization gets a real tenant database.
 */

const ORG = 'org_inv_recipes_a'
const ORG_B = 'org_inv_recipes_b'
const LOC = 'loc_a'
const LOC_OTHER = 'loc_b'

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
let full: string
let noCost: string
let kitchen: string
let readOnly: string
let scoped: string
let flagOff: string
let tokenB: string

const recipesOn = { recipes: true }

beforeAll(async () => {
	env = setupTenantEnv('inv-recipes')
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
	full = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features: recipesOn,
	})
	noCost = await mintToken(ORG, {
		grants: [READ, UPDATE, RECIPE],
		features: recipesOn,
	})
	kitchen = await mintToken(ORG, {
		grants: [READ, UPDATE, COST],
		features: recipesOn,
	})
	readOnly = await mintToken(ORG, {
		scope: 'read',
		grants: [READ, COST],
		features: recipesOn,
	})
	scoped = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, RECIPE],
		locationIds: [LOC],
		features: recipesOn,
	})
	flagOff = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, RECIPE],
		features: { recipes: false },
	})
	tokenB = await mintToken(ORG_B, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features: recipesOn,
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

async function newItem(
	body: Record<string, unknown>,
	token = full,
): Promise<{ id: string; units: { id: string }[] }> {
	const res = await call('POST', `${BASE}/items`, {
		token,
		body: {
			clientId: cid('item'),
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
			...body,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return itemDetailSchema.parse(res.body)
}

/** A delivery that prices items: `total` minor units for `quantity` thousandths. */
async function deliver(
	lines: { itemId: string; quantity: number; total: number }[],
) {
	const res = await call('POST', `${BASE}/deliveries`, {
		token: full,
		body: {
			clientId: cid('delivery'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: lines.map((line) => ({
				itemId: line.itemId,
				quantity: line.quantity,
				lineTotalMinor: line.total,
			})),
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
}

function line(itemId: string, amount: number, unit: string, extra = {}) {
	return { itemId, amount, unit, ...extra }
}

async function put(body: Record<string, unknown>, token = full) {
	return call('PUT', `${BASE}/recipes`, { token, body })
}

async function getRecipe(
	ownerKind: string,
	ownerId: string,
	token = full,
	orgPath = '',
) {
	const res = await call(
		'GET',
		`${BASE}/recipes?ownerKind=${ownerKind}&ownerId=${ownerId}${orgPath}`,
		{ token },
	)
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return recipeResultSchema.parse(res.body)
}

async function versionRows(
	ownerKind: 'menu_item' | 'made_item' | 'option' | 'variant',
	ownerId: string,
) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(invRecipes)
		.where(
			and(eq(invRecipes.ownerKind, ownerKind), eq(invRecipes.ownerId, ownerId)),
		)
		.orderBy(asc(invRecipes.version))
}

let chicken: string
let pita: string
let milk: string
let oat: string
let cheese: string

beforeAll(async () => {
	chicken = (
		await newItem({
			name: 'Chicken thighs',
			units: [{ name: 'Tray', baseQuantity: 500_000 }],
		})
	).id
	pita = (
		await newItem({ name: 'Pita bread', category: 'bakery', baseUnit: 'piece' })
	).id
	milk = (await newItem({ name: 'Milk', category: 'dairy', baseUnit: 'ml' })).id
	oat = (await newItem({ name: 'Oat milk', category: 'dairy', baseUnit: 'ml' }))
		.id
	cheese = (await newItem({ name: 'Mozzarella', category: 'dairy' })).id
	// Chicken SAR 2.80 a gram... a minor unit: 2.8 minor per g (SAR 28/kg); pita 40 per piece; milk 0.2 per ml.
	await deliver([
		{ itemId: chicken, quantity: 10_000_000, total: 28_000 },
		{ itemId: pita, quantity: 100_000, total: 4_000 },
		{ itemId: milk, quantity: 10_000_000, total: 2_000 },
	])
})

// ── Menu item recipes ───────────────────────────────────────────────────────

describe('menu item recipes', () => {
	it('answers an empty result for an owner without a recipe', async () => {
		const result = await getRecipe('menu_item', 'dish_never')
		expect(result).toEqual({ recipe: null, version: 0 })
		expect(
			getRecipeQuerySchema.safeParse({ ownerKind: 'menu_item', ownerId: 'x' })
				.success,
		).toBe(true)
	})

	it('round-trips lines in base thousandths with usable yield and the plate cost', async () => {
		const res = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_shawarma',
			expectedVersion: 0,
			lines: [
				line(chicken, 180, 'g', { usableBp: 8500 }),
				line(pita, 1, 'piece'),
			],
			method: 'Grill hot.',
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = recipeResultSchema.parse(res.body)
		expect(result.version).toBe(1)
		const recipe = result.recipe!
		expect(recipe).toMatchObject({
			ownerKind: 'menu_item',
			ownerId: 'dish_shawarma',
			version: 1,
			method: 'Grill hot.',
			makesQuantity: null,
			multiplierBp: null,
		})
		expect(recipe.effectiveFrom).toBeGreaterThan(0)
		expect(recipe.lines).toMatchObject([
			{
				itemId: chicken,
				itemName: 'Chicken thighs',
				baseUnit: 'g',
				quantity: 180_000,
				usableBp: 8500,
				mode: 'add',
				sortOrder: 0,
				priced: true,
			},
			{ itemId: pita, quantity: 1000, baseUnit: 'piece', sortOrder: 1 },
		])
		// 180 g usable 85% is 211.76 g raw at 2.8 a gram (592.94) plus a pita at 40.
		expect(recipe.lines[0]!.costMinor).toBe(593)
		expect(recipe.lines[1]!.costMinor).toBe(40)
		expect(recipe.plate).toEqual({
			state: 'complete',
			costMinor: 633,
			currency: 'SAR',
			missingItemIds: [],
		})
		// A read returns the same recipe.
		expect(await getRecipe('menu_item', 'dish_shawarma')).toEqual(result)
	})

	it('leaves every money field out for a token without the cost grant', async () => {
		const result = await getRecipe('menu_item', 'dish_shawarma', noCost)
		const text = JSON.stringify(result)
		expect(result.recipe!.plate).toBeUndefined()
		expect(text).not.toMatch(/costMinor|typedCost|currency|plate/)
		expect(result.recipe!.lines[0]).toMatchObject({ priced: true })
	})

	it('writes the first version expecting 0 and refuses a stale version', async () => {
		const first = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_stale',
			expectedVersion: 1,
			lines: [line(pita, 1, 'piece')],
		})
		expect(first.status).toBe(409)
		expect(first.body).toMatchObject({
			code: 'stale_version',
			currentVersion: 0,
		})
		const ok = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_stale',
			expectedVersion: 0,
			lines: [line(pita, 1, 'piece')],
		})
		expect(ok.status).toBe(200)
		const again = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_stale',
			expectedVersion: 0,
			lines: [line(pita, 2, 'piece')],
		})
		expect(again.status).toBe(409)
		expect(again.body).toMatchObject({
			code: 'stale_version',
			currentVersion: 1,
		})
		expect((await versionRows('menu_item', 'dish_stale')).length).toBe(1)
	})

	it('writes a new version and keeps the old one with its lines (supersede, never edit)', async () => {
		const before = await versionRows('menu_item', 'dish_shawarma')
		expect(before).toHaveLength(1)
		const res = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_shawarma',
			expectedVersion: 1,
			lines: [
				line(chicken, 200, 'g', { usableBp: 8500 }),
				line(pita, 1, 'piece'),
				line(milk, 20, 'ml'),
			],
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const rows = await versionRows('menu_item', 'dish_shawarma')
		expect(rows.map((row) => row.version)).toEqual([1, 2])
		expect(rows[0]!.supersededAt).not.toBeNull()
		expect(rows[1]!.supersededAt).toBeNull()
		expect(rows[1]!.effectiveFrom).toBeGreaterThanOrEqual(
			rows[0]!.effectiveFrom,
		)
		const db = await getTenantDb(ORG)
		const oldLines = await db
			.select()
			.from(invRecipeLines)
			.where(eq(invRecipeLines.recipeId, rows[0]!.id))
		expect(oldLines).toHaveLength(2)
		const current = await getRecipe('menu_item', 'dish_shawarma')
		expect(current.version).toBe(2)
		expect(current.recipe!.lines).toHaveLength(3)
	})

	it('replays an Idempotency-Key with the first answer', async () => {
		const key = cid('idem')
		const body = {
			ownerKind: 'menu_item',
			ownerId: 'dish_idem',
			expectedVersion: 0,
			lines: [line(pita, 2, 'piece')],
		}
		const first = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body,
			headers: { 'Idempotency-Key': key },
		})
		const second = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body,
			headers: { 'Idempotency-Key': key },
		})
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(second.body).toEqual(first.body)
		expect((await versionRows('menu_item', 'dish_idem')).length).toBe(1)
		// The same key with another body is a conflict, not a second write.
		const other = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body: { ...body, lines: [line(pita, 3, 'piece')] },
			headers: { 'Idempotency-Key': key },
		})
		expect(other.status).toBe(409)
		expect(other.body.code).toBe('idempotency_conflict')
		const bad = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body,
			headers: { 'Idempotency-Key': 'short' },
		})
		expect(bad.status).toBe(400)
	})

	it('stores a typed cost only for a caller with the cost grant, and never beside lines', async () => {
		const body = {
			ownerKind: 'menu_item',
			ownerId: 'dish_can',
			expectedVersion: 0,
			typedCost: { minor: 450, currency: 'SAR' },
		}
		const denied = await put(body, noCost)
		expect(denied.status).toBe(403)
		expect(denied.body).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: COST,
		})
		expect(await versionRows('menu_item', 'dish_can')).toHaveLength(0)
		const ok = await put(body)
		expect(ok.status, JSON.stringify(ok.body)).toBe(200)
		const recipe = recipeResultSchema.parse(ok.body).recipe!
		expect(recipe).toMatchObject({
			typedCostMinor: 450,
			typedCostCurrency: 'SAR',
			lines: [],
		})
		expect(recipe.plate).toMatchObject({
			state: 'typed',
			costMinor: 450,
			typedCostMinor: 450,
		})
		const mixed = await put({
			...body,
			ownerId: 'dish_mixed',
			lines: [line(pita, 1, 'piece')],
		})
		expect(mixed.status).toBe(400)
		expect(mixed.body.code).toBe('invalid_request')
	})

	it('refuses an empty recipe (recipe_empty) and writes nothing', async () => {
		const res = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_empty',
			expectedVersion: 0,
			lines: [],
		})
		expect(res.status).toBe(400)
		expect(res.body.code).toBe('recipe_empty')
		expect(await versionRows('menu_item', 'dish_empty')).toHaveLength(0)
	})

	it('refuses unknown, archived and mismatched ingredients and writes nothing', async () => {
		const unknown = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad',
			expectedVersion: 0,
			lines: [line('nope_item', 1, 'g')],
		})
		expect(unknown.status).toBe(404)
		expect(unknown.body).toMatchObject({
			code: 'not_found',
			reason: 'ingredient',
		})
		const old = await newItem({ name: 'Retired spice' })
		const archived = await call('POST', `${BASE}/items/${old.id}/archive`, {
			token: full,
			body: { expectedVersion: 1 },
		})
		expect(archived.status).toBe(200)
		const gone = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad',
			expectedVersion: 0,
			lines: [line(old.id, 1, 'g')],
		})
		expect(gone.status).toBe(409)
		expect(gone.body).toMatchObject({
			code: 'invalid_request',
			reason: 'ingredient_archived',
		})
		const wrongUnit = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad',
			expectedVersion: 0,
			lines: [line(chicken, 1, 'l')],
		})
		expect(wrongUnit.status).toBe(400)
		expect(wrongUnit.body.code).toBe('unit_mismatch')
		// Another item's named unit cannot measure this one.
		const tray = (
			await call('GET', `${BASE}/items/${chicken}?locationId=${LOC}`, {
				token: full,
			})
		).body.units[0].id as string
		const foreign = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad',
			expectedVersion: 0,
			lines: [line(pita, 1, `unit:${tray}`)],
		})
		expect(foreign.status).toBe(400)
		expect(foreign.body.code).toBe('unit_mismatch')
		const tiny = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad',
			expectedVersion: 0,
			lines: [line(chicken, 0.0001, 'g')],
		})
		expect(tiny.status).toBe(400)
		expect(await versionRows('menu_item', 'dish_bad')).toHaveLength(0)
	})

	it('converts a named unit of the ingredient and fixes its size from then on', async () => {
		const res = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_tray',
			expectedVersion: 0,
			lines: [
				line(
					chicken,
					0.5,
					`unit:${(await call('GET', `${BASE}/items/${chicken}?locationId=${LOC}`, { token: full })).body.units[0].id}`,
				),
			],
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		// Half a 500 g tray.
		expect(recipeResultSchema.parse(res.body).recipe!.lines[0]!.quantity).toBe(
			250_000,
		)
		const detail = await call(
			'GET',
			`${BASE}/items/${chicken}?locationId=${LOC}`,
			{
				token: full,
			},
		)
		expect(detail.body.units[0].used).toBe(true)
	})

	it('refuses duplicate ingredients, a replace line on a dish and unknown fields (400)', async () => {
		for (const body of [
			{
				ownerKind: 'menu_item',
				ownerId: 'dish_dup',
				expectedVersion: 0,
				lines: [line(pita, 1, 'piece'), line(pita, 2, 'piece')],
			},
			{
				ownerKind: 'menu_item',
				ownerId: 'dish_dup',
				expectedVersion: 0,
				lines: [line(oat, 20, 'ml', { mode: 'replace', replacesItemId: milk })],
			},
			{
				ownerKind: 'menu_item',
				ownerId: 'dish_dup',
				expectedVersion: 0,
				lines: [line(pita, 1, 'piece')],
				surprise: 'secret-canary',
			},
		]) {
			const res = await put(body)
			expect(res.status).toBe(400)
			expect(JSON.stringify(res.body)).not.toContain('secret-canary')
		}
		expect(await versionRows('menu_item', 'dish_dup')).toHaveLength(0)
	})

	it('starts a version later than now and never earlier than the one before it', async () => {
		const soon = Date.now() + 3_600_000
		const first = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_later',
			expectedVersion: 0,
			lines: [line(pita, 1, 'piece')],
		})
		expect(first.status).toBe(200)
		const scheduled = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_later',
			expectedVersion: 1,
			lines: [line(pita, 2, 'piece')],
			effectiveFrom: soon,
		})
		expect(scheduled.status).toBe(200)
		const earlier = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_later',
			expectedVersion: 2,
			lines: [line(pita, 3, 'piece')],
			effectiveFrom: soon - 1000,
		})
		expect(earlier.status).toBe(400)
		expect(earlier.body.reason).toBe('effective_from_before_previous')
		// Backdating past what a late-synced sale could need is refused, even
		// on a first version (0 would make every old sale deduct).
		for (const ownerId of ['dish_later', 'dish_never_written']) {
			const ancient = await put({
				ownerKind: 'menu_item',
				ownerId,
				expectedVersion: ownerId === 'dish_later' ? 2 : 0,
				lines: [line(pita, 1, 'piece')],
				effectiveFrom: 0,
			})
			expect(ancient.status).toBe(400)
			expect(ancient.body.reason).toBe('effective_from_too_old')
		}
		const lastMonth = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_never_written',
			expectedVersion: 0,
			lines: [line(pita, 1, 'piece')],
			effectiveFrom: Date.now() - 30 * 24 * 60 * 60 * 1000,
		})
		expect(lastMonth.status).toBe(400)
		expect(lastMonth.body.reason).toBe('effective_from_too_old')
		// Without a date the next version starts no earlier than the scheduled one.
		const next = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_later',
			expectedVersion: 2,
			lines: [line(pita, 3, 'piece')],
		})
		expect(next.status).toBe(200)
		const rows = await versionRows('menu_item', 'dish_later')
		expect(rows.map((row) => row.effectiveFrom)).toEqual(
			[...rows.map((row) => row.effectiveFrom)].sort((a, b) => a - b),
		)
		expect(rows[2]!.effectiveFrom).toBe(soon)
	})
})

// ── Clearing ────────────────────────────────────────────────────────────────

describe('clearing a recipe', () => {
	it('writes a cleared version, keeps the history and lets a new recipe follow', async () => {
		await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_clear',
			expectedVersion: 0,
			lines: [line(pita, 1, 'piece')],
		})
		const stale = await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: 'dish_clear',
				expectedVersion: 0,
			},
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')
		const cleared = await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: 'dish_clear',
				expectedVersion: 1,
			},
		})
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
		expect(recipeResultSchema.parse(cleared.body)).toEqual({
			recipe: null,
			version: 2,
		})
		expect(await getRecipe('menu_item', 'dish_clear')).toEqual({
			recipe: null,
			version: 2,
		})
		const rows = await versionRows('menu_item', 'dish_clear')
		expect(rows.map((row) => row.version)).toEqual([1, 2])
		const db = await getTenantDb(ORG)
		expect(
			await db
				.select()
				.from(invRecipeLines)
				.where(eq(invRecipeLines.recipeId, rows[1]!.id)),
		).toHaveLength(0)
		// Nothing left to clear.
		const again = await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: 'dish_clear',
				expectedVersion: 2,
			},
		})
		expect(again.status).toBe(409)
		expect(again.body).toMatchObject({ reason: 'no_recipe' })
		const never = await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: 'dish_unwritten',
				expectedVersion: 0,
			},
		})
		expect(never.status).toBe(409)
		const next = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_clear',
			expectedVersion: 2,
			lines: [line(pita, 3, 'piece')],
		})
		expect(next.status).toBe(200)
		expect(recipeResultSchema.parse(next.body).version).toBe(3)
	})
})

// ── Variants and options ────────────────────────────────────────────────────

describe('sizes and options', () => {
	it('stores a size as a multiple of its item or as its own recipe, never both', async () => {
		const multiple = await put({
			ownerKind: 'variant',
			ownerId: 'size_large',
			expectedVersion: 0,
			multiplierBp: 15_000,
		})
		expect(multiple.status, JSON.stringify(multiple.body)).toBe(200)
		const recipe = recipeResultSchema.parse(multiple.body).recipe!
		expect(recipe).toMatchObject({ multiplierBp: 15_000, lines: [] })
		expect(recipe.plate).toBeUndefined()
		const own = await put({
			ownerKind: 'variant',
			ownerId: 'size_own',
			expectedVersion: 0,
			lines: [line(pita, 2, 'piece')],
		})
		expect(own.status).toBe(200)
		expect(recipeResultSchema.parse(own.body).recipe!.plate).toMatchObject({
			state: 'complete',
			costMinor: 80,
		})
		for (const body of [
			{ multiplierBp: 15_000, lines: [line(pita, 1, 'piece')] },
			{ multiplierBp: 15_000, typedCost: { minor: 5, currency: 'SAR' } },
			{ multiplierBp: 50 },
		]) {
			const res = await put({
				ownerKind: 'variant',
				ownerId: 'size_bad',
				expectedVersion: 0,
				...body,
			})
			expect(res.status).toBe(400)
		}
		const onDish = await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_bad_multiple',
			expectedVersion: 0,
			multiplierBp: 15_000,
		})
		expect(onDish.status).toBe(400)
		expect(await versionRows('variant', 'size_bad')).toHaveLength(0)
	})

	it('costs a size through the dish it multiplies', async () => {
		const res = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: {
				refs: [
					{ key: 'base', itemId: 'dish_shawarma' },
					{ key: 'large', itemId: 'dish_shawarma', variantId: 'size_large' },
				],
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const rows = recipeCostsResultSchema.parse(res.body).rows
		const base = rows.find((row) => row.key === 'base')!
		const large = rows.find((row) => row.key === 'large')!
		// Version 2: 200 g at 85% (658.82), a pita (40) and 20 ml of milk (4); a large is 1.5x.
		expect(base.costMinor).toBe(703)
		expect(large.costMinor).toBe(1054)
	})

	it('stores an option that adds and one that replaces an ingredient', async () => {
		const res = await put({
			ownerKind: 'option',
			ownerId: 'opt_oat',
			expectedVersion: 0,
			lines: [
				line(oat, 200, 'ml', { mode: 'replace', replacesItemId: milk }),
				line(cheese, 30, 'g'),
			],
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const recipe = recipeResultSchema.parse(res.body).recipe!
		expect(recipe.lines[0]).toMatchObject({
			itemId: oat,
			mode: 'replace',
			replacesItemId: milk,
			replacesItemName: 'Milk',
			priced: false,
		})
		expect(recipe.lines[1]).toMatchObject({
			mode: 'add',
			replacesItemName: null,
		})
		expect(recipe.plate).toBeUndefined()
		const noReplaces = await put({
			ownerKind: 'option',
			ownerId: 'opt_bad',
			expectedVersion: 0,
			lines: [line(oat, 200, 'ml', { mode: 'replace' })],
		})
		expect(noReplaces.status).toBe(400)
		const replaceMissing = await put({
			ownerKind: 'option',
			ownerId: 'opt_bad',
			expectedVersion: 0,
			lines: [
				line(oat, 200, 'ml', { mode: 'replace', replacesItemId: 'nope_item' }),
			],
		})
		expect(replaceMissing.status).toBe(404)
		expect(await versionRows('option', 'opt_bad')).toHaveLength(0)
	})
})

// ── Made items ──────────────────────────────────────────────────────────────

describe('made item recipes', () => {
	let sauce: string
	let sauce2: string

	beforeAll(async () => {
		sauce = (
			await newItem({
				name: 'Garlic sauce',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'ml',
			})
		).id
		sauce2 = (
			await newItem({
				name: 'Hot garlic sauce',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'ml',
			})
		).id
	})

	it('stores what a batch makes and the ingredients, and costs one batch', async () => {
		const res = await put({
			ownerKind: 'made_item',
			ownerId: sauce,
			expectedVersion: 0,
			makes: { amount: 2, unit: 'l' },
			lines: [
				line(chicken, 600, 'g'),
				line(milk, 400, 'ml', { usableBp: 8000 }),
			],
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const recipe = recipeResultSchema.parse(res.body).recipe!
		expect(recipe.makesQuantity).toBe(2_000_000)
		// 600 g of chicken (1680) and 500 ml raw milk (100) for one batch.
		expect(recipe.plate).toMatchObject({ state: 'complete', costMinor: 1780 })
		expect(recipe.lines.map((entry) => entry.costMinor)).toEqual([1680, 100])
	})

	it('refuses a bought item, an unknown item and a made recipe without makes', async () => {
		const bought = await put({
			ownerKind: 'made_item',
			ownerId: pita,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'piece' },
			lines: [line(milk, 1, 'ml')],
		})
		expect(bought.status).toBe(400)
		expect(bought.body.code).toBe('not_a_made_item')
		const unknown = await put({
			ownerKind: 'made_item',
			ownerId: 'no_such_item',
			expectedVersion: 0,
			makes: { amount: 1, unit: 'l' },
			lines: [line(milk, 1, 'ml')],
		})
		expect(unknown.status).toBe(404)
		const noMakes = await put({
			ownerKind: 'made_item',
			ownerId: sauce2,
			expectedVersion: 0,
			lines: [line(milk, 1, 'ml')],
		})
		expect(noMakes.status).toBe(400)
		const typed = await put({
			ownerKind: 'made_item',
			ownerId: sauce2,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'l' },
			typedCost: { minor: 1, currency: 'SAR' },
		})
		expect(typed.status).toBe(400)
	})

	it('refuses an ingredient cycle and a too deep chain, persisting nothing', async () => {
		const ok = await put({
			ownerKind: 'made_item',
			ownerId: sauce2,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'l' },
			lines: [line(sauce, 500, 'ml')],
		})
		expect(ok.status, JSON.stringify(ok.body)).toBe(200)
		// sauce -> sauce2 -> sauce would loop.
		const loop = await put({
			ownerKind: 'made_item',
			ownerId: sauce,
			expectedVersion: 1,
			makes: { amount: 2, unit: 'l' },
			lines: [line(sauce2, 100, 'ml')],
		})
		expect(loop.status).toBe(409)
		expect(loop.body.code).toBe('recipe_cycle')
		expect(loop.body.path).toEqual(expect.arrayContaining([sauce, sauce2]))
		// A made item inside itself.
		const self = await put({
			ownerKind: 'made_item',
			ownerId: sauce,
			expectedVersion: 1,
			makes: { amount: 2, unit: 'l' },
			lines: [line(sauce, 100, 'ml')],
		})
		expect(self.status).toBe(409)
		expect(self.body.code).toBe('recipe_cycle')
		expect(await versionRows('made_item', sauce)).toHaveLength(1)
		expect((await getRecipe('made_item', sauce)).version).toBe(1)

		// A chain eight made items deep fits; one more on top does not.
		let below = chicken
		for (let index = 0; index < 8; index++) {
			const id = (
				await newItem({
					name: `Chain ${index}`,
					kind: 'made',
					category: 'sauces',
					baseUnit: 'g',
				})
			).id
			const res = await put({
				ownerKind: 'made_item',
				ownerId: id,
				expectedVersion: 0,
				makes: { amount: 1, unit: 'kg' },
				lines: [line(below, 100, 'g')],
			})
			expect(res.status, `${index} ${JSON.stringify(res.body)}`).toBe(200)
			below = id
		}
		const top = (
			await newItem({
				name: 'Chain top',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'g',
			})
		).id
		const deep = await put({
			ownerKind: 'made_item',
			ownerId: top,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'kg' },
			lines: [line(below, 100, 'g')],
		})
		expect(deep.status).toBe(409)
		expect(deep.body.code).toBe('recipe_too_deep')
		expect(await versionRows('made_item', top)).toHaveLength(0)
	})

	it('keeps what a batch makes when a made recipe is cleared', async () => {
		const jam = (
			await newItem({
				name: 'Chili jam',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'g',
			})
		).id
		const written = await put({
			ownerKind: 'made_item',
			ownerId: jam,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'kg' },
			lines: [line(chicken, 100, 'g')],
		})
		expect(written.status).toBe(200)
		const cleared = await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: { ownerKind: 'made_item', ownerId: jam, expectedVersion: 1 },
		})
		expect(cleared.status, JSON.stringify(cleared.body)).toBe(200)
		expect(cleared.body).toEqual({ recipe: null, version: 2 })
		expect((await versionRows('made_item', jam))[1]!.makesQuantity).toBe(
			1_000_000,
		)
	})
})

// ── Costs ───────────────────────────────────────────────────────────────────

describe('plate costs for the menu list', () => {
	it('answers food cost, status and the price for the target, by key', async () => {
		const res = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: {
				currency: 'SAR',
				refs: [
					{ key: 'a', itemId: 'dish_idem', priceMinor: 400 },
					{ key: 'b', itemId: 'dish_can', priceMinor: 1000 },
					{ key: 'c', itemId: 'dish_idem', priceMinor: 100 },
				],
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = recipeCostsResultSchema.parse(res.body)
		expect(result.targetBp).toBe(3000)
		// Two pitas cost 80: 20% of 400 is good, a typed 450 over 1000 is 45%.
		expect(result.rows[0]).toMatchObject({
			key: 'a',
			hasRecipe: true,
			state: 'complete',
			costMinor: 80,
			currency: 'SAR',
			foodCostBp: 2000,
			status: 'good',
			priceForTargetMinor: 267,
		})
		expect(result.rows[1]).toMatchObject({
			key: 'b',
			state: 'typed',
			costMinor: 450,
			foodCostBp: 4500,
			status: 'high',
		})
		expect(result.rows[2]).toMatchObject({ foodCostBp: 8000, status: 'high' })
	})

	it('reports a partial and an unknown cost without a percentage, and none for a dish without a recipe', async () => {
		await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_partial',
			expectedVersion: 0,
			lines: [line(pita, 1, 'piece'), line(cheese, 50, 'g')],
		})
		await put({
			ownerKind: 'menu_item',
			ownerId: 'dish_unpriced',
			expectedVersion: 0,
			lines: [line(cheese, 50, 'g')],
		})
		const res = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: {
				currency: 'SAR',
				refs: [
					{ key: 'partial', itemId: 'dish_partial', priceMinor: 500 },
					{ key: 'unknown', itemId: 'dish_unpriced', priceMinor: 500 },
					{ key: 'none', itemId: 'dish_without', priceMinor: 500 },
				],
			},
		})
		expect(res.status).toBe(200)
		const [partial, unknown, none] = res.body.rows
		expect(partial).toMatchObject({
			key: 'partial',
			hasRecipe: true,
			state: 'partial',
			costMinor: 40,
		})
		expect(partial.foodCostBp).toBeUndefined()
		expect(partial.priceForTargetMinor).toBeUndefined()
		expect(unknown).toEqual({
			key: 'unknown',
			hasRecipe: true,
			state: 'unknown',
		})
		expect(none).toEqual({ key: 'none', hasRecipe: false, state: 'none' })
		// The ingredient the recipe cannot price is named in its plate.
		const plate = (await getRecipe('menu_item', 'dish_partial')).recipe!.plate!
		expect(plate).toMatchObject({ state: 'partial', missingItemIds: [cheese] })
	})

	it('includes the usual options in a dish cost', async () => {
		const res = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: {
				refs: [
					{ key: 'with', itemId: 'dish_idem', optionIds: ['opt_oat'] },
					{ key: 'without', itemId: 'dish_idem' },
				],
			},
		})
		expect(res.status).toBe(200)
		const [withOption, without] = res.body.rows
		// The oat option adds an unpriced cheese and an oat milk: still partial.
		expect(without.costMinor).toBe(80)
		expect(withOption.state).toBe('partial')
		expect(withOption.costMinor).toBe(80)
	})

	it('costs with the recipes in force at a time', async () => {
		const early = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: { at: 1000, refs: [{ key: 'a', itemId: 'dish_idem' }] },
		})
		expect(early.body.rows[0]).toEqual({
			key: 'a',
			hasRecipe: false,
			state: 'none',
		})
	})

	it('leaves money and the percentage out without the cost grant but keeps the structure', async () => {
		const res = await call('POST', `${BASE}/recipes/costs`, {
			token: noCost,
			body: {
				currency: 'SAR',
				refs: [
					{ key: 'a', itemId: 'dish_idem', priceMinor: 400 },
					{ key: 'b', itemId: 'dish_without', priceMinor: 400 },
				],
			},
		})
		expect(res.status).toBe(200)
		expect(res.body.rows).toEqual([
			{ key: 'a', hasRecipe: true, state: 'complete' },
			{ key: 'b', hasRecipe: false, state: 'none' },
		])
		expect(res.body.targetBp).toBe(3000)
		// A read-scope token may ask: it changes nothing.
		const read = await call('POST', `${BASE}/recipes/costs`, {
			token: readOnly,
			body: { refs: [{ key: 'a', itemId: 'dish_idem' }] },
		})
		expect(read.status).toBe(200)
		expect(read.body.rows[0].costMinor).toBe(80)
	})

	it('validates the request (keys, prices, size)', async () => {
		const refs = (count: number) =>
			Array.from({ length: count }, (_, index) => ({
				key: `k${index}`,
				itemId: 'dish_idem',
			}))
		for (const body of [
			{ refs: refs(201) },
			{ refs: [] },
			{ refs: [refs(1)[0], refs(1)[0]] },
			{ refs: [{ key: 'a', itemId: 'dish_idem', priceMinor: 100 }] },
			{ refs: refs(1), extra: 1 },
		]) {
			const res = await call('POST', `${BASE}/recipes/costs`, {
				token: full,
				body,
			})
			expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
		}
		expect(refs(200)).toHaveLength(200)
		const ok = await call('POST', `${BASE}/recipes/costs`, {
			token: full,
			body: { refs: refs(200) },
		})
		expect(ok.status).toBe(200)
		expect(ok.body.rows).toHaveLength(200)
	})
})

// ── Dishes without a recipe ─────────────────────────────────────────────────

describe('dishes without a recipe', () => {
	let sequence = 0

	async function sell(
		itemId: string,
		quantity: number,
		options: { variantId?: string | null; totalCents?: number } = {},
	) {
		sequence += 1
		const db = await getTenantDb(ORG)
		const total = options.totalCents ?? 1000 * quantity
		await db.insert(restaurantOrders).values({
			orgId: ORG,
			number: `W-${sequence}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC,
			locationName: 'Olaya',
			contactName: 'Guest',
			contactPhone: '+966500000000',
			currency: 'sar',
			subtotalCents: total,
			taxCents: 0,
			totalCents: total,
			lines: [
				{
					itemId,
					itemName: '{"en":"Dish"}',
					variantId: options.variantId ?? null,
					quantity,
					unitPriceCents: Math.round(total / quantity),
					taxableUnitCents: Math.round(total / quantity),
					totalCents: total,
					taxableCents: total,
					instructions: null,
					baseUnitCents: 0,
					categoryIds: [],
					options: [],
				},
			],
			idempotencyKey: `idem-missing-${sequence}`,
			requestHash: 'hash',
			receiptTokenHash: `receipt-missing-${sequence}`,
			createdAt: new Date(),
		})
	}

	it('ranks sold dishes that have no recipe, most sold first', async () => {
		await sell('dish_top', 3)
		await sell('dish_top', 2)
		await sell('dish_second', 4, { totalCents: 8000 })
		await sell('dish_third', 1)
		// Covered by a recipe, by a size recipe and by a multiple of the item.
		await sell('dish_shawarma', 9)
		await sell('dish_unmapped_size', 7, { variantId: 'size_own' })
		await sell('dish_shawarma', 6, { variantId: 'size_large' })
		const res = await call(
			'GET',
			`${BASE}/recipes/missing?locationId=${LOC}&days=7&limit=2`,
			{ token: full },
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = dishesWithoutRecipeResultSchema.parse(res.body)
		expect(result).toMatchObject({ days: 7, total: 3, truncated: false })
		expect(result.dishes.map((dish) => [dish.itemId, dish.quantity])).toEqual([
			['dish_top', 5],
			['dish_second', 4],
		])
		expect(result.dishes[0]).toMatchObject({
			netSalesMinor: 5000,
			currency: 'SAR',
		})
	})

	it('leaves net sales out without the cost grant and refuses an excluded location', async () => {
		const res = await call('GET', `${BASE}/recipes/missing?locationId=${LOC}`, {
			token: noCost,
		})
		expect(res.status).toBe(200)
		expect(res.body.dishes).toHaveLength(3)
		expect(JSON.stringify(res.body)).not.toMatch(/netSalesMinor|currency/)
		const excluded = await call(
			'GET',
			`${BASE}/recipes/missing?locationId=${LOC_OTHER}`,
			{ token: scoped },
		)
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
		const empty = await call(
			'GET',
			`${BASE}/recipes/missing?locationId=${LOC_OTHER}`,
			{ token: full },
		)
		expect(empty.body).toMatchObject({ dishes: [], total: 0 })
		for (const query of ['days=0', 'days=91', 'limit=0', 'limit=51', 'x=1']) {
			const bad = await call(
				'GET',
				`${BASE}/recipes/missing?locationId=${LOC}&${query}`,
				{ token: full },
			)
			expect(bad.status, query).toBe(400)
		}
	})
})

// ── Recording a batch ───────────────────────────────────────────────────────

describe('recording a batch of a made item', () => {
	let sauce: string
	let sauce2: string
	let plain: string

	async function movements(itemId: string) {
		const res = await call(
			'GET',
			`${BASE}/items/${itemId}/movements?locationId=${LOC}`,
			{ token: full },
		)
		expect(res.status).toBe(200)
		return res.body.movements as {
			kind: string
			quantity: number
			valueMinor?: number
		}[]
	}

	async function onHand(itemId: string) {
		const res = await call('GET', `${BASE}/items/${itemId}?locationId=${LOC}`, {
			token: full,
		})
		return res.body.onHand as number
	}

	beforeAll(async () => {
		sauce = (
			await newItem({
				name: 'Batch sauce',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'ml',
			})
		).id
		sauce2 = (
			await newItem({
				name: 'Batch hot sauce',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'ml',
			})
		).id
		plain = (
			await newItem({
				name: 'Made without recipe',
				kind: 'made',
				category: 'sauces',
				baseUnit: 'ml',
			})
		).id
		expect(
			(
				await put({
					ownerKind: 'made_item',
					ownerId: sauce,
					expectedVersion: 0,
					makes: { amount: 2, unit: 'l' },
					lines: [
						line(chicken, 600, 'g'),
						line(milk, 400, 'ml', { usableBp: 8000 }),
					],
				})
			).status,
		).toBe(200)
		expect(
			(
				await put({
					ownerKind: 'made_item',
					ownerId: sauce2,
					expectedVersion: 0,
					makes: { amount: 1, unit: 'l' },
					lines: [line(sauce, 500, 'ml'), line(milk, 100, 'ml')],
				})
			).status,
		).toBe(200)
	})

	it('adds the made item and takes the ingredients out with the usable yield, valued at average cost', async () => {
		const body = {
			clientId: cid('batch'),
			locationId: LOC,
			made: { kind: 'batches', count: 1.5 },
			note: 'Morning prep',
		}
		const res = await call('POST', `${BASE}/items/${sauce}/batch`, {
			token: kitchen,
			body,
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = recordBatchResultSchema.parse(res.body)
		expect(result.madeQuantity).toBe(3_000_000)
		// 1.5 batches: 900 g of chicken, and 750 ml raw milk (400 ml at 80% usable, per batch).
		expect(result.used).toEqual([
			{ itemId: chicken, quantity: 900_000, valueMinor: 2520 },
			{ itemId: milk, quantity: 750_000, valueMinor: 150 },
		])
		expect(result).toMatchObject({ valueMinor: 2670, currency: 'SAR' })
		expect(await onHand(sauce)).toBe(3_000_000)
		expect(await movements(sauce)).toMatchObject([
			{ kind: 'batch_made', quantity: 3_000_000, valueMinor: 2670 },
		])
		const used = await movements(chicken)
		expect(used.find((entry) => entry.kind === 'batch_used')).toMatchObject({
			quantity: -900_000,
			valueMinor: -2520,
		})

		// A replay answers the first result and posts nothing more.
		const replay = await call('POST', `${BASE}/items/${sauce}/batch`, {
			token: kitchen,
			body,
		})
		expect(replay.status).toBe(200)
		expect(replay.body).toEqual(res.body)
		expect(await onHand(sauce)).toBe(3_000_000)
		// The same id for another amount is a conflict.
		const conflict = await call('POST', `${BASE}/items/${sauce}/batch`, {
			token: kitchen,
			body: { ...body, made: { kind: 'batches', count: 2 } },
		})
		expect(conflict.status).toBe(409)
		expect(conflict.body.code).toBe('idempotency_conflict')
		expect(await onHand(sauce)).toBe(3_000_000)
	})

	it('takes a typed amount and leaves values out without the cost grant', async () => {
		const res = await call('POST', `${BASE}/items/${sauce}/batch`, {
			token: noCost,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'amount', amount: 1, unit: 'l' },
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		// Half a batch: 300 g of chicken, 250 ml of raw milk.
		expect(res.body.madeQuantity).toBe(1_000_000)
		expect(res.body.used).toEqual([
			{ itemId: chicken, quantity: 300_000 },
			{ itemId: milk, quantity: 250_000 },
		])
		expect(JSON.stringify(res.body)).not.toMatch(/Minor|currency/)
	})

	it('takes a made ingredient out as itself, with no recursion', async () => {
		const before = await onHand(sauce)
		const res = await call('POST', `${BASE}/items/${sauce2}/batch`, {
			token: kitchen,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'batches', count: 2 },
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		expect(res.body.madeQuantity).toBe(2_000_000)
		expect(
			res.body.used.map((entry: { itemId: string }) => entry.itemId).sort(),
		).toEqual([milk, sauce].sort())
		expect(await onHand(sauce)).toBe(before - 1_000_000)
		// The sauce has no delivered price: its value is unknown, milk's counts.
		const sauceUse = res.body.used.find(
			(entry: { itemId: string }) => entry.itemId === sauce,
		)
		expect(sauceUse.valueMinor).toBeUndefined()
		expect(res.body.valueMinor).toBe(40)
	})

	it('refuses a bought item, a made item without a recipe, an excluded location and a bad amount', async () => {
		const bought = await call('POST', `${BASE}/items/${pita}/batch`, {
			token: kitchen,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'batches', count: 1 },
			},
		})
		expect(bought.status).toBe(400)
		expect(bought.body.code).toBe('not_a_made_item')
		const empty = await call('POST', `${BASE}/items/${plain}/batch`, {
			token: kitchen,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'batches', count: 1 },
			},
		})
		expect(empty.status).toBe(409)
		expect(empty.body.code).toBe('recipe_empty')
		const excluded = await call('POST', `${BASE}/items/${sauce}/batch`, {
			token: scoped,
			body: {
				clientId: cid('batch'),
				locationId: LOC_OTHER,
				made: { kind: 'batches', count: 1 },
			},
		})
		expect(excluded.status).toBe(403)
		for (const made of [
			{ kind: 'batches', count: 0 },
			{ kind: 'batches', count: 1001 },
			{ kind: 'amount', amount: 1, unit: 'kg' },
			{ kind: 'amount', amount: 0.0001, unit: 'ml' },
		]) {
			const bad = await call('POST', `${BASE}/items/${sauce}/batch`, {
				token: kitchen,
				body: { clientId: cid('batch'), locationId: LOC, made },
			})
			expect(bad.status, JSON.stringify(made)).toBe(400)
		}
		const missing = await call('POST', `${BASE}/items/nope_item/batch`, {
			token: kitchen,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'batches', count: 1 },
			},
		})
		expect(missing.status).toBe(404)
	})

	it('uses the recipe version in force now, and none once it is cleared', async () => {
		const item = (
			await newItem({
				name: 'Versioned dough',
				kind: 'made',
				category: 'bakery',
				baseUnit: 'g',
			})
		).id
		await put({
			ownerKind: 'made_item',
			ownerId: item,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'kg' },
			lines: [line(chicken, 100, 'g')],
		})
		await put({
			ownerKind: 'made_item',
			ownerId: item,
			expectedVersion: 1,
			makes: { amount: 1, unit: 'kg' },
			lines: [line(chicken, 300, 'g')],
		})
		const batch = (count: number) =>
			call('POST', `${BASE}/items/${item}/batch`, {
				token: kitchen,
				body: {
					clientId: cid('batch'),
					locationId: LOC,
					made: { kind: 'batches', count },
				},
			})
		const made = await batch(1)
		expect(made.body.used).toMatchObject([
			{ itemId: chicken, quantity: 300_000 },
		])
		await call('POST', `${BASE}/recipes/clear`, {
			token: full,
			body: { ownerKind: 'made_item', ownerId: item, expectedVersion: 2 },
		})
		const cleared = await batch(1)
		expect(cleared.status).toBe(409)
		expect(cleared.body.code).toBe('recipe_empty')
	})
})

// ── Item flags ──────────────────────────────────────────────────────────────

describe('item recipe flags', () => {
	it('reads the flags and counts only a made item in batches', async () => {
		const made = await newItem({
			name: 'Flag marinade',
			kind: 'made',
			category: 'sauces',
			baseUnit: 'ml',
		})
		const detail = await call(
			'GET',
			`${BASE}/items/${made.id}?locationId=${LOC}`,
			{
				token: full,
			},
		)
		expect(detail.body).toMatchObject({
			batchCounted: false,
			autoSoldOut: false,
		})
		const on = await call('PATCH', `${BASE}/items/${made.id}`, {
			token: kitchen,
			body: { expectedVersion: 1, batchCounted: true },
		})
		expect(on.status, JSON.stringify(on.body)).toBe(200)
		expect(on.body).toMatchObject({ batchCounted: true, version: 2 })
		const list = await call('GET', `${BASE}/items?locationId=${LOC}`, {
			token: full,
		})
		expect(
			list.body.items.find((item: { id: string }) => item.id === made.id),
		).toMatchObject({ batchCounted: true, autoSoldOut: false })

		const pitaVersion = (
			await call('GET', `${BASE}/items/${pita}?locationId=${LOC}`, {
				token: full,
			})
		).body.version as number
		const bought = await call('PATCH', `${BASE}/items/${pita}`, {
			token: kitchen,
			body: { expectedVersion: pitaVersion, batchCounted: true },
		})
		expect(bought.status).toBe(400)
		expect(bought.body.code).toBe('not_a_made_item')
		// Switching it off for a bought item is a no-op, not an error.
		const off = await call('PATCH', `${BASE}/items/${pita}`, {
			token: kitchen,
			body: { expectedVersion: pitaVersion, batchCounted: false },
		})
		expect(off.status).toBe(200)
	})

	it('needs the recipe grant to change auto sold out, and the recipes flag for either flag', async () => {
		const item = await newItem({ name: 'Flag tahini', category: 'sauces' })
		const denied = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: kitchen,
			body: { expectedVersion: 1, autoSoldOut: true },
		})
		expect(denied.status).toBe(403)
		expect(denied.body).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: RECIPE,
		})
		// Resending the current value needs nothing.
		const same = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: kitchen,
			body: { expectedVersion: 1, autoSoldOut: false, name: 'Flag tahini 2' },
		})
		expect(same.status).toBe(200)
		const off = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: flagOff,
			body: { expectedVersion: 2, autoSoldOut: true },
		})
		expect(off.status).toBe(403)
		expect(off.body).toMatchObject({
			code: 'feature_disabled',
			feature: 'recipes',
		})
		const ok = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: full,
			body: { expectedVersion: 2, autoSoldOut: true },
		})
		expect(ok.status, JSON.stringify(ok.body)).toBe(200)
		expect(ok.body).toMatchObject({ autoSoldOut: true, version: 3 })
		// Plain edits never need the flag.
		const rename = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: flagOff,
			body: { expectedVersion: 3, name: 'Flag tahini 3' },
		})
		expect(rename.status).toBe(200)
	})
})

// ── Access ──────────────────────────────────────────────────────────────────

describe('access', () => {
	it('keeps recipes inside one organization', async () => {
		const other = await call(
			'GET',
			`${BASE}/recipes?ownerKind=menu_item&ownerId=dish_shawarma`,
			{ token: tokenB },
		)
		expect(other.body).toEqual({ recipe: null, version: 0 })
		const hijack = await put(
			{
				ownerKind: 'menu_item',
				ownerId: 'dish_shawarma',
				expectedVersion: 0,
				lines: [line(chicken, 100, 'g')],
			},
			tokenB,
		)
		expect(hijack.status).toBe(404)
		expect(hijack.body).toMatchObject({ reason: 'ingredient' })
		const batch = await call('POST', `${BASE}/items/${chicken}/batch`, {
			token: tokenB,
			body: {
				clientId: cid('batch'),
				locationId: LOC,
				made: { kind: 'batches', count: 1 },
			},
		})
		expect(batch.status).toBe(404)
		expect((await getRecipe('menu_item', 'dish_shawarma')).version).toBe(2)
	})

	it('needs the recipes flag and the recipe grant', async () => {
		const query = '?ownerKind=menu_item&ownerId=dish_shawarma'
		const gated = await call('GET', `${BASE}/recipes${query}`, {
			token: flagOff,
		})
		expect(gated.status).toBe(403)
		expect(gated.body).toMatchObject({
			code: 'feature_disabled',
			feature: 'recipes',
		})
		const noGrant = await put(
			{
				ownerKind: 'menu_item',
				ownerId: 'dish_no_grant',
				expectedVersion: 0,
				lines: [line(pita, 1, 'piece')],
			},
			kitchen,
		)
		expect(noGrant.status).toBe(403)
		expect(noGrant.body).toMatchObject({ reason: 'grant', required: RECIPE })
		const read = await call('GET', `${BASE}/recipes${query}`, {
			token: readOnly,
		})
		expect(read.status).toBe(200)
	})
})
