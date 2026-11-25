import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { createDevRouter, type Router } from '@repo/geo'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { verifyDeliveryQuote } from '../lib/delivery-quote-token.ts'
import { setGeocoderForTesting } from '../lib/geocoder.ts'
import { resolveOrganizationForBrowserAuth } from '../lib/origin.ts'
import { setRouterForTesting } from '../lib/router.ts'
import {
	DELIVERY_LOCATIONS_CAP,
	publicDeliveryRoutes,
	rankDeliveryLocations,
	type RankedLocation,
} from './delivery.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const orgId = 'org_delivery_fees_1'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const hmacSecret = 'test-hmac-secret-123456789'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

// Dev geocoder fixtures. The Loop store is 123 Demo Street; Evanston's store
// is at the Orrington Avenue fixture. Wacker is ~1.3 km from the Loop store
// and ~17 km from Evanston; Orrington is far from the Loop.
const LOOP = { lat: 41.8853, lng: -87.6229 }
const EVANSTON = { lat: 42.0473, lng: -87.6815 }

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

function zone(overrides: Record<string, unknown> = {}) {
	return {
		id: 'zone-1',
		name: 'Standard',
		provider: 'in_house',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'miles' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 0,
		deliveryFee: 3.99,
		enabled: true,
		...overrides,
	}
}

function location(
	id: string,
	point: { lat: number; lng: number },
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		name: `Store ${id}`,
		timezone: 'UTC',
		taxRate: 0,
		prepTime: 15,
		currency: 'USD',
		address: {
			formattedAddress: `${id} Main Street`,
			city: 'Chicago',
			state: 'IL',
			postalCode: '60601',
			country: 'US',
			...point,
		},
		fulfillmentOptions: {
			pickup: true,
			delivery: true,
			dineIn: true,
			curbside: false,
		},
		inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
		scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 7 },
		deliveryConfig: {
			providers: ['in_house'],
			estimatedDeliveryTimeMin: 30,
			estimatedDeliveryTimeMax: 50,
		},
		deliveryZones: [zone()],
		onlineHours: ALL_DAYS,
		...overrides,
	}
}

function menuContext(locations: unknown[]) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations,
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

