import {
	adjustStockResultSchema,
	itemDetailSchema,
	itemPlaceSchema,
	listCountListsResultSchema,
	listItemsResultSchema,
	listMovementsResultSchema,
	listStorageAreasResultSchema,
	storageAreaSchema,
} from '@repo/inventory'
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

/**
 * Items, places, storage areas, count lists, stock adjustments and the
 * movement history of `/operator/inventory`. The control plane is mocked and
 * every organization gets a real tenant database.
 */

const ORG = 'org_inv_items_a'
const ORG_B = 'org_inv_items_b'

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
let scoped: string

beforeAll(async () => {
	env = setupTenantEnv('inv-items')
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
	full = await mintToken(ORG)
	noCost = await mintToken(ORG, { grants: [READ, UPDATE] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: ['loc_a'] })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function area(name: string, locationId = 'loc_a') {
	const res = await call('POST', `${BASE}/storage-areas`, {
		token: full,
		body: { locationId, name },
	})
	expect(res.status).toBe(200)
	return storageAreaSchema.parse(res.body)
}

async function newItem(body: Record<string, unknown>) {
	const res = await call('POST', `${BASE}/items`, {
		token: full,
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

describe('storage areas', () => {
	it('creates areas in walking order, renames, reorders and archives them', async () => {
		const walkIn = await area('Walk-in', 'loc_area')
		const freezer = await area('Freezer', 'loc_area')
		const dry = await area('Dry store', 'loc_area')
		expect([walkIn.sortOrder, freezer.sortOrder, dry.sortOrder]).toEqual([
			0, 1, 2,
		])

		const duplicate = await call('POST', `${BASE}/storage-areas`, {
			token: full,
			body: { locationId: 'loc_area', name: 'FREEZER' },
		})
		expect(duplicate.status).toBe(409)
		expect(duplicate.body.code).toBe('name_taken')

		const renamed = await call('PATCH', `${BASE}/storage-areas/${freezer.id}`, {
			token: full,
			body: { expectedVersion: 1, name: 'Deep freeze' },
		})
		expect(renamed.status).toBe(200)
		expect(renamed.body).toMatchObject({ name: 'Deep freeze', version: 2 })
		const stale = await call('PATCH', `${BASE}/storage-areas/${freezer.id}`, {
			token: full,
			body: { expectedVersion: 1, name: 'Again' },
		})
		expect(stale.status).toBe(409)
		expect(stale.body).toMatchObject({
			code: 'stale_version',
			currentVersion: 2,
		})

		const partial = await call('POST', `${BASE}/storage-areas/reorder`, {
			token: full,
			body: { locationId: 'loc_area', areaIds: [dry.id, walkIn.id] },
		})
		expect(partial.status).toBe(400)
		const reordered = await call('POST', `${BASE}/storage-areas/reorder`, {
			token: full,
			body: {
				locationId: 'loc_area',
				areaIds: [dry.id, walkIn.id, freezer.id],
			},
		})
		expect(reordered.status).toBe(200)
		expect(
			listStorageAreasResultSchema
				.parse(reordered.body)
				.areas.map((entry) => entry.name),
		).toEqual(['Dry store', 'Walk-in', 'Deep freeze'])

		const archived = await call(
			'POST',
			`${BASE}/storage-areas/${walkIn.id}/archive`,
			{ token: full, body: { expectedVersion: 1 } },
		)
		expect(archived.status).toBe(200)
		const list = await call(
			'GET',
			`${BASE}/storage-areas?locationId=loc_area`,
			{ token: full },
		)
		expect(
			list.body.areas.map((entry: { name: string }) => entry.name),
		).toEqual(['Dry store', 'Deep freeze'])
	})

	it('answers 404 for an area of another organization and 403 for an excluded location', async () => {
		const mine = await area('Pantry')
		const other = await call('PATCH', `${BASE}/storage-areas/${mine.id}`, {
			token: tokenB,
			body: { expectedVersion: 1, name: 'Hijack' },
		})
		expect(other.status).toBe(404)
		const excluded = await call('POST', `${BASE}/storage-areas`, {
			token: scoped,
			body: { locationId: 'loc_b', name: 'Nope' },
		})
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
		const list = await call('GET', `${BASE}/storage-areas?locationId=loc_b`, {
			token: scoped,
		})
		expect(list.status).toBe(403)
		// An area of an excluded location addressed by id is refused too.
		const bArea = await area('Bar', 'loc_b')
		const byId = await call('PATCH', `${BASE}/storage-areas/${bArea.id}`, {
			token: scoped,
			body: { expectedVersion: 1, name: 'Bar 2' },
		})
		expect(byId.status).toBe(403)
	})
})

describe('items', () => {
	it('creates an item with named units, a place and a supplier-less record, and replays the clientId', async () => {
		const shelf = await area('Shelf one')
		const clientId = cid('item')
		const body = {
			clientId,
			name: 'Chicken thighs',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
			units: [{ name: 'Box', baseQuantity: 10_000_000 }],
			place: {
				locationId: 'loc_a',
				countUnit: 'new:0',
				areaIds: [shelf.id],
				orderBelowQuantity: 8_000_000,
				fillUpToQuantity: 30_000_000,
			},
		}
		const first = await call('POST', `${BASE}/items`, { token: full, body })
		expect(first.status, JSON.stringify(first.body)).toBe(200)
		const detail = itemDetailSchema.parse(first.body)
		expect(detail).toMatchObject({
			name: 'Chicken thighs',
			baseUnit: 'g',
			onHand: 0,
			status: 'out',
			hasMovements: false,
			areaIds: [shelf.id],
			orderBelowQuantity: 8_000_000,
		})
		expect(detail.units).toHaveLength(1)
		expect(detail.countUnit).toBe(`unit:${detail.units[0]!.id}`)
		expect(detail.places).toHaveLength(1)

		const replay = await call('POST', `${BASE}/items`, { token: full, body })
		expect(replay.status).toBe(200)
		expect(replay.body.id).toBe(detail.id)

		const changed = await call('POST', `${BASE}/items`, {
			token: full,
			body: { ...body, name: 'Something else' },
		})
		expect(changed.status).toBe(409)
		expect(changed.body.code).toBe('idempotency_conflict')

		const again = await call('POST', `${BASE}/items`, {
			token: full,
			body: { ...body, clientId: cid('item'), name: 'chicken THIGHS' },
		})
		expect(again.status).toBe(409)
		expect(again.body.code).toBe('name_taken')
	})

	it('refuses unknown fields and bad units without echoing them', async () => {
		const bad = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'X',
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				secretField: 'leak-me',
			},
		})
		expect(bad.status).toBe(400)
		expect(JSON.stringify(bad.body)).not.toContain('leak-me')

		const mismatch = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'Mismatch',
				category: 'drinks',
				kind: 'bought',
				baseUnit: 'ml',
				place: {
					locationId: 'loc_a',
					countUnit: 'kg',
					areaIds: [],
					orderBelowQuantity: null,
					fillUpToQuantity: null,
				},
			},
		})
		expect(mismatch.status).toBe(400)
		expect(mismatch.body.code).toBe('unit_mismatch')
		// The failed create left no item behind (one transaction).
		const list = await call(
			'GET',
			`${BASE}/items?locationId=loc_a&q=Mismatch`,
			{
				token: full,
			},
		)
		expect(list.body.total).toBe(0)
	})

	it('lists with filters, paging and totals, and leaves money out without the cost grant', async () => {
		const shelf = await area('List shelf', 'loc_list')
		const items = []
		for (const [name, category, unit] of [
			['Zlist Alpha rice', 'dry_goods', 'g'],
			['Zlist Beta milk', 'dairy', 'ml'],
			['Zlist Gamma flour', 'dry_goods', 'g'],
		] as const) {
			items.push(
				await newItem({
					name,
					category,
					baseUnit: unit,
					place: {
						locationId: 'loc_list',
						countUnit: unit === 'g' ? 'kg' : 'l',
						areaIds: name === 'Zlist Beta milk' ? [] : [shelf.id],
						orderBelowQuantity: 5_000_000,
						fillUpToQuantity: null,
					},
				}),
			)
		}
		// Stock: rice well above its level, flour below it, milk none.
		const adjust = (itemId: string, quantity: number) =>
			call('POST', `${BASE}/items/${itemId}/adjust`, {
				token: full,
				body: {
					clientId: cid('adj'),
					locationId: 'loc_list',
					quantity,
					reason: 'found',
				},
			})
		expect((await adjust(items[0]!.id, 20_000_000)).status).toBe(200)
		expect((await adjust(items[2]!.id, 2_000_000)).status).toBe(200)

		const all = await call('GET', `${BASE}/items?locationId=loc_list&q=zlist`, {
			token: full,
		})
		const parsed = listItemsResultSchema.parse(all.body)
		expect(parsed.items.map((item) => item.name)).toEqual([
			'Zlist Alpha rice',
			'Zlist Beta milk',
			'Zlist Gamma flour',
		])
		expect(parsed.items.map((item) => item.status)).toEqual([
			'ok',
			'out',
			'low',
		])
		expect(parsed.total).toBe(3)

		const filter = async (query: string) =>
			(
				await call(
					'GET',
					`${BASE}/items?locationId=loc_list&q=zlist&${query}`,
					{
						token: full,
					},
				)
			).body.items.map((item: { name: string }) => item.name)
		expect(await filter('status=low')).toEqual(['Zlist Gamma flour'])
		expect(await filter('status=out')).toEqual(['Zlist Beta milk'])
		expect(await filter('status=attention')).toEqual([
			'Zlist Beta milk',
			'Zlist Gamma flour',
		])
		expect(await filter('category=dairy')).toEqual(['Zlist Beta milk'])
		expect(await filter('q=ZLIST gamma')).toEqual(['Zlist Gamma flour'])
		expect(await filter(`areaId=${shelf.id}`)).toEqual([
			'Zlist Alpha rice',
			'Zlist Gamma flour',
		])

		const page1 = await call(
			'GET',
			`${BASE}/items?locationId=loc_list&q=zlist&limit=2`,
			{
				token: full,
			},
		)
		expect(page1.body.items).toHaveLength(2)
		expect(page1.body.nextCursor).toBe('2')
		const page2 = await call(
			'GET',
			`${BASE}/items?locationId=loc_list&q=zlist&limit=2&cursor=${page1.body.nextCursor}`,
			{ token: full },
		)
		expect(page2.body.items).toHaveLength(1)
		expect(page2.body.nextCursor).toBeNull()
		const badCursor = await call(
			'GET',
			`${BASE}/items?locationId=loc_list&cursor=abc`,
			{ token: full },
		)
		expect(badCursor.status).toBe(400)
		expect(
			(
				await call('GET', `${BASE}/items?locationId=loc_list&limit=201`, {
					token: full,
				})
			).status,
		).toBe(400)

		// Money: only with the cost grant, omitted (not zeroed) without it.
		const costFree = await call(
			'GET',
			`${BASE}/items?locationId=loc_list&q=zlist`,
			{
				token: noCost,
			},
		)
		expect(costFree.status).toBe(200)
		const text = JSON.stringify(costFree.body)
		for (const field of [
			'valueMinor',
			'costMicro',
			'totalValueMinor',
			'currency',
		]) {
			expect(text, field).not.toContain(field)
		}
		expect(all.body.totalValueMinor).toBe(0)
		expect(await filter('includeArchived=false')).toHaveLength(3)
	})

	it('edits, archives and restores with expectedVersion, and keeps the base unit once there is stock', async () => {
		const item = await newItem({
			name: 'Olive oil',
			category: 'sauces',
			baseUnit: 'ml',
		})
		const renamed = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: full,
			body: {
				expectedVersion: item.version,
				name: 'Olive oil extra',
				notes: 'Cold pressed',
			},
		})
		expect(renamed.status).toBe(200)
		expect(renamed.body).toMatchObject({
			name: 'Olive oil extra',
			notes: 'Cold pressed',
			version: 2,
		})
		const stale = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: full,
			body: { expectedVersion: 1, name: 'Nope' },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')

		// No stock yet: the base unit may change. Then stock arrives and it may not.
		const unit = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: full,
			body: { expectedVersion: 2, baseUnit: 'g' },
		})
		expect(unit.status).toBe(200)
		await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body: {
				clientId: cid('adj'),
				locationId: 'loc_a',
				quantity: 1000,
				reason: 'found',
			},
		})
		const locked = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: full,
			body: { expectedVersion: 3, baseUnit: 'piece' },
		})
		expect(locked.status).toBe(409)
		expect(locked.body.code).toBe('unit_in_use')

		const archived = await call('POST', `${BASE}/items/${item.id}/archive`, {
			token: full,
			body: { expectedVersion: 3 },
		})
		expect(archived.status).toBe(200)
		expect(archived.body.archived).toBe(true)
		const gone = await call('GET', `${BASE}/items?locationId=loc_a&q=Olive`, {
			token: full,
		})
		expect(gone.body.total).toBe(0)
		const shown = await call(
			'GET',
			`${BASE}/items?locationId=loc_a&q=Olive&includeArchived=true`,
			{ token: full },
		)
		expect(shown.body.total).toBe(1)
		const restored = await call('POST', `${BASE}/items/${item.id}/restore`, {
			token: full,
			body: { expectedVersion: 4 },
		})
		expect(restored.status).toBe(200)
		expect(restored.body.archived).toBe(false)
	})

	it('adds named units (unique names, a limit of twelve) and refuses a unit that cannot measure the item', async () => {
		const item = await newItem({
			name: 'Tomatoes',
			category: 'produce',
			baseUnit: 'g',
		})
		const box = await call('POST', `${BASE}/items/${item.id}/units`, {
			token: full,
			body: { name: 'Crate', baseQuantity: 6_000_000 },
		})
		expect(box.status).toBe(200)
		expect(box.body.units).toHaveLength(1)
		const dup = await call('POST', `${BASE}/items/${item.id}/units`, {
			token: full,
			body: { name: 'crate', baseQuantity: 5_000_000 },
		})
		expect(dup.status).toBe(409)
		expect(dup.body.code).toBe('name_taken')
		for (let i = 0; i < 11; i++) {
			const added = await call('POST', `${BASE}/items/${item.id}/units`, {
				token: full,
				body: { name: `Pack ${i}`, baseQuantity: 1000 + i },
			})
			expect(added.status, `unit ${i}`).toBe(200)
		}
		const over = await call('POST', `${BASE}/items/${item.id}/units`, {
			token: full,
			body: { name: 'One too many', baseQuantity: 99 },
		})
		expect(over.status).toBe(409)
		expect(over.body.code).toBe('limit_reached')

		const place = await call('PUT', `${BASE}/items/${item.id}/places/loc_a`, {
			token: full,
			body: {
				expectedVersion: 0,
				countUnit: 'l',
				areaIds: [],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			},
		})
		expect(place.status).toBe(400)
		expect(place.body.code).toBe('unit_mismatch')
	})

	it('sets a place with expectedVersion, validates areas and levels, and refuses an excluded location', async () => {
		const shelf = await area('Place shelf', 'loc_place')
		const other = await area('Other loc shelf', 'loc_other')
		const item = await newItem({
			name: 'Garlic',
			category: 'produce',
			baseUnit: 'g',
		})
		const path = `${BASE}/items/${item.id}/places/loc_place`
		const put = (body: Record<string, unknown>, token = full) =>
			call('PUT', path, { token, body })
		const base = {
			countUnit: 'kg',
			areaIds: [shelf.id],
			orderBelowQuantity: 1000,
			fillUpToQuantity: 5000,
		}
		const created = await put({ expectedVersion: 0, ...base })
		expect(created.status).toBe(200)
		expect(itemPlaceSchema.parse(created.body)).toMatchObject({
			locationId: 'loc_place',
			countUnit: 'kg',
			areaIds: [shelf.id],
			version: 1,
		})
		expect((await put({ expectedVersion: 0, ...base })).body.code).toBe(
			'stale_version',
		)
		expect(
			(await put({ expectedVersion: 1, ...base, areaIds: [other.id] })).status,
		).toBe(404)
		expect(
			(await put({ expectedVersion: 1, ...base, orderBelowQuantity: 9000 }))
				.status,
		).toBe(400)
		const moved = await put({ expectedVersion: 1, ...base, areaIds: [] })
		expect(moved.body).toMatchObject({ areaIds: [], version: 2 })

		const excluded = await call(
			'PUT',
			`${BASE}/items/${item.id}/places/loc_b`,
			{
				token: scoped,
				body: { expectedVersion: 0, ...base, areaIds: [] },
			},
		)
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
	})

	it('adjusts stock with a reason, replays a clientId, lists the history and hides cost from a cost-less token', async () => {
		const item = await newItem({
			name: 'Cumin',
			category: 'dry_goods',
			baseUnit: 'g',
		})
		const clientId = cid('adj')
		const body = {
			clientId,
			locationId: 'loc_a',
			quantity: 750_000,
			reason: 'found',
			note: 'Behind the shelf',
		}
		const first = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body,
		})
		expect(first.status).toBe(200)
		expect(adjustStockResultSchema.parse(first.body)).toMatchObject({
			quantity: 750_000,
			onHand: 750_000,
		})
		const replay = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body,
		})
		expect(replay.body).toMatchObject({ id: first.body.id, onHand: 750_000 })
		const clash = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body: { ...body, quantity: 1 },
		})
		expect(clash.status).toBe(409)
		const out = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body: {
				clientId: cid('adj'),
				locationId: 'loc_a',
				quantity: -250_000,
				reason: 'damaged',
			},
		})
		expect(out.body.onHand).toBe(500_000)
		const zero = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: full,
			body: {
				clientId: cid('adj'),
				locationId: 'loc_a',
				quantity: 0,
				reason: 'found',
			},
		})
		expect(zero.status).toBe(400)

		const history = await call(
			'GET',
			`${BASE}/items/${item.id}/movements?locationId=loc_a&limit=1`,
			{ token: noCost },
		)
		expect(history.status).toBe(200)
		const parsed = listMovementsResultSchema.parse(history.body)
		expect(parsed.movements).toHaveLength(1)
		expect(parsed.movements[0]).toMatchObject({
			kind: 'adjustment',
			quantity: -250_000,
			reason: 'damaged',
		})
		expect(parsed.nextCursor).not.toBeNull()
		const rest = await call(
			'GET',
			`${BASE}/items/${item.id}/movements?locationId=loc_a&cursor=${parsed.nextCursor}`,
			{ token: noCost },
		)
		expect(rest.body.movements).toHaveLength(1)
		expect(rest.body.movements[0].note).toBe('Behind the shelf')
		expect(JSON.stringify(rest.body)).not.toContain('valueMinor')

		const detail = await call(
			'GET',
			`${BASE}/items/${item.id}?locationId=loc_a`,
			{ token: noCost },
		)
		expect(detail.body).toMatchObject({ onHand: 500_000, hasMovements: true })
		expect(detail.body.cost).toBeUndefined()
		const other = await call(
			'GET',
			`${BASE}/items/${item.id}?locationId=loc_a`,
			{ token: tokenB },
		)
		expect(other.status).toBe(404)
		const excluded = await call('POST', `${BASE}/items/${item.id}/adjust`, {
			token: scoped,
			body: {
				clientId: cid('adj'),
				locationId: 'loc_b',
				quantity: 5,
				reason: 'found',
			},
		})
		expect(excluded.status).toBe(403)
		const detailExcluded = await call(
			'GET',
			`${BASE}/items/${item.id}?locationId=loc_b`,
			{ token: scoped },
		)
		expect(detailExcluded.status).toBe(403)
	})
})

