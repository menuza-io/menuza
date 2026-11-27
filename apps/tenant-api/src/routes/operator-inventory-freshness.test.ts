import { localDateIn } from '@repo/inventory'
import { addDays, currentBusinessDate } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invLotTakes,
	invMovements,
	invStockLots,
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
 * Use-by dates (#479): receiving with a date (typed, or from the shelf life),
 * Today's "Use first" and "Expired" lists, using the oldest date first, waste
 * of expired stock taking that date's quantity, confirming dates, cancelling a
 * delivery and the flag.
 */

const ORG = 'org_inv_fresh_a'
const ORG_OFF = 'org_inv_fresh_off'
const LOC = 'loc_fresh'

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

const today = currentBusinessDate(Date.now(), 'UTC', 240)
const day = (offset: number) => addDays(today, offset)

let env: ReturnType<typeof setupTenantEnv>
let owner: string
let noFlag: string
let costless: string
let milk = ''
let cream = ''
let rice = ''

async function createItem(
	token: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	return call('POST', `${BASE}/items`, {
		token,
		body: {
			clientId: cid('item'),
			name,
			category: 'dairy',
			kind: 'bought',
			baseUnit: 'ml',
			...extra,
		},
	})
}

async function receive(
	item: string,
	quantity: number,
	useByDate?: string | null,
	token = owner,
) {
	const reply = await call('POST', `${BASE}/deliveries`, {
		token,
		body: {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [
				{
					itemId: item,
					quantity,
					lineTotalMinor: Math.round(quantity / 100),
					...(useByDate !== undefined ? { useByDate } : {}),
				},
			],
		},
	})
	expect(reply.status).toBe(200)
	return reply.body
}

const adjust = (item: string, quantity: number) =>
	call('POST', `${BASE}/items/${item}/adjust`, {
		token: owner,
		body: {
			clientId: cid('adj'),
			locationId: LOC,
			quantity,
			reason: quantity > 0 ? 'found' : 'correction',
		},
	})

const lots = async (item: string) =>
	(await call('GET', `${BASE}/items/${item}/lots?locationId=${LOC}`, { token: owner }))
		.body

beforeAll(async () => {
	env = setupTenantEnv('inv-fresh')
	for (const id of [ORG, ORG_OFF]) {
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
	owner = await mintToken(ORG, {
		features: { useBy: true },
		subject: 'user_sara',
	})
	costless = await mintToken(ORG, {
		grants: [READ, UPDATE],
		features: { useBy: true },
	})
	noFlag = await mintToken(ORG_OFF, {})
	milk = (await createItem(owner, 'Fresh milk', { trackByDate: true })).body.id
	cream = (
		await createItem(owner, 'Fresh cream', {
			trackByDate: true,
			shelfLifeHours: 72,
			storageNote: 'Keep at 4 C',
			nameAr: 'كريمة',
		})
	).body.id
	rice = (await createItem(owner, 'Plain rice', { kind: 'bought' })).body.id
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_OFF)
	env.cleanup()
})

describe('items tracked by date', () => {
	it('stores tracking, shelf life, storage note and the label name', async () => {
		const detail = await call(
			'GET',
			`${BASE}/items/${cream}?locationId=${LOC}`,
			{ token: owner },
		)
		expect(detail.body).toMatchObject({
			trackByDate: true,
			shelfLifeHours: 72,
			storageNote: 'Keep at 4 C',
			nameAr: 'كريمة',
		})
		const updated = await call('PATCH', `${BASE}/items/${cream}`, {
			token: owner,
			body: { expectedVersion: detail.body.version, shelfLifeHours: 48 },
		})
		expect(updated.body.shelfLifeHours).toBe(48)
		// Put it back for the later tests.
		await call('PATCH', `${BASE}/items/${cream}`, {
			token: owner,
			body: { expectedVersion: updated.body.version, shelfLifeHours: 72 },
		})
	})

	it('refuses changing them while the flag is off, but not resending the same values', async () => {
		const made = await createItem(noFlag, 'Flagless', { trackByDate: true })
		expect(made.status).toBe(403)
		expect(made.body.error).toBe('feature_disabled')
		const plain = await createItem(noFlag, 'Flagless plain')
		expect(plain.status).toBe(200)
		const same = await call('PATCH', `${BASE}/items/${plain.body.id}`, {
			token: noFlag,
			body: { expectedVersion: plain.body.version, trackByDate: false },
		})
		expect(same.status).toBe(200)
	})

	it('answers 403 on the use-by routes without the flag', async () => {
		const reply = await call('GET', `${BASE}/freshness?locationId=${LOC}`, {
			token: noFlag,
		})
		expect(reply.status).toBe(403)
		expect(reply.body.error).toBe('feature_disabled')
	})
})

describe('receiving with a use-by date', () => {
	it('shows milk on Today two days before its date (and not three)', async () => {
		await receive(milk, 10_000, day(2))
		await receive(cream, 4_000, day(3))
		const today_ = await call('GET', `${BASE}/today?locationId=${LOC}`, {
			token: owner,
		})
		expect(today_.status).toBe(200)
		const list = today_.body.freshness
		expect(list.useFirst.map((row: any) => [row.itemId, row.daysLeft])).toEqual([
			[milk, 2],
		])
		expect(list.expired).toEqual([])
		expect(
			today_.body.attention.find((row: any) => row.kind === 'use_first'),
		).toMatchObject({ itemId: milk, daysLeft: 2, more: 0 })
	})

	it('derives the date from the shelf life when none is typed', async () => {
		const item = (
			await createItem(owner, 'Shelf cream', {
				trackByDate: true,
				shelfLifeHours: 72,
			})
		).body.id
		const before = Date.now()
		await receive(item, 2_000)
		const result = await lots(item)
		// 72 hours from the receipt, on the location's calendar (UTC here).
		expect([
			localDateIn(before + 72 * 3_600_000, 'UTC'),
			localDateIn(Date.now() + 72 * 3_600_000, 'UTC'),
		]).toContain(result.lots[0].useByDate)
		expect(result.lots[0].remaining).toBe(2_000)
	})

	it('records no lot for an item that is not tracked, or a delivery with no date and no shelf life', async () => {
		await receive(rice, 5_000, day(1))
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(invStockLots)
			.where(eq(invStockLots.itemId, rice))
		expect(rows).toEqual([])
		const bare = await createItem(owner, 'No shelf life', { trackByDate: true })
		await receive(bare.body.id, 1_000)
		expect((await lots(bare.body.id)).lots).toEqual([])
		expect((await lots(bare.body.id)).undated).toBe(1_000)
	})

	it('refuses a date that is not a real calendar date range', async () => {
		const reply = await call('POST', `${BASE}/deliveries`, {
			token: owner,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: null,
				currency: 'SAR',
				lines: [
					{
						itemId: milk,
						quantity: 1_000,
						lineTotalMinor: 10,
						useByDate: '2999-01-01',
					},
				],
			},
		})
		expect(reply.status).toBe(400)
		expect(reply.body.reason ?? reply.body.error).toBeTruthy()
	})
})

