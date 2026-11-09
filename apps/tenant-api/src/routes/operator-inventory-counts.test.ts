import {
	approveCountResultSchema,
	countEntriesResultSchema,
	countReviewSchema,
	countSheetSchema,
	countSummarySchema,
	listCountsResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invAuditLog,
	invCountEntries,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	ALL_GRANTS,
	BASE,
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Counts end to end: start (one open count per list), the counting sheet,
 * entries from several people, review, approve (adjustments, uncounted keep
 * or zero, notes, food cost) and the rules around closed counts.
 */

const ORG = 'org_inv_cnt_a'
const ORG_B = 'org_inv_cnt_b'
const LOC = 'loc_cnt'

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
let noCost: string
let readOnly: string
let tokenB: string
let scoped: string

beforeAll(async () => {
	env = setupTenantEnv('inv-cnt')
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
	sara = await mintToken(ORG, { subject: 'user_sara' })
	omar = await mintToken(ORG, { subject: 'user_omar' })
	noCost = await mintToken(ORG, {
		grants: [READ, UPDATE],
		subject: 'user_kitchen',
	})
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: ['loc_elsewhere'] })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function ok(method: string, path: string, token: string, body?: unknown) {
	const res = await call(method, `${BASE}${path}`, { token, body })
	expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(200)
	return res.body
}

const world = {
	walkIn: '',
	dry: '',
	chicken: '',
	rice: '',
	milk: '',
	flour: '',
	carton: '',
	count: '',
	version: 1,
}

describe('counts: setup', () => {
	it('sets up areas, items with places, stock and a known cost', async () => {
		world.walkIn = (
			await ok('POST', '/storage-areas', sara, {
				locationId: LOC,
				name: 'Walk-in',
			})
		).id
		world.dry = (
			await ok('POST', '/storage-areas', sara, {
				locationId: LOC,
				name: 'Dry store',
			})
		).id
		const make = async (
			name: string,
			baseUnit: string,
			countUnit: string,
			areaIds: string[],
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
					countUnit,
					areaIds,
					orderBelowQuantity: null,
					fillUpToQuantity: null,
				},
				...extra,
			})
		world.chicken = (await make('Count chicken', 'g', 'kg', [world.walkIn])).id
		world.rice = (await make('Count rice', 'g', 'kg', [world.dry])).id
		world.flour = (await make('Count flour', 'g', 'kg', [world.dry])).id
		const milk = await make('Count milk', 'ml', 'new:0', [], {
			units: [{ name: 'Carton', baseQuantity: 3_000_000 }],
		})
		world.milk = milk.id
		world.carton = `unit:${milk.units[0].id}`

		// Chicken arrives with a cost (10 kg for 280.00); the rest by adjustment.
		await ok('POST', '/deliveries', sara, {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [
				{ itemId: world.chicken, quantity: 10_000_000, lineTotalMinor: 28000 },
			],
		})
		for (const [itemId, quantity] of [
			[world.rice, 20_000_000],
			[world.flour, 5_000_000],
			[world.milk, 6_000_000],
		] as const) {
			await ok('POST', `/items/${itemId}/adjust`, sara, {
				clientId: cid('adj'),
				locationId: LOC,
				quantity,
				reason: 'found',
			})
		}
	})
})

