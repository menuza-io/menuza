import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	MENU_POPULAR_PATH,
	MENU_POPULAR_WINDOW_DAYS,
} from '@repo/common/menu-popular'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	postMenuPopular,
	runMenuPopularTickForOrg,
} from '../services/popular-items-service.ts'
import { menuPopularTickRoutes } from './menu-popular-tick.ts'

const ORG = 'org_menu_popular_tick'
const LOC = 'loc_pop_a'
const NOON_UTC = Date.UTC(2026, 10, 21, 12, 0, 0)
const TOKEN = 'test-internal-command-token-123456'

function webLines(items: Array<{ itemId: string; quantity: number }>) {
	return items.map((line) => ({
		itemId: line.itemId,
		itemName: '{"en":"Dish"}',
		variantId: null,
		quantity: line.quantity,
		unitPriceCents: 1000,
		taxableUnitCents: 1000,
		totalCents: line.quantity * 1000,
		taxableCents: line.quantity * 1000,
		instructions: null,
		baseUnitCents: 0,
		categoryIds: [],
		options: [],
	}))
}

describe('menu-popular tick & popular-items-service', () => {
	let tempDir: string
	let db: TenantDatabase
	let sequence = 0
	const prevToken = process.env.INTERNAL_COMMAND_TOKEN
	const prevAppUrl = process.env.APP_URL

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-popular-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.INTERNAL_COMMAND_TOKEN = TOKEN
		process.env.APP_URL = 'https://app.example.test'
		syncEnvFromProcess()
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		if (prevToken === undefined) delete process.env.INTERNAL_COMMAND_TOKEN
		else process.env.INTERNAL_COMMAND_TOKEN = prevToken
		if (prevAppUrl === undefined) delete process.env.APP_URL
		else process.env.APP_URL = prevAppUrl
		syncEnvFromProcess()
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function insertWebOrder(
		items: Array<{ itemId: string; quantity: number }>,
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		sequence += 1
		const subtotal = items.reduce((sum, i) => sum + i.quantity * 1000, 0)
		await db.insert(restaurantOrders).values({
			orgId: ORG,
			number: `MP-${sequence}`,
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC,
			locationName: 'Main',
			contactName: 'Guest',
			contactPhone: '+966500000000',
			currency: 'sar',
			subtotalCents: subtotal,
			taxCents: 0,
			totalCents: subtotal,
			lines: webLines(items),
			idempotencyKey: `mp-idem-${sequence}`,
			requestHash: 'hash',
			receiptTokenHash: `mp-receipt-${sequence}`,
			createdAt: new Date(NOON_UTC),
			...overrides,
		})
	}

	it('rejects unauthenticated requests on POST /api/menu/popular/tick', async () => {
		const app = new Hono()
		app.route('/api/menu/popular', menuPopularTickRoutes)

		const unauth = await app.request('/api/menu/popular/tick', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ orgId: ORG }),
		})
		expect(unauth.status).toBe(401)

		const wrong = await app.request('/api/menu/popular/tick', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: 'Bearer wrong-token-1234567890',
			},
			body: JSON.stringify({ orgId: ORG }),
		})
		expect(wrong.status).toBe(401)
	})

	it('posts empty itemIds when fewer than 20 dishes were sold in 28 days', async () => {
		await insertWebOrder([{ itemId: 'item_a', quantity: 10 }])
		await insertWebOrder([{ itemId: 'item_b', quantity: 9 }])
		// Cancelled order must not count toward threshold
		await insertWebOrder([{ itemId: 'item_c', quantity: 50 }], {
			status: 'cancelled',
		})

		const sent: unknown[] = []
		const result = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC,
			post: async (payload) => {
				sent.push(payload)
				return { status: 'applied', updated: 2 }
			},
		})

		expect(result).toEqual({
			ran: true,
			updated: 2,
			itemIdsCount: 0,
			skipped: undefined,
			errors: 0,
		})
		expect(sent).toEqual([
			{ orgId: ORG, itemIds: [], windowDays: MENU_POPULAR_WINDOW_DAYS },
		])
	})

	it('ranks top-selling itemIds within 28 days, ignores older/cancelled orders, and sends only IDs', async () => {
		await insertWebOrder([
			{ itemId: 'item_second', quantity: 12 },
			{ itemId: 'item_first', quantity: 15 },
			{ itemId: 'item_third', quantity: 5 },
		])
		// Order outside 28-day window (30 days ago) should be ignored
		await insertWebOrder([{ itemId: 'item_old', quantity: 100 }], {
			createdAt: new Date(NOON_UTC - 30 * 86_400_000),
		})

		const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input)
				const body = JSON.parse(String(init?.body ?? '{}')) as Record<
					string,
					unknown
				>
				fetchCalls.push({ url, body })
				return new Response(JSON.stringify({ updated: 3 }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			}),
		)

		const result = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC,
			post: postMenuPopular,
		})

		expect(result.errors).toBe(0)
		expect(result.ran).toBe(true)
		expect(result.updated).toBe(3)
		expect(fetchCalls).toHaveLength(1)
		expect(fetchCalls[0]!.url).toBe(
			`https://app.example.test${MENU_POPULAR_PATH}`,
		)
		// Strictly only { orgId, itemIds, windowDays } — no sales counts or PII
		expect(Object.keys(fetchCalls[0]!.body).sort()).toEqual([
			'itemIds',
			'orgId',
			'windowDays',
		])
		expect(fetchCalls[0]!.body).toEqual({
			orgId: ORG,
			itemIds: ['item_first', 'item_second', 'item_third'],
			windowDays: MENU_POPULAR_WINDOW_DAYS,
		})
	})

	it('runs at most once per org per day, but retries after a retryable App error', async () => {
		await insertWebOrder([{ itemId: 'item_a', quantity: 25 }])

		const failResult = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC,
			post: async () => ({ status: 'retry', code: 'http_500' }),
		})
		expect(failResult.deferred).toBe(true)
		expect(failResult.errors).toBe(1)

		// Because the first attempt failed with retry, a second run the same day proceeds
		const okResult = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC + 3_600_000,
			post: async () => ({ status: 'applied', updated: 1 }),
		})
		expect(okResult.ran).toBe(true)
		expect(okResult.errors).toBe(0)

		// A third run on the same UTC day is skipped
		const skippedResult = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC + 7_200_000,
			post: async () => {
				throw new Error('should not be called')
			},
		})
		expect(skippedResult).toEqual({
			ran: false,
			updated: 0,
			itemIdsCount: 0,
			skipped: 'already_ran_today',
			errors: 0,
		})

		// Next UTC day runs again
		const nextDayResult = await runMenuPopularTickForOrg(ORG, {
			now: NOON_UTC + 86_400_000,
			post: async () => ({ status: 'applied', updated: 1 }),
		})
		expect(nextDayResult.ran).toBe(true)
		expect(nextDayResult.errors).toBe(0)
	})
})