describe('bulk create and large lists', () => {
	it('skips existing and repeated names, creates missing areas by name, and replays its clientId', async () => {
		await newItem({
			name: 'Existing flour',
			category: 'dry_goods',
			baseUnit: 'g',
		})
		const body = {
			clientId: cid('bulk'),
			locationId: 'loc_bulk',
			items: [
				{
					name: 'existing FLOUR',
					category: 'dry_goods',
					kind: 'bought',
					baseUnit: 'g',
				},
				{
					name: 'Bulk lemons',
					category: 'produce',
					kind: 'bought',
					baseUnit: 'piece',
					areaName: 'Produce rack',
				},
				{
					name: 'bulk Lemons',
					category: 'produce',
					kind: 'bought',
					baseUnit: 'piece',
				},
				{
					name: 'Bulk pitta',
					category: 'bakery',
					kind: 'bought',
					baseUnit: 'piece',
					areaName: 'produce RACK',
					costMicro: 250_000_000,
					currency: 'SAR',
				},
			],
		}
		const res = await call('POST', `${BASE}/items/bulk`, { token: full, body })
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		expect(
			res.body.created.map((entry: { name: string }) => entry.name),
		).toEqual(['Bulk lemons', 'Bulk pitta'])
		expect(res.body.skipped).toEqual([
			{ name: 'existing FLOUR', reason: 'exists' },
			{ name: 'bulk Lemons', reason: 'duplicate' },
		])
		expect(res.body.areasCreated).toBe(1)
		const replay = await call('POST', `${BASE}/items/bulk`, {
			token: full,
			body,
		})
		expect(replay.body).toEqual(res.body)
		const areas = await call(
			'GET',
			`${BASE}/storage-areas?locationId=loc_bulk`,
			{ token: full },
		)
		expect(areas.body.areas).toHaveLength(1)
		expect(areas.body.areas[0]).toMatchObject({
			name: 'Produce rack',
			itemCount: 2,
		})

		const detail = await call(
			'GET',
			`${BASE}/items/${res.body.created[1].id}?locationId=loc_bulk`,
			{ token: full },
		)
		expect(detail.body.cost).toMatchObject({
			avgCostMicro: 250_000_000,
			currency: 'SAR',
		})
		const tooMany = await call('POST', `${BASE}/items/bulk`, {
			token: full,
			body: {
				...body,
				clientId: cid('bulk'),
				items: Array.from({ length: 201 }, (_, i) => ({
					name: `n${i}`,
					category: 'meat',
					kind: 'bought',
					baseUnit: 'g',
				})),
			},
		})
		expect(tooMany.status).toBe(400)
	})

	it('handles more than 100 items in one request (chunked statements)', async () => {
		const items = Array.from({ length: 130 }, (_, i) => ({
			name: `Chunk item ${String(i).padStart(3, '0')}`,
			category: 'other',
			kind: 'bought',
			baseUnit: 'g',
			areaName: 'Chunk area',
		}))
		const bulk = await call('POST', `${BASE}/items/bulk`, {
			token: full,
			body: { clientId: cid('bulk'), locationId: 'loc_chunk', items },
		})
		expect(bulk.status, JSON.stringify(bulk.body)).toBe(200)
		expect(bulk.body.created).toHaveLength(130)
		const ids = bulk.body.created.map((entry: { id: string }) => entry.id)

		const list = await call('POST', `${BASE}/count-lists`, {
			token: full,
			body: {
				locationId: 'loc_chunk',
				name: 'Everything chunked',
				itemIds: ids,
			},
		})
		expect(list.status, JSON.stringify(list.body)).toBe(200)
		expect(list.body.itemIds).toHaveLength(130)
		const read = await call('GET', `${BASE}/count-lists?locationId=loc_chunk`, {
			token: full,
		})
		expect(
			listCountListsResultSchema.parse(read.body).lists[0]!.itemIds,
		).toEqual(ids)

		const areas = await call(
			'GET',
			`${BASE}/storage-areas?locationId=loc_chunk`,
			{ token: full },
		)
		const chunkArea = areas.body.areas[0]
		expect(chunkArea.itemCount).toBe(130)
		const reversed = [...ids].reverse()
		const order = await call(
			'PUT',
			`${BASE}/storage-areas/${chunkArea.id}/items`,
			{
				token: full,
				body: { itemIds: reversed },
			},
		)
		expect(order.status).toBe(200)
		const foreign = await call(
			'PUT',
			`${BASE}/storage-areas/${chunkArea.id}/items`,
			{
				token: full,
				body: { itemIds: ['no-such-item'] },
			},
		)
		expect(foreign.status).toBe(400)
	})
})

