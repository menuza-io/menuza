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
		const { organization, cookie } = await setupTestOrgWithUser('member')
		const request = createAuthenticatedRequest(
			`http://localhost:3001/${organization.slug}/marketing`,
			{},
			cookie,
		)
		return getOperatorTenantClient(request, organization.slug, options)
	}

	it('gives the browser token only the write claims it was asked for', async () => {
		const readOnly = await client({})
		expect(decodeJwt(readOnly.jwt)).not.toHaveProperty('canUpdate')
		expect(decodeJwt(readOnly.jwt)).not.toHaveProperty('canDelete')

		const updater = await client({ canUpdate: true })
		expect(decodeJwt(updater.jwt)).toMatchObject({ canUpdate: true })
		expect(decodeJwt(updater.jwt)).not.toHaveProperty('canDelete')
	})

	it('sends server-side requests with full write claims, never the browser token', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('{}'))
		const readOnly = await client({})

		await readOnly.fetchTenant('/operator/journeys')

		const headers = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers)
		const serverToken = headers.get('Authorization')?.replace('Bearer ', '')
		expect(serverToken).toBeTruthy()
		expect(serverToken).not.toBe(readOnly.jwt)
		expect(decodeJwt(serverToken!)).toMatchObject({
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
		expect(decodeJwt(scoped.jwt)).not.toHaveProperty('canUpdate')
	})
})
