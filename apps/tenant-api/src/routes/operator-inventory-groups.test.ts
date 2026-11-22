import { listGroupsResultSchema } from '@repo/inventory'
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
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

const ORG = 'org_inv_groups_routes_a'
const ORG_B = 'org_inv_groups_routes_b'
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
let flagOff: string
let readOnly: string
let tokenB: string

async function item(name: string, baseUnit = 'ml', token = full) {
	const res = await call('POST', `${BASE}/items`, {
		token,
		body: {
			clientId: cid('item'),
			name,
			category: 'sauces',
			kind: 'bought',
			baseUnit,
		},
	})
	expect(res.status, JSON.stringify(res.body)).toBe(200)
	return res.body.id as string
}

beforeAll(async () => {
	env = setupTenantEnv('inv-groups-routes')
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
	full = await mintToken(ORG, { grants: [READ, UPDATE, COST], features })
	flagOff = await mintToken(ORG, { grants: [READ, UPDATE, COST] })
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ], features })
	tokenB = await mintToken(ORG_B, { grants: [READ, UPDATE, COST], features })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

describe('/groups', () => {
	it('creates a group, lists it with members in rank order and dissolves it', async () => {
		const a = await item('Oil A')
		const b = await item('Oil B')
		const created = await call('POST', `${BASE}/groups`, {
			token: full,
			body: {
				clientId: cid('group'),
				name: 'Olive oil',
				baseUnit: 'ml',
				members: [{ itemId: a }, { itemId: b }],
			},
		})
		expect(created.status, JSON.stringify(created.body)).toBe(200)
		const id = created.body.id as string
		const list = listGroupsResultSchema.parse(
			(await call('GET', `${BASE}/groups?locationId=${LOC}`, { token: full }))
				.body,
		)
		expect(list.groups.map((g) => g.name)).toEqual(['Olive oil'])
		expect(list.groups[0]!.members.map((m) => m.itemId)).toEqual([a, b])
		// Reorder: B becomes the primary.
		const updated = await call('PATCH', `${BASE}/groups/${id}`, {
			token: full,
			body: {
				expectedVersion: created.body.version,
				members: [{ itemId: b }, { itemId: a }],
			},
		})
		expect(updated.status).toBe(200)
		expect(
			updated.body.members.map((m: { itemId: string }) => m.itemId),
		).toEqual([b, a])
		const stale = await call('PATCH', `${BASE}/groups/${id}`, {
			token: full,
			body: { expectedVersion: 1, name: 'Oil' },
		})
		expect(stale.status).toBe(409)
		const gone = await call('POST', `${BASE}/groups/${id}/dissolve`, {
			token: full,
			body: { expectedVersion: updated.body.version },
		})
		expect(gone.status).toBe(200)
		const after = listGroupsResultSchema.parse(
			(await call('GET', `${BASE}/groups?locationId=${LOC}`, { token: full }))
				.body,
		)
		expect(after.groups).toEqual([])
	})

	it('refuses an item already in a group, a nested group and a unit mismatch without a conversion', async () => {
		const a = await item('Tahini A')
		const b = await item('Tahini B')
		const grams = await item('Tahini jar', 'g')
		const make = (members: unknown[], name: string) =>
			call('POST', `${BASE}/groups`, {
				token: full,
				body: { clientId: cid('group'), name, baseUnit: 'ml', members },
			})
		const first = await make([{ itemId: a }], 'Tahini')
		expect(first.status).toBe(200)
		const taken = await make([{ itemId: a }, { itemId: b }], 'Tahini two')
		expect(taken.status).toBe(409)
		expect(taken.body.code).toBe('item_in_group')
		const nested = await make([{ itemId: first.body.id }], 'Nested')
		expect(nested.status).toBe(400)
		expect(nested.body.code).toBe('group_invalid')
		const mismatch = await make([{ itemId: grams }], 'Mismatch')
		expect(mismatch.status).toBe(400)
		expect(mismatch.body).toMatchObject({
			code: 'group_invalid',
			reason: 'conversion_required',
		})
		const converted = await make(
			[{ itemId: grams, memberQuantity: 1, groupQuantity: 1 }].map(() => ({
				itemId: grams,
				memberQuantity: 10,
				groupQuantity: 11,
			})),
			'Converted',
		)
		expect(converted.status).toBe(200)
	})

	it('needs the recipes flag, write scope, and stays inside the organization', async () => {
		const off = await call('GET', `${BASE}/groups?locationId=${LOC}`, {
			token: flagOff,
		})
		expect(off.status).toBe(403)
		expect(off.body.code).toBe('feature_disabled')
		const denied = await call('POST', `${BASE}/groups`, {
			token: readOnly,
			body: {
				clientId: cid('group'),
				name: 'X',
				baseUnit: 'ml',
				members: [{ itemId: 'x' }],
			},
		})
		expect(denied.status).toBe(403)
		const other = await call('GET', `${BASE}/groups?locationId=${LOC}`, {
			token: tokenB,
		})
		expect(listGroupsResultSchema.parse(other.body).groups).toEqual([])
	})
})
