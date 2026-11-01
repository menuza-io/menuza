import { describe, expect, it } from 'vitest'
import {
	applyCartQuote,
	cartDiscountView,
	createQuoteBudget,
	listedDiscountNames,
	menuPricingPayload,
} from './cart-discounts.ts'
import { type DiscountQuote } from './discount-quote.ts'

const quote = (overrides: Partial<DiscountQuote> = {}): DiscountQuote => ({
	currency: 'USD',
	subtotalMinor: 5000,
	discounts: [
		{
			discountId: 'd1',
			version: 1,
			name: 'Lunch deal',
			code: null,
			amountMinor: 500,
			deliveryAmountMinor: 0,
			lineIds: [],
		},
	],
	totalDiscountMinor: 500,
	loyaltyDiscountMinor: 0,
	taxMinor: 360,
	tipMinor: 0,
	deliveryFeeMinor: 0,
	deliveryDiscountMinor: 0,
	totalMinor: 4860,
	paymentRequired: true,
	coupon: null,
	...overrides,
})

const view = (
	overrides: Partial<Parameters<typeof cartDiscountView>[0]> = {},
) =>
	cartDiscountView({
		state: { status: 'idle' },
		fresh: null,
		mode: 'pickup',
		hasItems: true,
		deliveryVerified: false,
		atTable: false,
		...overrides,
	})

describe('cartDiscountView', () => {
	it('behaves as before when discounts are off', () => {
		expect(view({ state: { status: 'off' } })).toEqual({
			quote: null,
			note: null,
		})
		expect(view({ state: { status: 'off' }, mode: 'delivery' })).toEqual({
			quote: null,
			note: null,
		})
	})

	it('uses a fresh quote and says nothing', () => {
		const fresh = quote()
		expect(view({ state: { status: 'ready', quote: fresh }, fresh })).toEqual({
			quote: fresh,
			note: null,
		})
	})

	it('stays quiet while loading when the menu has no offers', () => {
		expect(
			view({
				state: { status: 'loading', last: quote() },
				discountOffersAvailable: false,
			}),
		).toEqual({ quote: null, note: null })
	})

	it('keeps the estimate, labelled, while a quote is on its way or failed', () => {
		expect(view({ state: { status: 'loading', last: quote() } }).note).toBe(
			'before_discounts',
		)
		expect(
			view({ state: { status: 'error', code: 'network', last: null } }).note,
		).toBe('before_discounts')
		// A ready state whose quote no longer matches the cart is not fresh.
		expect(
			view({ state: { status: 'ready', quote: quote() }, fresh: null }).quote,
		).toBeNull()
	})

	it('never shows a stale quote as the total', () => {
		const stale = quote()
		const result = view({
			state: { status: 'loading', last: stale },
			fresh: null,
		})
		expect(result.quote).toBeNull()
	})

	it('says discounts come at checkout for delivery with no verified address', () => {
		expect(view({ mode: 'delivery', deliveryVerified: false })).toEqual({
			quote: null,
			note: 'at_checkout',
		})
		const fresh = quote()
		expect(
			view({
				mode: 'delivery',
				deliveryVerified: true,
				state: { status: 'ready', quote: fresh },
				fresh,
			}).quote,
		).toBe(fresh)
	})

	it('shows nothing for an empty cart or at a table', () => {
		expect(view({ hasItems: false, mode: 'delivery' }).note).toBeNull()
		expect(view({ atTable: true, mode: 'delivery' }).note).toBeNull()
	})

	it('has no note while nothing can be priced yet', () => {
		expect(view({ state: { status: 'idle' } })).toEqual({
			quote: null,
			note: null,
		})
	})
})

describe('applyCartQuote', () => {
	const base = {
		subtotal: 50,
		tax: 3.75,
		deliveryFee: 0,
		total: 53.75,
		count: 2,
	}

	it('keeps the estimate without a quote', () => {
		expect(applyCartQuote(base, null)).toEqual({
			...base,
			discount: 0,
			names: [],
		})
	})

	it('takes tax, delivery fee and total from the region', () => {
		const result = applyCartQuote(base, quote({ deliveryFeeMinor: 300 }))
		expect(result).toMatchObject({
			subtotal: 50,
			tax: 3.6,
			deliveryFee: 3,
			total: 48.6,
			count: 2,
			discount: 5,
			names: ['Lunch deal'],
		})
	})

	it('counts a delivery discount in the discount row', () => {
		const result = applyCartQuote(
			base,
			quote({ totalDiscountMinor: 800, deliveryDiscountMinor: 300 }),
		)
		expect(result.discount).toBe(8)
	})
})

describe('listedDiscountNames', () => {
	it('lists names only while they fit', () => {
		expect(listedDiscountNames(['A', 'B', 'C'])).toEqual(['A', 'B', 'C'])
		expect(listedDiscountNames(['A', 'B', 'C', 'D'])).toEqual([])
		expect(listedDiscountNames([])).toEqual([])
	})
})

describe('menuPricingPayload', () => {
	const input = {
		lines: [{ itemId: 'burger', quantity: 2 }],
		orderLines: [{ itemId: 'burger', quantity: 2 }],
		locale: 'en',
		locationId: 'loc_1',
		mode: 'pickup' as const,
		verifiedDelivery: null,
		scheduledFor: null,
		open: true,
		atTable: false,
		posterSource: null,
	}

	it('builds a pickup order from ids and quantities only', () => {
		const payload = menuPricingPayload(input)
		expect(payload).toEqual({
			locale: 'en',
			locationId: 'loc_1',
			fulfillment: 'pickup',
			paymentMethod: 'handoff',
			tipPercent: 0,
			lines: [{ itemId: 'burger', quantity: 2 }],
		})
		expect(JSON.stringify(payload)).not.toMatch(/price|amount/i)
	})

	it('cannot price an empty cart, a table order, or a closed store', () => {
		expect(menuPricingPayload({ ...input, lines: [] })).toBeNull()
		expect(menuPricingPayload({ ...input, atTable: true })).toBeNull()
		expect(menuPricingPayload({ ...input, open: false })).toBeNull()
		expect(
			menuPricingPayload({
				...input,
				open: false,
				scheduledFor: '2026-11-01T12:00:00.000Z',
			})?.scheduledFor,
		).toBe('2026-11-01T12:00:00.000Z')
	})

	it('needs a verified address for delivery, and ignores one for pickup', () => {
		const verified = {
			line1: '1 Main Street',
			formatted: '1 Main Street, Town',
			quoteToken: 'q1',
			city: 'Town',
		}
		expect(menuPricingPayload({ ...input, mode: 'delivery' })).toBeNull()
		expect(
			menuPricingPayload({
				...input,
				mode: 'delivery',
				verifiedDelivery: verified,
			})?.delivery,
		).toEqual({ address: '1 Main Street', quoteToken: 'q1', city: 'Town' })
		expect(
			menuPricingPayload({ ...input, verifiedDelivery: verified }),
		).not.toHaveProperty('delivery')
	})

	it('marks a poster order like checkout does', () => {
		expect(
			menuPricingPayload({ ...input, posterSource: 'qr_poster' })?.source,
		).toBe('qr_poster')
	})
})

describe('createQuoteBudget', () => {
	it('allows a burst up to the cap, then says how long to wait', () => {
		let now = 0
		const budget = createQuoteBudget({
			max: 3,
			windowMs: 60_000,
			now: () => now,
		})
		expect([budget.take(), budget.take(), budget.take()]).toEqual([0, 0, 0])
		now = 10_000
		expect(budget.take()).toBe(50_000)
		now = 60_000
		expect(budget.take()).toBe(0)
	})
})
