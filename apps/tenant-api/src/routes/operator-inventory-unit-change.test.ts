import {
	itemDetailSchema,
	listItemsResultSchema,
	unitChangePlanSchema,
	unitChangeResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	invRecipes,
	invWaste,
	provisionTenantDb,
} from '@repo/tenant-db'
import { and, asc, eq, sql } from 'drizzle-orm'
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

/** Change an item's unit (#494): the plan, the apply, history and money. */

const ORG = 'org_inv_unit_change_a'
const ORG_B = 'org_inv_unit_change_b'
const LOC = 'loc_a'

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
let noRecipe: string
let tokenB: string
let scopedToken: string

beforeAll(async () => {
	env = setupTenantEnv('inv-unit-change')
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
	const features = { recipes: true }
	full = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
	})
	noRecipe = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING],
		features,
	})
	scopedToken = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
		locationIds: [LOC],
	})
	tokenB = await mintToken(ORG_B, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function ok(res: Promise<{ status: number; body: any }>) {
	const reply = await res
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return reply.body
}

/** A burger bun counted in pieces, with every kind of stored quantity. */
async function bunWithEverything(name: string) {
	const item = await ok(
		call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name,
				category: 'bakery',
				kind: 'bought',
				baseUnit: 'piece',
				units: [{ name: 'Box', baseQuantity: 20_000 }],
			},
		}),
	)
	const itemId = item.id as string
	await ok(
		call('PUT', `${BASE}/items/${itemId}/places/${LOC}`, {
			token: full,
			body: {
				countUnit: 'piece',
				areaIds: [],
				orderBelowQuantity: 20_000,
				fillUpToQuantity: 60_000,
				expectedVersion: 0,
			},
		}),
	)
	const supplier = await ok(
		call('POST', `${BASE}/suppliers`, {
			token: full,
			body: { clientId: cid('sup'), name: `Bakery ${name}`, currency: 'SAR' },
		}),
	)
	const product = await ok(
		call('POST', `${BASE}/suppliers/${supplier.id}/products`, {
			token: full,
			body: {
				itemId,
				packName: 'Bag of 10',
				packBaseQuantity: 10_000,
				priceMinor: 2_000,
			},
		}),
	)
	// 100 pieces for SAR 40.00: 0.40 per piece.
	await ok(
		call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('delivery'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [{ itemId, quantity: 100_000, lineTotalMinor: 4_000 }],
			},
		}),
	)
	await ok(
		call('POST', `${BASE}/waste`, {
			token: full,
			body: {
				entries: [
					{
						clientId: cid('waste'),
						locationId: LOC,
						itemId,
						amount: 4,
						unit: 'piece',
						reason: 'dropped',
					},
				],
			},
		}),
	)
	await ok(
		call('PUT', `${BASE}/recipes`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: `dish_${name}`,
				expectedVersion: 0,
				lines: [{ itemId, amount: 1, unit: 'piece' }],
			},
		}),
	)
	return { itemId, productId: product.id as string, supplierId: supplier.id }
}

const body = (version: number) => ({
	toUnit: 'g',
	oldAmount: '1',
	newAmount: '180',
	expectedVersion: version,
})

async function detail(itemId: string, token = full) {
	return itemDetailSchema.parse(
		await ok(
			call('GET', `${BASE}/items/${itemId}?locationId=${LOC}`, { token }),
		),
	)
}

async function stockValue(itemId: string) {
	const list = listItemsResultSchema.parse(
		await ok(
			call('GET', `${BASE}/items?locationId=${LOC}&limit=200`, { token: full }),
		),
	)
	return list.items.find((entry) => entry.id === itemId)!
}