describe('using the oldest date first', () => {
	it('lowers the oldest lot first when stock is used or counted away', async () => {
		const item = (await createItem(owner, 'Yogurt', { trackByDate: true })).body.id
		await receive(item, 6_000, day(5))
		await receive(item, 4_000, day(1))
		// 7 of the 10 are used (a by-hand correction stands in for sales).
		await adjust(item, -7_000)
		const after = await lots(item)
		expect(after.lots.map((lot: any) => [lot.useByDate, lot.remaining])).toEqual([
			[day(5), 3_000],
		])
		expect(after.onHand).toBe(3_000)
	})
})

describe('waste of expired stock', () => {
	it("removes that date's quantity, not the oldest one", async () => {
		const item = (await createItem(owner, 'Old sauce', { trackByDate: true })).body.id
		// Two lots, both past their date: the older (2) and the newer (3).
		await receive(item, 2_000, day(-6))
		await receive(item, 3_000, day(-1))
		const before = await lots(item)
		expect(before.lots.map((lot: any) => [lot.useByDate, lot.status])).toEqual([
			[day(-6), 'expired'],
			[day(-1), 'expired'],
		])
		const newer = before.lots[1]
		const waste = await call('POST', `${BASE}/lots/${newer.id}/waste`, {
			token: owner,
			body: { clientId: cid('lw'), locationId: LOC },
		})
		expect(waste.status).toBe(200)
		expect(waste.body).toMatchObject({ itemId: item, quantity: 3_000, duplicate: false })
		const after = await lots(item)
		// The newer date's 3 are gone; the older lot's 2 are still there.
		expect(after.lots.map((lot: any) => [lot.useByDate, lot.remaining])).toEqual([
			[day(-6), 2_000],
		])
		expect(after.onHand).toBe(2_000)
		// One waste entry with the reason, and a take on that lot only.
		const db = await getTenantDb(ORG)
		const movements = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, item))
		expect(movements.filter((row) => row.kind === 'waste')).toMatchObject([
			{ quantity: -3_000, reason: 'expired' },
		])
		expect(
			(await db.select().from(invLotTakes)).filter((take) => take.lotId === newer.id),
		).toHaveLength(1)
	})

	it('is one tap: a repeat of the same tap does not waste twice', async () => {
		const item = (await createItem(owner, 'Tap sauce', { trackByDate: true })).body.id
		await receive(item, 2_000, day(-2))
		const lot = (await lots(item)).lots[0]
		const body = { clientId: cid('lw'), locationId: LOC }
		const first = await call('POST', `${BASE}/lots/${lot.id}/waste`, { token: owner, body })
		const again = await call('POST', `${BASE}/lots/${lot.id}/waste`, { token: owner, body })
		expect(first.body.wasteId).toBe(again.body.wasteId)
		expect((await lots(item)).onHand).toBe(0)
	})

	it('takes part of a lot, and refuses more than is left', async () => {
		const item = (await createItem(owner, 'Part sauce', { trackByDate: true })).body.id
		await receive(item, 5_000, day(-1))
		const lot = (await lots(item)).lots[0]
		const tooMuch = await call('POST', `${BASE}/lots/${lot.id}/waste`, {
			token: owner,
			body: { clientId: cid('lw'), locationId: LOC, quantity: 6_000 },
		})
		expect(tooMuch.status).toBe(400)
		const part = await call('POST', `${BASE}/lots/${lot.id}/waste`, {
			token: owner,
			body: { clientId: cid('lw'), locationId: LOC, quantity: 2_000 },
		})
		expect(part.status).toBe(200)
		expect((await lots(item)).lots[0].remaining).toBe(3_000)
	})

	it('lists expired stock on Today and clears it after the waste', async () => {
		const item = (await createItem(owner, 'Today sauce', { trackByDate: true })).body.id
		await receive(item, 1_000, day(-3))
		const listed = await call('GET', `${BASE}/freshness?locationId=${LOC}`, {
			token: owner,
		})
		expect(listed.body.expired.some((row: any) => row.itemId === item)).toBe(true)
		const row = listed.body.expired.find((entry: any) => entry.itemId === item)
		expect(row.valueMinor).toBeDefined()
		await call('POST', `${BASE}/lots/${row.lotId}/waste`, {
			token: owner,
			body: { clientId: cid('lw'), locationId: LOC },
		})
		const after = await call('GET', `${BASE}/freshness?locationId=${LOC}`, {
			token: owner,
		})
		expect(after.body.expired.some((entry: any) => entry.itemId === item)).toBe(false)
	})

	it('keeps money out of the lists for a token without the cost grant', async () => {
		const listed = await call('GET', `${BASE}/freshness?locationId=${LOC}`, {
			token: costless,
		})
		expect(listed.status).toBe(200)
		expect(JSON.stringify(listed.body)).not.toContain('valueMinor')
	})
})

