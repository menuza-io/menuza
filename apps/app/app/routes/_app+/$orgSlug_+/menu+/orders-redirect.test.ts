import { describe, expect, it } from 'vitest'
import { loader } from './orders._index.tsx'

describe('legacy /menu/orders redirect', () => {
	it('moves to /orders and keeps the query', () => {
		const response = loader({
			request: new Request('https://app.example/cafe/menu/orders?order=o1'),
			params: { orgSlug: 'cafe' },
			context: {} as never,
		} as unknown as Parameters<typeof loader>[0]) as Response
		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe('/cafe/orders?order=o1')
	})
})
