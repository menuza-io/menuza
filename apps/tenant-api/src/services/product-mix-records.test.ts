import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	buildProductMixTree,
	productMixCurrencies,
} from '@repo/reports/product-mix'
import {
	createReportDefinition,
	runReport,
	type ReportResult,
} from '@repo/reports'
import {
	destroyTenantDb,
	getTenantDb,
	posOrders,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import { readItemSales } from './item-sales.ts'
import { insertPosDevice } from './loyalty-test-fixture.ts'
import {
	loadProductMixRecords,
	loadProductMixRows,
} from './product-mix-records.ts'

const ORG = 'org_product_mix_test'
const LOC = 'loc_a'
const NOON_UTC = Date.UTC(2026, 10, 5, 12, 0, 0)
const NOW = new Date(NOON_UTC + 3_600_000)

type Placement = {
	categoryId: string
	categoryName: string
	menuId: string
	menuName: string
}

const STARTERS: Placement = {
	categoryId: 'cat_starters',
	categoryName: '{"en":"Starters"}',
	menuId: 'menu_main',
	menuName: 'Main menu',
}
const MAINS: Placement = {
	categoryId: 'cat_mains',
	categoryName: 'Mains',
	menuId: 'menu_main',
	menuName: 'Main menu',
}

function webLine(
	itemId: string,
	itemName: string,
	quantity: number,
	totalCents: number,
	placement: Placement | null,
	options: Array<{ id: string; name: string; group: string; cents: number }> = [],
) {
	return {
		itemId,
		itemName,
		variantId: null,
		quantity,
		unitPriceCents: Math.round(totalCents / quantity),
		taxableUnitCents: Math.round(totalCents / quantity),
		totalCents,
		taxableCents: totalCents,
		instructions: null,
		baseUnitCents: 0,
		categoryIds: placement ? [placement.categoryId] : [],
		...(placement ?? {}),
		options: options.map((option) => ({
			groupId: `g_${option.group}`,
			groupName: option.group,
			optionId: option.id,
			optionName: option.name,
			half: null,
			quantity: 1,
			priceCents: option.cents,
			totalCents: option.cents,
		})),
	}
}

function dateRange() {
	return createReportDefinition({
		subject: 'product_mix',
		timeframe: {
			field: 'occurredAt',
			preset: 'custom',
			start: new Date(NOON_UTC - 86_400_000).toISOString(),
			end: new Date(NOON_UTC + 7_200_000).toISOString(),
		},
		groupBy: ['category'],
		visualization: {
			chartStyle: 'table',
			measure: 'share',
			valueField: 'sales',
			sortBy: 'value_desc',
			hideCounts: false,
		},
		settings: { title: 'Sales by category', notes: '', timezone: 'UTC' },
	})
}

describe('product mix records (#227)', () => {
	let tempDir: string
	let db: TenantDatabase
	let sequence = 0

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-product-mix-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function web(
		lines: ReturnType<typeof webLine>[],
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
			lines,
			idempotencyKey: `idem-${sequence}`,
			requestHash: 'hash',
			receiptTokenHash: `receipt-${sequence}`,
			createdAt: new Date(NOON_UTC),
			...overrides,
		})
	}

	async function station(
		itemId: string,
		name: string,
		baseCents: number,
		lineCatalog: Record<string, Placement> | null,
	) {
		sequence += 1
		const deviceId = await insertPosDevice(ORG, {
			id: `dev_${sequence}`,
			locationId: LOC,
		})
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
			subtotalCents: baseCents,
			taxCents: 0,
			totalCents: baseCents,
			lines: [
				{
					id: 'l1',
					itemId,
					name,
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents,
					instructions: '',
					options: [],
				},
			],
			lineCatalog,
			adjustments: [],
			rungUpAt: NOON_UTC,
			receivedAt: NOON_UTC,
			paidAt: NOON_UTC,
		})
	}

	const ctx = () => ({ db, locationIds: null, now: NOW })

	it('category totals add up to the sales total for the same filters', async () => {
		await web([
			webLine('soup', 'Soup', 2, 3000, STARTERS),
			webLine('burger', 'Burger', 1, 5000, MAINS, [
				{ id: 'cheese', name: 'Cheese', group: 'Extras', cents: 500 },
			]),
		])
		await station('burger', 'Burger', 4000, { burger: MAINS })
		await station('soup', 'Soup', 1500, { soup: STARTERS })

		const { records } = await loadProductMixRecords(ctx(), dateRange(), 'dish')
		const result = runReport(
			activeReportCatalog(),
			dateRange(),
			records,
			NOW,
		) as ReportResult
		const items = await readItemSales(db, {
			fromDate: '2026-11-05',
			toDate: '2026-11-05',
		})
		const itemsNet = items.items.reduce((sum, row) => sum + row.netSalesMinor, 0)
		// The groups' amounts add up to the items-sold reader's total ...
		const amounts = result.segments.map((segment) => segment.amount ?? 0)
		expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100)).toBe(itemsNet)
		// ... and the shares of the one currency add up to 100.
		const shares = result.segments.reduce((sum, s) => sum + (s.value ?? 0), 0)
		expect(shares).toBeCloseTo(100, 5)
		expect(result.segments.map((segment) => segment.label).sort()).toEqual([
			'Mains',
			'Starters',
		])
	})

	it('reads Station sales through the stamp the region wrote at upload', async () => {
		await station('burger', 'Burger', 4000, { burger: MAINS })
		const { rows } = await loadProductMixRows(
			ctx(),
			{ fromMs: NOON_UTC - 86_400_000, toMs: NOON_UTC + 7_200_000 },
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'dish',
			category: 'Mains',
			menu: 'Main menu',
			item: 'Burger',
			salesMinor: 4000,
			currency: 'SAR',
		})
	})

	it('does not rename last month\'s sales when a category is renamed today', async () => {
		const before = { ...STARTERS, categoryName: 'Starters' }
		const after = { ...STARTERS, categoryName: 'Appetizers' }
		await web([webLine('soup', 'Soup', 1, 1000, before)], {
			createdAt: new Date(NOON_UTC - 40 * 86_400_000),
		})
		await web([webLine('soup', 'Soup', 1, 1200, after)])
		const { rows } = await loadProductMixRows(ctx(), {
			fromMs: NOON_UTC - 60 * 86_400_000,
			toMs: NOON_UTC + 7_200_000,
		})
		const categories = rows
			.filter((row) => row.kind === 'dish')
			.map((row) => [row.categoryId, row.category, row.salesMinor])
			.sort()
		// Same category id, two names: each sale keeps the name it had.
		expect(categories).toEqual([
			['cat_starters', 'Appetizers', 1200],
			['cat_starters', 'Starters', 1000],
		])
	})

	it('groups lines with no stamp under Earlier sales and still counts them', async () => {
		await web([webLine('soup', 'Soup', 1, 1000, null)])
		await station('burger', 'Burger', 4000, null)
		const { rows } = await loadProductMixRows(ctx(), {
			fromMs: NOON_UTC - 86_400_000,
			toMs: NOON_UTC + 7_200_000,
		})
		expect(rows.map((row) => row.category)).toEqual([
			'Earlier sales',
			'Earlier sales',
		])
		const tree = buildProductMixTree(rows, ['category'], 'SAR')
		expect(tree.nodes).toHaveLength(1)
		expect(tree.nodes[0]!.label).toBe('Earlier sales')
		expect(tree.total.salesMinor).toBe(5000)
	})

	it('keeps option sales inside the dish and never mixes currencies', async () => {
		await web([
			webLine('burger', 'Burger', 1, 5000, MAINS, [
				{ id: 'cheese', name: 'Cheese', group: 'Extras', cents: 500 },
			]),
		])
		await web([webLine('tea', 'Tea', 1, 700, MAINS)], { currency: 'usd' })
		const { rows } = await loadProductMixRows(ctx(), {
			fromMs: NOON_UTC - 86_400_000,
			toMs: NOON_UTC + 7_200_000,
		})
		expect(productMixCurrencies(rows)).toEqual(['SAR', 'USD'])
		const sar = buildProductMixTree(rows, ['dish', 'optionGroup', 'option'], 'SAR')
		expect(sar.total.salesMinor).toBe(5000)
		const burger = sar.nodes.find((node) => node.label === 'Burger')!
		expect(burger.salesMinor).toBe(5000)
		// Cheese is charged 500 of the 5000: its share of the net, an of-which.
		expect(burger.children[0]!.children[0]!.salesMinor).toBe(500)
		expect(buildProductMixTree(rows, ['dish'], 'USD').total.salesMinor).toBe(700)
	})
})
