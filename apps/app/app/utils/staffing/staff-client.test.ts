import { describe, expect, it, vi } from 'vitest'
import {
	createStaffClient,
	createStaffClientPool,
	holdsGrant,
	StaffApiError,
	TOKEN_REFRESH_MARGIN_MS,
} from './staff-client.ts'

const API = 'https://us.tenant.test'

function tokenResponse(
	overrides: Partial<{
		jwt: string
		expiresAt: number
		grants: string[]
		scope: string
	}> = {},
) {
	return Response.json({
		jwt: overrides.jwt ?? 'jwt-1',
		tenantApiUrl: `${API}/`,
		scope: overrides.scope ?? 'staff',
		grants: overrides.grants ?? ['read:staff:any'],
		expiresAt: overrides.expiresAt ?? 10 * 60_000,
	})
}

/** A fetch double: token URL answers from `tokens`, API URL from `api`. */
function fakeFetch(
	tokens: Array<() => Response>,
	api: Array<() => Response> = [() => Response.json({ ok: true })],
) {
	const calls: Array<{ url: string; init?: RequestInit }> = []
	let t = 0
	let a = 0
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push({ url, init })
		if (url.includes('/staff/token')) {
			return tokens[Math.min(t++, tokens.length - 1)]!()
		}
		return api[Math.min(a++, api.length - 1)]!()
	})
	return { impl: impl as unknown as typeof fetch, calls }
}

describe('createStaffClient', () => {
	it('mints once per workplace and sends the bearer token to the regional origin', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await client.request('/positions')
		await client.request('/')
		const tokenCalls = calls.filter((c) => c.url.includes('/staff/token'))
		expect(tokenCalls).toHaveLength(1)
		expect(tokenCalls[0]!.url).toBe('/acme/staff/token?scope=staff')
		const api = calls.filter((c) => !c.url.includes('/staff/token'))
		expect(api[0]!.url).toBe(`${API}/operator/staff/positions`)
		expect(new Headers(api[0]!.init!.headers).get('Authorization')).toBe(
			'Bearer jwt-1',
		)
		expect(api[0]!.init!.cache).toBe('no-store')
	})

	it('sends each workplace to its own route group', async () => {
		const { impl, calls } = fakeFetch([
			() => tokenResponse({ scope: 'timeclock' }),
		])
		const client = createStaffClient({
			orgSlug: 'acme',
			scope: 'timeclock',
			fetchImpl: impl,
			now: () => 0,
		})
		await client.request('/today?scopeId=loc-1')
		await client.request('/policies/default')
		const api = calls.filter((c) => !c.url.includes('/staff/token'))
		expect(api.map((c) => c.url)).toEqual([
			`${API}/operator/timeclock/today?scopeId=loc-1`,
			`${API}/operator/timeclock/policies/default`,
		])
	})

	it('never adds a trailing slash, because the API has no such routes', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await client.request('/')
		await client.request('/?include=pay&limit=50')
		await client.request('?q=x')
		const urls = calls
			.filter((c) => !c.url.includes('/staff/token'))
			.map((c) => c.url)
		expect(urls).toEqual([
			`${API}/operator/staff`,
			`${API}/operator/staff?include=pay&limit=50`,
			`${API}/operator/staff?q=x`,
		])
	})

	it('shares one in-flight mint between concurrent callers', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await Promise.all([
			client.request('/a'),
			client.request('/b'),
			client.grants(),
		])
		expect(calls.filter((c) => c.url.includes('/staff/token'))).toHaveLength(1)
	})

	it('refreshes the token a minute before it expires', async () => {
		let clock = 0
		const { impl, calls } = fakeFetch([
			() => tokenResponse({ jwt: 'first', expiresAt: 5 * 60_000 }),
			() => tokenResponse({ jwt: 'second', expiresAt: 20 * 60_000 }),
		])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => clock,
		})
		await client.request('/')
		clock = 5 * 60_000 - TOKEN_REFRESH_MARGIN_MS - 1
		await client.request('/')
		expect(calls.filter((c) => c.url.includes('/staff/token'))).toHaveLength(1)
		clock = 5 * 60_000 - TOKEN_REFRESH_MARGIN_MS
		await client.request('/')
		const auth = calls
			.filter((c) => !c.url.includes('/staff/token'))
			.map((c) => new Headers(c.init!.headers).get('Authorization'))
		expect(auth).toEqual(['Bearer first', 'Bearer first', 'Bearer second'])
	})

	it('mints again once on a 401 and then gives up', async () => {
		const { impl, calls } = fakeFetch(
			[
				() => tokenResponse({ jwt: 'old' }),
				() => tokenResponse({ jwt: 'new' }),
			],
			[
				() => new Response('{}', { status: 401 }),
				() => Response.json({ staff: [] }),
			],
		)
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await expect(client.request('/')).resolves.toEqual({ staff: [] })
		expect(calls.filter((c) => c.url.includes('/staff/token'))).toHaveLength(2)

		const failing = fakeFetch(
			[() => tokenResponse()],
			[() => new Response('{"error":"Unauthorized"}', { status: 401 })],
		)
		const again = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: failing.impl,
			now: () => 0,
		})
		await expect(again.request('/')).rejects.toMatchObject({
			status: 401,
			code: 'Unauthorized',
		})
	})

	it('turns an error body into a StaffApiError with field issues', async () => {
		const { impl } = fakeFetch(
			[() => tokenResponse()],
			[
				() =>
					Response.json(
						{
							error: 'Invalid request',
							issues: [{ path: 'phone', code: 'invalid_format' }],
						},
						{ status: 400 },
					),
			],
		)
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		const error = await client
			.request('/', { method: 'POST', json: {} })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(StaffApiError)
		expect(error).toMatchObject({
			status: 400,
			code: 'Invalid request',
			issues: [{ path: 'phone', code: 'invalid_format' }],
		})
	})

	it('survives a non-JSON error page without leaking its body', async () => {
		const { impl } = fakeFetch(
			[() => tokenResponse()],
			[() => new Response('<html>boom secret</html>', { status: 502 })],
		)
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		const error = (await client.request('/').catch((e: unknown) => e)) as Error
		expect(error).toBeInstanceOf(StaffApiError)
		expect(error.message).toBe('request_failed')
	})

	it('serializes json bodies with a content type', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await client.request('/', { method: 'POST', json: { firstName: 'Dana' } })
		const call = calls.find((c) => !c.url.includes('/staff/token'))!
		expect(call.init!.body).toBe('{"firstName":"Dana"}')
		expect(new Headers(call.init!.headers).get('Content-Type')).toBe(
			'application/json',
		)
	})

	it('does not cache a failed mint', async () => {
		const { impl, calls } = fakeFetch([
			() => new Response('no', { status: 403 }),
			() => tokenResponse(),
		])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: impl,
			now: () => 0,
		})
		await expect(client.request('/')).rejects.toMatchObject({
			code: 'token_unavailable',
			status: 403,
		})
		await expect(client.request('/')).resolves.toEqual({ ok: true })
		expect(calls.filter((c) => c.url.includes('/staff/token'))).toHaveLength(2)
	})

	it('rejects a malformed token response and unknown grants are dropped', async () => {
		const bad = fakeFetch([() => Response.json({ jwt: 'x' })])
		const client = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: bad.impl,
			now: () => 0,
		})
		await expect(client.credentials()).rejects.toMatchObject({
			code: 'token_malformed',
		})

		const ok = fakeFetch([
			() => tokenResponse({ grants: ['read:staff:any', 'drop:table:any'] }),
		])
		const second = createStaffClient({
			orgSlug: 'acme',
			fetchImpl: ok.impl,
			now: () => 0,
		})
		expect([...(await second.grants())]).toEqual(['read:staff:any'])
	})

	it('encodes the org slug in the token URL', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const client = createStaffClient({
			orgSlug: 'a/b?c',
			fetchImpl: impl,
			now: () => 0,
		})
		await client.credentials()
		expect(calls[0]!.url).toBe('/a%2Fb%3Fc/staff/token?scope=staff')
	})
})

