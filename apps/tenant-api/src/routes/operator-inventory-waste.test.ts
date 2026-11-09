import {
	logWasteResultSchema,
	wasteEntrySchema,
	wasteSummarySchema,
	WASTE_UNDO_WINDOW_MS,
} from '@repo/inventory'
import { currentBusinessDate } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
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
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Waste: logging (cost at the average, batches, replays), undo by a reversing
 * entry within the window, the log and its summary, and the grant, location
 * and organization rules.
 */

const ORG = 'org_inv_waste_a'
const ORG_B = 'org_inv_waste_b'
const LOC = 'loc_waste'

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
let readOnly: string
let tokenB: string
let scoped: string
let chicken = ''
let milk = ''
let carton = ''
const today = currentBusinessDate(Date.now(), 'UTC', 240)

beforeAll(async () => {
	env = setupTenantEnv('inv-waste')
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
	full = await mintToken(ORG, { subject: 'user_sara' })
	noCost = await mintToken(ORG, { grants: [READ, UPDATE] })
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
	tokenB = await mintToken(ORG_B)
	scoped = await mintToken(ORG, { locationIds: [LOC] })

	const create = async (
		name: string,
		baseUnit: string,
		extra: Record<string, unknown> = {},
	) =>
		(
			await call('POST', `${BASE}/items`, {
				token: full,
				body: {
					clientId: cid('item'),
					name,
					category: baseUnit === 'g' ? 'meat' : 'dairy',
					kind: 'bought',
					baseUnit,
					...extra,
				},
			})
		).body
	chicken = (await create('Waste chicken', 'g')).id
	const m = await create('Waste milk', 'ml', {
		units: [{ name: 'Carton', baseQuantity: 3_000_000 }],
	})
	milk = m.id
	carton = `unit:${m.units[0].id}`
	// 10 kg chicken at 280.00 (2.8 halalas per gram); milk without a cost.
	const del = await call('POST', `${BASE}/deliveries`, {
		token: full,
		body: {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [{ itemId: chicken, quantity: 10_000_000, lineTotalMinor: 28000 }],
		},
	})
	expect(del.status).toBe(200)
	await call('POST', `${BASE}/items/${milk}/adjust`, {
		token: full,
		body: {
			clientId: cid('adj'),
			locationId: LOC,
			quantity: 12_000_000,
			reason: 'found',
		},
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

const entry = (
	itemId: string,
	amount: number,
	unit: string,
	reason = 'expired',
	extra: Record<string, unknown> = {},
) => ({
	clientId: cid('w'),
	locationId: LOC,
	itemId,
	amount,
	unit,
	reason,
	...extra,
})
const log = (token: string, entries: unknown[]) =>
	call('POST', `${BASE}/waste`, { token, body: { entries } })
const onHand = async (itemId: string) =>
	(
		await call('GET', `${BASE}/items/${itemId}?locationId=${LOC}`, {
			token: full,
		})
	).body.onHand

describe('POST /waste', () => {
	it('logs waste at the average cost, takes stock out, and replays a clientId', async () => {
		const first = entry(chicken, 2.3, 'kg', 'expired', {
			note: 'Walk-in failure',
		})
		const res = await log(full, [first])
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const parsed = logWasteResultSchema.parse(res.body)
		expect(parsed.accepted).toEqual([
			{
				clientId: first.clientId,
				id: expect.any(String),
				quantity: 2_300_000,
				valueMinor: 6440,
				currency: 'SAR',
			},
		])
		expect(parsed.duplicates).toEqual([])
		expect(await onHand(chicken)).toBe(7_700_000)

		const replay = await log(full, [first])
		expect(logWasteResultSchema.parse(replay.body)).toMatchObject({
			accepted: [],
			duplicates: [{ clientId: first.clientId, id: parsed.accepted[0]!.id }],
		})
		expect(await onHand(chicken)).toBe(7_700_000)
		const moved = await call(
			'GET',
			`${BASE}/items/${chicken}/movements?locationId=${LOC}&limit=1`,
			{ token: full },
		)
		expect(moved.body.movements[0]).toMatchObject({
			kind: 'waste',
			quantity: -2_300_000,
			valueMinor: -6440,
			reason: 'expired',
			note: 'Walk-in failure',
			sourceType: 'waste',
			sourceId: parsed.accepted[0]!.id,
		})
		const other = await log(full, [{ ...first, itemId: milk }])
		expect(other.status).toBe(409)
		expect(other.body.code).toBe('idempotency_conflict')
	})

	it('takes a batch (named units, no cost known), and refuses bad entries as a whole', async () => {
		const res = await log(full, [
			entry(milk, 1.5, carton, 'spoiled'),
			entry(milk, 500, 'ml', 'dropped'),
			entry(chicken, 0.2, 'kg', 'staff_meal'),
		])
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		expect(
			res.body.accepted.map((a: { quantity: number }) => a.quantity),
		).toEqual([4_500_000, 500_000, 200_000])
		// Milk has no cost: no value; chicken does.
		expect(res.body.accepted[0].valueMinor).toBeUndefined()
		expect(res.body.accepted[2].valueMinor).toBe(560)
		expect(await onHand(milk)).toBe(12_000_000 - 4_500_000 - 500_000)

		const before = await onHand(chicken)
		const bad = await log(full, [
			entry(chicken, 1, 'kg'),
			entry(chicken, 1, 'l'),
		])
		expect(bad.status).toBe(400)
		expect(bad.body.code).toBe('unit_mismatch')
		expect(await onHand(chicken)).toBe(before)
		expect((await log(full, [entry('ghost-item', 1, 'kg')])).status).toBe(404)
		expect((await log(full, [entry(chicken, 0, 'kg')])).status).toBe(400)
		expect((await log(full, [entry(chicken, 0.0001, 'g')])).status).toBe(400)
		expect(
			(
				await log(
					full,
					Array.from({ length: 51 }, () => entry(chicken, 1, 'g')),
				)
			).status,
		).toBe(400)
		const rogue = await log(full, [
			{ ...entry(chicken, 1, 'kg'), secret: 'echo-me' },
		])
		expect(rogue.status).toBe(400)
		expect(JSON.stringify(rogue.body)).not.toContain('echo-me')
	})

	it('refuses the reasons only the system records', async () => {
		for (const reason of ['cancelled_after_cooking', 'remade_at_till']) {
			const res = await log(full, [entry(chicken, 1, 'kg', reason)])
			expect(res.status, reason).toBe(400)
			expect(res.body.code).toBe('reason_not_allowed')
		}
	})

	it('leaves money out without the cost grant and refuses read-only, excluded-location and other-organization tokens', async () => {
		const res = await log(noCost, [entry(chicken, 0.1, 'kg')])
		expect(res.status).toBe(200)
		expect(JSON.stringify(res.body)).not.toMatch(/valueMinor|currency/)
		expect((await log(readOnly, [entry(chicken, 1, 'kg')])).status).toBe(403)
		const elsewhere = await log(scoped, [
			entry(chicken, 1, 'kg'),
			{ ...entry(chicken, 1, 'kg'), locationId: 'loc_closed_branch' },
		])
		expect(elsewhere.status).toBe(403)
		expect(elsewhere.body.code).toBe('location_forbidden')
		expect((await log(tokenB, [entry(chicken, 1, 'kg')])).status).toBe(404)
	})
})

describe('POST /waste/:id/undo', () => {
	it('undoes once by a reversing entry, keeps the original, and hides the reversal from the log', async () => {
		const logged = await log(full, [entry(chicken, 1, 'kg', 'dropped')])
		const id = logged.body.accepted[0].id
		const before = await onHand(chicken)
		const undoBody = { clientId: cid('undo') }
		const undone = await call('POST', `${BASE}/waste/${id}/undo`, {
			token: full,
			body: undoBody,
		})
		expect(undone.status, JSON.stringify(undone.body)).toBe(200)
		const reversal = wasteEntrySchema.parse(undone.body)
		expect(reversal).toMatchObject({
			reversesId: id,
			quantity: 1_000_000,
			reason: 'dropped',
			valueMinor: 2800,
		})
		expect(await onHand(chicken)).toBe(before + 1_000_000)

		const replay = await call('POST', `${BASE}/waste/${id}/undo`, {
			token: full,
			body: undoBody,
		})
		expect(replay.status).toBe(200)
		expect(replay.body.id).toBe(reversal.id)
		const again = await call('POST', `${BASE}/waste/${id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		expect(again.status).toBe(409)
		expect(again.body.code).toBe('already_undone')
		const ofReversal = await call('POST', `${BASE}/waste/${reversal.id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		expect(ofReversal.status).toBe(404)
		const mixed = await call(
			'POST',
			`${BASE}/waste/${logged.body.accepted[0].id}/undo`,
			{ token: full, body: { clientId: undoBody.clientId } },
		)
		expect(mixed.status).toBe(200)

		const list = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=${today}&to=${today}`,
			{ token: full },
		)
		const entries = list.body.entries.map((e: { id: string }) => e.id)
		expect(entries).toContain(id)
		expect(entries).not.toContain(reversal.id)
		expect(
			list.body.entries.find((e: { id: string }) => e.id === id).undoneAt,
		).toBe(reversal.createdAt)
	})

	it('refuses an expired undo, another organization, a read-only token and an excluded location', async () => {
		const db = await getTenantDb(ORG)
		const id = 'waste_old_entry'
		const old = Date.now() - WASTE_UNDO_WINDOW_MS - 60_000
		await db.insert(invWaste).values({
			id,
			locationId: LOC,
			itemId: chicken,
			quantity: 1000,
			reason: 'expired',
			actorKind: 'operator',
			clientId: 'client-old-entry',
			businessDate: today,
			createdAt: old,
		})
		const expired = await call('POST', `${BASE}/waste/${id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		expect(expired.status).toBe(409)
		expect(expired.body.code).toBe('undo_expired')
		expect(
			(
				await call('POST', `${BASE}/waste/${id}/undo`, {
					token: tokenB,
					body: { clientId: cid('undo') },
				})
			).status,
		).toBe(404)
		expect(
			(
				await call('POST', `${BASE}/waste/${id}/undo`, {
					token: readOnly,
					body: { clientId: cid('undo') },
				})
			).status,
		).toBe(403)
		const logged = await log(full, [entry(chicken, 1, 'g')])
		const scopedAway = await mintToken(ORG, { locationIds: ['loc_elsewhere'] })
		const away = await call(
			'POST',
			`${BASE}/waste/${logged.body.accepted[0].id}/undo`,
			{ token: scopedAway, body: { clientId: cid('undo') } },
		)
		expect(away.status).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/waste/missing/undo`, {
					token: full,
					body: { clientId: cid('undo') },
				})
			).status,
		).toBe(404)
	})

	it('writes the reversing movement once and leaves the original untouched (append-only)', async () => {
		const db = await getTenantDb(ORG)
		const logged = await log(full, [entry(milk, 1, 'l', 'other')])
		const id = logged.body.accepted[0].id
		await call('POST', `${BASE}/waste/${id}/undo`, {
			token: full,
			body: { clientId: cid('undo') },
		})
		const rows = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, milk))
		const wasteRows = rows.filter(
			(r) => r.sourceId === id || r.eventKey === `waste-undo:${id}`,
		)
		expect(wasteRows.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([
			-1_000_000, 1_000_000,
		])
		const original = await db
			.select()
			.from(invWaste)
			.where(eq(invWaste.id, id))
			.get()
		expect(original).toMatchObject({ quantity: 1_000_000, reversesId: null })
	})
})

describe('GET /waste and /waste/summary', () => {
	it('filters by reason and period, pages newest first, and hides money without the cost grant', async () => {
		const all = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=${today}&to=${today}&limit=2`,
			{ token: full },
		)
		expect(all.status).toBe(200)
		expect(all.body.entries).toHaveLength(2)
		expect(all.body.nextCursor).not.toBeNull()
		const parsed = wasteEntrySchema.parse(all.body.entries[0])
		expect(parsed.createdAt).toBeGreaterThanOrEqual(
			all.body.entries[1].createdAt,
		)
		const page2 = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=${today}&to=${today}&limit=2&cursor=${all.body.nextCursor}`,
			{ token: full },
		)
		expect(page2.body.entries.length).toBeGreaterThan(0)
		const ids = new Set(
			[...all.body.entries, ...page2.body.entries].map(
				(e: { id: string }) => e.id,
			),
		)
		expect(ids.size).toBe(all.body.entries.length + page2.body.entries.length)

		const expired = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=${today}&to=${today}&reason=expired`,
			{ token: full },
		)
		expect(
			expired.body.entries.every(
				(e: { reason: string }) => e.reason === 'expired',
			),
		).toBe(true)
		const none = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=2020-01-01&to=2020-01-02`,
			{ token: full },
		)
		expect(none.body.entries).toEqual([])
		const lean = await call(
			'GET',
			`${BASE}/waste?locationId=${LOC}&from=${today}&to=${today}`,
			{ token: noCost },
		)
		expect(lean.status).toBe(200)
		expect(JSON.stringify(lean.body)).not.toMatch(/valueMinor|currency/)
		expect(
			(
				await call(
					'GET',
					`${BASE}/waste?locationId=${LOC}&from=bad&to=${today}`,
					{ token: full },
				)
			).status,
		).toBe(400)
		expect(
			(
				await call(
					'GET',
					`${BASE}/waste?locationId=loc_closed_branch&from=${today}&to=${today}`,
					{ token: scoped },
				)
			).status,
		).toBe(403)
	})

	it('summarises by reason, category, day and item without the undone entries', async () => {
		const summary = wasteSummarySchema.parse(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=${today}&to=${today}`,
					{ token: full },
				)
			).body,
		)
		const reasons = Object.fromEntries(
			summary.byReason.map((r) => [r.reason, r.count]),
		)
		// expired: 2.3 kg, 0.1 kg (cost-less token), 1 g and an old row; spoiled 1; dropped: 500 ml (1 kg undone); staff meal 1; other: 1 L undone
		expect(reasons).toMatchObject({
			expired: 4,
			spoiled: 1,
			staff_meal: 1,
			dropped: 1,
		})
		expect(reasons.other).toBeUndefined()
		expect(summary.byDay).toHaveLength(1)
		expect(summary.byDay[0]!.date).toBe(today)
		expect(summary.byCategory.map((c) => c.category).sort()).toEqual([
			'dairy',
			'meat',
		])
		expect(summary.topItems[0]).toMatchObject({
			itemId: chicken,
			itemName: 'Waste chicken',
		})
		expect(summary.topItems.length).toBeLessThanOrEqual(5)
		expect(summary.count).toBe(summary.byDay[0]!.count)
		// 2.3 + 0.2 + 0.1 kg and 1 g at 2.8 per gram, plus the two cost-less milk entries.
		expect(summary.valueMinor).toBe(6440 + 560 + 280 + 3)
		expect(summary.currency).toBe('SAR')
		expect(summary.purchasesMinor).toBe(28000)

		const lean = await call(
			'GET',
			`${BASE}/waste/summary?locationId=${LOC}&from=${today}&to=${today}`,
			{ token: noCost },
		)
		expect(lean.status).toBe(200)
		expect(JSON.stringify(lean.body)).not.toMatch(
			/valueMinor|purchasesMinor|currency/,
		)
		expect(lean.body.topItems[0].count).toBeGreaterThan(0)
		expect(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=${today}&to=2000-01-01`,
					{ token: full },
				)
			).status,
		).toBe(400)
		expect(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=${LOC}&from=2020-01-01&to=2022-01-01`,
					{ token: full },
				)
			).status,
		).toBe(400)
		expect(
			(
				await call(
					'GET',
					`${BASE}/waste/summary?locationId=loc_closed_branch&from=${today}&to=${today}`,
					{ token: scoped },
				)
			).status,
		).toBe(403)
	})
})
