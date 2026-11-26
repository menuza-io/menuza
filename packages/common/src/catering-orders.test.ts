import { describe, expect, it } from 'vitest'

import { defaultCateringSettings, type CateringSettings } from './catering.ts'
import {
	canonicalOrderRequest,
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	restaurantOrderRequestSchema,
} from './restaurant-orders.ts'

/** The engine's catering rules (#124, #255): notice, window, menu, limits, cutoffs. */

const ORG_ID = 'org_catering'
const LOCATION_ID = 'loc-1'
// Monday 2026-06-01 12:00 in New York.
const NOW = new Date('2026-06-01T16:00:00.000Z')

const EVERY_DAY = [
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
	slots: [{ start: '08:00', end: '20:00' }],
}))

function location(overrides: Record<string, unknown> = {}) {
	return {
		id: LOCATION_ID,
		name: 'Main Street',
		timezone: 'America/New_York',
		taxRate: 10,
		prepTime: 15,
		currency: 'USD',
		fulfillmentOptions: { pickup: true, delivery: true, dineIn: true },
		inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
		onlineHours: EVERY_DAY,
		...overrides,
	}
}

const tray = {
	id: 'item-tray',
	displayName: 'Sandwich tray',
	price: 100,
	availabilityStatus: 'available',
}
const burger = {
	id: 'item-burger',
	displayName: 'Burger',
	price: 10,
	availabilityStatus: 'available',
}

function menu(id: string, menuType: string, items: unknown[]) {
	return {
		id,
		displayName: id,
		menuType,
		specialInstructions: true,
		availabilityStatus: 'available',
		categories: [
			{
				id: `cat-${id}`,
				displayName: 'Food',
				availabilityStatus: 'available',
				items,
			},
		],
	}
}

function settings(patch: Partial<CateringSettings> = {}): CateringSettings {
	return { ...defaultCateringSettings(), enabled: true, ...patch }
}

