// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { renderHook } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneCallsClient } from './use-phone-calls.ts'

const TENANT_API_URL = 'https://tenant-us.example.com'

function wrapper({ children }: { children: ReactNode }) {
	return <I18nProvider i18n={i18n}>{children}</I18nProvider>
}

describe('usePhoneCallsClient', () => {
	const fetchMock = vi.fn<typeof fetch>()

	beforeEach(() => {
		i18n.loadAndActivate({ locale: 'en', messages: {} })
		fetchMock.mockImplementation(async (input) => {
			const url = String(input)
			const body = url.endsWith('/calls-token')
				? { jwt: 'operator-jwt', tenantApiUrl: TENANT_API_URL }
				: { calls: [] }
			return new Response(JSON.stringify(body), { status: 200 })
		})
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		fetchMock.mockReset()
	})

	function apiUrls() {
		return fetchMock.mock.calls
			.map(([input]) => String(input))
			.filter(
				(url) =>
					new URL(url, 'http://localhost').origin ===
					new URL(TENANT_API_URL).origin,
			)
	}

	// tenant-api has no trailing-slash routes: `/operator/calls/` is a 404.
	it.each([
		['/?followUp=open&limit=1', '/operator/calls?followUp=open&limit=1'],
		['/', '/operator/calls'],
		['/requests?status=open', '/operator/calls/requests?status=open'],
		['/call_1', '/operator/calls/call_1'],
	])('requests %s without a trailing slash', async (path, expected) => {
		const { result } = renderHook(() => usePhoneCallsClient('acme'), {
			wrapper,
		})
		await result.current(path)
		expect(apiUrls()).toEqual([`${TENANT_API_URL}${expected}`])
	})
})