describe('counts: starting and the sheet', () => {
	it('starts a count, replays its clientId, and allows one open count per list', async () => {
		const body = { clientId: cid('count'), locationId: LOC, listId: null }
		const started = await call('POST', `${BASE}/counts`, { token: sara, body })
		expect(started.status, JSON.stringify(started.body)).toBe(200)
		const summary = countSummarySchema.parse(started.body)
		expect(summary).toMatchObject({
			status: 'counting',
			locationId: LOC,
			listId: null,
			startedBy: { kind: 'operator', id: 'user_sara' },
			itemTotal: 4,
			itemsCounted: 0,
			counters: [],
			version: 1,
		})
		world.count = summary.id
		const replay = await call('POST', `${BASE}/counts`, { token: sara, body })
		expect(replay.body.id).toBe(summary.id)
		const second = await call('POST', `${BASE}/counts`, {
			token: omar,
			body: { clientId: cid('count'), locationId: LOC, listId: null },
		})
		expect(second.status).toBe(409)
		expect(second.body).toMatchObject({
			code: 'count_in_progress',
			countId: summary.id,
		})
		const noList = await call('POST', `${BASE}/counts`, {
			token: sara,
			body: { clientId: cid('count'), locationId: LOC, listId: 'ghost-list' },
		})
		expect(noList.status).toBe(404)
		expect(
			(
				await call('POST', `${BASE}/counts`, {
					token: scoped,
					body: { clientId: cid('count'), locationId: LOC, listId: null },
				})
			).status,
		).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/counts`, {
					token: readOnly,
					body: { clientId: cid('count'), locationId: LOC, listId: null },
				})
			).status,
		).toBe(403)
	})

	it('answers the sheet in walking order, never with expected figures, and only to the right organization and location', async () => {
		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${world.count}`, sara),
		)
		expect(sheet.areas.map((entry) => entry.name)).toEqual([
			'Walk-in',
			'Dry store',
			null,
		])
		expect(sheet.areas[0]!.items.map((item) => item.name)).toEqual([
			'Count chicken',
		])
		// Shelf order: rice was put on the shelf first.
		expect(sheet.areas[1]!.items.map((item) => item.name)).toEqual([
			'Count rice',
			'Count flour',
		])
		expect(sheet.areas[2]!.areaId).toBeNull()
		const milk = sheet.areas[2]!.items[0]!
		expect(milk).toMatchObject({
			name: 'Count milk',
			quantity: null,
			mine: null,
		})
		expect(milk.countUnit).toBe(world.carton)
		expect(JSON.stringify(sheet)).not.toMatch(/expected|onHand/)
		expect(
			(await call('GET', `${BASE}/counts/${world.count}`, { token: tokenB }))
				.status,
		).toBe(404)
		const excluded = await call('GET', `${BASE}/counts/${world.count}`, {
			token: scoped,
		})
		expect(excluded.status).toBe(403)
		expect(excluded.body.code).toBe('location_forbidden')
		expect(
			(await call('GET', `${BASE}/counts/not%20an%20id`, { token: sara }))
				.status,
		).toBe(404)
	})
})