describe('confirming dates and cancelling a delivery', () => {
	it('confirmed dates replace the earlier ones and the rest stays undated', async () => {
		const item = (await createItem(owner, 'Check milk', { trackByDate: true })).body.id
		await receive(item, 9_000, day(4))
		const confirmed = await call('POST', `${BASE}/items/${item}/lots/confirm`, {
			token: owner,
			body: {
				clientId: cid('cf'),
				locationId: LOC,
				lots: [
					{ useByDate: day(1), quantity: 2_000 },
					{ useByDate: day(6), quantity: 4_000 },
				],
			},
		})
		expect(confirmed.status).toBe(200)
		expect(
			confirmed.body.lots.map((lot: any) => [lot.useByDate, lot.remaining, lot.source]),
		).toEqual([
			[day(1), 2_000, 'confirm'],
			[day(6), 4_000, 'confirm'],
		])
		expect(confirmed.body.undated).toBe(3_000)
		const tooMuch = await call('POST', `${BASE}/items/${item}/lots/confirm`, {
			token: owner,
			body: {
				clientId: cid('cf'),
				locationId: LOC,
				lots: [{ useByDate: day(2), quantity: 99_000 }],
			},
		})
		expect(tooMuch.status).toBe(400)
	})

	it('a cancelled delivery takes its own lots out', async () => {
		const item = (await createItem(owner, 'Cancel milk', { trackByDate: true })).body.id
		await receive(item, 3_000, day(7))
		const second = await receive(item, 4_000, day(2))
		expect((await lots(item)).lots).toHaveLength(2)
		const cancelled = await call(
			'POST',
			`${BASE}/deliveries/${second.delivery.id}/cancel`,
			{ token: owner, body: { expectedVersion: second.delivery.version } },
		)
		expect(cancelled.status).toBe(200)
		const after = await lots(item)
		expect(after.lots.map((lot: any) => [lot.useByDate, lot.remaining])).toEqual([
			[day(7), 3_000],
		])
	})
})
