import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type MenuRoster } from '@repo/common/slow-sellers'
import { createReportDefinition, runReport, splitLoaderFilters } from '@repo/reports'
import {
	destroyTenantDb,
	getTenantDb,
	menuAvailabilityEvents,
	posOrders,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import { insertPosDevice } from './loyalty-test-fixture.ts'
import {
	loadSlowSellerRecords,
	MenuRosterUnavailableError,
} from './slow-sellers-records.ts'

const roster = vi.hoisted(() => ({ value: null as MenuRoster | null }))
vi.mock('../lib/menu-roster.ts', () => ({
	getMenuRoster: vi.fn(async () => roster.value),
	clearMenuRosterCache: vi.fn(),
}))

const ORG = 'org_slow_sellers_test'
const DAY = 86_400_000
const NOW = new Date(Date.UTC(2026, 10, 25, 12, 0, 0))

function dish(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		createdAt: NOW.getTime() - 200 * DAY,
		availabilityStatus: 'available',
		unavailableUntil: null,
		categoryId: 'c-mains',
		categoryName: 'Mains',
		menuId: 'm1',
		menuName: 'Main',
		price: 10,
		hiddenLocationIds: [],
		...over,
	}
}

function rosterOf(dishes: ReturnType<typeof dish>[]): MenuRoster {
	return {
		orgId: ORG,
		dishes,
		locations: [
			{ id: 'loc_a', name: 'Olaya' },
			{ id: 'loc_b', name: 'Malaz' },
		],
	} as MenuRoster
}

