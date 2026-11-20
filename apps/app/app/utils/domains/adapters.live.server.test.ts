/**
 * The live partners' request shapes, through a fake `fetch`: Cloudflare zones,
 * DNS records and email routing, the Name.com registrar and Domain Connect.
 * (The emulators are covered by every other suite in this folder.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	CloudflareDnsZoneProvider,
	CloudflareEmailRouting,
} from './adapters.cloudflare.server.ts'
import { NameComRegistrar } from './adapters.namecom.server.ts'
import { RegistrarError } from './adapters.server.ts'

type Call = { url: string; method: string; body: unknown; auth: string | null }

function fakeFetch(
	answers: Array<{
		match: RegExp
		method?: string
		status?: number
		body: unknown
	}>,
) {
	const calls: Call[] = []
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		const headers = new Headers(init?.headers)
		calls.push({
			url,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			auth: headers.get('Authorization'),
		})
		const answer = answers.find(
			(a) => a.match.test(url) && (!a.method || a.method === method),
		)
		if (!answer)
			return Response.json(
				{ success: false, errors: [{ message: 'unexpected call' }] },
				{ status: 500 },
			)
		return Response.json(answer.body, { status: answer.status ?? 200 })
	}) as unknown as typeof fetch
	return { impl, calls }
}

const ok = <T>(result: T) => ({ success: true, errors: [], result })

beforeEach(() => {
	vi.stubEnv('CLOUDFLARE_DOMAINS_API_TOKEN', 'cf-token-123')
	vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acct-1')
	vi.stubEnv('NAMECOM_USERNAME', 'user')
	vi.stubEnv('NAMECOM_API_TOKEN', 'token')
})
afterEach(() => vi.unstubAllEnvs())

describe('Cloudflare DNS zones', () => {
	it('creates a zone in our account and reads its nameservers and status', async () => {
		const { impl, calls } = fakeFetch([
			{
				match: /\/zones$/u,
				method: 'POST',
				body: ok({
					id: 'z1',
					status: 'pending',
					name_servers: ['Ada.NS.cloudflare.com', 'bob.ns.cloudflare.com'],
				}),
			},
			{
				match: /\/zones\/z1$/u,
				method: 'GET',
				body: ok({
					id: 'z1',
					status: 'active',
					name_servers: ['ada.ns.cloudflare.com'],
				}),
			},
		])
		const provider = new CloudflareDnsZoneProvider({ fetchImpl: impl })
		expect(provider.isConfigured()).toBe(true)
		expect(await provider.createZone('example.com')).toEqual({
			zoneId: 'z1',
			nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
			status: 'pending',
		})
		expect(calls[0]).toMatchObject({
			url: 'https://api.cloudflare.com/client/v4/zones',
			body: { name: 'example.com', account: { id: 'acct-1' }, type: 'full' },
			auth: 'Bearer cf-token-123',
		})
		expect((await provider.getZone('z1'))?.status).toBe('active')
	})

	it('reuses a zone that already exists in the account', async () => {
		const { impl } = fakeFetch([
			{
				match: /\/zones$/u,
				method: 'POST',
				status: 400,
				body: { success: false, errors: [{ code: 1061, message: 'exists' }] },
			},
			{
				match: /\/zones\?name=example\.com/u,
				body: ok([
					{
						id: 'z9',
						status: 'pending',
						name_servers: ['a.ns.cloudflare.com'],
					},
				]),
			},
		])
		expect(
			(
				await new CloudflareDnsZoneProvider({ fetchImpl: impl }).createZone(
					'example.com',
				)
			).zoneId,
		).toBe('z9')
	})

	it('writes, reads and removes records with the right bodies', async () => {
		const { impl, calls } = fakeFetch([
			{
				match: /dns_records\?/u,
				body: ok([
					{
						id: 'r1',
						type: 'TXT',
						name: 'Example.com',
						content: '"v=spf1 -all"',
						ttl: 1,
					},
				]),
			},
			{
				match: /dns_records$/u,
				method: 'POST',
				body: ok({
					id: 'r2',
					type: 'MX',
					name: 'example.com',
					content: 'mx.example.net',
					ttl: 1,
					priority: 10,
				}),
			},
			{ match: /dns_records\/r2$/u, method: 'DELETE', body: ok({ id: 'r2' }) },
		])
		const provider = new CloudflareDnsZoneProvider({ fetchImpl: impl })
		expect((await provider.listRecords('z1'))[0]).toMatchObject({
			id: 'r1',
			name: 'example.com',
			content: 'v=spf1 -all',
		})
		await provider.createRecord('z1', {
			type: 'MX',
			name: 'example.com',
			content: 'mx.example.net',
			priority: 10,
		})
		expect(calls.at(-1)?.body).toEqual({
			type: 'MX',
			name: 'example.com',
			content: 'mx.example.net',
			ttl: 1,
			priority: 10,
		})
		await provider.deleteRecord('z1', 'r2')
		expect(calls.at(-1)).toMatchObject({ method: 'DELETE' })
	})

	it('answers null for a zone that is gone', async () => {
		const { impl } = fakeFetch([
			{
				match: /\/zones\/gone$/u,
				status: 404,
				body: { success: false, errors: [{ message: 'nope' }] },
			},
		])
		expect(
			await new CloudflareDnsZoneProvider({ fetchImpl: impl }).getZone('gone'),
		).toBeNull()
	})

	it('is not configured without a token and account', () => {
		vi.stubEnv('CLOUDFLARE_DOMAINS_API_TOKEN', '')
		expect(new CloudflareDnsZoneProvider().isConfigured()).toBe(false)
	})
})

describe('Cloudflare email routing', () => {
	it('adds a destination once, reports its confirmation, and writes rules', async () => {
		const { impl, calls } = fakeFetch([
			{
				match: /email\/routing\/addresses\?/u,
				body: ok([{ id: 'd1', email: 'Owner@gmail.com', verified: null }]),
			},
			{
				match: /email\/routing\/addresses$/u,
				method: 'POST',
				body: ok({ id: 'd2', email: 'new@gmail.com', verified: null }),
			},
			{
				match: /email\/routing\/rules$/u,
				method: 'POST',
				body: ok({ id: 'rule-1' }),
			},
			{
				match: /email\/routing\/rules\/catch_all$/u,
				method: 'PUT',
				body: ok({}),
			},
			{ match: /email\/routing\/dns$/u, method: 'POST', body: ok({}) },
		])
		const routing = new CloudflareEmailRouting({ fetchImpl: impl })
		// An existing unconfirmed destination is reused, not added twice.
		expect(await routing.addDestination('owner@gmail.com')).toEqual({
			email: 'owner@gmail.com',
			verified: false,
		})
		expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
		expect(await routing.addDestination('new@gmail.com')).toEqual({
			email: 'new@gmail.com',
			verified: false,
		})

		expect(
			await routing.upsertRule({
				zoneId: 'z1',
				domain: 'example.com',
				localPart: 'info',
				destination: 'owner@gmail.com',
			}),
		).toEqual({ ruleId: 'rule-1' })
		expect(calls.at(-1)?.body).toMatchObject({
			matchers: [{ type: 'literal', field: 'to', value: 'info@example.com' }],
			actions: [{ type: 'forward', value: ['owner@gmail.com'] }],
		})
		expect(
			await routing.upsertRule({
				zoneId: 'z1',
				domain: 'example.com',
				localPart: '*',
				destination: 'owner@gmail.com',
			}),
		).toEqual({ ruleId: 'catch_all' })
		expect(calls.at(-1)?.body).toMatchObject({ matchers: [{ type: 'all' }] })
		expect(await routing.enable('z1')).toEqual({
			records: [],
			spfInclude: 'include:_spf.mx.cloudflare.net',
		})
	})

	it('reads when mail last went through, and answers null on any trouble', async () => {
		const good = fakeFetch([
			{
				match: /\/graphql$/u,
				body: {
					data: {
						viewer: {
							zones: [
								{
									emailRoutingAdaptive: [{ datetime: '2026-11-18T10:00:00Z' }],
								},
							],
						},
					},
				},
			},
		])
		expect(
			await new CloudflareEmailRouting({
				fetchImpl: good.impl,
			}).lastForwardedAt?.('z1', 'rule-1'),
		).toEqual(new Date('2026-11-18T10:00:00Z'))
		const bad = fakeFetch([{ match: /\/graphql$/u, status: 500, body: {} }])
		expect(
			await new CloudflareEmailRouting({
				fetchImpl: bad.impl,
			}).lastForwardedAt?.('z1', 'rule-1'),
		).toBeNull()
		expect(
			await new CloudflareEmailRouting({
				fetchImpl: good.impl,
			}).lastForwardedAt?.('z1', 'catch_all'),
		).toBeNull()
	})
})

describe('Name.com registrar', () => {
	const contact = {
		firstName: 'Sara',
		lastName: 'Haddad',
		organization: 'Al Bait LLC',
		email: 'sara@albait.example',
		phone: '+966115550100',
		address1: '12 King Fahd Road',
		city: 'Riyadh',
		state: 'Riyadh',
		postalCode: '11564',
		country: 'SA',
	}

	it('checks availability and prices in cents', async () => {
		const { impl, calls } = fakeFetch([
			{
				match: /domains:checkAvailability$/u,
				method: 'POST',
				body: {
					results: [
						{
							domainName: 'albait.com',
							purchasable: true,
							premium: false,
							purchasePrice: 12.99,
							renewalPrice: 14.99,
						},
					],
				},
			},
		])
		const [result] = await new NameComRegistrar(impl).checkAvailability([
			'albait.com',
		])
		expect(result).toEqual({
			fqdn: 'albait.com',
			available: true,
			premium: false,
			costCents: 1299,
			renewalCostCents: 1499,
			currency: 'usd',
		})
		expect(calls[0]!.auth).toBe(`Basic ${btoa('user:token')}`)
		expect(calls[0]!.body).toEqual({ domainNames: ['albait.com'] })
	})

	it('registers with the contact, privacy, our nameservers and the price it just checked', async () => {
		const { impl, calls } = fakeFetch([
			{
				match: /domains:checkAvailability$/u,
				body: {
					results: [
						{
							domainName: 'albait.com',
							purchasable: true,
							purchasePrice: 12.99,
							renewalPrice: 12.99,
						},
					],
				},
			},
			{
				match: /\/v4\/domains$/u,
				method: 'POST',
				body: {
					domain: {
						domainName: 'albait.com',
						expireDate: '2027-11-19T00:00:00Z',
					},
				},
			},
		])
		const result = await new NameComRegistrar(impl).register({
			fqdn: 'albait.com',
			years: 1,
			contact,
			privacy: true,
			autoRenew: true,
			nameservers: ['ada.ns.cloudflare.com'],
			idempotencyKey: 'job-1',
		})
		expect(result.expiresAt).toEqual(new Date('2027-11-19T00:00:00Z'))
		const body = calls.at(-1)!.body as {
			domain: {
				contacts: { registrant: Record<string, string> }
				privacyEnabled: boolean
				nameservers: string[]
			}
			purchasePrice: number
			years: number
		}
		expect(body).toMatchObject({
			purchasePrice: 12.99,
			years: 1,
			domain: { privacyEnabled: true, nameservers: ['ada.ns.cloudflare.com'] },
		})
		expect(body.domain.contacts.registrant).toMatchObject({
			companyName: 'Al Bait LLC',
			zip: '11564',
			country: 'SA',
		})
	})

	it('refuses a name that is no longer purchasable, and maps transfer errors', async () => {
		const taken = fakeFetch([
			{
				match: /checkAvailability$/u,
				body: { results: [{ domainName: 'albait.com', purchasable: false }] },
			},
		])
		await expect(
			new NameComRegistrar(taken.impl).register({
				fqdn: 'albait.com',
				years: 1,
				contact,
				privacy: true,
				autoRenew: true,
				nameservers: [],
				idempotencyKey: 'k',
			}),
		).rejects.toMatchObject({ code: 'domain_unavailable' })

		const locked = fakeFetch([
			{
				match: /\/transfers$/u,
				method: 'POST',
				status: 400,
				body: { message: 'Domain is locked' },
			},
		])
		await expect(
			new NameComRegistrar(locked.impl).transferIn({
				fqdn: 'albait.com',
				authCode: 'X',
				contact,
				privacy: true,
				autoRenew: true,
				idempotencyKey: 'k',
			}),
		).rejects.toMatchObject({ code: 'locked' })
		const badCode = fakeFetch([
			{
				match: /\/transfers$/u,
				method: 'POST',
				status: 400,
				body: { message: 'invalid auth code' },
			},
		])
		await expect(
			new NameComRegistrar(badCode.impl).transferIn({
				fqdn: 'albait.com',
				authCode: 'X',
				contact,
				privacy: true,
				autoRenew: true,
				idempotencyKey: 'k',
			}),
		).rejects.toMatchObject({ code: 'invalid_auth_code' })
		expect(RegistrarError).toBeTruthy()
	})

	it('gets the authorization code, locks and sets auto-renew', async () => {
		const { impl, calls } = fakeFetch([
			{ match: /:getAuthCodeForDomain$/u, body: { authCode: 'AUTH-1' } },
			{ match: /:unlock$/u, method: 'POST', body: {} },
			{ match: /:setAutorenew$/u, method: 'POST', body: {} },
		])
		const registrar = new NameComRegistrar(impl)
		expect(await registrar.getAuthCode('albait.com')).toBe('AUTH-1')
		await registrar.setLock('albait.com', false)
		await registrar.setAutoRenew('albait.com', false)
		expect(calls.map((c) => c.url.split('/v4')[1])).toEqual([
			'/domains/albait.com:getAuthCodeForDomain',
			'/domains/albait.com:unlock',
			'/domains/albait.com:setAutorenew',
		])
		expect(calls[2]!.body).toEqual({ autorenewEnabled: false })
	})
})
