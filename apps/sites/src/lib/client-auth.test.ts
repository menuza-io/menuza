// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getAccessToken,
	getBrowserTenantApiUrl,
	getRefreshToken,
	setSessionTokens,
	tenantFetch,
	tenantFetchResponse,
	TenantSessionUnavailableError,
} from './client-auth.ts'

/** An unsigned token the decoder can read; the server side is mocked away. */
function accessToken(orgId = 'org-1'): string {
	const payload = btoa(JSON.stringify({ sub: 'cus-1', orgId }))
	return `head.${payload}.sig`
}

function answer(
	status: number,
	body: Record<string, unknown> = {},
): Promise<Response> {
	return Promise.resolve(Response.json(body, { status }))
}

const ORGANIZATION_INACTIVE = {
	error: 'Organization is no longer active',
	code: 'organization_inactive',
}

beforeEach(() => {
	const store = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	})
	document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('session refresh', () => {
	it('retries with the rotated tokens after a 401', async () => {
		setSessionTokens({
			accessToken: accessToken(),
			refreshToken: 'refresh-1',
		})
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(answer(401))
			.mockResolvedValueOnce(
				answer(200, {
					accessToken: accessToken(),
					refreshToken: 'refresh-2',
				}),
			)
			.mockResolvedValueOnce(answer(200, { ok: true }))
		vi.stubGlobal('fetch', fetchMock)
		const { session, response: res } = await tenantFetch('/loyalty/wallet')
		expect(session).toBe('ok')
		expect(res.status).toBe(200)
		expect(getRefreshToken()).toBe('refresh-2')
		// The retry carried the fresh access token.
		const retry = fetchMock.mock.calls[2]![1] as RequestInit
		expect(new Headers(retry.headers).get('Authorization')).toMatch(/^Bearer /)
	})

	it.each([
		[401, {}],
		[403, ORGANIZATION_INACTIVE],
	])(
		'clears the session when the refresh is refused with %i',
		async (status, body) => {
			setSessionTokens({
				accessToken: accessToken(),
				refreshToken: 'refresh-1',
			})
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValueOnce(answer(401))
					.mockResolvedValueOnce(answer(status, body)),
			)
			const { session } = await tenantFetch('/loyalty/wallet')
			expect(getAccessToken()).toBeNull()
			expect(getRefreshToken()).toBeNull()
			expect(session).toBe('signed_out')
		},
	)

	it.each([
		[400, {}],
		[403, {}],
		[403, { error: 'Forbidden', code: 'forbidden' }],
		[429, {}],
		[500, {}],
		[503, {}],
		[
			503,
			{
				error: 'Service temporarily unavailable. Please try again.',
				code: 'temporarily_unavailable',
			},
		],
	])(
		'keeps the session when the refresh answers %i %o',
		async (status, body) => {
			setSessionTokens({
				accessToken: accessToken(),
				refreshToken: 'refresh-1',
			})
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValueOnce(answer(401))
					.mockResolvedValueOnce(answer(status, body)),
			)
			const { session, response: res } = await tenantFetch('/loyalty/wallet')
			expect(res.status).toBe(401)
			expect(getAccessToken()).not.toBeNull()
			expect(getRefreshToken()).toBe('refresh-1')
			// Callers can tell this 401 from a refused session.
			expect(session).toBe('transient')
		},
	)

	it('keeps the session when the refresh never reaches the region', async () => {
		setSessionTokens({
			accessToken: accessToken(),
			refreshToken: 'refresh-1',
		})
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(answer(401))
				.mockRejectedValueOnce(new TypeError('fetch failed')),
		)
		const { session, response: res } = await tenantFetch('/loyalty/wallet')
		expect(res.status).toBe(401)
		expect(getAccessToken()).not.toBeNull()
		expect(getRefreshToken()).toBe('refresh-1')
		expect(session).toBe('transient')
	})

	it('does not refresh half a session (no refresh token)', async () => {
		setSessionTokens({ accessToken: accessToken() })
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(401)))
		const { session, response: res } = await tenantFetch('/loyalty/wallet')
		expect(res.status).toBe(401)
		expect(fetch).toHaveBeenCalledTimes(1)
		// Untouched here; the login page forgets a session that cannot refresh.
		expect(getAccessToken()).not.toBeNull()
		expect(session).toBe('signed_out')
	})

	it('reports a 401 without any session as signed out', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(401)))
		const { session } = await tenantFetch('/auth/me')
		expect(session).toBe('signed_out')
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('signs out when the refreshed token is refused as well', async () => {
		setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(answer(401))
				.mockResolvedValueOnce(
					answer(200, { accessToken: accessToken(), refreshToken: 'refresh-2' }),
				)
				.mockResolvedValueOnce(answer(401)),
		)
		const { session } = await tenantFetch('/auth/me')
		expect(session).toBe('signed_out')
		expect(getAccessToken()).toBeNull()
		expect(getRefreshToken()).toBeNull()
	})
})

