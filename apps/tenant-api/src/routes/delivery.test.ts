import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	signDeliveryQuote,
	verifyDeliveryQuote,
	type DeliveryQuotePayload,
} from '../lib/delivery-quote-token.ts'
import { setGeocoderForTesting } from '../lib/geocoder.ts'
import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { publicDeliveryRoutes } from './delivery.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

// ---------------------------------------------------------------------------
// Harness (mirrors orders.adversarial.test.ts)
// ---------------------------------------------------------------------------

const orgId = 'org_delivery_quotes_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const hmacSecret = 'test-hmac-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

const STORE = { lat: 41.8853, lng: -87.6229 } // dev fixture: 123 Demo Street

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

function radiusZone(overrides: Record<string, unknown> = {}) {
	return {
		id: 'default-radius-zone',
		name: 'Standard Delivery Area',
		provider: 'in_house',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'miles' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 15,
		deliveryFee: 3.99,
		enabled: true,
		...overrides,
	}
}

function menuContext(locationOverrides: Record<string, unknown> = {}) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Demo Bistro',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					address: {
						formattedAddress: '123 Demo Street, Chicago, IL, 60601, US',
						city: 'Chicago',
						state: 'IL',
						postalCode: '60601',
						country: 'US',
						...STORE,
					},
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
					},
					scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 7 },
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 50,
					},
					deliveryZones: [radiusZone()],
					onlineHours: ALL_DAYS,
					...locationOverrides,
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
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: null },
	}
}

function quotePayload(
	overrides: Partial<DeliveryQuotePayload> = {},
): DeliveryQuotePayload {
	return {
		orgId,
		locationId: 'loc-1',
		lat: 41.8789,
		lng: -87.6359,
		formatted: '233 South Wacker Drive, Chicago, IL 60606, USA',
		line1: '233 South Wacker Drive',
		city: 'Chicago',
		state: 'IL',
		postalCode: '60606',
		country: 'US',
		unit: 'Suite 4',
		exp: Date.now() + 60 * 60 * 1000,
		...overrides,
	}
}