describe('count lists', () => {
	it('creates, updates (replacing items), archives, and refuses items that do not exist', async () => {
		const a = await newItem({ name: 'List a', category: 'meat', baseUnit: 'g' })
		const b = await newItem({ name: 'List b', category: 'meat', baseUnit: 'g' })
		const created = await call('POST', `${BASE}/count-lists`, {
			token: full,
			body: {
				locationId: 'loc_lists',
				name: 'Proteins daily',
				itemIds: [a.id, b.id],
			},
		})
		expect(created.status).toBe(200)
		expect(created.body.itemIds).toEqual([a.id, b.id])
		const dup = await call('POST', `${BASE}/count-lists`, {
			token: full,
			body: {
				locationId: 'loc_lists',
				name: 'proteins DAILY',
				itemIds: [a.id],
			},
		})
		expect(dup.status).toBe(409)
		expect(dup.body.code).toBe('name_taken')
		const missing = await call('POST', `${BASE}/count-lists`, {
			token: full,
			body: { locationId: 'loc_lists', name: 'Ghost', itemIds: ['ghost-item'] },
		})
		expect(missing.status).toBe(404)

		const updated = await call(
			'PATCH',
			`${BASE}/count-lists/${created.body.id}`,
			{
				token: full,
				body: { expectedVersion: 1, name: 'Proteins', itemIds: [b.id] },
			},
		)
		expect(updated.body).toMatchObject({
			name: 'Proteins',
			itemIds: [b.id],
			version: 2,
		})
		const stale = await call(
			'PATCH',
			`${BASE}/count-lists/${created.body.id}`,
			{
				token: full,
				body: { expectedVersion: 1, name: 'Late' },
			},
		)
		expect(stale.body.code).toBe('stale_version')
		const archived = await call(
			'POST',
			`${BASE}/count-lists/${created.body.id}/archive`,
			{
				token: full,
				body: { expectedVersion: 2 },
			},
		)
		expect(archived.status).toBe(200)
		const list = await call('GET', `${BASE}/count-lists?locationId=loc_lists`, {
			token: full,
		})
		expect(list.body.lists).toEqual([])
		const excluded = await call('POST', `${BASE}/count-lists`, {
			token: scoped,
			body: { locationId: 'loc_b', name: 'Nope', itemIds: [a.id] },
		})
		expect(excluded.status).toBe(403)
	})
})
