// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetServerClock, serverNow } from '#app/utils/server-clock.ts'
import { useOperatorClient } from './use-operator-client.ts'

afterEach(() => {
	resetServerClock()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('useOperatorClient server clock', () => {
	it('learns the server clock from the credentials answer', async () => {
		const local = Date.now()
		const fetchMock = vi.fn(async (url: string) =>
			url.startsWith('/acme/orders-token')
				? Response.json({
						jwt: 'jwt',
						tenantApiUrl: 'https://regional.example',
						// This computer runs 5 minutes fast.
						serverNow: local - 5 * 60_000,
					})
				: Response.json({ orders: [] }),
		)
		vi.stubGlobal('fetch', fetchMock)
		const { result } = renderHook(() =>
			useOperatorClient('acme', '/operator/orders'),
		)
		await result.current.request('')
		// Within a few seconds of the true server time, not the local clock.
		expect(Math.abs(serverNow() - (Date.now() - 5 * 60_000))).toBeLessThan(5000)
	})

	it('keeps the local clock when the answer has no server time', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.startsWith('/acme/orders-token')
					? Response.json({
							jwt: 'jwt',
							tenantApiUrl: 'https://regional.example',
						})
					: Response.json({ orders: [] }),
			),
		)
		const { result } = renderHook(() =>
			useOperatorClient('acme', '/operator/orders'),
		)
		await result.current.request('')
		expect(Math.abs(serverNow() - Date.now())).toBeLessThan(50)
	})
})
