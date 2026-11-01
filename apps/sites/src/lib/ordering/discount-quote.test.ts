import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createDiscountQuotes,
	type QuoteTransportResult,
} from './discount-quote.ts'

const quoteBody = (overrides: Record<string, unknown> = {}) => ({
	currency: 'USD',
	subtotalMinor: 10_000,
	discounts: [],
	totalDiscountMinor: 0,
	loyaltyDiscountMinor: 0,
	taxMinor: 0,
	tipMinor: 0,
	deliveryFeeMinor: 0,
	deliveryDiscountMinor: 0,
	totalMinor: 10_000,
	paymentRequired: true,
	coupon: null,
	...overrides,
})

function setup(
	responses: Array<
		QuoteTransportResult | Error | (() => Promise<QuoteTransportResult>)
	>,
	extra: {
		code?: string | null
		payload?: Record<string, unknown> | null
	} = {},
) {
	const calls: Array<Record<string, unknown>> = []
	let n = 0
	const state = {
		code: extra.code ?? null,
		payload: extra.payload === undefined ? { cart: 1 } : extra.payload,
	}
	const post = vi.fn(async (body: Record<string, unknown>) => {
		calls.push(body)
		const next = responses[Math.min(n, responses.length - 1)]!
		n += 1
		if (next instanceof Error) throw next
		return typeof next === 'function' ? next() : next
	})
	const quotes = createDiscountQuotes({
		post,
		pricingPayload: () => state.payload,
		code: () => state.code,
		onChange: () => {},
		debounceMs: 10,
		retryDelays: [100, 200],
		placementWaitMs: 500,
	})
	return { quotes, post, calls, state }
}

describe('discount quote client', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('prices the order and then holds a fresh quote', async () => {
		const { quotes } = setup([{ status: 200, body: quoteBody() }])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		expect(quotes.state().status).toBe('ready')
		expect(quotes.freshQuote()?.totalMinor).toBe(10_000)
	})

	it('drops a stale answer when the order changed while it was on its way', async () => {
		let release: (value: QuoteTransportResult) => void = () => {}
		const slow = () =>
			new Promise<QuoteTransportResult>((resolve) => {
				release = resolve
			})
		const { quotes, state } = setup([
			slow,
			{ status: 200, body: quoteBody({ totalMinor: 9_000 }) },
		])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		state.payload = { cart: 2 }
		quotes.sync()
		release({ status: 200, body: quoteBody({ totalMinor: 1 }) })
		await vi.advanceTimersByTimeAsync(40)
		expect(quotes.freshQuote()?.totalMinor).toBe(9_000)
	})

	it('turns itself off on a 404 and then places without discounts', async () => {
		const { quotes } = setup([{ status: 404, body: {} }])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		expect(quotes.state().status).toBe('off')
		await expect(quotes.placement()).resolves.toEqual({
			ok: true,
			discounts: null,
		})
	})

	it('turns itself off when the region says discounts are disabled', async () => {
		const { quotes } = setup(
			[{ status: 503, body: { error: 'discounts_disabled' } }],
			{ code: 'SAVE10' },
		)
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		expect(quotes.state().status).toBe('off')
	})

	it('retries a 429 after the wait it asked for, then gives up as an error', async () => {
		const { quotes, post } = setup([
			{ status: 429, body: { retryAfterSeconds: 1 } },
		])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		expect(post).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(post).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(2_000)
		expect(quotes.state().status).toBe('error')
	})

	it('does not retry a refusal of the order itself', async () => {
		const { quotes, post } = setup([
			{ status: 400, body: { error: 'invalid_request' } },
		])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(post).toHaveBeenCalledTimes(1)
		expect(quotes.state().status).toBe('error')
	})

	it('sends the total discount the customer was shown when placing', async () => {
		const { quotes } = setup([
			{
				status: 200,
				body: quoteBody({ totalDiscountMinor: 500, totalMinor: 9_500 }),
			},
		])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		const placement = await quotes.placement()
		expect(placement).toEqual({
			ok: true,
			discounts: { expectedDiscountMinor: 500 },
		})
	})

	it('places an undiscounted order as shown when the region is unreachable and no code or discount was shown', async () => {
		const { quotes } = setup([new Error('offline')])
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(quotes.state().status).toBe('error')
		const placement = quotes.placement()
		await vi.advanceTimersByTimeAsync(5_000)
		await expect(placement).resolves.toEqual({ ok: true, discounts: null })
	})

	it('blocks placing when a typed code could not be checked', async () => {
		const { quotes } = setup([new Error('offline')], { code: 'SAVE10' })
		quotes.sync()
		await vi.advanceTimersByTimeAsync(20)
		await vi.advanceTimersByTimeAsync(5_000)
		const placement = quotes.placement()
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(placement).resolves.toEqual({ ok: false })
	})

	it('sends nothing while the order cannot be priced yet', async () => {
		const { quotes } = setup([{ status: 200, body: quoteBody() }], {
			payload: null,
		})
		quotes.sync()
		await expect(quotes.placement()).resolves.toEqual({
			ok: true,
			discounts: null,
		})
		expect(quotes.state().status).toBe('idle')
	})
})