describe('POST /items/:id/unit-change', () => {
	it('converts on hand, packs, units, levels, cost and recipe lines (piece to g at 180 g)', async () => {
		const { itemId, productId } = await bunWithEverything('bun')
		const before = await detail(itemId)
		expect(before.onHand).toBe(96_000)
		const valueBefore = (await stockValue(itemId)).valueMinor

		const preview = unitChangePlanSchema.parse(
			await ok(
				call('POST', `${BASE}/items/${itemId}/unit-change/preview`, {
					token: full,
					body: body(before.version),
				}),
			),
		)
		expect(preview.canApply).toBe(true)
		expect(preview.onHand).toEqual([
			{ locationId: LOC, before: 96_000, after: 17_280_000 },
		])
		expect(preview.packs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'supplier_product',
					id: productId,
					before: 10_000,
					after: 1_800_000,
				}),
				expect.objectContaining({
					kind: 'named_unit',
					name: 'Box',
					before: 20_000,
					after: 3_600_000,
				}),
			]),
		)
		expect(preview.recipes[0]!.lines[0]).toMatchObject({
			before: 1_000,
			after: 180_000,
		})
		expect(preview.levels[0]).toMatchObject({
			orderBelow: { before: 20_000, after: 3_600_000 },
			fillUpTo: { before: 60_000, after: 10_800_000 },
		})

		const applied = unitChangeResultSchema.parse(
			await ok(
				call('POST', `${BASE}/items/${itemId}/unit-change`, {
					token: full,
					body: body(before.version),
				}),
			),
		)
		// The preview is what happened.
		expect(applied.plan).toEqual(preview)

		const after = await detail(itemId)
		expect(after.baseUnit).toBe('g')
		expect(after.onHand).toBe(17_280_000)
		expect(after.suppliers[0]!.packBaseQuantity).toBe(1_800_000)
		expect(after.units.find((unit) => unit.name === 'Box')!.baseQuantity).toBe(
			3_600_000,
		)
		expect(after.places[0]).toMatchObject({
			orderBelowQuantity: 3_600_000,
			fillUpToQuantity: 10_800_000,
		})
		// Cost per base unit divides by the factor.
		expect(after.cost!.avgCostMicro).toBe(
			Math.round(before.cost!.avgCostMicro! / 180),
		)

		// The recipe got a new version; the old one is kept.
		const db = await getTenantDb(ORG)
		const versions = await db
			.select()
			.from(invRecipes)
			.where(eq(invRecipes.ownerId, 'dish_bun'))
			.orderBy(asc(invRecipes.version))
		expect(versions.map((row) => row.version)).toEqual([1, 2])
		expect(versions[0]!.supersededAt).not.toBeNull()
		const current = await ok(
			call('GET', `${BASE}/recipes?ownerKind=menu_item&ownerId=dish_bun`, {
				token: full,
			}),
		)
		expect(current.recipe.lines[0].quantity).toBe(180_000)

		// Money did not move.
		expect((await stockValue(itemId)).valueMinor).toBe(valueBefore)
	})

	it('leaves the ledger as written, records a unit-changed movement and keeps every sum of money', async () => {
		const { itemId } = await bunWithEverything('roll')
		const db = await getTenantDb(ORG)
		const sumValue = async () =>
			Number(
				(
					await db
						.select({ total: sql<number>`sum(${invMovements.valueMinor})` })
						.from(invMovements)
						.where(eq(invMovements.itemId, itemId))
				)[0]!.total,
			)
		const wasteValue = async () =>
			Number(
				(
					await db
						.select({ total: sql<number>`sum(${invWaste.valueMinor})` })
						.from(invWaste)
						.where(eq(invWaste.itemId, itemId))
				)[0]!.total,
			)
		const moneyBefore = await sumValue()
		const wasteBefore = await wasteValue()
		const rowsBefore = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, itemId))
			.orderBy(asc(invMovements.createdAt), asc(invMovements.id))
		const version = (await detail(itemId)).version
		await ok(
			call('POST', `${BASE}/items/${itemId}/unit-change`, {
				token: full,
				body: body(version),
			}),
		)
		const rowsAfter = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, itemId))
			.orderBy(asc(invMovements.createdAt), asc(invMovements.id))
		// Old rows are untouched; one new adjustment carries the difference.
		expect(rowsAfter.slice(0, rowsBefore.length)).toEqual(rowsBefore)
		const extra = rowsAfter.slice(rowsBefore.length)
		expect(extra).toHaveLength(1)
		expect(extra[0]).toMatchObject({
			kind: 'adjustment',
			reason: 'unit_changed',
			sourceType: 'unit_change',
			valueMinor: 0,
		})
		const sum = rowsAfter.reduce((total, row) => total + row.quantity, 0)
		expect(sum).toBe(96_000 * 180)
		// Reports before and after show the same money.
		expect(await sumValue()).toBe(moneyBefore)
		expect(await wasteValue()).toBe(wasteBefore)
	})

	it('is blocked while the item is in an open count and says which', async () => {
		const { itemId } = await bunWithEverything('croissant')
		const count = await ok(
			call('POST', `${BASE}/counts`, {
				token: full,
				body: { clientId: cid('count'), locationId: LOC, listId: null },
			}),
		)
		const version = (await detail(itemId)).version
		const preview = unitChangePlanSchema.parse(
			await ok(
				call('POST', `${BASE}/items/${itemId}/unit-change/preview`, {
					token: full,
					body: body(version),
				}),
			),
		)
		expect(preview.canApply).toBe(false)
		expect(preview.blockers).toEqual([
			expect.objectContaining({
				kind: 'open_count',
				id: count.id,
				locationId: LOC,
			}),
		])
		const refused = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: full,
			body: body(version),
		})
		expect(refused.status).toBe(409)
		expect(refused.body.code).toBe('change_blocked')
		expect((await detail(itemId)).baseUnit).toBe('piece')
		// Cancel the count so later tests are free of it.
		await ok(
			call('POST', `${BASE}/counts/${count.id}/cancel`, {
				token: full,
				body: { expectedVersion: count.version },
			}),
		)
	})

	it('refuses a change that would round a recipe line to nothing', async () => {
		const flour = await ok(
			call('POST', `${BASE}/items`, {
				token: full,
				body: {
					clientId: cid('item'),
					name: 'Pinch of salt',
					category: 'dry_goods',
					kind: 'bought',
					baseUnit: 'g',
				},
			}),
		)
		await ok(
			call('PUT', `${BASE}/recipes`, {
				token: full,
				body: {
					ownerKind: 'menu_item',
					ownerId: 'dish_salty',
					expectedVersion: 0,
					lines: [{ itemId: flour.id, amount: 0.1, unit: 'g' }],
				},
			}),
		)
		const request = {
			toUnit: 'piece',
			oldAmount: '1000',
			newAmount: '1',
			expectedVersion: flour.version,
		}
		const preview = unitChangePlanSchema.parse(
			await ok(
				call('POST', `${BASE}/items/${flour.id}/unit-change/preview`, {
					token: full,
					body: request,
				}),
			),
		)
		expect(preview.tooSmall).toBe(true)
		expect(preview.canApply).toBe(false)
		const refused = await call(
			'POST',
			`${BASE}/items/${flour.id}/unit-change`,
			{
				token: full,
				body: request,
			},
		)
		expect(refused.status).toBe(400)
		expect(refused.body.code).toBe('unit_change_too_small')
	})

	it('needs the recipe grant when recipes would get a new version', async () => {
		const { itemId } = await bunWithEverything('pretzel')
		const version = (await detail(itemId)).version
		const denied = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: noRecipe,
			body: body(version),
		})
		expect(denied.status).toBe(403)
		expect(denied.body.code).toBe('needs_recipe_grant')
	})

	it('refuses the same unit, a stale version and another organization', async () => {
		const { itemId } = await bunWithEverything('brioche')
		const version = (await detail(itemId)).version
		const same = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: full,
			body: { ...body(version), toUnit: 'piece' },
		})
		expect(same.status).toBe(400)
		const stale = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: full,
			body: body(version + 5),
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')
		const other = await call(
			'POST',
			`${BASE}/items/${itemId}/unit-change/preview`,
			{
				token: tokenB,
				body: body(version),
			},
		)
		expect(other.status).toBe(404)
		const invalid = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: full,
			body: { ...body(version), oldAmount: '0' },
		})
		expect(invalid.status).toBe(400)
	})

	it('shows older history in the new unit and the log still adds up to on hand', async () => {
		const { itemId } = await bunWithEverything('bagel')
		const version = (await detail(itemId)).version
		await ok(
			call('POST', `${BASE}/items/${itemId}/unit-change`, {
				token: full,
				body: body(version),
			}),
		)
		const log = await ok(
			call(
				'GET',
				`${BASE}/items/${itemId}/movements?locationId=${LOC}&limit=50`,
				{ token: full },
			),
		)
		const quantities = log.movements.map(
			(row: { quantity: number }) => row.quantity,
		)
		// 100 pieces in, 4 wasted, and the unit-changed line shows as no change.
		expect(quantities.sort((a: number, b: number) => a - b)).toEqual([
			-720_000, 0, 18_000_000,
		])
		expect(
			quantities.reduce((sum: number, quantity: number) => sum + quantity, 0),
		).toBe((await detail(itemId)).onHand)
		const waste = await ok(
			call(
				'GET',
				`${BASE}/waste?locationId=${LOC}&from=2000-01-01&to=2999-12-31`,
				{
					token: full,
				},
			),
		)
		const bagel = waste.entries.filter(
			(entry: { itemId: string }) => entry.itemId === itemId,
		)
		expect(bagel[0].quantity).toBe(720_000)
		// A waste entry logged before the change cannot be undone into the new unit.
		const undo = await call('POST', `${BASE}/waste/${bagel[0].id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		expect(undo.status).toBe(409)
		expect(undo.body.code).toBe('undo_expired')
	})

	it('is not for a token limited to some places', async () => {
		const { itemId } = await bunWithEverything('focaccia')
		const version = (await detail(itemId)).version
		const refused = await call('POST', `${BASE}/items/${itemId}/unit-change`, {
			token: scopedToken,
			body: body(version),
		})
		expect(refused.status).toBe(403)
		expect(refused.body.code).toBe('location_forbidden')
		expect((await detail(itemId)).baseUnit).toBe('piece')
	})
})