describe('counts: entries', () => {
	const entry = (
		itemId: string,
		areaId: string | null,
		amount: number | null,
		unit: string,
		clientId = cid('e'),
	) => ({
		clientId,
		itemId,
		areaId,
		amount,
		unit,
	})
	const post = (token: string, entries: unknown[]) =>
		call('POST', `${BASE}/counts/${world.count}/entries`, {
			token,
			body: { entries },
		})

	it('takes entries from several people: the latest per counter wins, counters add up, null clears', async () => {
		const dupId = cid('dup')
		const a = await post(sara, [
			entry(world.chicken, world.walkIn, 4, 'kg', dupId),
			entry(world.rice, world.dry, 10, 'kg'),
			entry(world.milk, null, 2, world.carton),
		])
		expect(a.status, JSON.stringify(a.body)).toBe(200)
		const parsed = countEntriesResultSchema.parse(a.body)
		expect(parsed.accepted.map((e) => e.quantity)).toEqual([
			4_000_000, 10_000_000, 6_000_000,
		])
		expect(parsed.refused).toEqual([])

		// Omar adds 3 kg of chicken in the same area; rice in a second area.
		await post(omar, [
			entry(world.chicken, world.walkIn, 3, 'kg'),
			entry(world.rice, world.walkIn, 2, 'kg'),
		])
		const sheet = async (token: string) =>
			countSheetSchema.parse(await ok('GET', `/counts/${world.count}`, token))
		const find = (
			s: Awaited<ReturnType<typeof sheet>>,
			areaId: string | null,
			name: string,
		) =>
			s.areas
				.find((x) => x.areaId === areaId)
				?.items.find((x) => x.name === name)
		let view = await sheet(sara)
		expect(find(view, world.walkIn, 'Count chicken')).toMatchObject({
			quantity: 7_000_000,
			mine: { amount: 4, unit: 'kg' },
		})
		expect(view.count.counters.map((c) => c.id)).toEqual([
			'user_sara',
			'user_omar',
		])
		expect(view.count.itemsCounted).toBe(3)

		// Sara corrects hers: her latest entry replaces her earlier one (5 + 3).
		await post(sara, [entry(world.chicken, world.walkIn, 5, 'kg')])
		view = await sheet(sara)
		expect(find(view, world.walkIn, 'Count chicken')!.quantity).toBe(8_000_000)
		// Omar clears his: 5 kg stays.
		const cleared = await post(omar, [
			entry(world.chicken, world.walkIn, null, 'kg'),
		])
		expect(cleared.body.accepted[0].quantity).toBeNull()
		view = await sheet(omar)
		expect(find(view, world.walkIn, 'Count chicken')).toMatchObject({
			quantity: 5_000_000,
			mine: null,
		})
		// Omar clearing again with nothing else left would read as not counted.
		expect(view.count.itemsCounted).toBe(3)

		// Replaying a clientId is reported, not stored twice.
		const replay = await post(sara, [
			entry(world.chicken, world.walkIn, 99, 'kg', dupId),
		])
		expect(countEntriesResultSchema.parse(replay.body)).toMatchObject({
			accepted: [],
			duplicates: [dupId],
		})
		const db = await getTenantDb(ORG)
		const stored = await db
			.select()
			.from(invCountEntries)
			.where(eq(invCountEntries.clientId, dupId))
		expect(stored).toHaveLength(1)

		// "2 boxes and 3 kg" are two live entries for one item.
		await post(sara, [entry(world.milk, null, 1.5, 'l')])
		view = await sheet(sara)
		expect(find(view, null, 'Count milk')!.quantity).toBe(7_500_000)
	})

	it('refuses entries one by one with a code, and never stores them', async () => {
		const res = await post(sara, [
			entry(world.chicken, world.walkIn, 1, 'l'),
			entry('ghost-item', null, 1, 'kg'),
			entry(world.chicken, 'ghost-area', 1, 'kg'),
			entry(world.chicken, world.walkIn, 1, 'unit:not-a-unit'),
			entry(world.flour, world.dry, 1000, 'kg'),
		])
		expect(res.status).toBe(200)
		expect(res.body.accepted).toHaveLength(1)
		expect(res.body.refused.map((r: { code: string }) => r.code)).toEqual([
			'unit_mismatch',
			'not_found',
			'not_found',
			'unit_mismatch',
		])
		// The last one (1,000 kg) was fine and is cleared again so flour stays uncounted.
		await post(sara, [entry(world.flour, world.dry, null, 'kg')])
		const bad = await call('POST', `${BASE}/counts/${world.count}/entries`, {
			token: sara,
			body: {
				entries: Array.from({ length: 201 }, () =>
					entry(world.flour, world.dry, 1, 'kg'),
				),
			},
		})
		expect(bad.status).toBe(400)
		expect(
			(
				await call('POST', `${BASE}/counts/${world.count}/entries`, {
					token: readOnly,
					body: { entries: [entry(world.flour, world.dry, 1, 'kg')] },
				})
			).status,
		).toBe(403)
		expect(
			(await post(scoped, [entry(world.flour, world.dry, 1, 'kg')])).status,
		).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/counts/${world.count}/entries`, {
					token: tokenB,
					body: { entries: [entry(world.flour, world.dry, 1, 'kg')] },
				})
			).status,
		).toBe(404)
	})

	it('accepts more than 100 entries in one request', async () => {
		const many = Array.from({ length: 150 }, (_, i) =>
			entry(world.rice, world.dry, 10 + (i % 2) * 0, 'kg'),
		)
		const res = await post(omar, many)
		expect(res.status).toBe(200)
		expect(res.body.accepted).toHaveLength(150)
		// Omar's latest rice entry is 10 kg in Dry store; clear it so the totals below stay simple.
		await post(omar, [entry(world.rice, world.dry, null, 'kg')])
	})
})

describe('counts: review and approve', () => {
	it('sends for review, refuses more entries, and can reopen', async () => {
		const sent = await call('POST', `${BASE}/counts/${world.count}/send`, {
			token: sara,
			body: { expectedVersion: 1 },
		})
		expect(sent.status).toBe(200)
		expect(countSummarySchema.parse(sent.body)).toMatchObject({
			status: 'in_review',
			version: 2,
		})
		expect(sent.body.sentForReviewAt).toEqual(expect.any(Number))
		const late = await call('POST', `${BASE}/counts/${world.count}/entries`, {
			token: sara,
			body: {
				entries: [
					{
						clientId: cid('e'),
						itemId: world.rice,
						areaId: world.dry,
						amount: 1,
						unit: 'kg',
					},
				],
			},
		})
		expect(late.status).toBe(200)
		expect(late.body.refused[0].code).toBe('count_closed')
		expect(
			(
				await call('POST', `${BASE}/counts/${world.count}/send`, {
					token: sara,
					body: { expectedVersion: 2 },
				})
			).status,
		).toBe(409)
		const reopened = await call(
			'POST',
			`${BASE}/counts/${world.count}/reopen`,
			{ token: sara, body: { expectedVersion: 2 } },
		)
		expect(reopened.body).toMatchObject({
			status: 'counting',
			sentForReviewAt: null,
			version: 3,
		})
		const stale = await call('POST', `${BASE}/counts/${world.count}/send`, {
			token: sara,
			body: { expectedVersion: 2 },
		})
		expect(stale.body.code).toBe('stale_version')
		await ok('POST', `/counts/${world.count}/send`, sara, {
			expectedVersion: 3,
		})
		world.version = 4
	})

	it('lists only what needs a look, with money for the cost grant only', async () => {
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${world.count}/review`, sara),
		)
		// chicken 5 kg vs 10 expected; rice 12 kg vs 20 expected; milk 7.5 L vs 6 expected (25%, value unknown)
		expect(review.lines.map((line) => [line.name, line.flag])).toEqual([
			['Count chicken', 'big_difference'],
			['Count rice', 'big_difference'],
			['Count milk', 'big_difference'],
			['Count flour', 'not_counted'],
		])
		const chicken = review.lines[0]!
		expect(chicken).toMatchObject({
			counted: 5_000_000,
			expected: 10_000_000,
			difference: -5_000_000,
			differenceValueMinor: -14000,
			currency: 'SAR',
		})
		// What moved the item since the last approved count (none yet), so the
		// expected figure explains itself.
		expect(chicken.movements).toMatchObject({ since: null })
		expect(
			(chicken.movements!.delivered ?? 0) + (chicken.movements!.adjusted ?? 0),
		).toBeGreaterThan(0)
		expect(review.lines[3]).toMatchObject({ counted: null, difference: null })
		expect(review).toMatchObject({
			matching: 0,
			notCounted: 1,
			differenceValueMinor: -14000,
		})

		const lean = await call('GET', `${BASE}/counts/${world.count}/review`, {
			token: noCost,
		})
		expect(lean.status).toBe(200)
		const text = JSON.stringify(lean.body)
		expect(text).not.toContain('ValueMinor')
		expect(text).not.toContain('currency')
		expect(lean.body.lines).toHaveLength(4)
		expect(
			(
				await call('GET', `${BASE}/counts/${world.count}/review`, {
					token: tokenB,
				})
			).status,
		).toBe(404)
		expect(
			(
				await call('GET', `${BASE}/counts/${world.count}/review`, {
					token: scoped,
				})
			).status,
		).toBe(403)
	})

	it('the list shows the pending difference to the cost grant and not to others', async () => {
		const withCost = listCountsResultSchema.parse(
			await ok('GET', `/counts?locationId=${LOC}&status=open`, sara),
		)
		expect(withCost.counts).toHaveLength(1)
		expect(withCost.counts[0]).toMatchObject({
			status: 'in_review',
			differenceValueMinor: -14000,
			itemTotal: 4,
			itemsCounted: 3,
		})
		const lean = await ok('GET', `/counts?locationId=${LOC}`, noCost)
		expect(JSON.stringify(lean)).not.toContain('differenceValueMinor')
	})

	it('needs the cost grant to approve, then posts adjustments, handles uncounted and notes, and closes for good', async () => {
		const denied = await call('POST', `${BASE}/counts/${world.count}/approve`, {
			token: noCost,
			body: { expectedVersion: world.version },
		})
		expect(denied.status).toBe(403)
		expect(denied.body).toMatchObject({ code: 'forbidden', reason: 'grant' })
		const stale = await call('POST', `${BASE}/counts/${world.count}/approve`, {
			token: sara,
			body: { expectedVersion: 1 },
		})
		expect(stale.body.code).toBe('stale_version')
		const strict = await call('POST', `${BASE}/counts/${world.count}/approve`, {
			token: sara,
			body: { expectedVersion: world.version, extra: true },
		})
		expect(strict.status).toBe(400)

		const res = await call('POST', `${BASE}/counts/${world.count}/approve`, {
			token: sara,
			body: {
				expectedVersion: world.version,
				uncounted: { [world.flour]: 'zero' },
				notes: { [world.chicken]: 'Two bags went to the event' },
			},
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const result = approveCountResultSchema.parse(res.body)
		expect(result.count).toMatchObject({
			status: 'approved',
			approvedBy: { id: 'user_sara' },
		})
		expect(result.adjustedItems).toBe(4)
		expect(result.differenceValueMinor).toBe(-14000)
		expect(result.foodCost).toMatchObject({
			state: 'need_two_counts',
			from: null,
			to: null,
			targetBp: 3000,
		})

		// Counted figures are now on hand; flour went to zero; milk counted 7.5 L.
		const onHand = async (itemId: string) =>
			(await ok('GET', `/items/${itemId}?locationId=${LOC}`, sara)).onHand
		expect(await onHand(world.chicken)).toBe(5_000_000)
		expect(await onHand(world.rice)).toBe(12_000_000)
		expect(await onHand(world.flour)).toBe(0)
		expect(await onHand(world.milk)).toBe(7_500_000)
		const history = await ok(
			'GET',
			`/items/${world.chicken}/movements?locationId=${LOC}`,
			sara,
		)
		expect(history.movements[0]).toMatchObject({
			kind: 'count',
			quantity: -5_000_000,
			valueMinor: -14000,
			note: 'Two bags went to the event',
			sourceType: 'count',
			sourceId: world.count,
		})
		const db = await getTenantDb(ORG)
		const audits = await db
			.select()
			.from(invAuditLog)
			.where(eq(invAuditLog.resourceId, world.count))
		expect(audits.map((row) => row.action)).toEqual(
			expect.arrayContaining(['count.start', 'count.send', 'count.approve']),
		)
		const approved = countSummarySchema.parse(
			(await ok('GET', `/counts?locationId=${LOC}&status=closed`, sara))
				.counts[0],
		)
		expect(approved).toMatchObject({
			status: 'approved',
			differenceValueMinor: -14000,
			itemsCounted: 3,
		})

		// Closed for good.
		for (const action of ['send', 'reopen', 'cancel']) {
			const closed = await call(
				'POST',
				`${BASE}/counts/${world.count}/${action}`,
				{ token: sara, body: { expectedVersion: world.version + 1 } },
			)
			expect(closed.status, action).toBe(409)
			expect(closed.body.code).toBe('count_closed')
		}
		const again = await call('POST', `${BASE}/counts/${world.count}/approve`, {
			token: sara,
			body: { expectedVersion: world.version + 1 },
		})
		expect(again.body.code).toBe('count_closed')
		const entries = await call(
			'POST',
			`${BASE}/counts/${world.count}/entries`,
			{
				token: sara,
				body: {
					entries: [
						{
							clientId: cid('e'),
							itemId: world.rice,
							areaId: null,
							amount: 1,
							unit: 'kg',
						},
					],
				},
			},
		)
		expect(entries.body.refused[0].code).toBe('count_closed')
		// The movements stay append-only.
		const movements = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, world.count))
		expect(movements).toHaveLength(4)
	})
})

