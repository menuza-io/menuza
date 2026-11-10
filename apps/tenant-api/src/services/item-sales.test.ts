import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	posOrders,
	provisionTenantDb,
	restaurantOrders,
	rsvLocationSettings,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	allocateSaleNet,
	parseSoldLines,
	posOrderNetMinor,
	readItemSales,
	restaurantOrderNetMinor,
} from './item-sales.ts'
import { insertPosDevice, insertTab } from './loyalty-test-fixture.ts'

const ORG = 'org_item_sales_test'
const LOC = 'loc_a'
const LOC_B = 'loc_b'

/** 2026-11-05 12:00 UTC: 15:00 in Riyadh, 07:00 in New York. */
const NOON_UTC = Date.UTC(2026, 10, 5, 12, 0, 0)

type WebLine = {
	itemId: string
	variantId?: string | null
	quantity: number
	totalCents: number
	options?: Array<{
		optionId: string
		quantity: number
		half?: 'whole' | 'left' | 'right' | null
	}>
}

function webLines(lines: WebLine[]) {
	return lines.map((line) => ({
		itemId: line.itemId,
		itemName: '{"en":"Dish"}',
		variantId: line.variantId ?? null,
		quantity: line.quantity,
		unitPriceCents: Math.round(line.totalCents / line.quantity),
		taxableUnitCents: Math.round(line.totalCents / line.quantity),
		totalCents: line.totalCents,
		taxableCents: line.totalCents,
		instructions: null,
		baseUnitCents: 0,
		categoryIds: [],
		options: (line.options ?? []).map((option) => ({
			groupId: 'g1',
			groupName: 'Extras',
			optionId: option.optionId,
			optionName: 'Extra',
			half: option.half ?? null,
			quantity: option.quantity,
			priceCents: 0,
			totalCents: 0,
		})),
	}))
}

type PosLine = {
	itemId: string
	variantId?: string | null
	quantity: number
	baseCents: number
	options?: Array<{ optionId: string; quantity: number; unitCents: number }>
}

function posLines(lines: PosLine[]) {
	return lines.map((line, index) => ({
		id: `line_${index}`,
		itemId: line.itemId,
		name: 'Dish',
		variantId: line.variantId ?? null,
		variantLabel: null,
		quantity: line.quantity,
		baseCents: line.baseCents,
		instructions: '',
		options: (line.options ?? []).map((option) => ({
			groupId: 'g1',
			groupName: 'Extras',
			optionId: option.optionId,
			optionName: 'Extra',
			quantity: option.quantity,
			unitCents: option.unitCents,
			taxable: true,
		})),
	}))
}

