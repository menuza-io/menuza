import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { operatorQrRoutes } from './operator-qr.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
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

const orgId = 'org_channels_test_1'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
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

function makeLocation(id: string, name: string) {
	return {
		id,
		name,
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
	}
}

function menuContext(overrides: Record<string, unknown> = {}) {
	return {
		orgId,
		dataRegion: 'us',
		qrOrdering: { enabled: true, dineIn: true, online: true },
		menu: {
			organization: {
				id: orgId,
				slug: 'test-org',
				currency: 'USD',
				defaultLocale: 'en',
			},
			locations: [
				makeLocation('loc-1', 'Main Street'),
				makeLocation('loc-2', 'Harbor'),
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					channels: ['web', 'qr', 'pos', 'app'],
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							channels: ['web', 'qr', 'pos', 'app'],
							items: [
								{
									id: 'item-burger',
									displayName: 'Classic Burger',
									price: 10,
									availabilityStatus: 'available',
									channels: ['web', 'qr', 'pos', 'app'],
								},
								{
									id: 'item-till-only',
									displayName: 'Till Only Steak',
									price: 40,
									availabilityStatus: 'available',
									channels: ['pos'],
								},
								{
									id: 'item-loc-web-off',
									displayName: 'Loc1 Web Hidden Salad',
									price: 14,
									availabilityStatus: 'available',
									channels: ['web', 'qr', 'pos', 'app'],
								},
								{
									id: 'item-qr-only',
									displayName: 'Table Special',
									price: 12,
									availabilityStatus: 'available',
									channels: ['qr'],
								},
							],
						},
						{
							id: 'cat-pos-only',
							displayName: 'Till Category',
							availabilityStatus: 'available',
							channels: ['pos'],
							items: [
								{
									id: 'item-cat-pos-only',
									displayName: 'Dish Under Till Category',
									price: 16,
									availabilityStatus: 'available',
									channels: ['web', 'qr', 'pos', 'app'],
								},
							],
						},
					],
				},
			],
			locationOverrides: {
				'loc-1': [
					{
						entityType: 'item',
						entityId: 'item-loc-web-off',
						isEnabled: true,
						channels: ['qr', 'pos', 'app'],
					},
				],
			},
			...overrides,
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		discounts: {
			features: { automatic: true, coupons: false },
			discounts: [],
			codes: [],
		},
	}
}

