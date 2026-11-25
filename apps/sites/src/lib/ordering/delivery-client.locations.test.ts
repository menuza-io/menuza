// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDeliveryLocations } from './delivery-client.ts'

describe('requestDeliveryLocations', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		document.documentElement.removeAttribute('data-tenant-api-url')
	})

	it('posts one search to the regional node and leaves out empty fields', async () => {
		document.documentElement.dataset.tenantApiUrl = 'https://region.example'
		const fetchMock = vi.fn(async () =>
			Response.json({ status: 'ok', locations: [] }),
		)
		vi.stubGlobal('fetch', fetchMock)
		await requestDeliveryLocations({
			purpose: 'delivery',
			placeId: 'p1',
			unit: ' ',
			locale: 'en',
			subtotal: 24.5,
		})
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://region.example/delivery/locations')
		const body = JSON.parse(String(init.body))
		expect(body).toMatchObject({ purpose: 'delivery', placeId: 'p1', locale: 'en', subtotal: 24.5 })
		expect(body).not.toHaveProperty('unit')
		expect(body).not.toHaveProperty('point')
	})

	it('sends the browser location only when it is given', async () => {
		document.documentElement.dataset.tenantApiUrl = 'https://region.example'
		const fetchMock = vi.fn(async () => Response.json({ status: 'ok', locations: [] }))
		vi.stubGlobal('fetch', fetchMock)
		await requestDeliveryLocations({
			purpose: 'pickup',
			point: { lat: 41.9, lng: -87.6 },
			locale: 'en',
		})
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(JSON.parse(String(init.body)).point).toEqual({ lat: 41.9, lng: -87.6 })
	})
})
