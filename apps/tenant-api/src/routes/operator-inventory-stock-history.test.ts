import { runChunkedCsvExport } from '@repo/reports/export'
import {
	STOCK_DAY_COLUMNS,
	stockDaySchema,
	stockOnDateSchema,
} from '@repo/inventory'
import { currentBusinessDate } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invCostEvents,
	invItems,
	invLocationSettings,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
 * Stock and stock value on a past business day (#521): a read model over the
 * movements. The value on a date is the sum of the movements to it, the day view
 * balances, a business day follows the location's zone and day start, and money
 * needs the cost grant.
 */

const ORG = 'org_inv_hist'
const LOC = 'loc_hist'
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
let owner: string
let noCost: string

const D1 = '2026-11-20'
const D2 = '2026-11-21'
const D3 = '2026-11-22'

const items = { flour: 'hist_flour', milk: 'hist_milk', salt: 'hist_salt' }

const at = (date: string, hh = 12) => Date.parse(`${date}T${String(hh).padStart(2, '0')}:00:00Z`)

async function move(
	itemId: string,
	businessDate: string,
	kind: (typeof invMovements.$inferInsert)['kind'],
	quantity: number,
	valueMinor: number | null,
) {
	const db = await getTenantDb(ORG)
	await db.insert(invMovements).values({
		locationId: LOC,
		itemId,
		quantity,
		valueMinor,
		currency: valueMinor === null ? null : 'SAR',
		kind,
		sourceType: kind,
		sourceId: `src-${Math.random().toString(36).slice(2)}`,
		businessDate,
		actorKind: 'operator',
		createdAt: at(businessDate),
	})
}

beforeAll(async () => {
	env = setupTenantEnv('inv-hist')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	owner = await mintToken(ORG, { subject: 'user_sara' })
	noCost = await mintToken(ORG, { grants: [READ, UPDATE] })
	const db = await getTenantDb(ORG)
	await db.insert(invLocationSettings).values({
		locationId: LOC,
		currency: 'SAR',
		currencySource: 'app',
		timeZone: 'Asia/Riyadh',
		dayStartMinutes: 300,
	})
	for (const [name, id, base] of [
		['Flour', items.flour, 'g'],
		['Milk', items.milk, 'ml'],
		['Salt', items.salt, 'g'],
	] as const) {
		await db.insert(invItems).values({
			id,
			name,
			category: 'dry_goods',
			kind: 'bought',
			baseUnit: base,
		})
	}
	// Day 1: flour 10 kg for 100.00, milk 5 l for 40.00.
	await move(items.flour, D1, 'delivery', 10_000_000, 10_000)
	await move(items.milk, D1, 'delivery', 5_000_000, 4_000)
	// Day 2: sales use 3 kg flour (30.00) and 1 l milk (8.00); 500 g flour wasted (5.00);
	// a count finds 200 ml milk less (1.60); a by-hand adjustment finds 50 g flour (0.50).
	await move(items.flour, D2, 'sale', -3_000_000, -3_000)
	await move(items.milk, D2, 'sale', -1_000_000, -800)
	await move(items.flour, D2, 'waste', -500_000, -500)
	await move(items.milk, D2, 'count', -200_000, -160)
	await move(items.flour, D2, 'adjustment', 50_000, 50)
	// Day 3: a delivery of flour, and a quantity-only delivery of salt priced later.
	await move(items.flour, D3, 'delivery', 4_000_000, 4_400)
	await move(items.salt, D2, 'delivery', 2_000_000, null)
	await db.insert(invCostEvents).values({
		itemId: items.salt,
		kind: 'confirm',
		locationId: LOC,
		quantity: 2_000_000,
		costMicro: 500_000,
		onHandBefore: 0,
		avgBeforeMicro: null,
		avgAfterMicro: 500_000,
		createdAt: at(D3),
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

afterEach(() => {
	vi.useRealTimers()
})

const onDate = async (date: string, token = owner, extra = '') => {
	const reply = await call(
		'GET',
		`${BASE}/stock/on-date?locationId=${LOC}&date=${date}${extra}`,
		{ token },
	)
	expect(reply.status).toBe(200)
	return stockOnDateSchema.parse(reply.body)
}

describe('stock on a past date', () => {
	it('on hand and value on a date are the sum of the movements to that date', async () => {
		const db = await getTenantDb(ORG)
		const all = await db.select().from(invMovements)
		for (const date of [D1, D2, D3]) {
			const upTo = all.filter((row) => row.businessDate <= date)
			const stock = await onDate(date)
			for (const item of stock.items) {
				expect(item.onHand).toBe(
					upTo
						.filter((row) => row.itemId === item.itemId)
						.reduce((sum, row) => sum + row.quantity, 0),
				)
			}
			// Everything here has a value of its own except the salt, priced later at 0.50 per kg.
			const valued = upTo
				.filter((row) => row.valueMinor !== null)
				.reduce((sum, row) => sum + row.valueMinor!, 0)
			const saltOnHand = date >= D2 ? 2_000_000 : 0
			// 2,000 g at 500,000 micro-minor per gram = 10.00.
			const salt = Math.round((saltOnHand * 500_000) / 1e9)
			expect(stock.totalValueMinor).toBe(valued + salt)
		}
		// Spot checks with plain numbers.
		expect((await onDate(D1)).totalValueMinor).toBe(14_000)
		const d2 = await onDate(D2)
		expect(d2.items.find((i) => i.itemId === items.flour)).toMatchObject({
			onHand: 6_550_000,
			valueMinor: 10_000 - 3_000 - 500 + 50,
		})
	})

	it('shows the date in the location, not in the middle of someone else\'s day', async () => {
		const stock = await onDate(D1)
		expect(stock.date).toBe(D1)
		expect(stock.open).toBe(false)
		expect(stock.items.map((i) => i.itemId).sort()).toEqual(
			[items.flour, items.milk].sort(),
		)
	})

	it('values a quantity-only delivery at the first cost known after it, and counts an item with no cost as unpriced', async () => {
		const stock = await onDate(D2)
		const salt = stock.items.find((i) => i.itemId === items.salt)!
		expect(salt.onHand).toBe(2_000_000)
		// 2,000 g at 500,000 micro-minor per gram is 10.00.
		expect(salt.valueMinor).toBe(1_000)
		expect(stock.unpricedItems).toBe(0)
		// An item that never had a cost has none.
		const db = await getTenantDb(ORG)
		await db.insert(invItems).values({
			id: 'hist_pepper',
			name: 'Pepper',
			category: 'dry_goods',
			kind: 'bought',
			baseUnit: 'g',
		})
		await move('hist_pepper', D2, 'delivery', 1_000, null)
		const after = await onDate(D2)
		expect(after.unpricedItems).toBe(1)
		expect(after.items.find((i) => i.itemId === 'hist_pepper')?.valueMinor).toBeNull()
	})

	it('filters, and leaves out items with no stock unless asked', async () => {
		const found = await onDate(D3, owner, '&q=milk')
		expect(found.items.map((i) => i.itemId)).toEqual([items.milk])
		const db = await getTenantDb(ORG)
		await db.insert(invItems).values({
			id: 'hist_empty',
			name: 'Emptied',
			category: 'dry_goods',
			kind: 'bought',
			baseUnit: 'g',
		})
		await move('hist_empty', D1, 'delivery', 1_000, 10)
		await move('hist_empty', D2, 'waste', -1_000, -10)
		expect((await onDate(D3)).items.some((i) => i.itemId === 'hist_empty')).toBe(false)
		expect(
			(await onDate(D3, owner, '&includeZero=true')).items.some(
				(i) => i.itemId === 'hist_empty',
			),
		).toBe(true)
	})

	it('refuses a day that has not happened', async () => {
		const reply = await call(
			'GET',
			`${BASE}/stock/on-date?locationId=${LOC}&date=2999-01-01`,
			{ token: owner },
		)
		expect(reply.status).toBe(400)
	})

	it('leaves money out without the cost grant', async () => {
		const stock = await onDate(D2, noCost)
		expect(stock.items.length).toBeGreaterThan(0)
		expect(stock.totalValueMinor).toBeUndefined()
		expect(JSON.stringify(stock)).not.toContain('valueMinor')
	})
})

describe('the day view', () => {
	const dayOf = async (date: string, token = owner, extra = '') => {
		const reply = await call(
			'GET',
			`${BASE}/stock/day?locationId=${LOC}&date=${date}${extra}`,
			{ token },
		)
		expect(reply.status, JSON.stringify(reply.body)).toBe(200)
		return stockDaySchema.parse(reply.body)
	}

	it('balances: opening plus the movements is closing, in quantity and in money', async () => {
		for (const date of [D1, D2, D3]) {
			const day = await dayOf(date)
			for (const row of day.rows) {
				const sum = (columns: Record<string, number>) =>
					STOCK_DAY_COLUMNS.filter((c) => c !== 'closing').reduce(
						(total, c) => total + columns[c]!,
						0,
					)
				expect(sum(row.quantity), row.name).toBe(row.quantity.closing)
				expect(sum(row.money!), row.name).toBe(row.money!.closing)
			}
			expect(
				STOCK_DAY_COLUMNS.filter((c) => c !== 'closing').reduce(
					(total, c) => total + day.totalsMoney![c]!,
					0,
				),
			).toBe(day.totalsMoney!.closing)
			// The closing is what the date picker shows for that day, and the opening is the day before.
			expect(day.totalsMoney!.closing).toBe((await onDate(date)).totalValueMinor)
		}
		const d2 = await dayOf(D2)
		expect(d2.totalsMoney!.opening).toBe((await onDate(D1)).totalValueMinor)
	})

	it('sorts each movement into its column', async () => {
		const day = await dayOf(D2, owner, `&itemId=${items.flour}`)
		expect(day.rows).toHaveLength(1)
		expect(day.rows[0]!.quantity).toEqual({
			opening: 10_000_000,
			delivered: 0,
			used: -3_000_000,
			wasted: -500_000,
			transfersIn: 0,
			transfersOut: 0,
			adjustments: 50_000,
			countCorrections: 0,
			made: 0,
			prepUsed: 0,
			closing: 6_550_000,
		})
		expect(day.rows[0]!.money).toMatchObject({
			opening: 10_000,
			used: -3_000,
			wasted: -500,
			adjustments: 50,
			closing: 6_550,
		})
		const milk = await dayOf(D2, owner, `&itemId=${items.milk}`)
		expect(milk.rows[0]!.quantity.countCorrections).toBe(-200_000)
	})

	it('keeps the quantities and drops the money without the cost grant', async () => {
		const day = await dayOf(D2, noCost)
		expect(day.rows.length).toBeGreaterThan(0)
		expect(day.rows[0]!.money).toBeUndefined()
		expect(day.totalsMoney).toBeUndefined()
	})
})

describe('the business day', () => {
	it("follows the location's time zone and day start when stock is written", async () => {
		// Day start 05:00 in Riyadh (UTC+3): 04:59 is still the 19th, 05:00 is the 20th.
		expect(currentBusinessDate(Date.parse('2026-11-20T01:59:00Z'), 'Asia/Riyadh', 300)).toBe(
			'2026-11-19',
		)
		const make = await call('POST', `${BASE}/items`, {
			token: owner,
			body: {
				clientId: cid('item'),
				name: 'Boundary rice',
				category: 'dry_goods',
				kind: 'bought',
				baseUnit: 'g',
			},
		})
		const itemId = make.body.id as string
		vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-20T01:59:00Z') })
		const late = await call('POST', `${BASE}/items/${itemId}/adjust`, {
			token: owner,
			body: { clientId: cid('adj'), locationId: LOC, quantity: 1_000, reason: 'found' },
		})
		vi.setSystemTime(Date.parse('2026-11-20T02:00:00Z'))
		const early = await call('POST', `${BASE}/items/${itemId}/adjust`, {
			token: owner,
			body: { clientId: cid('adj'), locationId: LOC, quantity: 2_000, reason: 'found' },
		})
		expect(late.status).toBe(200)
		expect(early.status).toBe(200)
		vi.useRealTimers()
		const before = (await onDate('2026-11-19')).items.find((i) => i.itemId === itemId)
		const after = (await onDate('2026-11-20')).items.find((i) => i.itemId === itemId)
		expect(before?.onHand).toBe(1_000)
		expect(after?.onHand).toBe(3_000)
		const day = stockDaySchema.parse(
			(
				await call('GET', `${BASE}/stock/day?locationId=${LOC}&date=2026-11-20&itemId=${itemId}`, {
					token: owner,
				})
			).body,
		)
		expect(day.rows[0]!.quantity).toMatchObject({ opening: 1_000, adjustments: 2_000, closing: 3_000 })
	})
})

describe('the month-end export', () => {
	async function fetchChunk(date: string, cursor: string | null, token = owner) {
		const reply = await call(
			'GET',
			`${BASE}/stock/value-export?locationId=${LOC}&date=${date}${cursor ? `&cursor=${cursor}` : ''}`,
			{ token },
		)
		if (reply.status !== 200) throw new Error(`export ${reply.status}`)
		return reply.body
	}

	it('is read page by page through the shared writer and its total is the screen total', async () => {
		const db = await getTenantDb(ORG)
		// More items than one page holds.
		const ids = Array.from({ length: 2_100 }, (_, i) => `hist_bulk_${i}`)
		for (let i = 0; i < ids.length; i += 200) {
			const chunk = ids.slice(i, i + 200)
			await db.insert(invItems).values(
				chunk.map((id, n) => ({
					id,
					name: `Bulk ${String(i + n).padStart(4, '0')}`,
					category: 'dry_goods',
					kind: 'bought' as const,
					baseUnit: 'g' as const,
				})),
			)
			await db.insert(invMovements).values(
				chunk.map((id) => ({
					locationId: LOC,
					itemId: id,
					quantity: 1_000,
					valueMinor: 7,
					currency: 'SAR',
					kind: 'delivery' as const,
					sourceType: 'delivery',
					sourceId: `src-${id}`,
					businessDate: D1,
					actorKind: 'operator' as const,
					createdAt: at(D1),
				})),
			)
		}
		const pages: number[] = []
		const result = await runChunkedCsvExport({
			fetchChunk: async (cursor) => {
				const chunk = await fetchChunk(D3, cursor)
				pages.push(chunk.rows.length)
				return chunk
			},
			yieldTurn: async () => {},
		})
		expect(result.status).toBe('done')
		if (result.status !== 'done') return
		expect(pages.length).toBeGreaterThan(1)
		const text = await result.blob.text()
		const lines = text.trim().split('\n')
		expect(lines[0]).toBe('Item,Category,Base unit,On hand (base units),Value (SAR)')
		const screen = await onDate(D3)
		expect(lines.length - 2).toBe(screen.items.length)
		expect(lines.at(-1)).toBe(`Total on ${D3},,,,${(screen.totalValueMinor! / 100).toFixed(2)}`)
		expect(result.rowCount).toBe(screen.items.length)
	})

	it('needs the cost grant', async () => {
		await expect(fetchChunk(D3, null, noCost)).rejects.toThrow('export 403')
	})
})