async function operatorJwt() {
	return new SignJWT({ orgId, role: 'operator', scope: 'qr:write' })
		.setSubject('user_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorToken))
}

describe('channel availability enforcement on orders & quotes (#220)', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}

	const postJson = (
		pathName: string,
		body: unknown,
		extraHeaders: Record<string, string> = {},
	) =>
		app.request(pathName, {
			method: 'POST',
			headers: { ...headers, ...extraHeaders },
			body: JSON.stringify(body),
		})

	function baseOrder(overrides: Record<string, unknown> = {}) {
		return {
			slug: 'test-org',
			idempotencyKey: crypto.randomUUID(),
			locale: 'en',
			locationId: 'loc-1',
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
			lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			...overrides,
		}
	}

	async function createTableToken(locationId = 'loc-1') {
		const jwt = await operatorJwt()
		const res = await app.request('/operator/qr/tables', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${jwt}`,
			},
			body: JSON.stringify({ locationId, label: 'T1' }),
		})
		if (res.status !== 201) throw new Error(await res.text())
		const data = (await res.json()) as { table: { token: string } }
		return data.table.token
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-channels-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
		activeContext = menuContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/qr', operatorQrRoutes)
	})

	afterEach(async () => {
		vi.useRealTimers()
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// Best-effort temp cleanup
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it('refuses a Till-only dish on web pickup and QR dine-in/poster with 409 item_unavailable (even if client spoofs channel)', async () => {
		// Quote on web
		const { idempotencyKey: _k, ...quotePayload } = baseOrder({
			lines: [{ itemId: 'item-till-only', quantity: 1, options: [] }],
			// Attempted client channel spoof must be ignored server-side
			channel: 'pos',
		})
		const webQuote = await postJson('/orders/quote', quotePayload)
		expect(webQuote.status).toBe(409)
		expect((await webQuote.json()).error).toBe('item_unavailable')

		// Placement on web returns 409 item_unavailable
		const webPlace = await postJson(
			'/orders',
			baseOrder({
				lines: [{ itemId: 'item-till-only', quantity: 1, options: [] }],
			}),
		)
		expect(webPlace.status).toBe(409)
		expect((await webPlace.json()).error).toBe('item_unavailable')

		// Spoofed channel field in strict placement body is rejected (400)
		const spoofedPlace = await postJson(
			'/orders',
			baseOrder({
				lines: [{ itemId: 'item-till-only', quantity: 1, options: [] }],
				channel: 'pos',
			}),
		)
		expect(spoofedPlace.status).toBe(400)

		// Placement on QR poster (channel = qr)
		const qrPosterPlace = await postJson(
			'/orders',
			baseOrder({
				source: 'qr_poster',
				lines: [{ itemId: 'item-till-only', quantity: 1, options: [] }],
			}),
		)
		expect(qrPosterPlace.status).toBe(409)
		expect((await qrPosterPlace.json()).error).toBe('item_unavailable')

		// Placement on QR dine-in table (channel = qr)
		const tableToken = await createTableToken('loc-1')
		const qrDineInTill = await postJson(
			'/orders',
			baseOrder({
				fulfillment: 'dine_in',
				paymentMethod: 'handoff',
				contact: {},
				lines: [{ itemId: 'item-till-only', quantity: 1, options: [] }],
			}),
			{ 'X-Table-Token': tableToken },
		)
		expect(qrDineInTill.status).toBe(409)
		expect((await qrDineInTill.json()).error).toBe('item_unavailable')

		// QR-only dish is refused on web pickup (409), accepted on QR dine-in (201) and QR poster (201)
		const webQrOnly = await postJson(
			'/orders',
			baseOrder({
				lines: [{ itemId: 'item-qr-only', quantity: 1, options: [] }],
			}),
		)
		expect(webQrOnly.status).toBe(409)
		expect((await webQrOnly.json()).error).toBe('item_unavailable')

		const qrDineInOk = await postJson(
			'/orders',
			baseOrder({
				fulfillment: 'dine_in',
				paymentMethod: 'handoff',
				contact: {},
				lines: [{ itemId: 'item-qr-only', quantity: 1, options: [] }],
			}),
			{ 'X-Table-Token': tableToken },
		)
		expect(qrDineInOk.status).toBe(201)

		const qrPosterOk = await postJson(
			'/orders',
			baseOrder({
				source: 'qr_poster',
				lines: [{ itemId: 'item-qr-only', quantity: 1, options: [] }],
			}),
		)
		expect(qrPosterOk.status).toBe(201)
	})

	it('refuses dishes whose category has web disabled with 409 item_unavailable', async () => {
		const { idempotencyKey: _k, ...quotePayload } = baseOrder({
			lines: [{ itemId: 'item-cat-pos-only', quantity: 1, options: [] }],
		})
		const quoteRes = await postJson('/orders/quote', quotePayload)
		expect(quoteRes.status).toBe(409)
		expect((await quoteRes.json()).error).toBe('item_unavailable')

		const placeRes = await postJson(
			'/orders',
			baseOrder({
				lines: [{ itemId: 'item-cat-pos-only', quantity: 1, options: [] }],
			}),
		)
		expect(placeRes.status).toBe(409)
		expect((await placeRes.json()).error).toBe('item_unavailable')
	})

	it('accepts existing menu contexts that omit channels metadata', async () => {
		activeContext = menuContext({
			menus: [
				{
					id: 'menu-legacy',
					displayName: 'Legacy',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-legacy',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-legacy',
									displayName: 'Legacy Dish',
									price: 10,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		})
		const { idempotencyKey: _k, ...quotePayload } = baseOrder({
			lines: [{ itemId: 'item-legacy', quantity: 1, options: [] }],
		})
		const quoteRes = await postJson('/orders/quote', quotePayload)
		expect(quoteRes.status).toBe(200)
		const placeRes = await postJson(
			'/orders',
			baseOrder({
				lines: [{ itemId: 'item-legacy', quantity: 1, options: [] }],
			}),
		)
		expect(placeRes.status).toBe(201)
	})

	it('enforces location channel override on web at loc-1 only while allowing loc-2 and QR at loc-1', async () => {
		const loc1WebQuote = await postJson('/orders/quote', {
			slug: 'test-org',
			locale: 'en',
			locationId: 'loc-1',
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			lines: [{ itemId: 'item-loc-web-off', quantity: 1, options: [] }],
		})
		expect(loc1WebQuote.status).toBe(409)
		expect((await loc1WebQuote.json()).error).toBe('item_unavailable')

		const loc1WebPlace = await postJson(
			'/orders',
			baseOrder({
				locationId: 'loc-1',
				lines: [{ itemId: 'item-loc-web-off', quantity: 1, options: [] }],
			}),
		)
		expect(loc1WebPlace.status).toBe(409)
		expect((await loc1WebPlace.json()).error).toBe('item_unavailable')

		// loc-2 has no override -> web succeeds
		const loc2WebPlace = await postJson(
			'/orders',
			baseOrder({
				locationId: 'loc-2',
				lines: [{ itemId: 'item-loc-web-off', quantity: 1, options: [] }],
			}),
		)
		expect(loc2WebPlace.status).toBe(201)

		// loc-1 on QR dine-in still allows item-loc-web-off
		const tableToken = await createTableToken('loc-1')
		const loc1QrPlace = await postJson(
			'/orders',
			baseOrder({
				locationId: 'loc-1',
				fulfillment: 'dine_in',
				paymentMethod: 'handoff',
				contact: {},
				lines: [{ itemId: 'item-loc-web-off', quantity: 1, options: [] }],
			}),
			{ 'X-Table-Token': tableToken },
		)
		expect(loc1QrPlace.status).toBe(201)
	})
})
