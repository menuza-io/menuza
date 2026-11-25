import { describe, expect, it, vi } from 'vitest'

import {
	createDevRouter,
	createGoogleRouter,
	DEV_ROUTE_DETOUR_FACTOR,
	selectRouter,
} from './router.ts'
import { haversineMeters } from './coverage.ts'
import { RouterError } from './types.ts'

const FROM = { lat: 41.8853, lng: -87.6229 }
const TO = { lat: 41.8789, lng: -87.6359 }

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

describe('createGoogleRouter (fake fetch, no live host)', () => {
	it('asks Routes for a driving route and reads meters and seconds', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({ routes: [{ distanceMeters: 6120, duration: '540s' }] }),
		)
		const router = createGoogleRouter({ apiKey: 'key', fetch })
		await expect(router.drivingDistance(FROM, TO)).resolves.toEqual({
			meters: 6120,
			seconds: 540,
		})
		const [url, init] = fetch.mock.calls[0]!
		expect(String(url)).toContain('routes.googleapis.com')
		const headers = init!.headers as Record<string, string>
		expect(headers['X-Goog-Api-Key']).toBe('key')
		expect(JSON.parse(String(init!.body)).travelMode).toBe('DRIVE')
	})

	it('answers null when no route exists', async () => {
		const router = createGoogleRouter({
			apiKey: 'key',
			fetch: async () => jsonResponse({}),
		})
		await expect(router.drivingDistance(FROM, TO)).resolves.toBeNull()
	})

	it('throws RouterError on an HTTP failure, a network failure and a bad body', async () => {
		const failing = [
			async () => jsonResponse({ error: 'quota' }, 429),
			async () => {
				throw new Error('socket hang up')
			},
			async () => jsonResponse({ routes: 'nope' }),
		]
		for (const fetch of failing) {
			const router = createGoogleRouter({ apiKey: 'key', fetch })
			await expect(router.drivingDistance(FROM, TO)).rejects.toBeInstanceOf(
				RouterError,
			)
		}
	})
})

describe('createDevRouter and selectRouter', () => {
	it('is the straight-line distance times a fixed detour', async () => {
		const route = await createDevRouter().drivingDistance(FROM, TO)
		expect(route!.meters).toBe(
			Math.round(haversineMeters(FROM, TO) * DEV_ROUTE_DETOUR_FACTOR),
		)
	})

	it('uses Google with a key, the dev router outside production, and none in production', () => {
		expect(selectRouter({ apiKey: 'k', isProduction: true })?.name).toBe('google')
		expect(selectRouter({ apiKey: '', isProduction: false })?.name).toBe('dev')
		expect(selectRouter({ apiKey: '', isProduction: true })).toBeNull()
	})
})
