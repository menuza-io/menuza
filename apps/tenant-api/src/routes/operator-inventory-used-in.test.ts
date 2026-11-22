import { usedInResultSchema } from '@repo/inventory'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	COST,
	makeClient,
	mintToken,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/** Where an item is used (#518). */

const ORG = 'org_inv_used_in_a'
const ORG_B = 'org_inv_used_in_b'
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
let noCost: string
let tokenB: string
let cheese: string
let dough: string
let madeSauce: string

async function newItem(body: Record<string, unknown>, token = full) {
	const res = await call('POST', `${BASE}/items`, {
		token,
		body: {
			clientId: cid('item'),
			category: 'dairy',
			kind: 'bought',
			baseUnit: 'g',
			...body,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body.id as string
}

async function putRecipe(
	ownerKind: string,
	ownerId: string,
	lines: Record<string, unknown>[],
	extra: Record<string, unknown> = {},
) {
	const res = await call('PUT', `${BASE}/recipes`, {
		token: full,
		body: { ownerKind, ownerId, expectedVersion: 0, lines, ...extra },
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-used-in')
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
		grants: [READ, UPDATE, COST, RECIPE],
		features,
	})
	noCost = await mintToken(ORG, { grants: [READ, UPDATE, RECIPE], features })
	tokenB = await mintToken(ORG_B, {
		grants: [READ, UPDATE, COST, RECIPE],
		features,
	})
	cheese = await newItem({ name: 'Mozzarella' })
	dough = await newItem({ name: 'Dough', category: 'bakery' })
	madeSauce = await newItem({
		name: 'Pizza sauce',
		kind: 'made',
		category: 'sauces',
	})
	const delivery = await call('POST', `${BASE}/deliveries`, {
		token: full,
		body: {
			clientId: cid('delivery'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [
				{ itemId: cheese, quantity: 10_000_000, lineTotalMinor: 30_000 },
				{ itemId: dough, quantity: 10_000_000, lineTotalMinor: 10_000 },
			],
		},
	})
	expect(delivery.status, JSON.stringify(delivery.body)).toBe(200)
	await putRecipe('menu_item', 'dish_margherita', [
		{ itemId: cheese, amount: 120, unit: 'g' },
		{ itemId: dough, amount: 250, unit: 'g' },
	])
	await putRecipe('menu_item', 'dish_quattro', [
		{ itemId: cheese, amount: 200, unit: 'g' },
	])
	await putRecipe('option', 'opt_extra_cheese', [
		{ itemId: cheese, amount: 40, unit: 'g' },
	])
	await putRecipe(
		'made_item',
		madeSauce,
		[{ itemId: cheese, amount: 10, unit: 'g' }],
		{ makes: { amount: 1000, unit: 'g' } },
	)
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

describe('GET /items/:id/used-in', () => {
	it('lists an ingredient used in several dishes, an option and a made item with quantities', async () => {
		const res = await call('GET', `${BASE}/items/${cheese}/used-in`, {
			token: full,
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = usedInResultSchema.parse(res.body)
		expect(result.baseUnit).toBe('g')
		expect(result.more).toBe(0)
		const byOwner = Object.fromEntries(
			result.rows.map((row) => [`${row.ownerKind}:${row.ownerId}`, row]),
		)
		expect(Object.keys(byOwner).sort()).toEqual(
			[
				'menu_item:dish_margherita',
				'menu_item:dish_quattro',
				`made_item:${madeSauce}`,
				'option:opt_extra_cheese',
			].sort(),
		)
		expect(byOwner['menu_item:dish_margherita']!.quantity).toBe(120_000)
		expect(byOwner['menu_item:dish_quattro']!.quantity).toBe(200_000)
		expect(byOwner['option:opt_extra_cheese']!.quantity).toBe(40_000)
		expect(byOwner[`made_item:${madeSauce}`]!.ownerName).toBe('Pizza sauce')
	})

	it('shows each line cost and its share of the dish with the cost grant', async () => {
		const res = await call('GET', `${BASE}/items/${cheese}/used-in`, {
			token: full,
		})
		const result = usedInResultSchema.parse(res.body)
		const margherita = result.rows.find(
			(row) => row.ownerId === 'dish_margherita',
		)!
		// Cheese 120 g at 0.003 minor per milligram-thousandth: SAR 30 / 10 kg = 3 per 1000 g -> 360 for 120 g.
		expect(margherita.costMinor).toBe(360)
		// Dough 250 g at 1 per 1000 g = 250: cheese is 360 of 610.
		expect(margherita.shareBp).toBe(Math.round((360 * 10_000) / 610))
		const quattro = result.rows.find((row) => row.ownerId === 'dish_quattro')!
		expect(quattro.shareBp).toBe(10_000)
	})

	it('leaves out every cost figure without the cost grant', async () => {
		const res = await call('GET', `${BASE}/items/${cheese}/used-in`, {
			token: noCost,
		})
		expect(res.status).toBe(200)
		const text = JSON.stringify(res.body)
		expect(text).not.toContain('costMinor')
		expect(text).not.toContain('shareBp')
		expect(usedInResultSchema.parse(res.body).rows).toHaveLength(4)
	})

	it('lists nothing for an item no recipe uses', async () => {
		const lonely = await newItem({ name: 'Saffron' })
		const res = await call('GET', `${BASE}/items/${lonely}/used-in`, {
			token: full,
		})
		expect(usedInResultSchema.parse(res.body).rows).toEqual([])
	})

	it('only lists current recipes: a replaced ingredient drops out', async () => {
		const res = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body: {
				ownerKind: 'menu_item',
				ownerId: 'dish_quattro',
				expectedVersion: 1,
				lines: [{ itemId: dough, amount: 200, unit: 'g' }],
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const used = await call('GET', `${BASE}/items/${cheese}/used-in`, {
			token: full,
		})
		expect(
			usedInResultSchema
				.parse(used.body)
				.rows.map((row) => row.ownerId)
				.includes('dish_quattro'),
		).toBe(false)
	})

	it('does not reach another organization', async () => {
		const res = await call('GET', `${BASE}/items/${cheese}/used-in`, {
			token: tokenB,
		})
		expect(res.status).toBe(404)
	})
})
