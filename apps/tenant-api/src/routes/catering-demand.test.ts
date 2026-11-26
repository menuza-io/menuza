import {
	prepPlanSchema,
	suggestedOrdersSchema,
	todaySchema,
} from '@repo/inventory'
import { addDays, currentBusinessDate } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
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
 * Catering prep and purchasing demand (#513): confirmed catering orders feed
 * their recipe ingredients into prep on the event's day, into suggested
 * supplier orders, and into Today's catering shortage panel (listing dishes
 * without a recipe as "no recipe"), and cancelling removes their need.
 */

const ORG = 'org_inv_catering_513'
const LOC = 'loc_catering_513'

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
let recipesOff: string

const today = currentBusinessDate(Date.now(), 'UTC', 240)
const tomorrow = addDays(today, 1)
const eventTomorrowMs = Date.parse(`${tomorrow}T14:00:00Z`)

const MENU_TRAY = 'menu_catering_tray'
const VARIANT_LARGE_TRAY = 'var_tray_10_servings'
const MENU_OFF_MENU = 'menu_off_menu_special'

const world = {
	chicken: '',
	sauce: '',
	supplier: '',
}

async function insertCateringOrder(input: {
	id: string
	eventAtMs: number
	paymentStatus: 'paid' | 'pending'
	status?: 'accepted' | 'cancelled'
	balanceState?: 'due' | 'paid' | null
	lines: Array<{
		itemId: string
		itemName: string
		variantId?: string | null
		quantity: number
	}>
}) {
	const db = await getTenantDb(ORG)
	await db.insert(restaurantOrders).values({
		id: input.id,
		orgId: ORG,
		number: `CAT-${input.id.slice(-4)}`,
		status: input.status ?? 'accepted',
		paymentMethod: 'online',
		paymentStatus: input.paymentStatus,
		fulfillment: 'delivery',
		locationId: LOC,
		locationName: 'Main Kitchen',
		locationTimezone: 'UTC',
		contactName: 'Event Host',
		contactPhone: '+15550001111',
		contactEmail: 'host@example.com',
		currency: 'USD',
		subtotalCents: 100_000,
		taxCents: 0,
		deliveryFeeCents: 0,
		totalCents: 100_000,
		paidCents: input.paymentStatus === 'paid' ? 30_000 : 0,
		depositPercent: 30,
		depositCents: 30_000,
		balanceState: input.balanceState ?? 'due',
		isCatering: true,
		cateringEventAt: new Date(input.eventAtMs),
		guestCount: 40,
		idempotencyKey: `idem_${input.id}`,
		requestHash: `hash_${input.id}`,
		receiptTokenHash: `rcpt_${input.id}`,
		lines: input.lines.map((line) => ({
			itemId: line.itemId,
			itemName: line.itemName,
			variantId: line.variantId ?? null,
			variantName: null,
			quantity: line.quantity,
			unitPriceCents: 25_000,
			lineTotalCents: 25_000 * line.quantity,
			options: [],
		})),
	})
}

