import { describe, expect, it, vi } from 'vitest'

import {
	TenantApiUnavailableError,
	getAccessToken,
	getRefreshToken,
	tenantFetch,
	tenantJson,
} from './client-auth.ts'

function jwt(payload: Record<string, unknown>) {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `h.${body}.s`
}

const ACCESS = jwt({ customerId: 'c1', orgId: 'org1' })

/** A signed-in page; `tenantApiUrl: null` is a page SSR gave no node. */
function signedInPage(
	options: { tenantApiUrl: string | null } = {
		tenantApiUrl: 'https://tenant.test',
	},
) {
	const store = new Map([
		['tenant_access_token', ACCESS],
		['tenant_refresh_token', 'refresh-1'],
	])
	const dataset: Record<string, string> = {}
	if (options.tenantApiUrl) dataset.tenantApiUrl = options.tenantApiUrl
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
	})
	vi.stubGlobal('document', { documentElement: { dataset } })
	vi.stubGlobal('navigator', {})
	return {
		[Symbol.dispose]() {
			vi.unstubAllGlobals()
		},
	}
}

/** Every call answers 401 except `/auth/refresh`, which `refresh` answers. */
function mockRefresh(refresh: () => Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (url.endsWith('/auth/refresh')) return refresh()
			return new Response('{}', { status: 401 })
		}),
	)
}

function answer(status: number, body: Record<string, unknown> = {}) {
	return async () => new Response(JSON.stringify(body), { status })
}

describe('tenantFetch refresh failures', () => {
	it.each([429, 500, 503])(
		'keeps the session when refresh answers %i',
		async (status) => {
			using _page = signedInPage()
			mockRefresh(answer(status))
			// A retryable error, not a 401 that would send the customer to sign in.
			await expect(tenantFetch('/me')).rejects.toBeInstanceOf(
				TenantApiUnavailableError,
			)
			expect(getRefreshToken()).toBe('refresh-1')
			expect(getAccessToken()).toBe(ACCESS)
		},
	)

	it('keeps the session when refresh hits a network error', async () => {
		using _page = signedInPage()
		mockRefresh(async () => {
			throw new TypeError('Failed to fetch')
		})
		await expect(tenantFetch('/me')).rejects.toBeInstanceOf(
			TenantApiUnavailableError,
		)
		expect(getRefreshToken()).toBe('refresh-1')
	})

	it('keeps the session when the control plane is unreachable (bare 403)', async () => {
		using _page = signedInPage()
		mockRefresh(answer(403, { error: 'Organization is no longer active' }))
		await expect(tenantFetch('/me')).rejects.toBeInstanceOf(
			TenantApiUnavailableError,
		)
		expect(getRefreshToken()).toBe('refresh-1')
	})

	it('signs out when tenant-api rejects the refresh token', async () => {
		using _page = signedInPage()
		mockRefresh(answer(401, { error: 'Invalid refresh token' }))
		const res = await tenantFetch('/me')
		expect(res.status).toBe(401)
		expect(getRefreshToken()).toBeNull()
		expect(getAccessToken()).toBeNull()
	})

	it('signs out when the organization is inactive', async () => {
		using _page = signedInPage()
		mockRefresh(
			answer(403, {
				error: 'Organization is no longer active',
				code: 'organization_inactive',
			}),
		)
		const res = await tenantFetch('/me')
		expect(res.status).toBe(401)
		expect(getRefreshToken()).toBeNull()
	})
})

describe('a page without a tenant-api for its region', () => {
	it('never calls another origin', async () => {
		using _page = signedInPage({ tenantApiUrl: null })
		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)

		await expect(tenantFetch('/auth/me')).rejects.toBeInstanceOf(
			TenantApiUnavailableError,
		)
		await expect(
			tenantJson('/auth/send-code', { phone: '+966501234567' }),
		).rejects.toBeInstanceOf(TenantApiUnavailableError)
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(getRefreshToken()).toBe('refresh-1')
	})
})
