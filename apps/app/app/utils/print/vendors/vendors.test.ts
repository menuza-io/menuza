import { afterEach, describe, expect, it, vi } from 'vitest'
import { gelatoVendor } from './gelato.server.ts'
import { createMockVendor } from './mock.server.ts'
import { prodigiVendor } from './prodigi.server.ts'
import { VendorError, type VendorAddress } from './types.ts'

const address: VendorAddress = {
	name: 'Sam Rivera',
	phone: '+15550102000',
	email: null,
	line1: '1 Main Street',
	line2: null,
	city: 'Springfield',
	state: 'IL',
	postalCode: '62701',
	country: 'US',
}

function stubFetch(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => Response.json(body, { status }))
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe('Gelato adapter', () => {
	it('sums product prices and picks the cheapest shipping', async () => {
		vi.stubEnv('GELATO_API_KEY', 'gelato-test-key')
		const fetchMock = stubFetch({
			quotes: [
				{
					products: [{ price: 2.5 }, { price: '3.10' }],
					shipmentMethods: [
						{ shipmentMethodUid: 'express', price: 12 },
						{ shipmentMethodUid: 'normal', price: 4.99 },
					],
				},
			],
		})
		const quote = await gelatoVendor.quote(
			[{ reference: 'a_0', sku: 'cards', quantity: 2 }],
			address,
		)
		expect(quote).toEqual({
			itemsCents: 560,
			shippingCents: 499,
			shippingMethod: 'normal',
			currency: 'USD',
		})
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('https://order.gelatoapis.com/v4/orders:quote')
		expect((init.headers as Record<string, string>)['X-API-KEY']).toBe(
			'gelato-test-key',
		)
		expect(
			(JSON.parse(String(init.body)) as { recipient: unknown }).recipient,
		).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', postCode: '62701' })
	})

	it('maps fulfillment states and treats 4xx cancel as too late', async () => {
		vi.stubEnv('GELATO_API_KEY', 'gelato-test-key')
		stubFetch({
			fulfillmentStatus: 'shipped',
			items: [
				{
					fulfillments: [
						{ trackingCode: 'T1', trackingUrl: 'https://t.example/T1' },
					],
				},
			],
		})
		expect(await gelatoVendor.status('o1')).toMatchObject({
			state: 'shipped',
			trackingNumber: 'T1',
		})
		stubFetch({ message: 'no' }, 409)
		expect(await gelatoVendor.cancel('o1')).toBe('too_late')
		stubFetch({}, 503)
		await expect(gelatoVendor.cancel('o1')).rejects.toBeInstanceOf(VendorError)
	})

	it('refuses to run without a key', async () => {
		vi.stubEnv('GELATO_API_KEY', '')
		await expect(gelatoVendor.status('o1')).rejects.toMatchObject({
			code: 'not_configured',
		})
	})
})

describe('Prodigi adapter', () => {
	it('reads cost summaries and uses the sandbox when asked', async () => {
		vi.stubEnv('PRODIGI_API_KEY', 'prodigi-test-key')
		vi.stubEnv('PRODIGI_SANDBOX', 'true')
		const fetchMock = stubFetch({
			outcome: 'Created',
			quotes: [
				{
					costSummary: {
						items: { amount: '10.00' },
						shipping: { amount: '5.50' },
					},
				},
			],
		})
		expect(
			await prodigiVendor.quote(
				[{ reference: 'a_0', sku: 'GLOBAL-POST', quantity: 1 }],
				address,
			),
		).toMatchObject({ itemsCents: 1000, shippingCents: 550 })
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
			'https://api.sandbox.prodigi.com/v4.0/quotes',
		)
	})

	it('maps stages and shipments', async () => {
		vi.stubEnv('PRODIGI_API_KEY', 'prodigi-test-key')
		stubFetch({ order: { status: { stage: 'InProgress' }, shipments: [] } })
		expect((await prodigiVendor.status('o1')).state).toBe('in_production')
		stubFetch({
			order: {
				status: { stage: 'Complete' },
				shipments: [
					{
						carrier: { name: 'USPS' },
						tracking: { number: 'P1', url: 'https://t.example/P1' },
					},
				],
			},
		})
		expect(await prodigiVendor.status('o1')).toMatchObject({
			state: 'shipped',
			carrier: 'USPS',
			trackingNumber: 'P1',
		})
		stubFetch({ outcome: 'FailedToCancel' })
		expect(await prodigiVendor.cancel('o1')).toBe('too_late')
	})
})

describe('mock vendor', () => {
	it('quotes stably and moves on with the clock', async () => {
		const vendor = createMockVendor()
		const first = await vendor.quote(
			[{ reference: 'x', sku: 'a', quantity: 2 }],
			address,
		)
		expect(
			await vendor.quote([{ reference: 'x', sku: 'a', quantity: 2 }], address),
		).toEqual(first)
		const { vendorOrderId } = await vendor.createOrder({
			reference: 'r',
			items: [],
			address,
			shippingMethod: 'm',
			callbackUrl: null,
		})
		expect((await vendor.status(vendorOrderId)).state).toBe('submitted')
		expect(await vendor.cancel(vendorOrderId)).toBe('cancelled')
		expect((await vendor.status(`mock_${Date.now() - 600_000}_r`)).state).toBe(
			'shipped',
		)
	})
})
