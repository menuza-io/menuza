import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getMockEmailDomainProvider,
	MockEmailDomainProvider,
} from '@repo/email'
import { emailDomainRoutes } from './email-domains.ts'

const token = 'test-internal-command-token'
const orgId = 'clw9x0a12000008l00domain01'

function post(
	path: string,
	body: unknown,
	auth: string | null = `Bearer ${token}`,
) {
	return emailDomainRoutes.request(path, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(auth ? { Authorization: auth } : {}),
		},
		body: JSON.stringify(body),
	})
}

beforeEach(() => {
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', token)
	vi.stubEnv('MOCKS', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('sending domains on the node', () => {
	it('refuses without the internal token', async () => {
		expect(
			(
				await post(
					'/email-domains/register',
					{ orgId, domain: 'a.com', localPart: 'hello' },
					null,
				)
			).status,
		).toBe(401)
		expect(
			(
				await post(
					'/email-domains/register',
					{ orgId, domain: 'a.com', localPart: 'hello' },
					'Bearer wrong-token-value-1234',
				)
			).status,
		).toBe(401)
	})

	it('registers, checks and removes a domain at the region provider', async () => {
		const domain = `node-${Date.now()}.com`
		const registered = await post('/email-domains/register', {
			orgId,
			domain,
			localPart: 'hello',
		})
		expect(registered.status).toBe(200)
		const body = (await registered.json()) as {
			providerRef: string
			dkimSelector: string
			records: Array<{
				purpose: string
				type: string
				name: string
				value: string
				required: boolean
			}>
		}
		expect(body.records.map((r) => r.purpose)).toEqual([
			'spf',
			'dkim',
			'return_path',
			'dmarc',
		])
		expect(body.dkimSelector).toMatch(/^mz[a-z0-9]+$/u)

		const pending = await post('/email-domains/check', {
			providerRef: body.providerRef,
			domain,
			records: body.records,
		})
		expect(((await pending.json()) as { status: string }).status).toBe(
			'pending',
		)

		const provider = getMockEmailDomainProvider()
		for (const record of body.records)
			provider.dns.add(MockEmailDomainProvider.recordKey(record))
		const verified = await post('/email-domains/check', {
			providerRef: body.providerRef,
			domain,
			records: body.records,
		})
		expect(((await verified.json()) as { status: string }).status).toBe(
			'verified',
		)

		expect(
			(await post('/email-domains/remove', { providerRef: body.providerRef }))
				.status,
		).toBe(200)
		const gone = await post('/email-domains/check', {
			providerRef: body.providerRef,
			domain,
			records: body.records,
		})
		expect(((await gone.json()) as { status: string }).status).toBe('failed')
	})

	it('validates the body', async () => {
		expect(
			(
				await post('/email-domains/register', {
					orgId: 'bad id!',
					domain: 'a.com',
					localPart: 'hello',
				})
			).status,
		).toBe(422)
		expect(
			(
				await post('/email-domains/register', {
					orgId,
					domain: 'not a domain',
					localPart: 'hello',
				})
			).status,
		).toBe(422)
		expect(
			(
				await post('/email-domains/register', {
					orgId,
					domain: 'a.com',
					localPart: 'Bad Part',
				})
			).status,
		).toBe(422)
		expect(
			(
				await post('/email-domains/check', {
					providerRef: '',
					domain: 'a.com',
					records: [],
				})
			).status,
		).toBe(422)
	})
})