describe('counts: lists and cancelling', () => {
	it('counts a saved list only, and cancels a count without posting anything', async () => {
		const list = await ok('POST', '/count-lists', sara, {
			locationId: LOC,
			name: 'Proteins',
			itemIds: [world.chicken],
		})
		const started = await ok('POST', '/counts', sara, {
			clientId: cid('count'),
			locationId: LOC,
			listId: list.id,
		})
		expect(started).toMatchObject({
			listId: list.id,
			listName: 'Proteins',
			itemTotal: 1,
		})
		// A full count may run beside a list count.
		const full = await ok('POST', '/counts', sara, {
			clientId: cid('count'),
			locationId: LOC,
			listId: null,
		})
		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${started.id}`, sara),
		)
		expect(sheet.areas.flatMap((a) => a.items.map((i) => i.name))).toEqual([
			'Count chicken',
		])
		const cancelled = await ok('POST', `/counts/${started.id}/cancel`, sara, {
			expectedVersion: 1,
		})
		expect(cancelled).toMatchObject({ status: 'cancelled' })
		expect(cancelled.cancelledAt).toEqual(expect.any(Number))
		await ok('POST', `/counts/${full.id}/cancel`, sara, { expectedVersion: 1 })
		const notApprovable = await call(
			'POST',
			`${BASE}/counts/${full.id}/approve`,
			{ token: sara, body: { expectedVersion: 2 } },
		)
		expect(notApprovable.body.code).toBe('count_closed')
		const review = await call('GET', `${BASE}/counts/${full.id}/review`, {
			token: sara,
		})
		expect(review.status).toBe(409)
	})

	it('refuses to approve a count that is still being counted', async () => {
		const started = await ok('POST', '/counts', sara, {
			clientId: cid('count'),
			locationId: LOC,
			listId: null,
		})
		const res = await call('POST', `${BASE}/counts/${started.id}/approve`, {
			token: sara,
			body: { expectedVersion: 1 },
		})
		expect(res.status).toBe(409)
		expect(res.body).toMatchObject({
			code: 'invalid_request',
			reason: 'not_in_review',
		})
		await ok('POST', `/counts/${started.id}/cancel`, sara, {
			expectedVersion: 1,
		})
	})
})

describe('counts: a second approved count gives food cost', () => {
	it('reports no sales when two full counts are approved without sales in between', async () => {
		const started = await ok('POST', '/counts', sara, {
			clientId: cid('count'),
			locationId: LOC,
			listId: null,
		})
		const entries = [
			[world.chicken, world.walkIn, 5],
			[world.rice, world.dry, 12],
			[world.flour, world.dry, 0],
		] as const
		await ok('POST', `/counts/${started.id}/entries`, sara, {
			entries: [
				...entries.map(([itemId, areaId, amount]) => ({
					clientId: cid('e'),
					itemId,
					areaId,
					amount,
					unit: 'kg',
				})),
				{
					clientId: cid('e'),
					itemId: world.milk,
					areaId: null,
					amount: 7.5,
					unit: 'l',
				},
			],
		})
		await ok('POST', `/counts/${started.id}/send`, sara, { expectedVersion: 1 })
		const res = approveCountResultSchema.parse(
			await ok('POST', `/counts/${started.id}/approve`, sara, {
				expectedVersion: 2,
			}),
		)
		expect(res.adjustedItems).toBe(0)
		expect(res.differenceValueMinor).toBe(0)
		expect(res.foodCost).toMatchObject({
			state: 'no_sales',
			openingMinor: 14000,
			closingMinor: 14000,
			purchasesMinor: 0,
			salesMinor: 0,
		})
		expect(res.foodCost!.bp).toBeUndefined()
	})
})
