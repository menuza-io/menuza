import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	dishPhotoDaily,
	dishPhotoOrderLines,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import {
	PHOTO_TEST_MAX_DAILY_ROWS,
	PHOTO_TEST_MAX_ROW_COUNT,
} from '@repo/common/photo-test-events'
import type { PhotoTestResultsResponse } from '@repo/common/photo-test-results'
import { eq, getTableColumns } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRateLimits } from '../lib/rate-limit.ts'
import {
	countDishPhotoEvents,
	readPhotoTestResults,
} from '../services/dish-photo-tests.ts'
import { orderCountsTowardSales } from '../services/report-records.ts'
import { orderCountsAsPhotoTestWin } from '@repo/common/photo-test'
import { publicFormRoutes } from './forms.ts'
import { photoTestOperatorRoutes } from './operator-photo-tests.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/origin.ts')>()
	const findActiveOrganizationById = vi.fn()
	return {
		...actual,
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'

/**
 * Dish photo tests (#192), regional side: the counter beacon, the photo each
 * ordered dish showed, and the results the App reads.
 */

const orgId = 'org_photo_tests_1'
const otherOrgId = 'org_photo_tests_2'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const OTHER_ORG = {
	id: otherOrgId,
	slug: 'other-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const ORIGINS: Record<string, typeof ORG> = {
	'https://test-org.example.com': ORG,
	'https://other-org.example.com': OTHER_ORG,
}
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-03-10T12:00:00.000Z').getTime()
const OPERATOR_SECRET = 'test-operator-token-very-long-and-secure-12345'
const TEST_ID = 'test_burger_1'
const OTHER_TEST_ID = 'test_fries__1'
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

function orderContext(id: string) {
	return {
		orgId: id,
		dataRegion: 'us',
		menu: {
			organization: {
				id,
				slug: 'test-org',
				currency: 'USD',
				defaultLocale: 'en',
			},
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-burger',
									displayName: 'Burger',
									price: 10,
									availabilityStatus: 'available',
								},
								{
									id: 'item-fries',
									displayName: 'Fries',
									price: 4,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
	}
}

// The key the App signs into the menu payload for (organization, test, dish).
function signedKeyFor(testId: string, itemId: string, forOrg = orgId) {
	return crypto
		.createHmac('sha256', OPERATOR_SECRET)
		.update(`photo-test:v1:${forOrg}:${testId}:${itemId}`)
		.digest('base64url')
		.slice(0, 32)
}

/** Signs the photo-test entries of an order body the way the App's menu does. */
function withSignedEntries(overrides: Record<string, unknown>) {
	const entries = overrides.photoTests
	if (!Array.isArray(entries)) return overrides
	return {
		...overrides,
		photoTests: entries.map((entry) =>
			entry &&
			typeof entry === 'object' &&
			!('key' in entry) &&
			/^[A-Za-z0-9_-]{8,40}$/.test((entry as { testId: string }).testId)
				? {
						...entry,
						key: signedKeyFor(
							(entry as { testId: string }).testId,
							(entry as { itemId: string }).itemId,
						),
					}
				: entry,
		),
	}
}

function orderBody(rawOverrides: Record<string, unknown> = {}) {
	const overrides = withSignedEntries(rawOverrides)
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

const mint = (claims: { org?: string; scope?: string } = {}) =>
	new SignJWT({
		orgId: claims.org ?? orgId,
		role: 'operator',
		scope: claims.scope ?? 'photo_tests',
	})
		.setSubject('user-1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('5m')
		.sign(new TextEncoder().encode(OPERATOR_SECRET))

describe('dish photo tests (#192)', () => {
	let directory: string
	let app: Hono
	const orderHeaders = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dish-photo-tests-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('DISH_PHOTO_TESTS_ENABLED', '')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_SECRET)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(orderContext(orgId)), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (origin, identity) => {
				const organization = origin ? ORIGINS[origin] : undefined
				if (!organization) return null
				// The slug hint, when sent, must be this origin's own.
				if (identity?.slug && identity.slug !== organization.slug) return null
				return organization as never
			},
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId
				? (ORG as never)
				: id === otherOrgId
					? (OTHER_ORG as never)
					: null,
		)
		resetRateLimits()
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		app = new Hono()
		app.route('/forms', publicFormRoutes)
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/photo-tests', photoTestOperatorRoutes)
	})

	afterEach(async () => {
		vi.useRealTimers()
		try {
			await destroyTenantDb(orgId)
			await destroyTenantDb(otherOrgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		resetRateLimits()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// The key the App signs into the menu payload for (organization, test, dish).
	const signedKey = signedKeyFor
	const event = (
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> => {
		const base = {
			testId: TEST_ID,
			itemId: 'item-burger',
			variant: 'A',
			event: 'view',
			...overrides,
		}
		return {
			key: signedKey(base.testId as string, base.itemId as string),
			...base,
		}
	}
	const beacon = (
		body: unknown,
		origin: string | null = 'https://test-org.example.com',
	) =>
		app.request('/forms/dish-photo-events', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(origin ? { Origin: origin } : {}),
			},
			body: JSON.stringify({ slug: 'test-org', ...(body as object) }),
		})
	const rows = async (id = orgId) =>
		(await getTenantDb(id)).select().from(dishPhotoDaily)

	describe('the counter beacon', () => {
		it('holds no visitor id, address or user agent anywhere', () => {
			expect(Object.keys(getTableColumns(dishPhotoDaily)).sort()).toEqual([
				'adds',
				'day',
				'itemId',
				'testId',
				'variant',
				'views',
			])
			expect(Object.keys(getTableColumns(dishPhotoOrderLines)).sort()).toEqual([
				'itemId',
				'orderId',
				'testId',
				'variant',
			])
		})

		it('counts views and adds per photo and accumulates over requests', async () => {
			const res = await beacon({
				events: [
					event(),
					event(),
					event({ event: 'add' }),
					event({ variant: 'B' }),
					event({ itemId: 'item-fries' }),
				],
			})
			expect(res.status).toBe(204)
			await beacon({ events: [event(), event({ variant: 'B', event: 'add' })] })
			const all = await rows()
			expect(all).toHaveLength(3)
			const find = (itemId: string, variant: string) =>
				all.find((r) => r.itemId === itemId && r.variant === variant)
			expect(find('item-burger', 'A')).toMatchObject({
				day: '2026-03-10',
				testId: TEST_ID,
				views: 3,
				adds: 1,
			})
			expect(find('item-burger', 'B')).toMatchObject({ views: 1, adds: 1 })
			expect(find('item-fries', 'A')).toMatchObject({ views: 1, adds: 0 })
		})

		it('counts only events for a test the App signed: invented ids count nothing', async () => {
			// A forged key, a key for another dish, another organization's key and
			// a missing key are all dropped silently (204, nothing written).
			const forged = event({ key: 'f'.repeat(32) })
			const otherDish = {
				...event({ itemId: 'item-fries' }),
				key: signedKey(TEST_ID, 'item-burger'),
			}
			const otherOrg = {
				...event(),
				key: signedKey(TEST_ID, 'item-burger', otherOrgId),
			}
			const { key: _dropped, ...noKey } = event() as Record<string, unknown>
			for (const bad of [forged, otherDish, otherOrg, noKey]) {
				const res = await beacon({ events: [bad] })
				expect(res.status).toBe(204)
			}
			expect(await rows()).toHaveLength(0)
			// A batch with one real and one invented event counts only the real one.
			await beacon({
				events: [
					event(),
					event({ testId: 'invented_test_9', key: 'x'.repeat(32) }),
				],
			})
			const all = await rows()
			expect(all).toHaveLength(1)
			expect(all[0]).toMatchObject({ testId: TEST_ID, views: 1 })
		})

		it('counts nothing on a node without the shared secret', async () => {
			vi.stubEnv('TENANT_OPERATOR_TOKEN', '')
			await beacon({ events: [event()] })
			expect(await rows()).toHaveLength(0)
		})

		it('stops counting a row past the daily count cap, so a replayed key cannot run away', async () => {
			const db = await getTenantDb(orgId)
			await db.insert(dishPhotoDaily).values({
				day: '2026-03-10',
				testId: TEST_ID,
				itemId: 'item-burger',
				variant: 'A',
				views: PHOTO_TEST_MAX_ROW_COUNT - 1,
				adds: 0,
			})
			await beacon({ events: [event(), event(), event({ event: 'add' })] })
			const row = (await rows()).find(
				(r) => r.itemId === 'item-burger' && r.variant === 'A',
			)!
			// The row took the events up to the cap in one statement, then stopped.
			expect(row.views + row.adds).toBeGreaterThanOrEqual(
				PHOTO_TEST_MAX_ROW_COUNT,
			)
			await beacon({ events: [event()] })
			const after = (await rows()).find(
				(r) => r.itemId === 'item-burger' && r.variant === 'A',
			)!
			expect(after.views + after.adds).toBe(row.views + row.adds)
		})

		it('counts per UTC day', async () => {
			await beacon({ events: [event()] })
			vi.setSystemTime(NOW + DAY)
			await beacon({ events: [event(), event()] })
			const all = await rows()
			expect(all.map((r) => [r.day, r.views]).sort()).toEqual([
				['2026-03-10', 1],
				['2026-03-11', 2],
			])
		})

		it('answers 204 and writes nothing for a bad body', async () => {
			const bad: unknown[] = [
				{ events: [] },
				{ events: [event({ variant: 'C' })] },
				{ events: [event({ event: 'order' })] },
				{ events: [event({ testId: 'short' })] },
				{ events: [event({ itemId: '' })] },
				{ events: [event({ clientId: 'abc' })] },
				{ events: [event()], visitorId: 'abc' },
				{ events: Array.from({ length: 51 }, () => event()) },
				{ nothing: true },
			]
			for (const body of bad) {
				expect((await beacon(body)).status, JSON.stringify(body)).toBe(204)
			}
			const notJson = await app.request('/forms/dish-photo-events', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: 'https://test-org.example.com',
				},
				body: 'not json',
			})
			expect(notJson.status).toBe(204)
			expect(await rows()).toHaveLength(0)
		})

		it('takes a full batch of 50 events', async () => {
			const res = await beacon({
				events: Array.from({ length: 50 }, (_, i) =>
					event({ itemId: `dish-${i % 10}` }),
				),
			})
			expect(res.status).toBe(204)
			const all = await rows()
			expect(all).toHaveLength(10)
			expect(all.reduce((sum, r) => sum + r.views, 0)).toBe(50)
		})

		it('answers 204 for an oversized request without counting it', async () => {
			const res = await beacon({
				events: [event()],
				slug: 'x'.repeat(40 * 1024),
			})
			expect(res.status).toBe(204)
			expect(await rows()).toHaveLength(0)
		})

		it('names the organization by the browser Origin only', async () => {
			await beacon({ events: [event()] })
			const theirs = () => ({
				...event(),
				key: signedKey(TEST_ID, 'item-burger', otherOrgId),
			})
			await beacon(
				{ slug: 'other-org', events: [theirs(), theirs()] },
				'https://other-org.example.com',
			)
			// slug says test-org, origin is other-org: refused, nothing counted.
			await beacon({ events: [event()] }, 'https://other-org.example.com')
			expect((await rows(orgId)).map((r) => r.views)).toEqual([1])
			expect((await rows(otherOrgId)).map((r) => r.views)).toEqual([2])
		})

		it('is silent for a foreign origin, a missing origin or a mismatching host or slug', async () => {
			expect(
				(await beacon({ events: [event()] }, 'https://evil.example')).status,
			).toBe(204)
			expect((await beacon({ events: [event()] }, null)).status).toBe(204)
			expect(
				(await beacon({ events: [event()], slug: 'other-org' })).status,
			).toBe(204)
			expect(await rows(orgId)).toHaveLength(0)
			expect(await rows(otherOrgId)).toHaveLength(0)
		})

		it('counts nothing while the node kill switch is off, for every off word', async () => {
			for (const value of ['false', '0', 'off', 'no', 'disabled', ' FALSE ']) {
				vi.stubEnv('DISH_PHOTO_TESTS_ENABLED', value)
				expect((await beacon({ events: [event()] })).status).toBe(204)
			}
			expect(await rows()).toHaveLength(0)
			vi.stubEnv('DISH_PHOTO_TESTS_ENABLED', 'true')
			await beacon({ events: [event()] })
			expect(await rows()).toHaveLength(1)
		})

		it('limits one address to 20 requests a minute', async () => {
			vi.stubEnv('NODE_ENV', 'production')
			resetRateLimits()
			for (let i = 0; i < 20; i++) {
				expect((await beacon({ events: [event()] })).status).toBe(204)
			}
			const limited = await beacon({ events: [event()] })
			expect(limited.status).toBe(429)
			expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
			expect((await rows())[0]!.views).toBe(20)
		})

		it('caps distinct rows per organization per day, existing rows keep counting', async () => {
			const db = await getTenantDb(orgId)
			await db.insert(dishPhotoDaily).values(
				Array.from({ length: PHOTO_TEST_MAX_DAILY_ROWS - 1 }, (_, i) => ({
					day: '2026-03-10',
					testId: TEST_ID,
					itemId: `seed-${i}`,
					variant: 'A' as const,
					views: 1,
					adds: 0,
				})),
			)
			// The last free slot, then the cap.
			await beacon({ events: [event({ itemId: 'last-slot' })] })
			expect(await rows()).toHaveLength(PHOTO_TEST_MAX_DAILY_ROWS)
			await beacon({ events: [event({ itemId: 'one-too-many' })] })
			await beacon({ events: [event({ itemId: 'last-slot', event: 'add' })] })
			await beacon({ events: [event({ itemId: 'seed-0' })] })
			const all = await rows()
			expect(all).toHaveLength(PHOTO_TEST_MAX_DAILY_ROWS)
			expect(all.find((r) => r.itemId === 'one-too-many')).toBeUndefined()
			expect(all.find((r) => r.itemId === 'last-slot')).toMatchObject({
				views: 1,
				adds: 1,
			})
			expect(all.find((r) => r.itemId === 'seed-0')!.views).toBe(2)
			// The cap is per day and per organization.
			vi.setSystemTime(NOW + DAY)
			await beacon({ events: [event({ itemId: 'next-day' })] })
			expect((await rows()).find((r) => r.itemId === 'next-day')).toBeDefined()
			await beacon(
				{
					slug: 'other-org',
					events: [
						{ ...event(), key: signedKey(TEST_ID, 'item-burger', otherOrgId) },
					],
				},
				'https://other-org.example.com',
			)
			expect(await rows(otherOrgId)).toHaveLength(1)
		})
	})

	describe('orders', () => {
		const postOrder = (body: unknown) =>
			app.request('/orders', {
				method: 'POST',
				headers: orderHeaders,
				body: JSON.stringify(body),
			})
		async function place(overrides: Record<string, unknown> = {}) {
			const res = await postOrder(orderBody(overrides))
			expect(res.status, await res.clone().text()).toBe(201)
			return ((await res.json()) as { order: { id: string } }).order.id
		}
		const lines = async () =>
			(await getTenantDb(orgId)).select().from(dishPhotoOrderLines)
		const tests = [
			{ testId: TEST_ID, itemId: 'item-burger', variant: 'B' },
			{ testId: OTHER_TEST_ID, itemId: 'item-fries', variant: 'A' },
		]

		it('stores only the entries for dishes in the order', async () => {
			const id = await place({ photoTests: tests })
			expect(await lines()).toEqual([
				{
					orderId: id,
					testId: TEST_ID,
					itemId: 'item-burger',
					variant: 'B',
				},
			])
		})

		it('credits an order only to a test the App signed: forged, foreign or missing keys store nothing but the order is placed', async () => {
			const forged = {
				testId: TEST_ID,
				itemId: 'item-burger',
				variant: 'B',
				key: 'f'.repeat(32),
			}
			const otherDish = {
				testId: TEST_ID,
				itemId: 'item-burger',
				variant: 'B',
				key: signedKeyFor(TEST_ID, 'item-fries'),
			}
			const otherOrg = {
				testId: TEST_ID,
				itemId: 'item-burger',
				variant: 'B',
				key: signedKeyFor(TEST_ID, 'item-burger', otherOrgId),
			}
			await place({ photoTests: [forged] })
			await place({ photoTests: [otherDish] })
			await place({ photoTests: [otherOrg] })
			expect(await lines()).toEqual([])
			// One real entry among bad ones is kept, the bad ones are not.
			const id = await place({
				photoTests: [
					forged,
					{ testId: TEST_ID, itemId: 'item-burger', variant: 'A' },
				],
			})
			expect(await lines()).toEqual([
				{ orderId: id, testId: TEST_ID, itemId: 'item-burger', variant: 'A' },
			])
		})

		it('a node without the shared secret credits no order to a test', async () => {
			vi.stubEnv('TENANT_OPERATOR_TOKEN', '')
			await place({ photoTests: tests })
			expect(await lines()).toEqual([])
		})

		it('keeps the first entry of a duplicated test and dish', async () => {
			const id = await place({
				photoTests: [
					{ testId: TEST_ID, itemId: 'item-burger', variant: 'B' },
					{ testId: TEST_ID, itemId: 'item-burger', variant: 'A' },
				],
			})
			expect(await lines()).toEqual([
				{ orderId: id, testId: TEST_ID, itemId: 'item-burger', variant: 'B' },
			])
		})

		it('stores nothing for an order without the key, and behaves as before', async () => {
			const plain = await place()
			expect(await lines()).toEqual([])
			const db = await getTenantDb(orgId)
			const [row] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, plain))
			expect(row).toMatchObject({
				status: 'accepted',
				paymentMethod: 'handoff',
			})
			// An entry for no dish in the cart stores nothing either.
			await place({
				photoTests: [{ testId: TEST_ID, itemId: 'item-fries', variant: 'A' }],
			})
			expect(await lines()).toEqual([])
		})

		it('refuses a malformed key and places nothing', async () => {
			for (const photoTests of [
				[{ testId: TEST_ID, itemId: 'item-burger', variant: 'C' }],
				[{ testId: 'short', itemId: 'item-burger', variant: 'A' }],
				[{ testId: TEST_ID, itemId: 'item-burger', variant: 'A', extra: 1 }],
				Array.from({ length: 21 }, () => ({
					testId: TEST_ID,
					itemId: 'item-burger',
					variant: 'A',
				})),
			]) {
				expect((await postOrder(orderBody({ photoTests }))).status).toBe(400)
			}
			const db = await getTenantDb(orgId)
			expect(await db.select().from(restaurantOrders)).toHaveLength(0)
		})

		it('is not part of the idempotency hash: a retry with other photo tests replays the same order', async () => {
			const idempotencyKey = crypto.randomUUID()
			const first = await postOrder(orderBody({ idempotencyKey }))
			expect(first.status).toBe(201)
			const retry = await postOrder(
				orderBody({
					idempotencyKey,
					photoTests: [
						{ testId: TEST_ID, itemId: 'item-burger', variant: 'B' },
					],
				}),
			)
			expect(retry.status, await retry.clone().text()).toBe(200)
			expect(((await retry.json()) as { order: { id: string } }).order.id).toBe(
				((await first.json()) as { order: { id: string } }).order.id,
			)
			// The replay recorded nothing again.
			expect(await lines()).toEqual([])
		})

		it('deletes the lines with the order', async () => {
			const id = await place({ photoTests: tests })
			const db = await getTenantDb(orgId)
			await db.delete(restaurantOrders).where(eq(restaurantOrders.id, id))
			expect(await lines()).toEqual([])
		})
	})

	describe('results', () => {
		const post = (body: unknown, token: string | null) =>
			app.request('/operator/photo-tests/results', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			})
		const query = async (
			testList: Array<{
				testId?: string
				itemId?: string
				startedAt: number
				endedAt: number | null
			}>,
			token?: string,
		) => {
			const res = await post(
				{
					tests: testList.map((t) => ({
						testId: TEST_ID,
						itemId: 'item-burger',
						...t,
					})),
				},
				token ?? (await mint()),
			)
			expect(res.status, await res.clone().text()).toBe(200)
			expect(res.headers.get('cache-control')).toBe('private, no-store')
			return ((await res.json()) as PhotoTestResultsResponse).results
		}

		async function placeOrder(
			variant: 'A' | 'B',
			options: { id?: string; itemId?: string; testId?: string } = {},
		) {
			const itemId = options.itemId ?? 'item-burger'
			const res = await app.request('/orders', {
				method: 'POST',
				headers: orderHeaders,
				body: JSON.stringify(
					orderBody({
						lines: [{ itemId, quantity: 1, options: [] }],
						photoTests: [
							{ testId: options.testId ?? TEST_ID, itemId, variant },
						],
					}),
				),
			})
			expect(res.status, await res.clone().text()).toBe(201)
			return ((await res.json()) as { order: { id: string } }).order.id
		}
		async function patchOrder(
			id: string,
			set: Partial<typeof restaurantOrders.$inferInsert>,
		) {
			const db = await getTenantDb(orgId)
			await db
				.update(restaurantOrders)
				.set(set)
				.where(eq(restaurantOrders.id, id))
		}

		it('reads views, adds and orders per photo', async () => {
			await beacon({
				events: [
					...Array.from({ length: 5 }, () => event()),
					...Array.from({ length: 4 }, () => event({ variant: 'B' })),
					event({ event: 'add' }),
					event({ variant: 'B', event: 'add' }),
					event({ variant: 'B', event: 'add' }),
				],
			})
			await placeOrder('A')
			await placeOrder('B')
			await placeOrder('B')
			const [result] = await query([{ startedAt: NOW - DAY, endedAt: null }])
			expect(result).toEqual({
				testId: TEST_ID,
				itemId: 'item-burger',
				A: { views: 5, adds: 1, orders: 1 },
				B: { views: 4, adds: 2, orders: 2 },
			})
		})

		it('answers zeros for a test with no counts', async () => {
			expect(await query([{ startedAt: NOW - DAY, endedAt: null }])).toEqual([
				{
					testId: TEST_ID,
					itemId: 'item-burger',
					A: { views: 0, adds: 0, orders: 0 },
					B: { views: 0, adds: 0, orders: 0 },
				},
			])
		})

		it('counts only the test and the dish asked for', async () => {
			await beacon({
				events: [
					event(),
					event({ itemId: 'item-fries' }),
					event({ testId: OTHER_TEST_ID }),
				],
			})
			await placeOrder('A', { itemId: 'item-fries', testId: OTHER_TEST_ID })
			const [result] = await query([{ startedAt: NOW - DAY, endedAt: null }])
			expect(result).toMatchObject({
				A: { views: 1, adds: 0, orders: 0 },
				B: { views: 0, orders: 0 },
			})
		})

		it('does not count cancelled, rejected, unpaid, pending or refunded orders; counts paid and completed ones', async () => {
			const counted = await placeOrder('A')
			const completed = await placeOrder('A')
			await patchOrder(completed, { status: 'completed' })
			const paidOnline = await placeOrder('A')
			await patchOrder(paidOnline, {
				paymentMethod: 'online',
				paymentStatus: 'paid',
			})
			const free = await placeOrder('A')
			await patchOrder(free, {
				paymentMethod: 'online',
				paymentStatus: 'not_required',
				totalCents: 0,
			})
			const partlyRefunded = await placeOrder('A')
			await patchOrder(partlyRefunded, { refundedCents: 100 })
			const refundReversed = await placeOrder('A')
			await patchOrder(refundReversed, {
				refundedCents: 1000,
				refundReversedCents: 1000,
			})

			const cancelled = await placeOrder('A')
			await patchOrder(cancelled, { status: 'cancelled' })
			const pendingAcceptance = await placeOrder('A')
			await patchOrder(pendingAcceptance, { status: 'pending_acceptance' })
			const unpaid = await placeOrder('A')
			await patchOrder(unpaid, {
				paymentMethod: 'online',
				paymentStatus: 'pending',
			})
			const failed = await placeOrder('A')
			await patchOrder(failed, {
				paymentMethod: 'online',
				paymentStatus: 'failed',
			})
			const review = await placeOrder('A')
			await patchOrder(review, {
				paymentMethod: 'online',
				paymentStatus: 'review',
			})
			const refunded = await placeOrder('A')
			await patchOrder(refunded, { refundedCents: 1000 })

			const [result] = await query([{ startedAt: NOW - DAY, endedAt: null }])
			// counted, completed, paid online, free, partly refunded, reversed.
			expect(result!.A.orders).toBe(6)
			expect(counted).toBeTruthy()
			expect(result!.B.orders).toBe(0)
		})

		it('agrees with the pure rule shared with Sites and the App', async () => {
			const total = 1000
			const cases: Array<
				Partial<typeof restaurantOrders.$inferInsert> & { counts?: never }
			> = [
				{ status: 'accepted' },
				{ status: 'completed' },
				{ status: 'preparing' },
				{ status: 'ready' },
				{ status: 'cancelled' },
				{ status: 'rejected' },
				{ status: 'pending_acceptance' },
				{ status: 'expired' },
				{ paymentMethod: 'online', paymentStatus: 'paid' },
				{ paymentMethod: 'online', paymentStatus: 'pending' },
				{ paymentMethod: 'online', paymentStatus: 'review' },
				{
					paymentMethod: 'online',
					paymentStatus: 'not_required',
					totalCents: 0,
				},
				{ refundedCents: 999 },
				{ refundedCents: total },
				{ refundedCents: total, refundReversedCents: total },
				{ refundedCents: total, refundReversedCents: 1 },
			]
			for (const patch of cases) {
				const id = await placeOrder('A')
				await patchOrder(id, patch)
				const db = await getTenantDb(orgId)
				const [row] = await db
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, id))
				const [result] = await readPhotoTestResults(
					db,
					[
						{
							testId: TEST_ID,
							itemId: 'item-burger',
							startedAt: NOW - DAY,
							endedAt: null,
						},
					],
					{ now: NOW },
				)
				// Compare the SQL with the pure rule on a clean slate each time.
				const counted = result!.A.orders === 1
				expect(counted, JSON.stringify(patch)).toBe(
					orderCountsAsPhotoTestWin(row!),
				)
				if (
					row!.totalCents > 0 &&
					row!.refundedCents - row!.refundReversedCents < row!.totalCents
				) {
					expect(orderCountsTowardSales(row!)).toBe(counted)
				}
				await db.delete(restaurantOrders).where(eq(restaurantOrders.id, id))
			}
		})

		it('filters views and adds by UTC day and orders by time, start and end inclusive', async () => {
			const day = (offset: number) => NOW + offset * DAY
			// Counters on days -3 .. +1.
			for (const offset of [-3, -2, -1, 0, 1]) {
				await countDishPhotoEvents(orgId, [event() as never], {
					now: day(offset),
				})
			}
			// One order each at -3, -1, 0, +1 days.
			const ids: Record<number, string> = {}
			for (const offset of [-3, -1, 0, 1]) {
				vi.setSystemTime(day(offset))
				ids[offset] = await placeOrder('B')
			}
			vi.setSystemTime(NOW)
			// Ended at -1 days 23:00 (same UTC day as the counter of -1).
			const ended = await query([
				{ startedAt: day(-2), endedAt: day(-1) + 11 * 60 * 60 * 1000 },
			])
			expect(ended[0]).toMatchObject({
				A: { views: 2, orders: 0 },
				B: { orders: 1 },
			})
			// Running: from -1 to now (day 0): counters -1 and 0, orders -1 and 0
			// (the one on +1 is in the future and not counted).
			const running = await query([{ startedAt: day(-1), endedAt: null }])
			expect(running[0]).toMatchObject({ A: { views: 2 }, B: { orders: 2 } })
			// Whole window.
			const all = await query([{ startedAt: day(-3), endedAt: day(1) }])
			expect(all[0]).toMatchObject({ A: { views: 5 }, B: { orders: 4 } })
			// Orders before the start are left out.
			const late = await query([{ startedAt: day(0) - 1000, endedAt: null }])
			expect(late[0]).toMatchObject({ A: { views: 1 }, B: { orders: 1 } })
			expect(ids[-3]).toBeTruthy()
		})

		it('answers several tests at once, in order', async () => {
			await beacon({ events: [event(), event({ testId: OTHER_TEST_ID })] })
			const results = await query([
				{ startedAt: NOW - DAY, endedAt: null },
				{ testId: OTHER_TEST_ID, startedAt: NOW - DAY, endedAt: null },
			])
			expect(results.map((r) => [r.testId, r.A.views])).toEqual([
				[TEST_ID, 1],
				[OTHER_TEST_ID, 1],
			])
		})

		it('never shows one organization the counters or orders of another', async () => {
			await beacon({ events: [event(), event({ variant: 'B' })] })
			await placeOrder('A')
			const other = await query(
				[{ startedAt: NOW - DAY, endedAt: null }],
				await mint({ org: otherOrgId }),
			)
			expect(other[0]).toEqual({
				testId: TEST_ID,
				itemId: 'item-burger',
				A: { views: 0, adds: 0, orders: 0 },
				B: { views: 0, adds: 0, orders: 0 },
			})
			const mine = await query([{ startedAt: NOW - DAY, endedAt: null }])
			expect(mine[0]).toMatchObject({
				A: { views: 1, orders: 1 },
				B: { views: 1 },
			})
		})

		it('serves only a photo_tests-scope operator token', async () => {
			const body = {
				tests: [
					{
						testId: TEST_ID,
						itemId: 'item-burger',
						startedAt: NOW - DAY,
						endedAt: null,
					},
				],
			}
			expect((await post(body, null)).status).toBe(401)
			expect((await post(body, 'garbage')).status).toBe(401)
			for (const scope of ['funnel', 'mailbox', 'people', 'phone_calls']) {
				expect((await post(body, await mint({ scope }))).status).toBe(401)
			}
			// A token with no scope at all (the generic operator token) is refused too.
			const unscoped = await new SignJWT({ orgId, role: 'operator' })
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('5m')
				.sign(new TextEncoder().encode(OPERATOR_SECRET))
			expect((await post(body, unscoped)).status).toBe(401)
			expect((await post(body, await mint())).status).toBe(200)
		})

		it('refuses a bad body with 400', async () => {
			const token = await mint()
			const good = {
				testId: TEST_ID,
				itemId: 'item-burger',
				startedAt: NOW - DAY,
				endedAt: null,
			}
			for (const body of [
				{},
				{ tests: [] },
				{ tests: Array.from({ length: 21 }, () => good) },
				{ tests: [{ ...good, endedAt: good.startedAt - 1 }] },
				{ tests: [{ ...good, testId: 'x' }] },
				{ tests: [{ ...good, orgId: otherOrgId }] },
				{ tests: [good], orgId: otherOrgId },
			]) {
				expect((await post(body, token)).status, JSON.stringify(body)).toBe(400)
			}
			const notJson = await app.request('/operator/photo-tests/results', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: 'nope',
			})
			expect(notJson.status).toBe(400)
		})
	})
})