describe('item sales reader', () => {
	let tempDir: string
	let db: TenantDatabase
	let sequence = 0

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-item-sales-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function insertWebOrder(
		lines: WebLine[],
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		sequence += 1
		const subtotal = lines.reduce((sum, line) => sum + line.totalCents, 0)
		await db.insert(restaurantOrders).values({
			orgId: ORG,
			number: `W-${sequence}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC,
			locationName: 'Olaya',
			contactName: 'Guest',
			contactPhone: '+966500000000',
			currency: 'sar',
			subtotalCents: subtotal,
			taxCents: 0,
			totalCents: subtotal,
			lines: webLines(lines),
			idempotencyKey: `idem-${sequence}`,
			requestHash: 'hash',
			receiptTokenHash: `receipt-${sequence}`,
			createdAt: new Date(NOON_UTC),
			...overrides,
		})
	}

	async function insertSale(
		lines: PosLine[],
		overrides: Partial<typeof posOrders.$inferInsert> = {},
	) {
		sequence += 1
		const deviceId = await insertPosDevice(ORG, {
			id: `dev_${sequence}`,
			locationId: overrides.locationId ?? LOC,
		})
		const subtotal = lines.reduce(
			(sum, line) =>
				sum +
				(line.baseCents +
					(line.options ?? []).reduce(
						(s, option) => s + option.unitCents * option.quantity,
						0,
					)) *
					line.quantity,
			0,
		)
		await db.insert(posOrders).values({
			id: `sale_${sequence}`,
			deviceId,
			number: `P-${sequence}`,
			businessDate: '2026-11-05',
			revision: 1,
			status: 'paid',
			orderType: 'takeaway',
			locationId: LOC,
			currency: 'SAR',
			subtotalCents: subtotal,
			taxCents: 0,
			totalCents: subtotal,
			lines: posLines(lines),
			adjustments: [],
			rungUpAt: NOON_UTC,
			receivedAt: NOON_UTC,
			paidAt: NOON_UTC,
			...overrides,
		})
	}

	const range = { fromDate: '2026-11-05', toDate: '2026-11-05' }

	it('reads nothing from an empty database', async () => {
		expect(await readItemSales(db, range)).toEqual({
			items: [],
			options: [],
			truncated: false,
		})
	})

	it('counts counted web and QR orders and leaves out cancelled, expired, unpaid and review orders', async () => {
		await insertWebOrder([{ itemId: 'burger', quantity: 2, totalCents: 4000 }])
		// Online and paid, and a free online order: both count.
		await insertWebOrder(
			[{ itemId: 'burger', quantity: 1, totalCents: 2000 }],
			{
				paymentMethod: 'online',
				paymentStatus: 'paid',
				status: 'accepted',
			},
		)
		await insertWebOrder(
			[{ itemId: 'burger', quantity: 1, totalCents: 2000 }],
			{
				paymentMethod: 'online',
				paymentStatus: 'not_required',
				status: 'accepted',
			},
		)
		// None of these sold anything.
		for (const overrides of [
			{ status: 'cancelled' as const },
			{
				status: 'expired' as const,
				paymentMethod: 'online' as const,
				paymentStatus: 'expired' as const,
			},
			{
				status: 'accepted' as const,
				paymentMethod: 'online' as const,
				paymentStatus: 'pending' as const,
			},
			{
				status: 'payment_review' as const,
				paymentMethod: 'online' as const,
				paymentStatus: 'paid' as const,
			},
		]) {
			await insertWebOrder(
				[{ itemId: 'burger', quantity: 10, totalCents: 20000 }],
				overrides,
			)
		}
		// A refund does not un-sell.
		await insertWebOrder(
			[{ itemId: 'burger', quantity: 1, totalCents: 2000 }],
			{
				refundedCents: 2000,
			},
		)

		const sales = await readItemSales(db, range)
		expect(sales.items).toEqual([
			{
				locationId: LOC,
				businessDate: '2026-11-05',
				itemId: 'burger',
				variantId: null,
				currency: 'SAR',
				quantity: 5,
				netSalesMinor: 10000,
			},
		])
	})

	it('counts paid and refunded Station sales, not open or cancelled ones, and never subtracts voided lines twice', async () => {
		await insertSale([{ itemId: 'shawarma', quantity: 3, baseCents: 1500 }])
		await insertSale([{ itemId: 'shawarma', quantity: 1, baseCents: 1500 }], {
			status: 'refunded',
			refundedCents: 1500,
			refundedAt: NOON_UTC,
		})
		await insertSale([{ itemId: 'shawarma', quantity: 9, baseCents: 1500 }], {
			status: 'open',
			paidAt: null,
		})
		await insertSale([{ itemId: 'shawarma', quantity: 9, baseCents: 1500 }], {
			status: 'void',
			paidAt: null,
			voidedAt: NOON_UTC,
			voidReason: 'mistake',
		})
		// Two came off the tab: `lines` already holds only the one left.
		await insertSale([{ itemId: 'shawarma', quantity: 1, baseCents: 1500 }], {
			lineVoids: [
				{
					id: '00000000-0000-4000-8000-000000000001',
					itemId: 'shawarma',
					name: 'Shawarma',
					variantLabel: null,
					quantity: 2,
					unitCents: 1500,
					at: new Date(NOON_UTC).toISOString(),
					by: null,
					approvedBy: null,
					reason: 'quality',
				},
			],
		})

		const sales = await readItemSales(db, range)
		expect(sales.items).toEqual([
			expect.objectContaining({
				itemId: 'shawarma',
				quantity: 5,
				netSalesMinor: 7500,
			}),
		])
	})

	it('adds web and Station sales of the same item and variant, and keeps variants apart', async () => {
		await insertWebOrder([
			{ itemId: 'pizza', variantId: 'large', quantity: 1, totalCents: 5000 },
			{ itemId: 'pizza', variantId: 'small', quantity: 2, totalCents: 6000 },
		])
		await insertSale([
			{ itemId: 'pizza', variantId: 'large', quantity: 2, baseCents: 5000 },
		])
		const sales = await readItemSales(db, range)
		expect(
			sales.items.map((row) => [
				row.variantId,
				row.quantity,
				row.netSalesMinor,
			]),
		).toEqual([
			['large', 3, 15000],
			['small', 2, 6000],
		])
	})

	it('counts options with their quantities, times the line quantity, and halves apart', async () => {
		await insertWebOrder([
			{
				itemId: 'pizza',
				quantity: 2,
				totalCents: 8000,
				options: [
					{ optionId: 'cheese', quantity: 1, half: 'whole' },
					{ optionId: 'olives', quantity: 1, half: 'left' },
				],
			},
			{
				itemId: 'latte',
				quantity: 3,
				totalCents: 4500,
				options: [{ optionId: 'oat_milk', quantity: 1 }],
			},
		])
		await insertSale([
			{
				itemId: 'latte',
				quantity: 2,
				baseCents: 1200,
				options: [{ optionId: 'oat_milk', quantity: 2, unitCents: 200 }],
			},
		])
		const sales = await readItemSales(db, range)
		expect(
			sales.options.map((row) => [
				row.optionId,
				row.quantity,
				row.halfQuantity,
			]),
		).toEqual([
			['cheese', 2, 0],
			['oat_milk', 7, 0],
			['olives', 2, 2],
		])
		// Station line total includes its options: (1200 + 2 x 200) x 2.
		expect(sales.items.find((row) => row.itemId === 'latte')).toMatchObject({
			quantity: 5,
			netSalesMinor: 4500 + 3200,
		})
	})

	it('nets out discounts, loyalty rewards and inclusive tax, never tips or delivery, split by line value', async () => {
		// Exclusive tax: 10000 subtotal - 1000 discount - 500 reward, + 1275
		// tax + 300 tip + 1000 delivery - 200 delivery discount.
		await insertWebOrder(
			[
				{ itemId: 'a', quantity: 1, totalCents: 7500 },
				{ itemId: 'b', quantity: 1, totalCents: 2500 },
			],
			{
				subtotalCents: 10000,
				discountCents: 1000,
				loyaltyDiscountCents: 500,
				taxCents: 1275,
				tipCents: 300,
				deliveryFeeCents: 1000,
				deliveryDiscountCents: 200,
				totalCents: 10000 - 1000 - 500 + 1275 + 300 + 800,
				fulfillment: 'delivery',
			},
		)
		// Inclusive tax (KSA): the 15% VAT is inside the 2300 after discount.
		await insertWebOrder([{ itemId: 'c', quantity: 1, totalCents: 2300 }], {
			subtotalCents: 2300,
			taxCents: 300,
			totalCents: 2300,
		})
		// Station, inclusive tax and a discount adjustment.
		await insertSale([{ itemId: 'd', quantity: 1, baseCents: 1150 }], {
			adjustmentCents: 115,
			taxCents: 135,
			taxInclusive: true,
			tipCents: 500,
			totalCents: 1150 - 115 + 500,
		})

		const sales = await readItemSales(db, range)
		const net = Object.fromEntries(
			sales.items.map((row) => [row.itemId, row.netSalesMinor]),
		)
		expect(net).toEqual({ a: 6375, b: 2125, c: 2000, d: 900 })
	})

	it('keeps currencies apart', async () => {
		await insertWebOrder([{ itemId: 'tea', quantity: 1, totalCents: 500 }])
		await insertWebOrder([{ itemId: 'tea', quantity: 1, totalCents: 300 }], {
			currency: 'usd',
		})
		const sales = await readItemSales(db, range)
		expect(
			sales.items.map((row) => [row.currency, row.quantity, row.netSalesMinor]),
		).toEqual([
			['SAR', 1, 500],
			['USD', 1, 300],
		])
	})

	it('dates web orders in the location’s business day, and Station sales by the till’s date', async () => {
		await db
			.insert(rsvLocationSettings)
			.values({ locationId: LOC, timeZone: 'Asia/Riyadh', dayStartMin: 240 })
		// 2026-11-05 00:30 UTC is 03:30 in Riyadh, before the 04:00 day start:
		// it belongs to 2026-11-04.
		await insertWebOrder([{ itemId: 'late', quantity: 1, totalCents: 100 }], {
			createdAt: new Date(Date.UTC(2026, 10, 5, 0, 30)),
		})
		// 2026-11-05 01:30 UTC is 04:30 in Riyadh: 2026-11-05.
		await insertWebOrder([{ itemId: 'early', quantity: 1, totalCents: 100 }], {
			createdAt: new Date(Date.UTC(2026, 10, 5, 1, 30)),
		})
		// Location B has no settings: its pickup time zone is used.
		await insertWebOrder([{ itemId: 'ny', quantity: 1, totalCents: 100 }], {
			locationId: LOC_B,
			pickupTimezone: 'America/New_York',
			// 2026-11-06 03:00 UTC is 22:00 on the 5th in New York.
			createdAt: new Date(Date.UTC(2026, 10, 6, 3, 0)),
		})
		// The till's date wins even though it was rung up on the 6th (UTC).
		await insertSale([{ itemId: 'till', quantity: 1, baseCents: 100 }], {
			rungUpAt: Date.UTC(2026, 10, 6, 1, 0),
		})

		const sales = await readItemSales(db, {
			fromDate: '2026-11-04',
			toDate: '2026-11-06',
		})
		expect(
			sales.items.map((row) => [row.itemId, row.locationId, row.businessDate]),
		).toEqual([
			['late', LOC, '2026-11-04'],
			['early', LOC, '2026-11-05'],
			['till', LOC, '2026-11-05'],
			['ny', LOC_B, '2026-11-05'],
		])

		// A clock passed in wins over the stored settings.
		const utc = await readItemSales(db, {
			fromDate: '2026-11-05',
			toDate: '2026-11-05',
			locationId: LOC,
			clocks: { [LOC]: { timeZone: 'UTC', dayStartMin: 0 } },
		})
		expect(utc.items.map((row) => row.itemId)).toEqual([
			'early',
			'late',
			'till',
		])
	})

	it('filters by location and by date range', async () => {
		await insertWebOrder([{ itemId: 'x', quantity: 1, totalCents: 100 }])
		await insertWebOrder([{ itemId: 'x', quantity: 1, totalCents: 100 }], {
			locationId: LOC_B,
		})
		await insertSale([{ itemId: 'x', quantity: 1, baseCents: 100 }], {
			locationId: LOC_B,
		})
		await insertSale([{ itemId: 'x', quantity: 1, baseCents: 100 }], {
			businessDate: '2026-11-07',
		})
		const onlyB = await readItemSales(db, { ...range, locationId: LOC_B })
		expect(onlyB.items).toEqual([
			expect.objectContaining({ locationId: LOC_B, quantity: 2 }),
		])
		const all = await readItemSales(db, range)
		expect(all.items.map((row) => [row.locationId, row.quantity])).toEqual([
			[LOC, 1],
			[LOC_B, 2],
		])
		expect(
			(
				await readItemSales(db, {
					fromDate: '2026-11-06',
					toDate: '2026-11-05',
				})
			).items,
		).toEqual([])
		await expect(
			readItemSales(db, { fromDate: '5 Nov', toDate: '2026-11-05' }),
		).rejects.toThrow(RangeError)
	})

	it('leaves out the rounds of a QR tab that was rung up on a Station till', async () => {
		const rungUp = await insertTab(ORG, {
			locationId: LOC,
			rungUpOnStation: true,
			paymentMethod: 'counter',
		})
		const phonePaid = await insertTab(ORG, { locationId: LOC })
		for (const tabId of [rungUp, phonePaid]) {
			await insertWebOrder(
				[{ itemId: 'round', quantity: 1, totalCents: 900 }],
				{
					fulfillment: 'dine_in',
					source: 'qr_table',
					tabId,
				},
			)
		}
		// The till sale for the rung-up tab is what counts.
		await insertSale([{ itemId: 'round', quantity: 1, baseCents: 900 }])
		const sales = await readItemSales(db, range)
		expect(sales.items).toEqual([
			expect.objectContaining({ itemId: 'round', quantity: 2 }),
		])
	})

	it('skips malformed lines and keeps reading', async () => {
		await insertWebOrder([{ itemId: 'ok', quantity: 1, totalCents: 100 }], {
			lines: [
				null,
				{ itemId: '', quantity: 1 },
				{ itemId: 'zero', quantity: 0, totalCents: 5 },
				{
					itemId: 'ok',
					quantity: 1,
					totalCents: 100,
					options: [{ optionId: 'o', quantity: 'x' }],
				},
			],
		})
		const sales = await readItemSales(db, range)
		expect(sales.items.map((row) => row.itemId)).toEqual(['ok'])
		expect(sales.options).toEqual([])
	})
})

describe('item sales arithmetic', () => {
	it('splits a sale’s net over its lines exactly', () => {
		expect(
			allocateSaleNet(1000, [
				{ totalMinor: 1 },
				{ totalMinor: 1 },
				{ totalMinor: 1 },
			]),
		).toEqual([334, 333, 333])
		expect(
			allocateSaleNet(500, [{ totalMinor: 0 }, { totalMinor: 0 }]),
		).toEqual([500, 0])
		expect(allocateSaleNet(-5, [{ totalMinor: 10 }])).toEqual([0])
		expect(allocateSaleNet(100, [])).toEqual([])
	})

	it('reads tax inclusion of web orders from their totals', () => {
		const base = {
			subtotalCents: 1150,
			discountCents: 0,
			loyaltyDiscountCents: 0,
			taxCents: 150,
			tipCents: 0,
			deliveryFeeCents: 0,
			deliveryDiscountCents: 0,
		}
		expect(restaurantOrderNetMinor({ ...base, totalCents: 1150 })).toBe(1000)
		expect(restaurantOrderNetMinor({ ...base, totalCents: 1300 })).toBe(1150)
		expect(
			restaurantOrderNetMinor({ ...base, discountCents: 5000, totalCents: 0 }),
		).toBe(0)
	})

	it('nets Station adjustments and inclusive tax', () => {
		expect(
			posOrderNetMinor({
				subtotalCents: 1000,
				adjustmentCents: 100,
				taxCents: 117,
				taxInclusive: true,
			}),
		).toBe(783)
		expect(
			posOrderNetMinor({
				subtotalCents: 1000,
				adjustmentCents: 100,
				taxCents: 135,
				taxInclusive: false,
			}),
		).toBe(900)
	})

	it('works out Station line totals from base and options', () => {
		expect(
			parseSoldLines(
				[
					{
						itemId: 'latte',
						variantId: null,
						quantity: 2,
						baseCents: 1200,
						options: [{ optionId: 'oat', quantity: 2, unitCents: 200 }],
					},
				],
				'pos',
			),
		).toEqual([
			{
				itemId: 'latte',
				variantId: null,
				quantity: 2,
				totalMinor: 3200,
				options: [{ optionId: 'oat', quantity: 4, half: false }],
			},
		])
	})
})