function definition(filters: Array<Record<string, unknown>> = []) {
	return createReportDefinition({
		subject: 'slow_sellers',
		timeframe: { field: 'periodEnd', preset: 'last_30_days' },
		visualization: {
			chartStyle: 'table',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		filters: { combinator: 'and', conditions: filters as never },
		settings: { title: 'Slow sellers', notes: '', timezone: 'UTC' },
	})
}

describe('slow sellers loader (#261)', () => {
	let tempDir: string
	let db: TenantDatabase
	let seq = 0

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-slow-'))
		process.env.TENANT_DB_DIR = tempDir
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		roster.value = rosterOf([
			dish('hot'),
			dish('slow'),
			dish('never'),
			dish('fresh', { createdAt: NOW.getTime() - 5 * DAY }),
		])
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function web(
		itemId: string,
		quantity: number,
		over: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		seq += 1
		const total = quantity * 1000
		await db.insert(restaurantOrders).values({
			orgId: ORG,
			number: `W-${seq}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: 'loc_a',
			locationName: 'Olaya',
			contactName: 'Guest',
			contactPhone: '+966500000000',
			currency: 'sar',
			subtotalCents: total,
			taxCents: 0,
			totalCents: total,
			lines: [
				{
					itemId,
					itemName: itemId,
					variantId: null,
					quantity,
					unitPriceCents: 1000,
					taxableUnitCents: 1000,
					totalCents: total,
					taxableCents: total,
					instructions: null,
					baseUnitCents: 0,
					categoryIds: [],
					options: [],
				},
			],
			idempotencyKey: `idem-${seq}`,
			requestHash: 'hash',
			receiptTokenHash: `receipt-${seq}`,
			createdAt: new Date(NOW.getTime() - 3 * DAY),
			...over,
		})
	}

	async function station(itemId: string, locationId: string) {
		seq += 1
		const deviceId = await insertPosDevice(ORG, { id: `dev_${seq}`, locationId })
		await db.insert(posOrders).values({
			id: `sale_${seq}`,
			deviceId,
			number: `P-${seq}`,
			businessDate: new Date(NOW.getTime() - 3 * DAY).toISOString().slice(0, 10),
			revision: 1,
			status: 'paid',
			orderType: 'takeaway',
			locationId,
			currency: 'SAR',
			subtotalCents: 1000,
			taxCents: 0,
			totalCents: 1000,
			lines: [
				{
					id: 'l1',
					itemId,
					name: itemId,
					variantId: null,
					variantLabel: null,
					quantity: 1,
					baseCents: 1000,
					instructions: '',
					options: [],
				},
			],
			adjustments: [],
			rungUpAt: NOW.getTime() - 3 * DAY,
			receivedAt: NOW.getTime(),
			paidAt: NOW.getTime(),
		})
	}

	async function run(filters: Array<Record<string, unknown>> = [], costAllowed = false) {
		const split = splitLoaderFilters(activeReportCatalog(), definition(filters))
		const loaded = await loadSlowSellerRecords(
			{ db, orgId: ORG, locationIds: null, now: NOW, costAllowed, userId: 'user_1' },
			definition(filters),
			split.loader,
		)
		const result = runReport(activeReportCatalog(), split.definition, loaded.records, NOW)
		if ('error' in result) throw new Error(result.message)
		return result.rows ?? []
	}

	it('lists dishes with zero sales first, then the fewest sold', async () => {
		await web('hot', 9)
		await web('slow', 1)
		const rows = await run()
		expect(rows.map((row) => row.item)).toEqual(['never', 'slow', 'hot', 'fresh'])
		expect(rows[0]).toMatchObject({ 'quantity': '0' })
	})

	it('marks a dish added during the period New and lists it after the ranked dishes', async () => {
		await web('fresh', 1)
		const rows = await run()
		const fresh = rows.find((row) => row.item === 'fresh')!
		expect(fresh.status).toBe('New (added during the period)')
		expect(rows.at(-1)!.item).toBe('fresh')
	})

	it('changes the ranking with the location, channel and category filters', async () => {
		await web('hot', 5, { locationId: 'loc_a' })
		await web('slow', 5, { locationId: 'loc_b', locationName: 'Malaz' })
		await station('slow', 'loc_b')
		// Everywhere: slow (6) is above hot (5) once sold; both ahead of unsold.
		const all = await run()
		expect(all.map((row) => row.item).slice(0, 4)).toEqual([
			'never',
			'hot',
			'slow',
			'fresh',
		])
		// Only Olaya: slow never sold there, so it drops to the top.
		const olaya = await run([{ field: 'locationId', operator: 'eq', value: 'loc_a' }])
		expect(
			olaya
				.map((row) => row.item)
				.slice(0, 2)
				.sort(),
		).toEqual(['never', 'slow'])
		expect(olaya[2]!.item).toBe('hot')
		// Only Station sales: hot sold none there.
		const counter = await run([
			{ field: 'channel', operator: 'eq', value: 'station_counter' },
		])
		expect(counter.find((row) => row.item === 'hot')).toMatchObject({ quantity: '0' })
		expect(counter.find((row) => row.item === 'slow')).toMatchObject({ quantity: '1' })
		// One category.
		roster.value = rosterOf([
			dish('hot'),
			dish('soup', { categoryId: 'c-starters', categoryName: 'Starters' }),
		])
		const starters = await run([
			{ field: 'category', operator: 'eq', value: 'Starters' },
		])
		expect(starters.map((row) => row.item)).toEqual(['soup'])
	})

	it('leaves sold-out time out of the days since last sold', async () => {
		await web('hot', 3, { createdAt: new Date(NOW.getTime() - 10 * DAY) })
		await db.insert(menuAvailabilityEvents).values([
			{
				locationId: 'loc_a',
				entityType: 'item',
				entityId: 'hot',
				event: 'unavailable',
				occurredAt: new Date(NOW.getTime() - 8 * DAY),
			},
			{
				locationId: 'loc_a',
				entityType: 'item',
				entityId: 'hot',
				event: 'available',
				occurredAt: new Date(NOW.getTime() - 4 * DAY),
			},
		])
		// One location in scope, so the sold-out counts (both locations: not off at Malaz).
		const rows = await run([{ field: 'locationId', operator: 'eq', value: 'loc_a' }])
		const hot = rows.find((row) => row.item === 'hot')!
		// Sold 10 days ago and off for 4 of the 10 days since: 6 available days.
		expect(hot.daysSinceLastSold).toBe('6')
		expect(hot.availableWholePeriod).toBe('No')
	})

	it('shows no food cost without the cost grant', async () => {
		const rows = await run([], false)
		expect(rows.every((row) => !('foodCostPercent' in row))).toBe(true)
	})

	it('refuses, with its own error, when the menu cannot be read', async () => {
		roster.value = null
		await expect(
			loadSlowSellerRecords(
				{ db, orgId: ORG, locationIds: null, now: NOW, costAllowed: false, userId: 'u' },
				definition(),
				[],
			),
		).rejects.toBeInstanceOf(MenuRosterUnavailableError)
	})
})
