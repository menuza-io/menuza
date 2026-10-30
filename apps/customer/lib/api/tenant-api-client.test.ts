import { ApiError } from './api-error'
import {
	organizationIconUrl,
	resolvedDataRegion,
	resolvedLocales,
} from './public-site'
import { TenantApiClient } from './tenant-api-client'
import { failingTransport, header, StubTransport } from '@/test/stub-transport'
import { makeAccessToken, makeConfiguration } from '@/test/support'

async function caught(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof ApiError) return error
		throw error
	}
	throw new Error('Expected an ApiError')
}

describe('TenantApiClient', () => {
	it('fetches the organization with the slug binding and decodes the branding', async () => {
		const transport = new StubTransport([
			{
				json: {
					id: 'org_1',
					name: 'Acme Coffee',
					slug: 'acme',
					dataRegion: 'us',
					locales: ['en', 'ar'],
					defaultLocale: 'en',
					siteIcon: {
						original: '/resources/images?objectKey=org%2Facme%2Ficon.png',
					},
					theme: {
						baseColor: 'neutral',
						theme: 'amber',
						radius: 'large',
						mode: 'system',
						headingFont: 'space-grotesk',
						bodyFont: 'inter',
						css: 'html { --primary: oklch(0.205 0 0); }',
					},
					announcements: [
						{
							id: 'ann_1',
							content: 'Free delivery this week',
							type: 'info',
							linkUrl: '/shop',
							linkLabel: 'Shop',
							linkNewTab: false,
						},
					],
				},
			},
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const organization = await client.fetchOrganization('ar')

		expect(organization.name).toBe('Acme Coffee')
		expect(resolvedDataRegion(organization)).toBe('us')
		expect(resolvedLocales(organization)).toEqual(['en', 'ar'])
		expect((organization.theme as { theme?: string }).theme).toBe('amber')
		expect(organization.announcements?.[0]?.content).toBe(
			'Free delivery this week',
		)
		expect(
			organizationIconUrl(organization, 'https://app.epic-startup.com'),
		).toBe(
			'https://app.epic-startup.com/resources/images?objectKey=org%2Facme%2Ficon.png',
		)

		const url = transport.lastRequest?.url
		expect(url?.pathname).toBe('/resources/sites')
		expect(url?.searchParams.get('slug')).toBe('acme')
		expect(url?.searchParams.get('lng')).toBe('ar')
	})

	it('uses the custom domain binding', async () => {
		const transport = new StubTransport([
			{ json: { id: 'org_2', name: 'Custom', slug: 'custom' } },
		])
		const client = new TenantApiClient(
			makeConfiguration({ slug: null, host: 'www.acme.com' }),
			transport.send,
		)

		await client.fetchOrganization()

		const url = transport.lastRequest?.url
		expect(url?.searchParams.get('host')).toBe('www.acme.com')
		expect(url?.searchParams.has('slug')).toBe(false)
	})

	it('sends the device languages as Accept-Language', async () => {
		const transport = new StubTransport([
			{ json: { id: 'org_1', name: 'Acme', slug: 'acme' } },
			{ json: { id: 'org_1', name: 'Acme', slug: 'acme' } },
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		await client.fetchOrganization(null, [
			'ar-SA',
			' en-US ',
			'bad tag;',
			'',
			'fr',
		])
		expect(header(transport.lastRequest, 'Accept-Language')).toBe(
			'ar-SA, en-US, fr',
		)
		expect(transport.lastRequest?.url.searchParams.has('lng')).toBe(false)

		await client.fetchOrganization()
		expect(header(transport.lastRequest, 'Accept-Language')).toBeUndefined()
	})

	it('refuses site calls while unbound', async () => {
		const transport = new StubTransport()
		const client = new TenantApiClient(
			makeConfiguration({ slug: null, host: null }),
			transport.send,
		)

		const error = await caught(client.fetchOrganization())
		expect(error.code).toBe('not_bound')
		expect(error.message).toBe('This app is not connected to a site yet.')
		expect(transport.recorded).toHaveLength(0)
	})

	it('binds send-code to the organization with an Origin header', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const client = new TenantApiClient(
			makeConfiguration({ origin: 'https://acme.epic-startup.com' }),
			transport.send,
		)

		await client.sendCode('+15550001111')

		const recorded = transport.lastRequest
		expect(recorded?.request.url).toBe(
			'https://tenant-us.epic-startup.com/auth/send-code',
		)
		expect(recorded?.body.slug).toBe('acme')
		expect(recorded?.body.phone).toBe('+15550001111')
		expect(header(recorded, 'Origin')).toBe('https://acme.epic-startup.com')
		expect(header(recorded, 'Content-Type')).toBe('application/json')
	})

	it('omits the Origin header for local development', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const client = new TenantApiClient(
			makeConfiguration({ origin: 'http://acme.epic-startup.test:3010' }),
			transport.send,
		)

		await client.sendCode('+15550001111')

		expect(header(transport.lastRequest, 'Origin')).toBeUndefined()
		expect(transport.lastRequest?.body.slug).toBe('acme')
	})

	it('sends KSA organizations to the KSA node', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const client = new TenantApiClient(
			makeConfiguration({
				origin: 'https://acme.epic-startup.com',
				region: 'ksa',
			}),
			transport.send,
		)

		await client.sendCode('+966500000000')

		expect(transport.lastRequest?.url.host).toBe('tenant-ksa.epic-startup.com')
	})

	it('never sends a KSA organization to another region', async () => {
		const transport = new StubTransport([{ json: { success: true } }])
		const client = new TenantApiClient(
			{ ...makeConfiguration({ region: 'ksa' }), tenantApiBaseUrlKsa: null },
			transport.send,
		)

		const error = await caught(client.sendCode('+966500000000'))
		expect(error.code).toBe('region_unavailable')
		expect(transport.recorded).toHaveLength(0)
	})

	it('surfaces the server error description', async () => {
		const transport = new StubTransport([
			{
				status: 429,
				raw: '{"error":"rate_limit_exceeded","error_description":"Too many verification attempts for this phone number."}',
			},
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const error = await caught(client.verify('+15550001111', '123456'))
		expect(error.status).toBe(429)
		expect(error.isRateLimited).toBe(true)
		expect(error.code).toBe('rate_limit_exceeded')
		expect(error.message).toBe(
			'Too many verification attempts for this phone number.',
		)
	})

	it('rejects a verification without an access token', async () => {
		const transport = new StubTransport([
			{ json: { success: false, error: 'Invalid or expired code' } },
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const error = await caught(client.verify('+15550001111', '000000'))
		expect(error.message).toBe('Invalid or expired code')
	})

	it('fetches the profile with the bearer token', async () => {
		const transport = new StubTransport([
			{
				json: {
					customer: {
						id: 'cust_1',
						name: 'Ada Lovelace',
						email: 'ada@example.com',
						phone: '+15550001111',
						needsName: false,
					},
				},
			},
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const profile = await client.fetchProfile('token-123')

		expect(profile.name).toBe('Ada Lovelace')
		expect(profile.needsName).toBe(false)
		expect(transport.lastRequest?.request.url).toBe(
			'https://tenant-us.epic-startup.com/auth/me',
		)
		expect(header(transport.lastRequest, 'Authorization')).toBe(
			'Bearer token-123',
		)
	})

	it('answers 404 when the profile envelope is empty', async () => {
		const transport = new StubTransport([{ json: { customer: null } }])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const error = await caught(client.fetchProfile('token-123'))
		expect(error.isNotFound).toBe(true)
	})

	it('posts the name and email when saving the profile', async () => {
		const transport = new StubTransport([
			{
				json: {
					success: true,
					accessToken: makeAccessToken(),
					refreshToken: 'refresh-2',
				},
			},
		])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const tokens = await client.updateProfile(
			'Ada Byron',
			'ada@example.com',
			'token-123',
		)

		expect(tokens.refreshToken).toBe('refresh-2')
		expect(transport.lastRequest?.request.url).toBe(
			'https://tenant-us.epic-startup.com/auth/profile',
		)
		expect(transport.lastRequest?.body).toEqual({
			name: 'Ada Byron',
			email: 'ada@example.com',
		})
	})

	it('refuses token answers without a refresh token', async () => {
		const answer = { json: { success: true, accessToken: makeAccessToken() } }
		const transport = new StubTransport([answer, answer, answer])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		expect((await caught(client.verify('+15550001111', '123456'))).code).toBe(
			'verification_failed',
		)
		expect((await caught(client.refresh('refresh-1', 'org_1'))).code).toBe(
			'session_expired',
		)
		expect(
			(await caught(client.updateProfile('Ada', undefined, 't'))).code,
		).toBe('profile_not_saved')
	})

	it('turns unexpected payloads into errors', async () => {
		const transport = new StubTransport([{ raw: '{"unexpected":true}' }])
		const client = new TenantApiClient(makeConfiguration(), transport.send)

		const error = await caught(client.fetchOrganization())
		expect(error.status).toBe(200)
		expect(error.message).toContain('Unexpected response')
	})

	it('turns transport failures into status 0 errors', async () => {
		const client = new TenantApiClient(makeConfiguration(), failingTransport)

		const error = await caught(client.fetchOrganization())
		expect(error.isTransportFailure).toBe(true)
		expect(error.message).not.toBe('')
	})

	it('prefers the most specific error message', () => {
		expect(ApiError.from(404, 'Not Found').message).toBe('Not Found')
		expect(ApiError.from(400, '{"message":"Bad input"}').message).toBe(
			'Bad input',
		)
		expect(ApiError.from(500, '').message).toBe('Request failed (500)')
		expect(ApiError.from(500, 'x'.repeat(300)).message).toBe(
			'Request failed (500)',
		)
		expect(
			ApiError.from(401, '{"error":"Invalid or expired token"}').code,
		).toBeNull()
	})

	it('reads the machine code and tells which answers end the session', () => {
		const inactive = ApiError.from(
			403,
			'{"error":"Organization is no longer active","code":"organization_inactive"}',
		)
		expect(inactive.message).toBe('Organization is no longer active')
		expect(inactive.code).toBe('organization_inactive')
		expect(inactive.endsSession).toBe(true)
		expect(
			ApiError.from(401, '{"error":"Invalid refresh token"}').endsSession,
		).toBe(true)
		expect(
			ApiError.from(403, '{"error":"Organization is no longer active"}')
				.endsSession,
		).toBe(false)
		expect(
			ApiError.from(503, '{"error":"Busy","code":"temporarily_unavailable"}')
				.code,
		).toBe('temporarily_unavailable')
		expect(
			ApiError.from(503, '{"code":"organization_inactive"}').endsSession,
		).toBe(false)
	})
})
