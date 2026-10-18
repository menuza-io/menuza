import { describe, expect, it, vi } from 'vitest'
import {
	acceptCheckoutUrl,
	checkoutAttemptKey,
	clearCheckoutAttempt,
	fetchOrderingOptions,
	orderLines,
	submitRegionalOrder,
} from './order-client.ts'
import { type CartItem } from './types.ts'

function setup() {
	const values = new Map<string, string>()
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	})
	vi.stubGlobal('document', {
		documentElement: {
			dataset: { tenantApiUrl: 'https://regional.example', orgSlug: 'cafe' },
		},
	})
	return { [Symbol.dispose]: () => vi.unstubAllGlobals() }
}

describe('regional order client', () => {
	it('discards every browser price and display field', () => {
		const line: CartItem = {
			id: 'line',
			itemId: 'dish',
			name: 'Untrusted name',
			basePrice: 1,
			unitPrice: 1,
			quantity: 2,
			instructions: '',
			options: [],
		}
		expect(orderLines([line])).toEqual([
			{
				itemId: 'dish',
				variantId: undefined,
				quantity: 2,
				instructions: '',
				options: [],
			},
		])
	})
	it('keeps the variant id but drops display-only variation options', () => {
		const line: CartItem = {
			id: 'line',
			itemId: 'loaf',
			variantId: 'size-half',
			name: 'Country Sourdough',
			basePrice: 8,
			unitPrice: 8,
			quantity: 1,
			instructions: '',
			options: [
				{
					groupId: 'size',
					groupName: 'Size',
					optionId: 'half',
					optionName: 'Half loaf',
					priceDelta: 0,
					variation: true,
				},
				{
					groupId: 'extras',
					groupName: 'Extras',
					optionId: 'seeds',
					optionName: 'Toasted seeds',
					priceDelta: 150,
				},
			],
		}
		expect(orderLines([line])).toEqual([
			{
				itemId: 'loaf',
				variantId: 'size-half',
				quantity: 1,
				instructions: '',
				options: [
					{
						groupId: 'extras',
						optionId: 'seeds',
						half: undefined,
						quantity: undefined,
					},
				],
			},
		])
	})
	it('reuses an attempt only for an unchanged checkout', async () => {
		using ignoredSetup = setup()
		const first = await checkoutAttemptKey('org', {
			contact: { name: 'Test guest' },
			lines: [],
		})
		expect(
			await checkoutAttemptKey('org', {
				contact: { name: 'Test guest' },
				lines: [],
			}),
		).toBe(first)
		expect(
			await checkoutAttemptKey('org', {
				contact: { name: 'Other guest' },
				lines: [],
			}),
		).not.toBe(first)
		expect(sessionStorage.getItem('menuza_order_attempt_org')).not.toContain(
			'guest',
		)
	})
	it('fails closed rather than falling back to the US API', async () => {
		using ignoredSetup = setup()
		vi.stubGlobal('document', { documentElement: { dataset: {} } })
		const fetch = vi.fn()
		vi.stubGlobal('fetch', fetch)
		await expect(submitRegionalOrder({})).rejects.toMatchObject({
			code: 'region_unavailable',
		})
		expect(fetch).not.toHaveBeenCalled()
	})
	it('clears the attempt so a later order mints a fresh key', async () => {
		using ignoredSetup = setup()
		const payload = { contact: { name: 'Test guest' }, lines: [] }
		const first = await checkoutAttemptKey('org', payload)
		clearCheckoutAttempt('org')
		expect(sessionStorage.getItem('menuza_order_attempt_org')).toBeNull()
		expect(await checkoutAttemptKey('org', payload)).not.toBe(first)
	})
	it('requests ordering options scoped to the org and location', async () => {
		using ignoredSetup = setup()
		const fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				onlinePayment: { enabled: true, processor: 'connect' },
				ordering: { open: true, status: 'open', reason: null, nextOpen: null },
			}),
		})
		vi.stubGlobal('fetch', fetch)
		const options = await fetchOrderingOptions({
			locationId: 'loc-1',
			dropSlug: 'ramadan-box',
		})
		expect(options.onlinePayment.enabled).toBe(true)
		const [url] = fetch.mock.calls[0] as [string]
		expect(url).toBe(
			'https://regional.example/orders/options?slug=cafe&locationId=loc-1&dropSlug=ramadan-box',
		)
	})
	it('rejects malformed ordering options responses', async () => {
		using ignoredSetup = setup()
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ unexpected: true }),
			}),
		)
		await expect(
			fetchOrderingOptions({ locationId: 'loc-1' }),
		).rejects.toMatchObject({ code: 'options_unavailable' })
	})
})

describe('checkout url (VAL-PMOCK-038)', () => {
	it('always accepts https', () => {
		for (const production of [false, true]) {
			expect(
				acceptCheckoutUrl('https://checkout.stripe.com/c/pay/cs_1', {
					production,
				}),
			).toBe('https://checkout.stripe.com/c/pay/cs_1')
		}
	})

	it('accepts loopback http outside production (the local payment mock)', () => {
		for (const url of [
			'http://localhost:3001/mock-payments/stripe/checkout/cs_test_1',
			'http://127.0.0.1:3001/mock-payments/checkout-com/hpp/hpp_1',
			'http://app.localhost:3001/mock-payments/stripe/checkout/cs_test_1',
		]) {
			expect(acceptCheckoutUrl(url, { production: false })).toBe(url)
		}
	})

	it('refuses any other http address with payment_unavailable', () => {
		for (const url of [
			'http://example.com/pay',
			'http://localhost.evil.com/pay',
			'http://evil-localhost/pay',
			'http://10.0.0.5/pay',
			'http://[::1]:3001/pay',
		]) {
			expect(() => acceptCheckoutUrl(url, { production: false })).toThrow(
				expect.objectContaining({ code: 'payment_unavailable', status: 502 }),
			)
		}
	})

	it('refuses even loopback http in production', () => {
		expect(() =>
			acceptCheckoutUrl(
				'http://localhost:3001/mock-payments/stripe/checkout/cs_1',
				{
					production: true,
				},
			),
		).toThrow(expect.objectContaining({ code: 'payment_unavailable' }))
	})

	it('refuses other schemes and malformed values', () => {
		for (const url of [
			'javascript:alert(1)',
			'ftp://localhost/x',
			'not a url',
			'',
		]) {
			expect(() => acceptCheckoutUrl(url, { production: false })).toThrow(
				expect.objectContaining({ code: 'payment_unavailable' }),
			)
		}
	})

	it('the default follows the build: this test run is not a production build', () => {
		expect(acceptCheckoutUrl('http://localhost:3001/x')).toBe(
			'http://localhost:3001/x',
		)
	})
})