beforeAll(async () => {
	env = setupTenantEnv('inv-catering-513')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)

	full = await mintToken(ORG, {
		grants: [READ, UPDATE, PURCHASING, RECIPE, COST],
		features: { purchasing: true, recipes: true, prep: true },
	})
	noCost = await mintToken(ORG, {
		grants: [READ, UPDATE, PURCHASING, RECIPE],
		features: { purchasing: true, recipes: true, prep: true },
	})
	recipesOff = await mintToken(ORG, {
		grants: [READ, UPDATE, PURCHASING, COST],
		features: { purchasing: true, recipes: false, prep: true },
	})

	const w = makeWorld(call, full, LOC)

	const sup = await w.supplier('Fresh Farms')
	world.supplier = sup.id

	// Bought ingredient: chicken (grams). Pack is 5 kg (5,000,000 thousandths of g).
	const chicken = await w.item('Chicken breast', 'g')
	world.chicken = chicken.id
	await w.product(world.supplier, world.chicken, {
		packName: 'Case 5 kg',
		packBaseQuantity: 5_000_000,
		priceMinor: 4_500,
	})
	// Put 1 kg of chicken on hand (so a 4 kg catering need is 3 kg short).
	await w.stock(world.chicken, 1_000_000)

	// Batch-counted made item: garlic sauce (ml). One batch makes 2 L (2,000,000 ml thousandths).
	const sauce = await w.ok('POST', '/items', {
		clientId: cid('item'),
		name: 'Garlic sauce',
		category: 'sauces',
		kind: 'made',
		baseUnit: 'ml',
	})
	world.sauce = sauce.id
	await w.ok('PATCH', `/items/${world.sauce}`, {
		expectedVersion: sauce.version,
		batchCounted: true,
	})
	await w.ok('PUT', '/recipes', {
		ownerKind: 'made_item',
		ownerId: world.sauce,
		expectedVersion: 0,
		makes: { amount: 2, unit: 'l' },
		lines: [{ itemId: world.chicken, amount: 100, unit: 'g' }],
	})

	// Dish recipe: 1 serving uses 200 g chicken + 100 ml garlic sauce.
	await w.ok('PUT', '/recipes', {
		ownerKind: 'menu_item',
		ownerId: MENU_TRAY,
		expectedVersion: 0,
		lines: [
			{ itemId: world.chicken, amount: 200, unit: 'g' },
			{ itemId: world.sauce, amount: 100, unit: 'ml' },
		],
	})
	// Catering tray variant scales 1 serving -> 10 servings (multiplier 10x = 100,000 bp).
	await w.ok('PUT', '/recipes', {
		ownerKind: 'variant',
		ownerId: VARIANT_LARGE_TRAY,
		expectedVersion: 0,
		multiplierBp: 100_000,
		lines: [],
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('catering prep, suggested orders and Today (#513)', () => {
	it('ignores unpaid catering orders', async () => {
		await insertCateringOrder({
			id: 'ord_cat_unpaid',
			eventAtMs: eventTomorrowMs,
			paymentStatus: 'pending',
			lines: [
				{
					itemId: MENU_TRAY,
					itemName: 'Chicken Tray',
					variantId: VARIANT_LARGE_TRAY,
					quantity: 2,
				},
			],
		})

		const sugRes = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${LOC}`,
			{ token: full },
		)
		expect(sugRes.status).toBe(200)
		const sug = suggestedOrdersSchema.parse(sugRes.body)
		expect(sug.suppliers).toHaveLength(0)

		const todayRes = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: full,
		})
		expect(todayRes.status).toBe(200)
		const todayView = todaySchema.parse(todayRes.body)
		expect(todayView.catering).toBeUndefined()
	})

	it('adds a confirmed catering order to the right prep day, suggested orders and Today, and cancelling removes it (513-1, 513-2)', async () => {
		// 2 trays x 10 servings = 20 servings -> 4,000 g chicken (4,000,000) and 2,000 ml sauce (2,000,000).
		// Plus an off-menu dish with no recipe.
		await insertCateringOrder({
			id: 'ord_cat_confirmed',
			eventAtMs: eventTomorrowMs,
			paymentStatus: 'paid',
			balanceState: 'due', // 30% deposit paid, balance still due -> still confirmed!
			lines: [
				{
					itemId: MENU_TRAY,
					itemName: 'Chicken Tray',
					variantId: VARIANT_LARGE_TRAY,
					quantity: 2,
				},
				{
					itemId: MENU_OFF_MENU,
					itemName: 'Custom Dessert Platter',
					quantity: 1,
				},
			],
		})

		// 1. Prep on tomorrow (event day) gets 2 L garlic sauce; today gets none.
		const genTodayRes = await call('POST', `${BASE}/prep/generate`, {
			token: full,
			body: { locationId: LOC, date: today },
		})
		expect(genTodayRes.status, JSON.stringify(genTodayRes.body)).toBe(200)
		const planToday = prepPlanSchema.parse(genTodayRes.body)
		expect(planToday.tasks).toHaveLength(0)

		const genTomorrowRes = await call('POST', `${BASE}/prep/generate`, {
			token: full,
			body: { locationId: LOC, date: tomorrow },
		})
		expect(genTomorrowRes.status, JSON.stringify(genTomorrowRes.body)).toBe(200)
		const planTomorrow = prepPlanSchema.parse(genTomorrowRes.body)
		const sauceTask = planTomorrow.tasks.find((t) => t.itemId === world.sauce)
		expect(sauceTask).toBeDefined()
		expect(sauceTask!.plannedQuantity).toBe(2_000_000)
		expect(sauceTask!.explain.committed).toBe(2_000_000)

		// 2. Suggested orders include the 4 kg chicken need (minus 1 kg on hand -> 3 kg needed -> 1 case of 5 kg).
		const sugRes = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${LOC}`,
			{ token: full },
		)
		expect(sugRes.status).toBe(200)
		const sug = suggestedOrdersSchema.parse(sugRes.body)
		expect(sug.suppliers).toHaveLength(1)
		const chickenLine = sug.suppliers[0]!.lines.find(
			(l) => l.itemId === world.chicken,
		)
		expect(chickenLine).toBeDefined()
		expect(chickenLine!.explanation.cateringQuantity).toBe(4_000_000)
		expect(chickenLine!.explanation.neededQuantity).toBe(3_000_000)
		expect(chickenLine!.packs).toBe(1)

		// Without cost grant, cateringQuantity (stock quantity, not money) stays visible.
		const sugNoCostRes = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${LOC}`,
			{ token: noCost },
		)
		expect(sugNoCostRes.status).toBe(200)
		const sugNoCost = suggestedOrdersSchema.parse(sugNoCostRes.body)
		expect(sugNoCost.suppliers[0]!.lines[0]!.explanation.cateringQuantity).toBe(
			4_000_000,
		)

		// With inventory.recipes off, suggested orders and Today omit catering recipe demand.
		const sugOffRes = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${LOC}`,
			{ token: recipesOff },
		)
		expect(sugOffRes.status).toBe(200)
		expect(suggestedOrdersSchema.parse(sugOffRes.body).suppliers).toHaveLength(
			0,
		)

		// 3. Today shows the event day, short items (chicken short 3 kg, sauce short 2 L) and the off-menu dish.
		const todayRes = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: full,
		})
		expect(todayRes.status).toBe(200)
		const todayView = todaySchema.parse(todayRes.body)
		expect(todayView.catering).toHaveLength(1)
		const entry = todayView.catering![0]!
		expect(entry.date).toBe(tomorrow)
		expect(entry.orders).toBe(1)
		expect(entry.short).toEqual([
			{
				itemId: world.chicken,
				itemName: 'Chicken breast',
				baseUnit: 'g',
				needed: 4_000_000,
				short: 3_000_000,
			},
			{
				itemId: world.sauce,
				itemName: 'Garlic sauce',
				baseUnit: 'ml',
				needed: 2_000_000,
				short: 2_000_000,
			},
		])
		expect(entry.noRecipe).toEqual(['Custom Dessert Platter'])

		const todayOffRes = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: recipesOff,
		})
		expect(todayOffRes.status).toBe(200)
		expect(todaySchema.parse(todayOffRes.body).catering).toBeUndefined()

		// 4. Cancelling the catering order removes its need from prep, suggested orders and Today (513-2).
		const db = await getTenantDb(ORG)
		await db
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, 'ord_cat_confirmed'))

		const regenRes = await call('POST', `${BASE}/prep/generate`, {
			token: full,
			body: { locationId: LOC, date: tomorrow },
		})
		expect(regenRes.status).toBe(200)
		expect(prepPlanSchema.parse(regenRes.body).tasks).toHaveLength(0)

		const sugAfterRes = await call(
			'GET',
			`${BASE}/orders/suggested?locationId=${LOC}`,
			{ token: full },
		)
		expect(sugAfterRes.status).toBe(200)
		expect(
			suggestedOrdersSchema.parse(sugAfterRes.body).suppliers,
		).toHaveLength(0)

		const todayAfterRes = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: full,
		})
		expect(todayAfterRes.status).toBe(200)
		expect(todaySchema.parse(todayAfterRes.body).catering).toBeUndefined()
	})
})