describe('answers from the route itself', () => {
	beforeEach(() => {
		setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
	})

	it('signs out when the organization is no longer active', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(answer(403, ORGANIZATION_INACTIVE)),
		)
		const { session, response } = await tenantFetch('/auth/me')
		expect(session).toBe('signed_out')
		expect(response.status).toBe(403)
		expect(getAccessToken()).toBeNull()
		expect(getRefreshToken()).toBeNull()
		// The caller can still read the answer.
		await expect(response.json()).resolves.toMatchObject({
			code: 'organization_inactive',
		})
	})

	it('keeps the session while the region cannot check it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(
				answer(503, {
					error: 'Service temporarily unavailable. Please try again.',
					code: 'temporarily_unavailable',
				}),
			),
		)
		const { session } = await tenantFetch('/auth/me')
		expect(session).toBe('transient')
		expect(getAccessToken()).not.toBeNull()
		expect(getRefreshToken()).toBe('refresh-1')
	})

	it.each([
		[200, {}],
		[403, { error: 'organization_mismatch' }],
		[404, { error: 'Not found' }],
		[500, { error: 'boom' }],
		[503, { error: 'down', code: 'loyalty_unavailable' }],
	])(
		'hands any other %i answer to the caller and keeps the session',
		async (status, body) => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer(status, body)))
			const { session, response } = await tenantFetch('/loyalty/wallet')
			expect(session).toBe('ok')
			expect(response.status).toBe(status)
			expect(getRefreshToken()).toBe('refresh-1')
		},
	)
})

describe('tenantFetchResponse', () => {
	it('rejects a transient session like the network', async () => {
		setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(answer(401)).mockResolvedValueOnce(answer(503)),
		)
		await expect(tenantFetchResponse('/loyalty/wallet')).rejects.toBeInstanceOf(
			TenantSessionUnavailableError,
		)
		expect(getRefreshToken()).toBe('refresh-1')
	})

	it('returns the answer of a signed-out or settled session', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(answer(401))
				.mockResolvedValueOnce(answer(200, { ok: true })),
		)
		expect((await tenantFetchResponse('/auth/me')).status).toBe(401)
		expect((await tenantFetchResponse('/auth/me')).status).toBe(200)
	})
})

describe('the regional address', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('comes from the page', () => {
		document.documentElement.dataset.tenantApiUrl = 'https://regional.example/'
		expect(getBrowserTenantApiUrl()).toBe('https://regional.example')
	})

	it('falls back to the local node in development only', () => {
		delete document.documentElement.dataset.tenantApiUrl
		vi.stubEnv('DEV', true)
		expect(getBrowserTenantApiUrl()).toBe('http://localhost:3007')
		vi.stubEnv('DEV', false)
		expect(() => getBrowserTenantApiUrl()).toThrow()
	})

	it('never sends the customer token anywhere else', async () => {
		delete document.documentElement.dataset.tenantApiUrl
		vi.stubEnv('DEV', false)
		setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		await expect(tenantFetch('/loyalty/wallet')).rejects.toThrow()
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