describe('createStaffClientPool', () => {
	it('keeps one client per workplace and mints each workplace separately', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const pool = createStaffClientPool('acme', {
			fetchImpl: impl,
			now: () => 0,
		})
		expect(pool.get('staff')).toBe(pool.get('staff'))
		expect(pool.get('staff')).not.toBe(pool.get('timeclock'))
		await pool.get('staff').credentials()
		await pool.get('timeclock').credentials()
		expect(calls.map((c) => c.url)).toEqual([
			'/acme/staff/token?scope=staff',
			'/acme/staff/token?scope=timeclock',
		])
	})

	it('forgetAll drops cached tokens', async () => {
		const { impl, calls } = fakeFetch([() => tokenResponse()])
		const pool = createStaffClientPool('acme', {
			fetchImpl: impl,
			now: () => 0,
		})
		await pool.get('staff').credentials()
		pool.forgetAll()
		await pool.get('staff').credentials()
		expect(calls).toHaveLength(2)
	})
})

describe('holdsGrant', () => {
	it('lets a stronger grant satisfy a read and never the reverse', () => {
		expect(
			holdsGrant(new Set(['update:staff_pay:any']), 'read:staff_pay:any'),
		).toBe(true)
		expect(
			holdsGrant(new Set(['read:staff_pay:any']), 'update:staff_pay:any'),
		).toBe(false)
		expect(holdsGrant(null, 'read:staff:any')).toBe(false)
		expect(holdsGrant(new Set(), 'read:staff:any')).toBe(false)
	})
})
