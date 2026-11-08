import { decodeJwt } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

import {
	getOperatorTenantClient,
	resolveRegionalTenantApiUrls,
} from './tenant-api.server.ts'

describe('resolveRegionalTenantApiUrls', () => {
	it('gives the browser the public HTTPS origin and keeps localhost for server fetch', () => {
		expect(
			resolveRegionalTenantApiUrls('us', {
				TENANT_API_URL: 'http://localhost:3007',
			}),
		).toEqual({
			tenantApiUrl: 'http://localhost:3007',
		})
	})

	it('resolves KSA public and internal URLs independently', () => {
		expect(
			resolveRegionalTenantApiUrls('ksa', {
				TENANT_API_URL_KSA: 'http://localhost:3009',
			}),
		).toEqual({
			tenantApiUrl: 'http://localhost:3009',
		})
	})

	it('falls back to the internal URL when no public origin is configured', () => {
		expect(
			resolveRegionalTenantApiUrls('us', {
				TENANT_API_URL: 'https://tenant-api.example.com/',
			}),
		).toEqual({
			tenantApiUrl: 'https://tenant-api.example.com',
		})
	})
})

describe('getOperatorTenantClient tokens', () => {
	afterEach(() => vi.restoreAllMocks())

	async function client(
		options: Parameters<typeof getOperatorTenantClient>[2],
	) {
		const { organization, user, cookie } = await setupTestOrgWithUser('member')
		const request = createAuthenticatedRequest(
			`http://localhost:3001/${organization.slug}/marketing`,
			{},
			cookie,
		)
		const result = await getOperatorTenantClient(
			request,
			organization.slug,
			options,
		)
		return { ...result, organizationId: organization.id, userId: user.id }
	}

	/** The bearer token `fetchTenant` sent on its only call. */
	function sentToken(fetchSpy: { mock: { calls: any[][] } }) {
		const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers)
		return headers.get('Authorization')?.replace('Bearer ', '')
	}

	it('gives the browser token only the write claims it was asked for', async () => {
		const readOnly = await client({ area: 'customers' })
		expect(decodeJwt(readOnly.jwt!)).not.toHaveProperty('canUpdate')
		expect(decodeJwt(readOnly.jwt!)).not.toHaveProperty('canDelete')

		const updater = await client({ area: 'customers', canUpdate: true })
		expect(decodeJwt(updater.jwt!)).toMatchObject({
			area: 'customers',
			canUpdate: true,
		})
		expect(decodeJwt(updater.jwt!)).not.toHaveProperty('canDelete')
	})

	it('never hands out an unbound token: it works on every operator route', async () => {
		const unbound = await client({ canUpdate: true })
		expect(unbound.jwt).toBeUndefined()
	})

	it('signs the member and organization the request was authorized for', async () => {
		const operator = await client({ area: 'marketing', canUpdate: true })

		expect(decodeJwt(operator.jwt!)).toMatchObject({
			sub: operator.userId,
			orgId: operator.organizationId,
			role: 'operator',
		})
	})

	it('limits server-side requests to the claims it was asked for', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}'))
		const readOnly = await client({})

		await readOnly.fetchTenant('/operator/journeys', { method: 'DELETE' })

		const claims = decodeJwt(sentToken(fetchSpy)!)
		expect(claims).not.toHaveProperty('canUpdate')
		expect(claims).not.toHaveProperty('canDelete')
	})

	it('sends write claims on the server only when they were asked for', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}'))
		const writer = await client({ canUpdate: true, canDelete: true })

		await writer.fetchTenant('/operator/journeys', { method: 'POST' })

		expect(decodeJwt(sentToken(fetchSpy)!)).toMatchObject({
			canUpdate: true,
			canDelete: true,
		})
	})

	it('keeps scoped tokens exactly as asked, for the browser and the server', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}'))
		const scoped = await client({ scope: 'mailbox' })

		await scoped.fetchTenant('/operator/mailbox/count')

		const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers)
		expect(headers.get('Authorization')).toBe(`Bearer ${scoped.jwt}`)
		expect(decodeJwt(scoped.jwt!)).not.toHaveProperty('canUpdate')
	})
})