function context(
	options: {
		catering?: unknown
		location?: Record<string, unknown>
	} = {},
) {
	return restaurantOrderContextSchema.parse({
		orgId: ORG_ID,
		dataRegion: 'us',
		menu: {
			organization: { id: ORG_ID, slug: 'org', currency: 'USD' },
			locations: [location(options.location)],
			menus: [
				menu('catering-menu', 'catering', [tray]),
				menu('regular-menu', 'regular', [burger]),
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		// `null` leaves the key out, like an App that predates catering.
		...(options.catering === null
			? {}
			: {
					catering:
						options.catering === undefined
							? {
									version: 1,
									quotes: false,
									locations: { [LOCATION_ID]: settings() },
								}
							: options.catering,
				}),
	})
}

function request(overrides: Record<string, unknown> = {}) {
	return restaurantOrderRequestSchema.parse({
		idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
		locale: 'en',
		locationId: LOCATION_ID,
		fulfillment: 'pickup',
		paymentMethod: 'online',
		contact: { name: 'Guest', phone: '+1 555 123 4567' },
		tipPercent: 0,
		guestCount: 30,
		catering: { notes: 'Office lunch' },
		// Thursday Jun 4, 12:00 New York: three days out.
		scheduledFor: '2026-06-04T16:00:00.000Z',
		lines: [{ itemId: 'item-tray', quantity: 2, options: [] }],
		...overrides,
	})
}

describe('catering request schema', () => {
	it('needs an event time, a head count and online payment', () => {
		const base = {
			idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
			locationId: LOCATION_ID,
			fulfillment: 'pickup',
			paymentMethod: 'online',
			contact: { name: 'Guest', phone: '+1 555 123 4567' },
			lines: [{ itemId: 'item-tray', quantity: 1 }],
			catering: {},
		}
		expect(restaurantOrderRequestSchema.safeParse(base).success).toBe(false)
		expect(
			restaurantOrderRequestSchema.safeParse({
				...base,
				scheduledFor: '2026-06-04T16:00:00.000Z',
				guestCount: 10,
			}).success,
		).toBe(true)
		expect(
			restaurantOrderRequestSchema.safeParse({
				...base,
				scheduledFor: '2026-06-04T16:00:00.000Z',
				guestCount: 10,
				paymentMethod: 'handoff',
			}).success,
		).toBe(false)
		// The body is strict: an unknown catering key is refused.
		expect(
			restaurantOrderRequestSchema.safeParse({
				...base,
				scheduledFor: '2026-06-04T16:00:00.000Z',
				guestCount: 10,
				catering: { price: 1 },
			}).success,
		).toBe(false)
	})

	it('puts the catering notes into the idempotency fingerprint', () => {
		const a = canonicalOrderRequest(request())
		const b = canonicalOrderRequest(
			request({ catering: { notes: 'Different notes' } }),
		)
		expect(a).not.toBe(b)
		expect(
			canonicalOrderRequest(request({ catering: undefined, guestCount: 30 })),
		).not.toContain('"catering"')
	})
})

describe('priceRestaurantOrder for catering', () => {
	it('prices a catering order from the catering menu and schedules it at the event time', () => {
		const priced = priceRestaurantOrder(context(), request(), { now: NOW })
		expect(priced.ok).toBe(true)
		if (!priced.ok) return
		expect(priced.result.subtotalCents).toBe(20_000)
		expect(priced.result.scheduledFor).toBe('2026-06-04T16:00:00.000Z')
	})

	it('refuses a catering order inside the notice period (124-1)', () => {
		const settled = context({
			catering: {
				version: 1,
				quotes: false,
				locations: { [LOCATION_ID]: settings({ noticeHours: 72 }) },
			},
		})
		const inside = priceRestaurantOrder(
			settled,
			request({ scheduledFor: '2026-06-03T16:00:00.000Z' }),
			{ now: NOW },
		)
		expect(inside).toMatchObject({
			ok: false,
			error: { code: 'catering_too_soon', status: 422 },
		})
		expect(
			priceRestaurantOrder(
				settled,
				request({ scheduledFor: '2026-06-04T16:00:00.000Z' }),
				{ now: NOW },
			).ok,
		).toBe(true)
	})

	it('fails closed without the location settings, with the setting off or for a walk-in', () => {
		for (const catering of [
			null,
			{ version: 1, quotes: false, locations: {} },
			{
				version: 1,
				quotes: false,
				locations: { [LOCATION_ID]: settings({ enabled: false }) },
			},
			{ version: 1, quotes: false, locations: { [LOCATION_ID]: 'garbage' } },
		]) {
			expect(
				priceRestaurantOrder(context({ catering }), request(), { now: NOW }),
			).toMatchObject({ ok: false, error: { code: 'catering_disabled' } })
		}
		expect(
			priceRestaurantOrder(context(), request(), { now: NOW, walkIn: true }),
		).toMatchObject({ ok: false, error: { code: 'catering_disabled' } })
	})

	it('only sells catering menus to a catering order', () => {
		const result = priceRestaurantOrder(
			context(),
			request({ lines: [{ itemId: 'item-burger', quantity: 1, options: [] }] }),
			{ now: NOW },
		)
		expect(result).toMatchObject({ ok: false, error: { code: 'unknown_item' } })
	})

	it('is not blocked by an ordering pause or busy mode for a future day', () => {
		const paused = context({
			location: {
				orderingPause: { pausedAt: NOW.toISOString(), until: null },
				busyMode: { extraPrepMinutes: 60, until: null },
			},
		})
		expect(priceRestaurantOrder(paused, request(), { now: NOW }).ok).toBe(true)
	})

	it('refuses a closed day or time and a passed cutoff', () => {
		// 03:00 New York is outside the 08:00 to 20:00 online hours.
		expect(
			priceRestaurantOrder(
				context(),
				request({ scheduledFor: '2026-06-04T07:00:00.000Z' }),
				{ now: NOW },
			),
		).toMatchObject({ ok: false, error: { code: 'catering_closed' } })
		const cutoff = context({
			catering: {
				version: 1,
				quotes: false,
				locations: {
					[LOCATION_ID]: settings({
						cutoffs: [
							{
								id: 'thu',
								from: '2026-06-04',
								to: '2026-06-05',
								orderByDate: '2026-06-01',
								orderByTime: '09:00',
							},
						],
					}),
				},
			},
		})
		expect(priceRestaurantOrder(cutoff, request(), { now: NOW })).toMatchObject(
			{
				ok: false,
				error: { code: 'catering_cutoff_passed' },
			},
		)
		// Before the order-by moment the same date is orderable.
		expect(
			priceRestaurantOrder(cutoff, request(), {
				now: new Date('2026-06-01T12:00:00.000Z'),
			}).ok,
		).toBe(true)
	})

	it('enforces the minimum, maximum, guests and fulfillment', () => {
		const limited = context({
			catering: {
				version: 1,
				quotes: false,
				locations: {
					[LOCATION_ID]: settings({
						minMinor: 30_000,
						maxMinor: 50_000,
						maxGuests: 50,
						fulfillments: { pickup: true, delivery: false },
					}),
				},
			},
		})
		expect(
			priceRestaurantOrder(limited, request(), { now: NOW }),
		).toMatchObject({
			ok: false,
			error: { code: 'catering_minimum' },
		})
		expect(
			priceRestaurantOrder(
				limited,
				request({ lines: [{ itemId: 'item-tray', quantity: 6, options: [] }] }),
				{ now: NOW },
			),
		).toMatchObject({ ok: false, error: { code: 'catering_maximum' } })
		expect(
			priceRestaurantOrder(
				limited,
				request({
					guestCount: 60,
					lines: [{ itemId: 'item-tray', quantity: 4, options: [] }],
				}),
				{ now: NOW },
			),
		).toMatchObject({ ok: false, error: { code: 'catering_guests' } })
	})

	it('does not apply the regular order size cap to catering', () => {
		const capped = restaurantOrderContextSchema.parse({
			...context(),
			orderCaps: {
				locations: { [LOCATION_ID]: { pickup: { maxSubtotalMinor: 5_000 } } },
			},
		})
		expect(priceRestaurantOrder(capped, request(), { now: NOW }).ok).toBe(true)
	})
})
