import { RouterContextProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { loader } from './terminals._index.tsx'

describe('legacy menu terminals route', () => {
	it('redirects old links to the same organization’s Settings page', () => {
		const response = loader({
			params: { orgSlug: 'acme-demo' },
			request: new Request('https://app.example.com/acme-demo/menu/terminals'),
			url: new URL('https://app.example.com/acme-demo/menu/terminals'),
			pattern: '/:orgSlug/menu/terminals',
			context: new RouterContextProvider(),
		})

		expect(response.status).toBe(302)
		expect(response.headers.get('Location')).toBe(
			'/acme-demo/settings/terminals',
		)
	})
})
