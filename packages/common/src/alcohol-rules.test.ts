import { describe, expect, it } from 'vitest'
import {
	alcoholAllowedFor,
	effectiveAlcoholOnline,
	readAlcoholContext,
	readAlcoholOnline,
} from './alcohol-rules.ts'
import {
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	restaurantOrderRequestSchema,
} from './restaurant-orders.ts'

const NOW = new Date('2025-06-15T16:00:00.000Z')
const HOURS = [
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

function context(
	options: {
		alcohol?: unknown
		provider?: string
		currency?: 'USD' | 'SAR'
	} = {},
) {
	return restaurantOrderContextSchema.parse({
		orgId: 'org_1',
		dataRegion: 'us',
		...(options.alcohol !== undefined ? { alcohol: options.alcohol } : {}),
		menu: {
			organization: { id: 'org_1', slug: 'o', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 10,
					currency: options.currency ?? 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 60,
					},
					deliveryZones: [
						{
							id: 'zone-1',
							name: 'Downtown',
							provider: options.provider ?? 'in_house',
							restriction: 'allowed',
							type: 'zip_code',
							zipCodes: ['78701'],
							minimumOrder: 0,
							deliveryFee: 3,
							enabled: true,
						},
					],
					onlineHours: HOURS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Menu',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-1',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-wine',
									displayName: 'House wine',
									price: 9,
									isAlcohol: true,
									availabilityStatus: 'available',
									modifierGroups: [],
								},
								{
									id: 'item-soda',
									displayName: 'Soda',
									price: 3,
									availabilityStatus: 'available',
									modifierGroups: [],
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
	})
}

function request(
	fulfillment: 'pickup' | 'delivery',
	itemId = 'item-wine',
	extra: Record<string, unknown> = {},
) {
	return restaurantOrderRequestSchema.parse({
		idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
		locale: 'en',
		locationId: 'loc-1',
		fulfillment,
		paymentMethod: 'handoff',
		contact: { name: 'Test Person', phone: '+1 555 123 4567' },
		tipPercent: 0,
		...(fulfillment === 'delivery'
			? { delivery: { address: '1 Main St, Austin, TX 78701', city: 'Austin' } }
			: {}),
		lines: [{ itemId, quantity: 1, options: [] }],
		...extra,
	})
}

describe('alcohol rules: the setting', () => {
	it('reads known values and treats the rest as not reviewed', () => {
		expect(readAlcoholOnline('pickup')).toBe('pickup')
		expect(readAlcoholOnline(null)).toBeNull()
		expect(readAlcoholOnline('everywhere')).toBeNull()
	})

	it('keeps today\'s behaviour for an unreviewed location', () => {
		expect(effectiveAlcoholOnline(null)).toBe('pickup_and_delivery')
	})

	it('refuses alcohol online in KSA whatever was stored', () => {
		expect(effectiveAlcoholOnline('pickup_and_delivery', { ksa: true })).toBe(
			'none',
		)
		expect(
			readAlcoholContext({ locations: { a: 'pickup' } }, 'a', 'SAR'),
		).toBe('none')
	})

	it('allows each order type only where the setting says', () => {
		expect(alcoholAllowedFor('pickup', 'pickup')).toBe(true)
		expect(alcoholAllowedFor('pickup', 'delivery')).toBe(false)
		expect(alcoholAllowedFor('delivery', 'pickup')).toBe(false)
		expect(alcoholAllowedFor('delivery', 'delivery')).toBe(true)
		expect(alcoholAllowedFor('none', 'pickup')).toBe(false)
		expect(alcoholAllowedFor('none', 'dine_in')).toBe(false)
		expect(alcoholAllowedFor('pickup', 'dine_in')).toBe(true)
	})

	it('never allows courier delivery, whatever the setting', () => {
		expect(
			alcoholAllowedFor('pickup_and_delivery', 'delivery', { courier: true }),
		).toBe(false)
	})
})

describe('priceRestaurantOrder: alcohol (#167)', () => {
	const noDelivery = { locations: { 'loc-1': 'pickup' } }

	it('refuses a delivery cart with wine when delivery is not allowed, naming the line', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: noDelivery }),
			request('delivery'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error.status).toBe(422)
		expect(result.error.code).toBe('alcohol_not_allowed')
		expect(result.error.details).toMatchObject({
			fulfillment: 'delivery',
			lines: [{ line: 0, itemId: 'item-wine', name: 'House wine' }],
		})
	})

	it('allows the same cart for pickup and marks the order Check ID', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: noDelivery }),
			request('pickup'),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.hasAlcohol).toBe(true)
		expect(result.result.lines[0]?.alcohol).toBe(true)
	})

	it('leaves a cart without alcohol alone, whatever the setting', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: { locations: { 'loc-1': 'none' } } }),
			request('delivery', 'item-soda'),
			{ now: NOW },
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.result.hasAlcohol).toBe(false)
	})

	it('refuses everything online when the location says not online', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: { locations: { 'loc-1': 'none' } } }),
			request('pickup'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('alcohol_not_allowed')
	})

	it('cannot reach a courier zone at all: only the restaurant\'s own drivers are priced online', () => {
		// The engine fulfils in-house zones only, so alcohol never rides a courier;
		// `alcoholAllowedFor(..., { courier: true })` is the rule when one is added.
		const result = priceRestaurantOrder(
			context({
				alcohol: { locations: { 'loc-1': 'pickup_and_delivery' } },
				provider: 'doordash',
			}),
			request('delivery'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('delivery_unavailable')
	})

	it('keeps today\'s behaviour when the setting was never reviewed', () => {
		const result = priceRestaurantOrder(context(), request('delivery'), {
			now: NOW,
		})
		expect(result.ok).toBe(true)
	})

	it('refuses alcohol online for a KSA organization', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: { ksa: true }, currency: 'SAR' }),
			request('pickup'),
			{ now: NOW },
		)
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.code).toBe('alcohol_not_allowed')
	})

	it('does not refuse a till sale: staff check ID and the ticket says so', () => {
		const result = priceRestaurantOrder(
			context({ alcohol: { locations: { 'loc-1': 'none' } } }),
			request('pickup'),
			{ now: NOW, walkIn: true },
		)
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.result.hasAlcohol).toBe(true)
	})

	it('accepts a yes and never a birth date on the request', () => {
		expect(request('pickup', 'item-wine', { ageConfirmed: true }).ageConfirmed).toBe(true)
		expect(() =>
			restaurantOrderRequestSchema.parse({
				idempotencyKey: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
				locationId: 'loc-1',
				fulfillment: 'pickup',
				paymentMethod: 'handoff',
				contact: { name: 'A', phone: '+15551234567' },
				lines: [{ itemId: 'item-wine', quantity: 1, options: [] }],
				birthDate: '1990-01-01',
			}),
		).toThrow()
	})
})
