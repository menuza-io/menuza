import {
	bottlesAndWeightToMl,
	bottlesToMl,
	countLateEntriesResultSchema,
	countReviewSchema,
	countSheetSchema,
	countSummarySchema,
	openBottleMlFromWeight,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountDevices,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { seedInventoryContextForTest } from '../lib/inventory-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	setupTenantEnv,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * The count controls beside a count: the key-item second-person check (#525),
 * devices still counting and late entries (#474) and counting open bottles by
 * tenths or by weight (#470).
 */

const ORG = 'org_inv_ctrl'
const LOC = 'loc_ctrl'

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
let sara: string
let omar: string
let boss: string
let noCost: string

const world = { steak: '', rice: '', vodka: '', walkIn: '' }

async function ok(method: string, path: string, token: string, body?: unknown) {
	const res = await call(method, `${BASE}${path}`, { token, body })
	expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(200)
	return res.body
}

const entry = (
	itemId: string,
	amount: number | null,
	unit = 'kg',
	areaId: string | null = null,
) => ({ clientId: cid('e'), itemId, areaId, amount, unit })

async function startCount(token = sara) {
	return countSummarySchema.parse(
		await ok('POST', '/counts', token, {
			clientId: cid('count'),
			locationId: LOC,
			listId: null,
		}),
	)
}

async function onHand(itemId: string) {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(invMovements)
		.where(
			and(eq(invMovements.itemId, itemId), eq(invMovements.locationId, LOC)),
		)
	return rows.reduce((sum, row) => sum + row.quantity, 0)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-ctrl')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	seedInventoryContextForTest(ORG, {
		enabled: true,
		purchasing: false,
		recipes: false,
		prep: false,
		transfers: false,
	})
	sara = await mintToken(ORG, { subject: 'user_sara' })
	omar = await mintToken(ORG, { subject: 'user_omar' })
	boss = await mintToken(ORG, { subject: 'user_boss', canManageSettings: true })
	noCost = await mintToken(ORG, {
		subject: 'user_kitchen',
		grants: ['read:inventory:any', 'update:inventory:any'],
	})
	world.walkIn = (
		await ok('POST', '/storage-areas', sara, {
			locationId: LOC,
			name: 'Walk-in',
		})
	).id
	const make = async (
		name: string,
		baseUnit: 'g' | 'ml',
		extra: Record<string, unknown> = {},
	) =>
		await ok('POST', '/items', sara, {
			clientId: cid('item'),
			name,
			category: 'other',
			kind: 'bought',
			baseUnit,
			place: {
				locationId: LOC,
				countUnit: baseUnit === 'g' ? 'kg' : 'l',
				areaIds: [world.walkIn],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			},
			...extra,
		})
	world.steak = (await make('Ctrl steak', 'g', { isKey: true })).id
	world.rice = (await make('Ctrl rice', 'g')).id
	for (const [itemId, quantity] of [
		[world.steak, 10_000_000],
		[world.rice, 20_000_000],
	] as const) {
		await ok('POST', '/deliveries', sara, {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [{ itemId, quantity, lineTotalMinor: quantity / 1000 }],
		})
	}
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('second person checks key items (#525)', () => {
	it('is a manager setting of the location', async () => {
		const settings = await ok('GET', '/settings', sara)
		const location = settings.locations.find(
			(entry: { locationId: string }) => entry.locationId === LOC,
		)
		const body = {
			expectedVersion: location.version,
			secondCountRequired: true,
		}
		const denied = await call(
			'PUT',
			`${BASE}/settings/locations/${LOC}/count-controls`,
			{ token: sara, body },
		)
		expect(denied.status).toBe(403)
		const saved = await ok(
			'PUT',
			`/settings/locations/${LOC}/count-controls`,
			boss,
			body,
		)
		expect(saved.secondCountRequired).toBe(true)
	})

	it('makes the count wait for a second person, who cannot be the first', async () => {
		const count = await startCount(sara)
		await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [
				entry(world.steak, 8, 'kg', world.walkIn),
				entry(world.rice, 20, 'kg', world.walkIn),
			],
		})
		const sent = await ok('POST', `/counts/${count.id}/send`, sara, {
			expectedVersion: count.version,
		})
		// With the setting on, a count waits for a second person.
		expect(sent).toMatchObject({ status: 'counting', secondState: 'waiting' })
		const early = await call('POST', `${BASE}/counts/${count.id}/approve`, {
			token: sara,
			body: { expectedVersion: sent.version },
		})
		expect(early.status).toBe(409)

		// The same person cannot be the second counter, and the first count is closed.
		const same = await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.steak, 8, 'kg', world.walkIn)],
		})
		expect(same.refused).toEqual([
			{ clientId: expect.any(String), code: 'second_count_same_person' },
		])
		expect(same.accepted).toEqual([])

		// Omar sees only key items, blind.
		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${count.id}`, omar),
		)
		expect(sheet.pass).toBe(2)
		expect(sheet.areas.flatMap((a) => a.items.map((i) => i.name))).toEqual([
			'Ctrl steak',
		])
		expect(sheet.areas[0]!.items[0]!.quantity).toBeNull()
		const sarasSheet = countSheetSchema.parse(
			await ok('GET', `/counts/${count.id}`, sara),
		)
		expect(sarasSheet.pass).toBe(1)

		const second = await ok('POST', `/counts/${count.id}/entries`, omar, {
			entries: [
				entry(world.steak, 7, 'kg', world.walkIn),
				entry(world.rice, 5, 'kg', world.walkIn),
			],
		})
		expect(second.accepted).toHaveLength(1)
		expect(second.refused).toEqual([
			{ clientId: expect.any(String), code: 'second_count_not_key_item' },
		])

		// Finishing compares the two counts side by side.
		const waiting = await ok('GET', `/counts/${count.id}`, sara)
		const finished = await ok(
			'POST',
			`/counts/${count.id}/second/finish`,
			omar,
			{
				expectedVersion: waiting.count.version,
			},
		)
		expect(finished).toMatchObject({
			status: 'counting',
			secondState: 'settling',
		})
		const check = await ok('GET', `/counts/${count.id}/second`, sara)
		expect(check.lines).toEqual([
			expect.objectContaining({
				name: 'Ctrl steak',
				firstQuantity: 8_000_000,
				secondQuantity: 7_000_000,
				resolution: null,
			}),
		])

		// Settled before review: the second figure stands.
		const settled = await ok(
			'POST',
			`/counts/${count.id}/second/settle`,
			sara,
			{
				expectedVersion: finished.version,
				resolutions: { [world.steak]: 'second' },
			},
		)
		expect(settled).toMatchObject({ status: 'in_review', secondState: 'done' })
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${count.id}/review`, sara),
		)
		expect(review.second?.lines[0]).toMatchObject({ resolution: 'second' })
		await ok('POST', `/counts/${count.id}/approve`, sara, {
			expectedVersion: settled.version,
		})
		// The second figure (7 kg) was posted, not the first (8 kg).
		expect(await onHand(world.steak)).toBe(7_000_000)
		expect(await onHand(world.rice)).toBe(20_000_000)
	})

	it('goes straight to review when the two counts agree', async () => {
		const count = await startCount(sara)
		await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.steak, 7, 'kg', world.walkIn)],
		})
		const sent = await ok('POST', `/counts/${count.id}/send`, sara, {
			expectedVersion: count.version,
		})
		await ok('POST', `/counts/${count.id}/entries`, omar, {
			entries: [entry(world.steak, 7, 'kg', world.walkIn)],
		})
		const finished = await ok(
			'POST',
			`/counts/${count.id}/second/finish`,
			omar,
			{
				expectedVersion: sent.version,
			},
		)
		expect(finished).toMatchObject({ status: 'in_review', secondState: 'done' })
		await ok('POST', `/counts/${count.id}/cancel`, sara, {
			expectedVersion: finished.version,
		})
	})

	it('lets a manager skip it with a reason, recorded', async () => {
		const count = await startCount(sara)
		await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.steak, 7, 'kg', world.walkIn)],
		})
		const sent = await ok('POST', `/counts/${count.id}/send`, sara, {
			expectedVersion: count.version,
		})
		const body = { expectedVersion: sent.version, reason: 'Nobody else is in' }
		expect(
			(
				await call('POST', `${BASE}/counts/${count.id}/second/skip`, {
					token: sara,
					body,
				})
			).status,
		).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/counts/${count.id}/second/skip`, {
					token: boss,
					body: { ...body, reason: 'x' },
				})
			).status,
		).toBe(400)
		const skipped = await ok(
			'POST',
			`/counts/${count.id}/second/skip`,
			boss,
			body,
		)
		expect(skipped).toMatchObject({
			status: 'in_review',
			secondState: 'skipped',
		})
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${count.id}/review`, sara),
		)
		expect(review.second?.skipReason).toBe('Nobody else is in')
		await ok('POST', `/counts/${count.id}/cancel`, sara, {
			expectedVersion: skipped.version,
		})
	})

	it('turns off again', async () => {
		const settings = await ok('GET', '/settings', sara)
		const location = settings.locations.find(
			(entry: { locationId: string }) => entry.locationId === LOC,
		)
		const off = await ok(
			'PUT',
			`/settings/locations/${LOC}/count-controls`,
			boss,
			{ expectedVersion: location.version, secondCountRequired: false },
		)
		expect(off.secondCountRequired).toBe(false)
	})
})

