import {
	listWasteResultSchema,
	logWasteDishResultSchema,
	wasteEntrySchema,
	wasteSummarySchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountEntries,
	invCounts,
	invMovements,
	invWaste,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
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
 * A whole dish as waste (#517): the recipe in force now, with size and options,
 * becomes grouped ingredient rows and one line in the log; an undo takes the
 * whole group back. And a later correction of an entry (#522): reverse it or
 * change its quantity, the original stays, stock moves unless an approved count
 * already covers the entry, and the waste figures follow.
 */

const ORG = 'org_inv_waste_dishes'
const LOC = 'loc_waste_dishes'
const today = () => new Date().toISOString().slice(0, 10)
const from = () =>
	new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10)

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
let readOnly: string
let noRecipes: string
const world = { chicken: '', flour: '', cheese: '' }

const line = (itemId: string, amount: number, unit: string, extra = {}) => ({
	itemId,
	amount,
	unit,
	...extra,
})

async function item(name: string, baseUnit: 'g' | 'piece' = 'g') {
	const made = await call('POST', `${BASE}/items`, {
		token: full,
		body: {
			clientId: cid('item'),
			name,
			category: 'meat',
			kind: 'bought',
			baseUnit,
		},
	})
	expect(made.status, JSON.stringify(made.body)).toBe(200)
	return made.body.id as string
}

async function stock(itemId: string) {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(invMovements)
		.where(eq(invMovements.itemId, itemId))
	return rows.reduce((sum, row) => sum + row.quantity, 0)
}

async function recipe(body: Record<string, unknown>) {
	const res = await call('PUT', `${BASE}/recipes`, {
		token: full,
		body: { expectedVersion: 0, ...body },
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-waste-dishes')
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
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ], features })
	noRecipes = await mintToken(ORG, { grants, features: { recipes: false } })
	world.chicken = await item('Chicken')
	world.flour = await item('Pita flour')
	world.cheese = await item('Cheese')
	// 10 kg chicken at SAR 30/kg, 10 kg flour at SAR 3/kg, 5 kg cheese at SAR 40/kg.
	const delivery = await call('POST', `${BASE}/deliveries`, {
		token: full,
		body: {
			clientId: cid('delivery'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [
				{ itemId: world.chicken, quantity: 10_000_000, lineTotalMinor: 30_000 },
				{ itemId: world.flour, quantity: 10_000_000, lineTotalMinor: 3_000 },
				{ itemId: world.cheese, quantity: 5_000_000, lineTotalMinor: 20_000 },
			],
		},
	})
	expect(delivery.status, JSON.stringify(delivery.body)).toBe(200)
	// A shawarma: 200 g chicken and 50 g flour; extra cheese adds 30 g; a large
	// size is half as much again.
	await recipe({
		ownerKind: 'menu_item',
		ownerId: 'dish_shawarma',
		lines: [line(world.chicken, 200, 'g'), line(world.flour, 50, 'g')],
	})
	await recipe({
		ownerKind: 'option',
		ownerId: 'opt_cheese',
		lines: [line(world.cheese, 30, 'g')],
	})
	await recipe({
		ownerKind: 'variant',
		ownerId: 'var_large',
		multiplierBp: 15_000,
	})
	// A dish with only a typed cost, and one with nothing.
	await recipe({
		ownerKind: 'menu_item',
		ownerId: 'dish_typed',
		typedCost: { minor: 700, currency: 'SAR' },
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

const wasteDish = (extra: Record<string, unknown>, token = full) =>
	call('POST', `${BASE}/waste/dishes`, {
		token,
		body: {
			clientId: cid('wd'),
			locationId: LOC,
			menuItemId: 'dish_shawarma',
			quantity: 1,
			reason: 'dropped',
			...extra,
		},
	})

const log = async (token = full) =>
	listWasteResultSchema.parse(
		(
			await call(
				'GET',
				`${BASE}/waste?locationId=${LOC}&from=${from()}&to=${today()}&limit=50`,
				{ token },
			)
		).body,
	)

describe('a whole dish as waste (#517)', () => {
	it('writes its ingredients times the quantity under one grouped line, and undo takes the whole group back', async () => {
		const before = {
			chicken: await stock(world.chicken),
			flour: await stock(world.flour),
		}
		const tapId = cid('wd')
		const made = await wasteDish({
			clientId: tapId,
			quantity: 2,
			note: 'Dropped tray',
		})
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		const result = logWasteDishResultSchema.parse(made.body)
		expect(result).toMatchObject({
			entries: 2,
			basis: 'recipe',
			duplicate: false,
			// 2 x (200 g at SAR 0.03 + 50 g at SAR 0.003) = 1200 + 30.
			valueMinor: 1230,
			currency: 'SAR',
		})

		// 2 dishes: 400 g chicken and 100 g flour, as waste rows and movements.
		expect(await stock(world.chicken)).toBe(before.chicken - 400_000)
		expect(await stock(world.flour)).toBe(before.flour - 100_000)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(invWaste)
			.where(eq(invWaste.groupId, result.id))
		expect(rows.map((row) => [row.itemId, row.quantity]).sort()).toEqual(
			[
				[world.chicken, 400_000],
				[world.flour, 100_000],
			].sort(),
		)
		expect(rows.every((row) => row.dishRef === 'dish_shawarma')).toBe(true)

		// One grouped line in the log, not two rows.
		const entries = (await log()).entries
		const group = entries.filter((entry) => entry.id === result.id)
		expect(group).toHaveLength(1)
		expect(
			entries.filter((entry) => entry.dish?.groupId === result.id),
		).toHaveLength(1)
		expect(group[0]).toMatchObject({
			reason: 'dropped',
			note: 'Dropped tray',
			dish: {
				menuItemId: 'dish_shawarma',
				variantId: null,
				dishes: 2,
				basis: 'recipe',
				ingredients: 2,
			},
			valueMinor: 1230,
			undoneAt: null,
		})
		// The ingredient rows are not listed on their own.
		expect(
			entries.some((entry) => rows.some((row) => row.id === entry.id)),
		).toBe(false)
		const summary = wasteSummarySchema.parse(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=${from()}&to=${today()}`,
					{ token: full },
				)
			).body,
		)
		// A dish is one time wasted.
		expect(summary.count).toBe(1)
		expect(summary.valueMinor).toBe(1230)

		// A repeated tap answers the first result and writes nothing more.
		const again = await call('POST', `${BASE}/waste/dishes`, {
			token: full,
			body: {
				clientId: tapId,
				locationId: LOC,
				menuItemId: 'dish_shawarma',
				quantity: 2,
				reason: 'dropped',
				note: 'Dropped tray',
			},
		})
		expect(again.status, JSON.stringify(again.body)).toBe(200)
		expect(logWasteDishResultSchema.parse(again.body)).toMatchObject({
			id: result.id,
			duplicate: true,
		})
		expect(await stock(world.chicken)).toBe(before.chicken - 400_000)

		// Undo removes the whole group: every row is reversed and stock is back.
		const undone = await call(
			'POST',
			`${BASE}/waste/dishes/${result.id}/undo`,
			{
				token: full,
				body: { clientId: cid('undo') },
			},
		)
		expect(undone.status, JSON.stringify(undone.body)).toBe(200)
		expect(undone.body).toMatchObject({ id: result.id, entries: 2 })
		expect(await stock(world.chicken)).toBe(before.chicken)
		expect(await stock(world.flour)).toBe(before.flour)
		const reversals = (
			await db.select().from(invWaste).where(eq(invWaste.groupId, result.id))
		).filter((row) => row.reversesId !== null)
		expect(reversals).toHaveLength(2)
		const after = (await log()).entries.find((entry) => entry.id === result.id)!
		expect(after.undoneAt).not.toBeNull()
		const summaryAfter = wasteSummarySchema.parse(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=${from()}&to=${today()}`,
					{ token: full },
				)
			).body,
		)
		expect(summaryAfter.count).toBe(0)

		// Only once.
		const twice = await call('POST', `${BASE}/waste/dishes/${result.id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		expect([twice.status, twice.body.code]).toEqual([409, 'already_undone'])
	})

	it('changes the ingredients with the size and options chosen, like a sale does', async () => {
		const made = await wasteDish({
			variantId: 'var_large',
			options: [{ optionId: 'opt_cheese' }],
			reason: 'returned',
		})
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(invWaste)
			.where(eq(invWaste.groupId, made.body.id))
		const byItem = new Map(rows.map((row) => [row.itemId, row.quantity]))
		// Large is 1.5x the dish; the cheese option is added on top.
		expect(byItem.get(world.chicken)).toBe(300_000)
		expect(byItem.get(world.flour)).toBe(75_000)
		expect(byItem.get(world.cheese)).toBe(30_000)
		const entry = (await log()).entries.find((e) => e.id === made.body.id)!
		expect(entry.dish).toMatchObject({
			variantId: 'var_large',
			options: [{ optionId: 'opt_cheese' }],
		})
	})

	it('logs a dish with only a typed cost at that cost, and refuses a dish with neither recipe nor cost', async () => {
		const typed = await wasteDish({ menuItemId: 'dish_typed', quantity: 3 })
		expect(typed.status, JSON.stringify(typed.body)).toBe(200)
		expect(typed.body).toMatchObject({
			basis: 'typed',
			entries: 1,
			valueMinor: 2100,
		})
		const entry = (await log()).entries.find((e) => e.id === typed.body.id)!
		expect(entry.dish?.basis).toBe('typed')
		expect(entry.valueMinor).toBe(2100)

		const missing = await wasteDish({ menuItemId: 'dish_without_recipe' })
		expect([missing.status, missing.body.code]).toEqual([409, 'recipe_missing'])
		const db = await getTenantDb(ORG)
		const none = await db
			.select()
			.from(invWaste)
			.where(eq(invWaste.dishRef, 'dish_without_recipe'))
		expect(none).toEqual([])
	})

	it('needs the recipes flag, the update grant and a pickable reason, and hides money without the cost grant', async () => {
		expect((await wasteDish({}, noRecipes)).status).toBe(403)
		expect((await wasteDish({}, readOnly)).status).toBe(403)
		const system = await wasteDish({ reason: 'cancelled_after_cooking' })
		expect([system.status, system.body.code]).toEqual([
			400,
			'reason_not_allowed',
		])
		const plain = await wasteDish({}, noCost)
		expect(plain.status, JSON.stringify(plain.body)).toBe(200)
		expect(JSON.stringify(plain.body)).not.toMatch(/valueMinor|currency/)
		const listed = JSON.stringify((await log(noCost)).entries)
		expect(listed).not.toMatch(/valueMinor|currentValueMinor/)
	})
})

describe('correcting a waste entry later (#522)', () => {
	async function oldEntry(itemId: string, quantity: number, ageDays: number) {
		// Entered three days ago (rows are append-only, so written as they were then).
		const db = await getTenantDb(ORG)
		const at = Date.now() - ageDays * 24 * 3600_000
		const id = crypto.randomUUID()
		const date = new Date(at).toISOString().slice(0, 10)
		const value = Math.round(quantity * 0.03)
		await db.insert(invWaste).values({
			id,
			locationId: LOC,
			itemId,
			quantity,
			reason: 'spoiled',
			valueMinor: value,
			currency: 'SAR',
			actorKind: 'operator',
			actorId: 'op_1',
			clientId: `old-${id}`,
			businessDate: date,
			createdAt: at,
		})
		await db.insert(invMovements).values({
			locationId: LOC,
			itemId,
			quantity: -quantity,
			valueMinor: -value,
			currency: 'SAR',
			kind: 'waste',
			reason: 'spoiled',
			sourceType: 'waste',
			sourceId: id,
			eventKey: `waste:${id}`,
			businessDate: date,
			actorKind: 'operator',
			actorId: 'op_1',
			createdAt: at,
		})
		return { id, at, value }
	}

	const summary = async (token = full) =>
		wasteSummarySchema.parse(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=${from()}&to=${today()}`,
					{ token },
				)
			).body,
		)

	it('reverses a 3 day old entry: the original stays, stock comes back and the waste report is corrected', async () => {
		const stockBefore = await stock(world.chicken)
		const entry = await oldEntry(world.chicken, 3_000_000, 3)
		expect(await stock(world.chicken)).toBe(stockBefore - 3_000_000)
		const reportBefore = await summary()

		// The 24 hour undo is long gone; the later correction is not an undo.
		const undo = await call('POST', `${BASE}/waste/${entry.id}/undo`, {
			token: full,
			body: { clientId: cid('u') },
		})
		expect([undo.status, undo.body.code]).toEqual([409, 'undo_expired'])

		const reversed = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'reverse',
				reason: 'Logged twice by mistake',
			},
		})
		expect(reversed.status, JSON.stringify(reversed.body)).toBe(200)
		const view = wasteEntrySchema.parse(reversed.body)
		// Both are on the log: what was written, and what it is now.
		expect(view).toMatchObject({
			id: entry.id,
			quantity: 3_000_000,
			currentQuantity: 0,
			valueMinor: entry.value,
			currentValueMinor: 0,
			countedSince: false,
		})
		expect(view.corrections).toHaveLength(1)
		expect(view.corrections![0]).toMatchObject({
			kind: 'reverse',
			previousQuantity: 3_000_000,
			newQuantity: 0,
			stockEffect: 'applied',
			reason: 'Logged twice by mistake',
			valueDeltaMinor: -entry.value,
		})
		// The original row is untouched.
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(invWaste)
			.where(eq(invWaste.id, entry.id))
			.get()
		expect(row).toMatchObject({ quantity: 3_000_000, valueMinor: entry.value })
		// Stock is back, and the waste report no longer counts it.
		expect(await stock(world.chicken)).toBe(stockBefore)
		const reportAfter = await summary()
		expect(reportAfter.count).toBe(reportBefore.count - 1)
		expect(reportAfter.valueMinor).toBe(
			(reportBefore.valueMinor ?? 0) - entry.value,
		)

		// Once reversed, nothing more to correct; and it cannot be undone either.
		const again = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: { clientId: cid('c'), kind: 'reverse', reason: 'Again' },
		})
		expect([again.status, again.body.code]).toEqual([409, 'already_reversed'])
		// The same correction repeated answers the same.
	})

	it('changes a quantity (5 kg typed instead of 5 g): the difference goes back to stock', async () => {
		const entry = await oldEntry(world.flour, 5_000_000, 4)
		const stockBefore = await stock(world.flour)
		const fixed = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'quantity',
				amount: 5,
				unit: 'g',
				reason: 'It was 5 g, not 5 kg',
			},
		})
		expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
		const view = wasteEntrySchema.parse(fixed.body)
		expect(view.currentQuantity).toBe(5_000)
		expect(view.currentValueMinor).toBe(
			Math.round(entry.value * (5_000 / 5_000_000)),
		)
		expect(await stock(world.flour)).toBe(stockBefore + 4_995_000)
		// A correction of a corrected entry starts from its current figure.
		const more = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'quantity',
				amount: 20,
				unit: 'g',
				reason: 'Weighed again',
			},
		})
		expect(more.status, JSON.stringify(more.body)).toBe(200)
		expect(wasteEntrySchema.parse(more.body).corrections).toHaveLength(2)
		expect(await stock(world.flour)).toBe(stockBefore + 4_980_000)
		// A corrected entry cannot be undone, and an unchanged figure is no correction.
		const undo = await call('POST', `${BASE}/waste/${entry.id}/undo`, {
			token: full,
			body: { clientId: cid('u') },
		})
		expect([undo.status, undo.body.code]).toEqual([409, 'already_corrected'])
		const same = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'quantity',
				amount: 20,
				unit: 'g',
				reason: 'Nothing new',
			},
		})
		expect(same.status).toBe(400)
	})

	it('leaves stock alone after a later approved count, and says so', async () => {
		const entry = await oldEntry(world.cheese, 1_000_000, 3)
		const db = await getTenantDb(ORG)
		// The shelves were counted (and approved) after the waste.
		const countedAt = Date.now() - 24 * 3600_000
		await db.insert(invCounts).values({
			id: 'wc_after',
			locationId: LOC,
			status: 'counting',
			businessDate: today(),
			startedByKind: 'operator',
			createdAt: countedAt - 1000,
		})
		await db.insert(invCountEntries).values({
			countId: 'wc_after',
			itemId: world.cheese,
			quantity: 4_000_000,
			enteredAmount: '4',
			enteredUnit: 'kg',
			counterKind: 'operator',
			clientId: cid('entry'),
			createdAt: countedAt,
		})
		await db
			.update(invCounts)
			.set({ status: 'approved', approvedAt: countedAt })
			.where(eq(invCounts.id, 'wc_after'))
		const listed = (await log()).entries.find((e) => e.id === entry.id)!
		// The dialog reads this before it asks for anything.
		expect(listed.countedSince).toBe(true)

		const stockBefore = await stock(world.cheese)
		const reportBefore = await summary()
		const fixed = await call('POST', `${BASE}/waste/${entry.id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'reverse',
				reason: 'Not wasted after all',
			},
		})
		expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
		const view = wasteEntrySchema.parse(fixed.body)
		expect(view.corrections![0]).toMatchObject({
			kind: 'reverse',
			stockEffect: 'covered_by_count',
		})
		// No movement for the correction: the count already reflects the waste.
		expect(await stock(world.cheese)).toBe(stockBefore)
		const moves = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceType, 'waste_correction'))
		expect(moves.some((m) => m.itemId === world.cheese)).toBe(false)
		// ... but the waste figures are corrected.
		const reportAfter = await summary()
		expect(reportAfter.valueMinor).toBe(
			(reportBefore.valueMinor ?? 0) - entry.value,
		)
	})

	it('corrects a whole dish by the number of dishes, and needs the update grant', async () => {
		const made = await wasteDish({ quantity: 4 })
		const id = made.body.id as string
		const stockBefore = await stock(world.chicken)
		const denied = await call('POST', `${BASE}/waste/${id}/correct`, {
			token: readOnly,
			body: { clientId: cid('c'), kind: 'reverse', reason: 'No grant' },
		})
		expect(denied.status).toBe(403)
		const fixed = await call('POST', `${BASE}/waste/${id}/correct`, {
			token: full,
			body: {
				clientId: cid('c'),
				kind: 'quantity',
				dishes: 1,
				reason: 'Only one fell',
			},
		})
		expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
		const view = wasteEntrySchema.parse(fixed.body)
		expect(view.dish?.dishes).toBe(4)
		expect(view.currentQuantity).toBe(1)
		// 3 of 4 dishes come back: 600 g chicken.
		expect(await stock(world.chicken)).toBe(stockBefore + 600_000)
		expect(view.corrections).toHaveLength(1)
		expect(view.corrections![0]).toMatchObject({
			previousQuantity: 4,
			newQuantity: 1,
		})
		// A dish corrected cannot be undone as a whole.
		const undo = await call('POST', `${BASE}/waste/dishes/${id}/undo`, {
			token: full,
			body: { clientId: cid('u') },
		})
		expect([undo.status, undo.body.code]).toEqual([409, 'already_corrected'])
	})
})