describe('Delivery: store picker, zone order, fee tables and distance fees', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown
	let fetchMock: ReturnType<typeof vi.fn>

	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}

	const post = (route: string, body: Record<string, unknown>) =>
		app.request(route, {
			method: 'POST',
			headers,
			body: JSON.stringify({ slug: 'test-org', ...body }),
		})
	const quote = (body: Record<string, unknown>) =>
		post('/delivery/quote', { locationId: 'loc-1', ...body })
	const locations = (body: Record<string, unknown>) =>
		post('/delivery/locations', body)
	const place = (body: Record<string, unknown>) =>
		post('/orders', deliveryOrder(body))

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-fees-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('GOOGLE_MAPS_API_KEY', '')

		activeContext = menuContext([location('loc-1', LOOP)])
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
		setRouterForTesting(undefined)
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// #161: the store that serves an address
	// -----------------------------------------------------------------------

	describe('POST /delivery/locations (#161)', () => {
		const twoStores = (loopOverrides = {}, evanstonOverrides = {}) =>
			menuContext([
				location('loc-1', LOOP, loopOverrides),
				location('loc-2', EVANSTON, evanstonOverrides),
			])

		it('picks the one location whose zone covers the address', async () => {
			activeContext = twoStores()
			const response = await locations({ placeId: 'dev_chi_wacker_233' })
			expect(response.status).toBe(200)
			const body = await response.json()
			expect(body.status).toBe('ok')
			expect(body.locations.map((l: { locationId: string }) => l.locationId)).toEqual(['loc-1'])
			expect(body.locations[0].quote).toMatchObject({
				zoneId: 'zone-1',
				deliveryFee: 3.99,
				address: { line1: '233 South Wacker Drive' },
			})
			// The token is signed for the location it was quoted for.
			const verified = await verifyDeliveryQuote(body.locations[0].quote.token, {
				orgId,
				locationId: 'loc-1',
			})
			expect(verified.ok).toBe(true)
			// An Evanston address is served by the other store.
			const north = await (
				await locations({ placeId: 'dev_evanston_orrington_1603' })
			).json()
			expect(north.locations.map((l: { locationId: string }) => l.locationId)).toEqual(['loc-2'])
		})

		it('does not offer a paused location, and keeps offering the rest', async () => {
			const pause = { orderingPause: { until: null } }
			activeContext = menuContext([
				location('loc-1', LOOP, pause),
				location('loc-2', LOOP),
			])
			const body = await (await locations({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body.locations.map((l: { locationId: string }) => l.locationId)).toEqual(['loc-2'])
			// Pickup lists leave the paused store out too.
			const pickup = await (
				await locations({ purpose: 'pickup', placeId: 'dev_chi_wacker_233' })
			).json()
			expect(pickup.locations.map((l: { locationId: string }) => l.locationId)).toEqual(['loc-2'])
			// Paused until later is paused now; an ended pause is not.
			activeContext = menuContext([
				location('loc-1', LOOP, {
					orderingPause: { until: new Date(Date.now() - 60_000).toISOString() },
				}),
			])
			const ended = await (await locations({ placeId: 'dev_chi_wacker_233' })).json()
			expect(ended.locations).toHaveLength(1)
		})

		it('offers a closed store that takes scheduled orders, and not one that does not', async () => {
			const closed = {
				onlineHours: ALL_DAYS.map((day) => ({ ...day, isOpen: false })),
			}
			activeContext = menuContext([
				location('loc-1', LOOP, closed),
				location('loc-2', LOOP, {
					...closed,
					scheduling: { scheduledOrdersEnabled: false, advanceOrderDays: 7 },
				}),
			])
			const body = await (await locations({ placeId: 'dev_chi_wacker_233' })).json()
			expect(
				body.locations.map((l: { locationId: string; open: boolean }) => [
					l.locationId,
					l.open,
				]),
			).toEqual([['loc-1', false]])
		})

		it('says nothing delivers here when no store covers the address', async () => {
			activeContext = twoStores()
			const body = await (await locations({ placeId: 'dev_nyc_fifth_350' })).json()
			expect(body).toEqual({ status: 'ok', locations: [] })
		})

		it('ranks by fee, then estimate, then distance, and geocodes once', async () => {
			const geocode = vi.fn()
			const real = (await import('@repo/geo')).createDevGeocoder()
			setGeocoderForTesting({
				...real,
				name: 'counting',
				placeDetails: async (id, options) => {
					geocode()
					return real.placeDetails(id, options)
				},
			})
			activeContext = menuContext([
				location('pricey', LOOP, { deliveryZones: [zone({ deliveryFee: 6 })] }),
				location('cheap-far', { lat: 41.9, lng: -87.64 }, {
					deliveryZones: [zone({ deliveryFee: 2 })],
				}),
				location('cheap-near', LOOP, { deliveryZones: [zone({ deliveryFee: 2 })] }),
				location('cheap-slow', LOOP, {
					deliveryZones: [zone({ deliveryFee: 2 })],
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 60,
						estimatedDeliveryTimeMax: 90,
					},
				}),
			])
			const body = await (await locations({ placeId: 'dev_chi_wacker_233' })).json()
			expect(geocode).toHaveBeenCalledTimes(1)
			expect(body.locations.map((l: { locationId: string }) => l.locationId)).toEqual([
				'cheap-near',
				'cheap-far',
				'cheap-slow',
				'pricey',
			])
		})

		it('sorts pickup locations by distance from the browser location, with no geocode', async () => {
			setGeocoderForTesting(null)
			activeContext = twoStores()
			const body = await (
				await locations({ purpose: 'pickup', point: EVANSTON })
			).json()
			expect(
				body.locations.map((l: { locationId: string }) => l.locationId),
			).toEqual(['loc-2', 'loc-1'])
			expect(body.locations[0].distanceMeters).toBeLessThan(10)
			expect(body.locations[0].quote).toBeNull()
		})

		it('refuses delivery without an address and an unknown organization', async () => {
			expect((await locations({})).status).toBe(400)
			expect((await locations({ purpose: 'pickup' })).status).toBe(400)
			expect((await locations({ slug: 'nope', placeId: 'x' })).status).toBe(404)
		})

		it('only looks at the first 25 locations', async () => {
			expect(DELIVERY_LOCATIONS_CAP).toBe(25)
			activeContext = menuContext(
				Array.from({ length: 30 }, (_, i) => location(`loc-${i}`, LOOP)),
			)
			const body = await (await locations({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body.locations).toHaveLength(25)
		})

		it('ranks stable on a dead heat (unit)', () => {
			const entry = (
				locationId: string,
				overrides: Partial<RankedLocation> = {},
			): RankedLocation => ({
				locationId,
				name: locationId,
				formattedAddress: null,
				distanceMeters: 100,
				open: true,
				etaMinutes: { min: 20, max: 30 },
				quote: { deliveryFee: 3 } as never,
				...overrides,
			})
			expect(
				rankDeliveryLocations([
					entry('b'),
					entry('a'),
					entry('none', { quote: null }),
				]).map((l) => l.locationId),
			).toEqual(['b', 'a', 'none'])
		})
	})

	// -----------------------------------------------------------------------
	// #266: the zone order wins at the quote and at placement
	// -----------------------------------------------------------------------

	describe('zone order (#266)', () => {
		const ring = zone({
			id: 'ring',
			name: 'Free ring',
			radius: { value: 3, unit: 'miles' },
			deliveryFee: 0,
			minimumOrder: 20,
		})
		const wide = zone({
			id: 'wide',
			name: 'Wide area',
			radius: { value: 20, unit: 'miles' },
			deliveryFee: 6,
			minimumOrder: 5,
		})
		const ordered = {
			providers: ['in_house'],
			estimatedDeliveryTimeMin: 30,
			estimatedDeliveryTimeMax: 50,
			zonePriority: 'order',
		}

		it('gives the higher zone fee and minimum at the quote and at placement', async () => {
			activeContext = menuContext([
				location('loc-1', LOOP, {
					deliveryZones: [wide, ring],
					deliveryConfig: ordered,
				}),
			])
			const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(quoted.quote).toMatchObject({
				zoneId: 'wide',
				deliveryFee: 6,
				minimumOrder: 5,
			})
			const placed = await place({ delivery: { quoteToken: quoted.quote.token } })
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.deliveryFeeCents).toBe(600)
		})

		it('lets the operator reorder: the ring now wins at both', async () => {
			activeContext = menuContext([
				location('loc-1', LOOP, {
					deliveryZones: [ring, wide],
					deliveryConfig: ordered,
				}),
			])
			const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(quoted.quote).toMatchObject({ zoneId: 'ring', deliveryFee: 0, minimumOrder: 20 })
			// 2 x 10.00 = 20.00 meets the ring's minimum and is free.
			const placed = await place({ delivery: { quoteToken: quoted.quote.token } })
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.deliveryFeeCents).toBe(0)
			// The ring's minimum applies at placement too.
			const small = await place({
				delivery: { quoteToken: quoted.quote.token },
				lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			})
			expect(small.status).toBe(422)
			expect((await small.json()).error).toBe('minimum_order')
		})

		it('keeps the cheapest zone for a location that never reordered', async () => {
			for (const zones of [[wide, ring], [ring, wide]]) {
				activeContext = menuContext([location('loc-1', LOOP, { deliveryZones: zones })])
				const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
				expect(quoted.quote.zoneId).toBe('ring')
			}
		})

		it('names the excluding zone for an address that cannot be delivered to', async () => {
			activeContext = menuContext([
				location('loc-1', LOOP, {
					deliveryZones: [
						wide,
						zone({
							id: 'campus',
							name: 'Campus',
							restriction: 'disallowed',
							type: 'zip_code',
							zipCodes: ['60606'],
						}),
					],
				}),
			])
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body).toMatchObject({
				status: 'out_of_range',
				reason: 'excluded',
				excludedBy: 'Campus',
			})
		})
	})

	// -----------------------------------------------------------------------
	// #244: fee by order size, and "price changed"
	// -----------------------------------------------------------------------

	describe('fee by order size (#244)', () => {
		const stepped = zone({
			minimumOrder: 10,
			deliveryFee: 5,
			feeSteps: [
				{ from: 10, fee: 5 },
				{ from: 20, fee: 3 },
				{ from: 40, fee: 0 },
			],
		})
		beforeEach(() => {
			activeContext = menuContext([location('loc-1', LOOP, { deliveryZones: [stepped] })])
		})

		const lines = (quantity: number) => [
			{ itemId: 'item-burger', quantity, options: [] },
		]

		it('quotes the fee for the cart and carries the table', async () => {
			const first = await (
				await quote({ placeId: 'dev_chi_wacker_233', subtotal: 25 })
			).json()
			expect(first.quote.deliveryFee).toBe(3)
			expect(first.quote.pricing).toEqual({
				baseFee: 5,
				steps: [
					{ from: 10, fee: 5 },
					{ from: 20, fee: 3 },
					{ from: 40, fee: 0 },
				],
				byDistance: false,
			})
			// Without a subtotal the quote shows the fee at the zone's minimum.
			const noCart = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(noCart.quote.deliveryFee).toBe(5)
		})

		it('gives free delivery above the last step, at placement', async () => {
			const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			const fee = async (quantity: number) => {
				const response = await place({
					delivery: { quoteToken: quoted.quote.token },
					lines: lines(quantity),
				})
				expect(response.status).toBe(201)
				return (await response.json()).order.deliveryFeeCents
			}
			expect(await fee(1)).toBe(500) // 10.00
			expect(await fee(2)).toBe(300) // 20.00
			expect(await fee(5)).toBe(0) // 50.00
		})

		it('places when the fee shown matches, and tells the guest when it changed', async () => {
			const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			const token = quoted.quote.token
			const matching = await place({
				delivery: { quoteToken: token },
				lines: lines(2),
				expectedDeliveryFeeMinor: 300,
			})
			expect(matching.status).toBe(201)
			// The guest saw the 5.00 fee but the cart earns 3.00.
			const stale = await place({
				delivery: { quoteToken: token },
				lines: lines(2),
				expectedDeliveryFeeMinor: 500,
			})
			expect(stale.status).toBe(409)
			expect(await stale.json()).toMatchObject({
				error: 'delivery_fee_changed',
				details: { deliveryFeeMinor: 300 },
			})
			// An operator changed the table after the guest looked.
			activeContext = menuContext([
				location('loc-1', LOOP, {
					deliveryZones: [{ ...stepped, feeSteps: [{ from: 10, fee: 7 }] }],
				}),
			])
			const changed = await place({
				delivery: { quoteToken: token },
				lines: lines(2),
				expectedDeliveryFeeMinor: 300,
			})
			expect(changed.status).toBe(409)
			expect((await changed.json()).error).toBe('delivery_fee_changed')
		})
	})

	// -----------------------------------------------------------------------
	// #421: fee by distance, routing and the straight-line fallback
	// -----------------------------------------------------------------------

	describe('fee by distance (#421)', () => {
		const bands = (mode: 'driving' | 'straight_line') => ({
			mode,
			unit: 'km',
			bands: [
				{ from: 0, fee: 3 },
				{ from: 1, fee: 4 },
				{ from: 5, fee: 5 },
				{ from: 8, fee: 7 },
			],
		})
		const useZone = (mode: 'driving' | 'straight_line') => {
			activeContext = menuContext([
				location('loc-1', LOOP, {
					deliveryZones: [
						zone({
							radius: { value: 25, unit: 'km' },
							deliveryFee: 9,
							distanceFees: bands(mode),
						}),
					],
				}),
			])
		}
		const roadSixKm: Router = {
			name: 'test',
			drivingDistance: async () => ({ meters: 6_000, seconds: 600 }),
		}

		it('puts an address 6 km away by road in the 5-8 km band', async () => {
			useZone('driving')
			setRouterForTesting(roadSixKm)
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body.quote.deliveryFee).toBe(5)
			expect(body.quote.distance).toEqual({ meters: 6000, source: 'driving' })
			// The signed token carries the road distance, so placement agrees.
			const verified = await verifyDeliveryQuote(body.quote.token, {
				orgId,
				locationId: 'loc-1',
			})
			expect(verified.ok && verified.payload.drivingMeters).toBe(6000)
			const placed = await place({
				delivery: { quoteToken: body.quote.token },
				expectedDeliveryFeeMinor: 500,
			})
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.deliveryFeeCents).toBe(500)
		})

		it('uses the straight-line fee when routing fails, and never logs the result', async () => {
			useZone('driving')
			const logged: unknown[][] = []
			for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
				vi.spyOn(console, method).mockImplementation((...args) => {
					logged.push(args)
				})
			}
			setRouterForTesting({
				name: 'broken',
				drivingDistance: async () => {
					throw new (await import('@repo/geo')).RouterError('quota exceeded', {
						status: 429,
					})
				},
			})
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			// ~1.3 km in a straight line: the 1-5 km band.
			expect(body.quote.deliveryFee).toBe(4)
			expect(body.quote.distance.source).toBe('straight_line')
			const verified = await verifyDeliveryQuote(body.quote.token, {
				orgId,
				locationId: 'loc-1',
			})
			expect(verified.ok && verified.payload.drivingMeters).toBeFalsy()
			const placed = await place({
				delivery: { quoteToken: body.quote.token },
				expectedDeliveryFeeMinor: 400,
			})
			expect(placed.status).toBe(201)
			// Only the failure class was logged: no coordinate, address or distance.
			const text = JSON.stringify(logged)
			expect(text).not.toMatch(/41\.87|87\.63|Wacker|1[0-9]{3}\b/)
		})

		it('falls back to straight line when there is no routing service at all', async () => {
			useZone('driving')
			setRouterForTesting(null)
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body.quote.deliveryFee).toBe(4)
			expect(body.quote.distance.source).toBe('straight_line')
		})

		it('does not ask routing for a zone measured in a straight line', async () => {
			useZone('straight_line')
			const router: Router = {
				name: 'spy',
				drivingDistance: vi.fn(async () => ({ meters: 9_000, seconds: null })),
			}
			setRouterForTesting(router)
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(router.drivingDistance).not.toHaveBeenCalled()
			expect(body.quote.deliveryFee).toBe(4)
		})

		it('uses the dev router by default outside production', async () => {
			useZone('driving')
			const body = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
			expect(body.quote.distance.source).toBe('driving')
			expect(createDevRouter().name).toBe('dev')
		})
	})

	// -----------------------------------------------------------------------
	// The three together: zone first, then distance, then order size
	// -----------------------------------------------------------------------

	it('resolves the zone, then the distance, then the order size, the same at quote and placement', async () => {
		const near = zone({
			id: 'near',
			name: 'Near',
			radius: { value: 25, unit: 'km' },
			deliveryFee: 9,
			minimumOrder: 10,
			distanceFees: {
				mode: 'driving',
				unit: 'km',
				bands: [
					{ from: 0, fee: 3 },
					{ from: 5, fee: 5 },
				],
			},
			feeSteps: [
				{ from: 10, fee: 6 },
				{ from: 20, fee: 4 },
				{ from: 40, fee: 0 },
			],
		})
		const other = zone({ id: 'other', name: 'Other', deliveryFee: 1 })
		activeContext = menuContext([
			location('loc-1', LOOP, {
				deliveryZones: [near, other],
				deliveryConfig: {
					providers: ['in_house'],
					estimatedDeliveryTimeMin: 30,
					estimatedDeliveryTimeMax: 50,
					zonePriority: 'order',
				},
			}),
		])
		setRouterForTesting({
			name: 'test',
			drivingDistance: async () => ({ meters: 6_000, seconds: null }),
		})
		const quoted = await (await quote({ placeId: 'dev_chi_wacker_233' })).json()
		// Zone order picks "near" even though "other" is cheaper; 6 km is the 5+
		// band at 5.00; the order-size table only lowers it.
		expect(quoted.quote.zoneId).toBe('near')
		const expected: Array<[number, number]> = [
			[1, 500], // 10.00: step 6.00, distance 5.00 -> 5.00
			[2, 400], // 20.00: step 4.00 -> 4.00
			[4, 0], // 40.00: free
		]
		for (const [quantity, fee] of expected) {
			const placed = await place({
				delivery: { quoteToken: quoted.quote.token },
				lines: [{ itemId: 'item-burger', quantity, options: [] }],
				expectedDeliveryFeeMinor: fee,
			})
			expect(placed.status).toBe(201)
			expect((await placed.json()).order.deliveryFeeCents).toBe(fee)
		}
	})
})