describe('devices still counting and late entries (#474)', () => {
	let countId = ''

	it('shows devices with unsent entries and asks before approving anyway', async () => {
		const count = await startCount(sara)
		countId = count.id
		await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.steak, 6, 'kg', world.walkIn)],
			device: { id: 'tablet-kitchen-1', name: 'Kitchen iPad', unsent: 3 },
		})
		const sent = await ok('POST', `/counts/${count.id}/send`, sara, {
			expectedVersion: count.version,
		})
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${count.id}/review`, sara),
		)
		expect(review.devices).toEqual([
			expect.objectContaining({
				deviceId: 'tablet-kitchen-1',
				name: 'Kitchen iPad',
				unsentCount: 3,
				state: 'counting',
				person: { kind: 'operator', id: 'user_sara' },
			}),
		])
		expect(review.count.devicesCounting).toBe(1)

		const refused = await call('POST', `${BASE}/counts/${count.id}/approve`, {
			token: sara,
			body: { expectedVersion: sent.version },
		})
		expect(refused.status).toBe(409)
		expect(refused.body).toMatchObject({
			code: 'devices_still_counting',
			devices: [{ deviceId: 'tablet-kitchen-1', unsentCount: 3 }],
		})

		// A device silent for two hours is not responding.
		const db = await getTenantDb(ORG)
		await db
			.update(invCountDevices)
			.set({ lastSyncAt: Date.now() - 3 * 60 * 60 * 1000 })
			.where(eq(invCountDevices.countId, count.id))
		const stale = countReviewSchema.parse(
			await ok('GET', `/counts/${count.id}/review`, sara),
		)
		expect(stale.devices?.[0]?.state).toBe('not_responding')

		await ok('POST', `/counts/${count.id}/approve`, sara, {
			expectedVersion: sent.version,
			approveAnyway: true,
		})
		expect(await onHand(world.steak)).toBe(6_000_000)
	})

	it('keeps entries that arrive after approval as late entries and adds one to a correction in a tap', async () => {
		const clientIds = [cid('late'), cid('late')]
		const late = await call('POST', `${BASE}/counts/${countId}/entries`, {
			token: omar,
			body: {
				entries: [
					{
						clientId: clientIds[0],
						itemId: world.rice,
						areaId: world.walkIn,
						amount: 19,
						unit: 'kg',
					},
					{
						clientId: clientIds[1],
						itemId: world.steak,
						areaId: world.walkIn,
						amount: 1,
						unit: 'kg',
					},
				],
				device: { id: 'tablet-bar-2', unsent: 0 },
			},
		})
		expect(late.status, JSON.stringify(late.body)).toBe(200)
		expect(late.body.late).toEqual(clientIds)
		expect(late.body.refused).toEqual([])
		expect(late.body.accepted).toHaveLength(2)
		// Not lost, not merged: stock is as approved.
		expect(await onHand(world.rice)).toBe(20_000_000)

		// Replays keep their first result.
		const replay = await ok('POST', `/counts/${countId}/entries`, omar, {
			entries: [
				{
					clientId: clientIds[0],
					itemId: world.rice,
					areaId: world.walkIn,
					amount: 19,
					unit: 'kg',
				},
			],
		})
		expect(replay.duplicates).toEqual([clientIds[0]])

		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${countId}`, sara),
		)
		expect(sheet.count.lateEntries).toBe(2)
		const listed = countLateEntriesResultSchema.parse(
			await ok('GET', `/counts/${countId}/late-entries`, sara),
		)
		const rice = listed.entries.find((e) => e.itemName === 'Ctrl rice')!
		const steak = listed.entries.find((e) => e.itemName === 'Ctrl steak')!
		expect(rice).toMatchObject({ status: 'open', adjustment: -1_000_000 })
		// Steak was counted in the approved count: this is one more shelf on top.
		expect(steak).toMatchObject({ status: 'open', adjustment: 1_000_000 })

		const needsCost = await call(
			'POST',
			`${BASE}/counts/${countId}/late-entries/${rice.id}/apply`,
			{ token: noCost, body: { clientId: cid('res') } },
		)
		expect(needsCost.status).toBe(403)
		const applied = await ok(
			'POST',
			`/counts/${countId}/late-entries/${rice.id}/apply`,
			sara,
			{ clientId: cid('res') },
		)
		expect(applied).toMatchObject({
			adjustment: -1_000_000,
			entry: { status: 'applied' },
		})
		expect(await onHand(world.rice)).toBe(19_000_000)
		const db = await getTenantDb(ORG)
		const move = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, rice.id))
			.get()
		expect(move).toMatchObject({ kind: 'adjustment', reason: 'correction' })

		const again = await call(
			'POST',
			`${BASE}/counts/${countId}/late-entries/${rice.id}/apply`,
			{ token: sara, body: { clientId: cid('res') } },
		)
		expect(again.status).toBe(409)
		await ok(
			'POST',
			`/counts/${countId}/late-entries/${steak.id}/dismiss`,
			sara,
			{ clientId: cid('res') },
		)
		expect(await onHand(world.steak)).toBe(6_000_000)
		const after = countSheetSchema.parse(
			await ok('GET', `/counts/${countId}`, sara),
		)
		expect(after.count.lateEntries).toBe(0)
	})

	it('stops warning about a device once it says it is done', async () => {
		const count = await startCount(sara)
		await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.steak, 6, 'kg', world.walkIn)],
			device: { id: 'tablet-kitchen-1', unsent: 2 },
		})
		await ok('POST', `/counts/${count.id}/presence`, sara, {
			device: { id: 'tablet-kitchen-1', unsent: 0, done: true },
		})
		const sent = await ok('POST', `/counts/${count.id}/send`, sara, {
			expectedVersion: count.version,
		})
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${count.id}/review`, sara),
		)
		expect(review.devices?.[0]).toMatchObject({ state: 'done', unsentCount: 0 })
		await ok('POST', `/counts/${count.id}/approve`, sara, {
			expectedVersion: sent.version,
		})
	})
})

describe('counting open bottles by tenths or by weight (#470)', () => {
	const spec = { sizeMl: 700, fullWeightG: 1300, emptyWeightG: 500 }

	it('stores the bottle on a millilitre item only', async () => {
		const vodka = await ok('POST', '/items', sara, {
			clientId: cid('item'),
			name: 'Ctrl vodka',
			category: 'drinks',
			kind: 'bought',
			baseUnit: 'ml',
			bottle: spec,
			place: {
				locationId: LOC,
				countUnit: 'ml',
				areaIds: [world.walkIn],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			},
		})
		world.vodka = vodka.id
		expect(vodka.bottle).toEqual(spec)

		const grams = await call('POST', `${BASE}/items`, {
			token: sara,
			body: {
				clientId: cid('item'),
				name: 'Ctrl bad bottle',
				category: 'other',
				kind: 'bought',
				baseUnit: 'g',
				bottle: spec,
			},
		})
		expect(grams.status).toBe(400)
		const lopsided = await call('PATCH', `${BASE}/items/${world.vodka}`, {
			token: sara,
			body: {
				expectedVersion: vodka.version,
				bottle: { sizeMl: 700, fullWeightG: 1300, emptyWeightG: null },
			},
		})
		expect(lopsided.status).toBe(400)
		const heavier = await call('PATCH', `${BASE}/items/${world.vodka}`, {
			token: sara,
			body: {
				expectedVersion: vodka.version,
				bottle: { sizeMl: 700, fullWeightG: 500, emptyWeightG: 700 },
			},
		})
		expect(heavier.status).toBe(400)
		await ok('POST', '/items/' + world.vodka + '/adjust', sara, {
			clientId: cid('adj'),
			locationId: LOC,
			quantity: 5_000_000,
			reason: 'found',
		})
	})

	it('records 3 full bottles and one at 0.4 as 3.4 bottles in millilitres', async () => {
		const ml = bottlesToMl(spec, 3, 4)
		expect(ml).toBe(2380)
		const count = await startCount(sara)
		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${count.id}`, sara),
		)
		const item = sheet.areas
			.flatMap((a) => a.items)
			.find((i) => i.name === 'Ctrl vodka')!
		expect(item.bottle).toEqual(spec)
		const result = await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.vodka, ml, 'ml', world.walkIn)],
		})
		expect(result.accepted[0].quantity).toBe(2_380_000)
		await ok('POST', `/counts/${count.id}/cancel`, sara, {
			expectedVersion: count.version,
		})
	})

	it('turns a typed weight of the open bottle into millilitres from the full and empty weights', async () => {
		// 700 g on the scale: (700 - 500) / (1300 - 500) = a quarter of 700 ml.
		expect(openBottleMlFromWeight(spec, 700)).toBe(175)
		const total = bottlesAndWeightToMl(spec, 3, 700)
		expect(total).toBe(2275)
		const count = await startCount(sara)
		const result = await ok('POST', `/counts/${count.id}/entries`, sara, {
			entries: [entry(world.vodka, total, 'ml', world.walkIn)],
		})
		expect(result.accepted[0].quantity).toBe(2_275_000)
		await ok('POST', `/counts/${count.id}/cancel`, sara, {
			expectedVersion: count.version,
		})
	})

	it('stops counting by bottle when the spec is removed', async () => {
		const detail = await ok(
			'GET',
			`/items/${world.vodka}?locationId=${LOC}`,
			sara,
		)
		const cleared = await ok(
			'PATCH',
			`/items/${world.vodka}?locationId=${LOC}`,
			sara,
			{
				expectedVersion: detail.version,
				bottle: null,
			},
		)
		expect(cleared.bottle).toBeNull()
	})
})
