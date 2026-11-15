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

const tokenAnswer = Response.json({
	jwt: 'jwt',
	tenantApiUrl: 'https://regional.example',
})

describe('useOperatorClient server clock', () => {
	it('learns the region clock from an answer that carries serverNow', async () => {
		const local = Date.now()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.startsWith('/acme/orders-token')
					? tokenAnswer.clone()
					: Response.json({
							orders: [],
							// This computer runs 5 minutes fast.
							serverNow: local - 5 * 60_000,
						}),
			),
		)
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
					? tokenAnswer.clone()
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