function deliveryOrder(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'delivery',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

describe('Delivery address quotes (public browser surface)', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown
	let fetchMock: ReturnType<typeof vi.fn>

	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}

	async function quote(body: Record<string, unknown>) {
		return app.request('/delivery/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'test-org', locationId: 'loc-1', ...body }),
		})
	}

	async function places(query: string) {
		return app.request(`/delivery/places?${query}`, { headers })
	}

	async function postOrder(body: unknown) {
		return app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-quotes-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('GOOGLE_MAPS_API_KEY', '')

		activeContext = menuContext()
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/resources/order-context')) {
				return new Response(JSON.stringify(activeContext), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			}
			return new Response('not found', { status: 404 })
		})
		vi.stubGlobal('fetch', fetchMock)

		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)

		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/delivery', publicDeliveryRoutes)
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		setGeocoderForTesting(undefined)
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// GET /delivery/places
	// -----------------------------------------------------------------------

	it('returns no predictions for queries shorter than 3 characters', async () => {
		const response = await places('slug=test-org&locationId=loc-1&q=ab')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ predictions: [] })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('autocompletes through the dev geocoder, restricted to the store country', async () => {
		const response = await places(
			'slug=test-org&locationId=loc-1&q=wacker&sessionToken=abc&lng=en',
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = await response.json()
		expect(body.predictions[0]).toEqual({
			placeId: 'dev_chi_wacker_233',
			mainText: '233 South Wacker Drive',
			secondaryText: 'Chicago, IL 60606, USA',
		})
		const saudi = await places('slug=test-org&locationId=loc-1&q=king%20fahd')
		expect((await saudi.json()).predictions).toEqual([])
	})

	it('rejects unknown organizations and malformed searches', async () => {
		expect(
			(await places('slug=other-org&locationId=loc-1&q=wacker')).status,
		).toBe(404)
		expect((await places('slug=test-org&q=wacker')).status).toBe(400)
	})

	// -----------------------------------------------------------------------
	// POST /delivery/quote
	// -----------------------------------------------------------------------

	it('quotes an in-zone place with a signed token, zone fee, minimum and ETA', async () => {
		const response = await quote({
			placeId: 'dev_chi_wacker_233',
			unit: 'Suite 4',
			sessionToken: 'abc',
		})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.status).toBe('deliverable')
		expect(body.quote).toMatchObject({
			address: {
				formatted: '233 South Wacker Drive, Chicago, IL 60606, USA',
				line1: '233 South Wacker Drive',
				unit: 'Suite 4',
				city: 'Chicago',
				state: 'IL',
				postalCode: '60606',
				country: 'US',
				lat: 41.8789,
				lng: -87.6359,
			},
			zoneId: 'default-radius-zone',
			zoneName: 'Standard Delivery Area',
			deliveryFee: 3.99,
			minimumOrder: 15,
			eta: { min: 30, max: 50 },
		})
		const expiresIn = Date.parse(body.quote.expiresAt) - Date.now()
		expect(expiresIn).toBeGreaterThan(110 * 60 * 1000)
		expect(expiresIn).toBeLessThanOrEqual(120 * 60 * 1000)
		const verified = await verifyDeliveryQuote(body.quote.token, {
			orgId,
			locationId: 'loc-1',
		})
		expect(verified.ok).toBe(true)
	})

	it('geocodes free text when no placeId is given', async () => {
		const response = await quote({ address: '600 E Grand Ave, Chicago' })
		const body = await response.json()
		expect(body.status).toBe('deliverable')
		expect(body.quote.address.line1).toBe('600 East Grand Avenue')
	})

	it('reports out_of_range with the normalized address', async () => {
		const response = await quote({ placeId: 'dev_evanston_orrington_1603' })
		const body = await response.json()
		expect(body).toEqual({
			status: 'out_of_range',
			address: expect.objectContaining({ city: 'Evanston', lat: 42.0473 }),
		})
		expect(body.quote).toBeUndefined()
	})

	it('reports excluded points as out_of_range', async () => {
		activeContext = menuContext({
			deliveryZones: [
				radiusZone(),
				radiusZone({
					id: 'no-go',
					restriction: 'disallowed',
					type: 'zip_code',
					zipCodes: ['60606'],
				}),
			],
		})
		const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
		expect(body.status).toBe('out_of_range')
	})

	it('reports not_found for addresses that cannot be geocoded', async () => {
		const body = await (
			await quote({ address: '1 Nonexistent Lane, Atlantis' })
		).json()
		expect(body).toEqual({ status: 'not_found' })
		const byPlace = await (await quote({ placeId: 'dev_missing' })).json()
		expect(byPlace).toEqual({ status: 'not_found' })
	})

	it.each([
		[
			'delivery_disabled',
			{
				fulfillmentOptions: {
					pickup: true,
					delivery: false,
					dineIn: true,
					curbside: false,
				},
			},
		],
		['no_zones', { deliveryZones: [radiusZone({ enabled: false })] }],
		[
			'store_location_missing',
			{ address: { formattedAddress: 'x', country: 'US', lat: 0, lng: 0 } },
		],
	])('reports unavailable/%s', async (reason, overrides) => {
		activeContext = menuContext(overrides)
		const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
		expect(body).toEqual({ status: 'unavailable', reason })
	})

	it('reports geocoding_unavailable without a geocoder (production, no key)', async () => {
		setGeocoderForTesting(null)
		const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
		expect(body).toEqual({
			status: 'unavailable',
			reason: 'geocoding_unavailable',
		})
	})

	it('reports geocoding_unavailable when the provider fails', async () => {
		setGeocoderForTesting({
			name: 'broken',
			autocomplete: async () => [],
			placeDetails: async () => {
				throw new Error('quota')
			},
			geocode: async () => null,
		})
		const body = await (await quote({ placeId: 'anything' })).json()
		expect(body).toEqual({
			status: 'unavailable',
			reason: 'geocoding_unavailable',
		})
	})

	it('rejects malformed quote requests and unknown orgs', async () => {
		expect((await quote({})).status).toBe(400)
		expect((await quote({ placeId: 'x', lat: 1 })).status).toBe(400)
		const unknown = await app.request('/delivery/quote', {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'nope', locationId: 'loc-1', placeId: 'x' }),
		})
		expect(unknown.status).toBe(404)
		expect(
			(await quote({ locationId: 'loc-ghost', placeId: 'x' })).status,
		).toBe(404)
	})

	// -----------------------------------------------------------------------
	// Placing orders with a quote token
	// -----------------------------------------------------------------------

	it('places a delivery order from a quote: fee from the live zone, address from the token', async () => {
		const quoted = await (
			await quote({ placeId: 'dev_chi_wacker_233', unit: 'Suite 4' })
		).json()
		const response = await postOrder(
			deliveryOrder({
				delivery: {
					quoteToken: quoted.quote.token,
					address: 'client text is ignored',
					city: '',
					notes: 'Front desk',
				},
			}),
		)
		expect(response.status).toBe(201)
		const body = await response.json()
		expect(body.order.deliveryFeeCents).toBe(399)
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, body.order.id))
		expect(row).toMatchObject({
			deliveryAddress: '233 South Wacker Drive, Chicago, IL 60606, USA',
			deliveryCity: 'Chicago',
			deliveryUnit: 'Suite 4',
			deliveryNotes: 'Front desk',
			deliveryPostalCode: '60606',
			deliveryLat: 41.8789,
			deliveryLng: -87.6359,
			deliveryZoneId: 'default-radius-zone',
			scheduledFor: null,
		})
	})

	it('re-resolves the zone at order time (fees changed after the quote)', async () => {
		const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
		activeContext = menuContext({
			deliveryZones: [radiusZone({ deliveryFee: 6.5 })],
		})
		const response = await postOrder(
			deliveryOrder({ delivery: { quoteToken: quoted.quote.token } }),
		)
		expect(response.status).toBe(201)
		expect((await response.json()).order.deliveryFeeCents).toBe(650)

		activeContext = menuContext({
			deliveryZones: [radiusZone({ radius: { value: 0.5, unit: 'miles' } })],
		})
		const shrunk = await postOrder(
			deliveryOrder({ delivery: { quoteToken: quoted.quote.token } }),
		)
		expect(shrunk.status).toBe(422)
		expect((await shrunk.json()).error).toBe('delivery_coverage_unverified')
	})

	it.each([
		[
			'expired',
			async () => signDeliveryQuote(quotePayload({ exp: Date.now() - 1 })),
		],
		[
			'for another location',
			async () => signDeliveryQuote(quotePayload({ locationId: 'loc-2' })),
		],
		[
			'for another org',
			async () => signDeliveryQuote(quotePayload({ orgId: 'org_other' })),
		],
		[
			'tampered',
			async () => {
				const token = await signDeliveryQuote(quotePayload())
				const [prefix, body, signature] = token.split('.')
				const payload = JSON.parse(
					Buffer.from(body!, 'base64url').toString('utf8'),
				)
				payload.lat = 41.9
				const forged = Buffer.from(JSON.stringify(payload)).toString(
					'base64url',
				)
				return `${prefix}.${forged}.${signature}`
			},
		],
		['garbage', async () => 'dq1.not-a-real-token.at-all-really'],
	])(
		'rejects a quote token that is %s with 422 delivery_quote_expired',
		async (_label, makeToken) => {
			const response = await postOrder(
				deliveryOrder({ delivery: { quoteToken: await makeToken() } }),
			)
			expect(response.status).toBe(422)
			const body = await response.json()
			expect(body.error).toBe('delivery_quote_expired')
			expect(body.message).toMatch(/confirm your address/i)
		},
	)

	it('rejects tokens signed with a different secret', async () => {
		const token = await signDeliveryQuote(quotePayload())
		vi.stubEnv('AUTH_HMAC_SECRET', 'another-hmac-secret-987654321')
		const result = await verifyDeliveryQuote(token, {
			orgId,
			locationId: 'loc-1',
		})
		expect(result).toEqual({ ok: false, reason: 'signature' })
	})

	it('validates and persists scheduledFor', async () => {
		const scheduledFor = new Date(Date.now() + 2 * 60 * 60 * 1000)
		scheduledFor.setUTCSeconds(0, 0)
		const response = await postOrder(
			deliveryOrder({
				fulfillment: 'pickup',
				scheduledFor: scheduledFor.toISOString(),
			}),
		)
		expect(response.status).toBe(201)
		const body = await response.json()
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, body.order.id))
		expect(row?.scheduledFor?.toISOString()).toBe(scheduledFor.toISOString())

		const receipt = await app.request(
			`/orders/${body.order.id}?slug=test-org`,
			{
				headers: { ...headers, Authorization: `Bearer ${body.receiptToken}` },
			},
		)
		expect((await receipt.json()).order.scheduledFor).toBe(
			scheduledFor.toISOString(),
		)

		const tooFar = await postOrder(
			deliveryOrder({
				fulfillment: 'pickup',
				scheduledFor: new Date(
					Date.now() + 30 * 24 * 60 * 60 * 1000,
				).toISOString(),
			}),
		)
		expect(tooFar.status).toBe(422)
		expect((await tooFar.json()).error).toBe('schedule_unavailable')
	})

	it('reports delivery.available truthfully in ordering options', async () => {
		const options = async () =>
			(
				await app.request('/orders/options?slug=test-org&locationId=loc-1', {
					headers,
				})
			).json()
		expect((await options()).delivery.available).toBe(true)

		activeContext = menuContext({
			address: { formattedAddress: 'x', country: 'US', lat: 0, lng: 0 },
		})
		expect((await options()).delivery.available).toBe(false)

		activeContext = menuContext()
		setGeocoderForTesting(null)
		expect((await options()).delivery.available).toBe(false)
	})
})
