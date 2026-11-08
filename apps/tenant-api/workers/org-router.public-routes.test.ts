import { SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import { mintOperatorAnalyticsToken } from '@repo/reports/token'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantApiWorkerEnv } from './bindings.ts'

const resolveOrganizationForBrowserAuth = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveOrganizationForBrowserAuth,
}))

import { signConsentToken } from '../src/lib/email-consent.ts'
import { resolveOrgId } from './org-router.ts'

const ORG = 'clw9x0a12000008l00test79'
const OTHER = 'clw9x0a12000008l00test80'
const env = {
	TENANT_API_RUNTIME: 'workers',
	JWT_SECRET: 'test-jwt-secret-123456789',
} as TenantApiWorkerEnv

const base = 'https://tenant.example.test'

// Unsubscribe and confirm links, customer subscription toggles and public
// website forms must reach the organization's Durable Object; before, the
// edge answered 400 for all of them.
describe('resolveOrgId for consent, subscription and public form routes', () => {
	beforeEach(() => {
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		resolveOrganizationForBrowserAuth.mockReset()
	})

	const token = () =>
		signConsentToken({ k: 'unsubscribe', o: ORG, c: 'cust1', t: 'marketing' })

	it('routes unsubscribe and confirm links by the token org claim', async () => {
		const confirm = signConsentToken({
			k: 'confirm',
			o: ORG,
			c: 'cust1',
			t: 'marketing',
			e: 'hash',
			x: Date.now() + 60_000,
		})
		for (const [path, raw] of [
			['/subscriptions/unsubscribe', token()],
			['/subscriptions/confirm', confirm],
		] as const) {
			const t = encodeURIComponent(raw)
			expect(
				await resolveOrgId(new Request(`${base}${path}?token=${t}`), env),
			).toBe(ORG)
			expect(
				await resolveOrgId(
					new Request(`${base}${path}?token=${t}`, { method: 'POST' }),
					env,
				),
			).toBe(ORG)
		}
	})

	it('routes a one-click unsubscribe POST with the token in a form body', async () => {
		const body = new URLSearchParams({ token: token() }).toString()
		const request = new Request(`${base}/subscriptions/unsubscribe`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': String(body.length),
			},
			body,
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
	})

	it('routes nowhere for a forged or wrong-kind token, so no Durable Object wakes', async () => {
		const [body] = token().split('.')
		const forged = `${body}.${'0'.repeat(64)}`
		expect(
			await resolveOrgId(
				new Request(`${base}/subscriptions/unsubscribe?token=${forged}`),
				env,
			),
		).toBeNull()
		// An unsubscribe token is not a confirm token.
		expect(
			await resolveOrgId(
				new Request(
					`${base}/subscriptions/confirm?token=${encodeURIComponent(token())}`,
				),
				env,
			),
		).toBeNull()
	})

	it('still routes an expired confirm link, so the route can say it expired', async () => {
		const expired = signConsentToken({
			k: 'confirm',
			o: ORG,
			c: 'cust1',
			t: 'marketing',
			e: 'hash',
			x: Date.now() - 1000,
		})
		expect(
			await resolveOrgId(
				new Request(
					`${base}/subscriptions/confirm?token=${encodeURIComponent(expired)}`,
				),
				env,
			),
		).toBe(ORG)
	})

	it('routes a large form submission the route itself would accept', async () => {
		resolveOrganizationForBrowserAuth.mockImplementation(
			async (_o, identity) => (identity.slug === 'acme' ? { id: ORG } : null),
		)
		const answers = JSON.stringify({
			slug: 'acme',
			message: 'x'.repeat(200_000),
		})
		const request = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://acme.example',
				'Content-Type': 'application/json',
			},
			body: answers,
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
	})

	it('uses the query identity over the body', async () => {
		resolveOrganizationForBrowserAuth.mockImplementation(
			async (_o, identity) => (identity.slug === 'acme' ? { id: ORG } : null),
		)
		const request = new Request(`${base}/forms/f1/submissions?slug=acme`, {
			method: 'POST',
			headers: { Origin: 'https://acme.example' },
			body: 'not json',
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
	})

	it('stops reading a streamed body over the limit (length is not trusted)', async () => {
		resolveOrganizationForBrowserAuth.mockImplementation(
			async (_o, identity) => (identity.slug === 'acme' ? { id: ORG } : null),
		)
		let pulled = 0
		// Starts like a valid body naming the org, then never ends.
		let first = true
		const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
		const opening = new TextEncoder().encode('{"slug":"acme","pad":"')
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = first ? opening : chunk
				first = false
				pulled += next.byteLength
				controller.enqueue(next)
				if (pulled > 4 * 1024 * 1024) controller.close()
			},
		})
		const request = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://acme.example',
				'Content-Type': 'application/json',
			},
			body: stream,
			duplex: 'half',
		} as RequestInit)
		// Refused at the edge: no organization, so no Durable Object wakes.
		expect(await resolveOrgId(request, env)).toBeNull()
		expect(resolveOrganizationForBrowserAuth).not.toHaveBeenCalled()
		expect(pulled).toBeLessThan(2 * 1024 * 1024)
	})

	it('routes nowhere for a malformed token, and ignores a body orgId', async () => {
		expect(
			await resolveOrgId(
				new Request(`${base}/subscriptions/unsubscribe?token=junk`),
				env,
			),
		).toBeNull()
		const request = new Request(`${base}/subscriptions/unsubscribe`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ orgId: OTHER }),
		})
		expect(await resolveOrgId(request, env)).toBeNull()
	})

	it('routes customer subscription toggles by the customer JWT only', async () => {
		const jwt = await new SignJWT({ orgId: ORG, type: 'access' })
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(brand.slug)
			.setAudience('tenant-api')
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode(env.JWT_SECRET))
		const put = new Request(`${base}/subscriptions/marketing/email`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${jwt}` },
		})
		expect(await resolveOrgId(put, env)).toBe(ORG)
		expect(
			await resolveOrgId(
				new Request(`${base}/subscriptions`, {
					headers: { Authorization: `Bearer ${jwt}` },
				}),
				env,
			),
		).toBe(ORG)
		const forged = new Request(`${base}/subscriptions/marketing/email`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ orgId: OTHER }),
		})
		expect(await resolveOrgId(forged, env)).toBeNull()
	})

	it('routes public forms by Origin and slug or host, never a body orgId', async () => {
		resolveOrganizationForBrowserAuth.mockImplementation(
			async (origin, identity) =>
				origin === 'https://acme.example' && identity.slug === 'acme'
					? { id: ORG }
					: null,
		)
		const get = new Request(`${base}/forms/f1?slug=acme`, {
			headers: { Origin: 'https://acme.example' },
		})
		expect(await resolveOrgId(get, env)).toBe(ORG)
		const formBody = JSON.stringify({ slug: 'acme', orgId: OTHER })
		const post = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://acme.example',
				'Content-Type': 'application/json',
				'Content-Length': String(formBody.length),
			},
			body: formBody,
		})
		expect(await resolveOrgId(post, env)).toBe(ORG)
		const foreign = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Content-Type': 'application/json',
				'Content-Length': String(formBody.length),
			},
			body: formBody,
		})
		expect(await resolveOrgId(foreign, env)).toBeNull()
	})

	it('refuses an oversized post even when the query names the organization', async () => {
		resolveOrganizationForBrowserAuth.mockResolvedValue({ id: ORG })
		const request = new Request(`${base}/forms/f1/submissions?slug=acme`, {
			method: 'POST',
			headers: { Origin: 'https://acme.example' },
			body: 'x'.repeat(1024 * 1024 + 1),
		})
		expect(await resolveOrgId(request, env)).toBeNull()
		expect(resolveOrganizationForBrowserAuth).not.toHaveBeenCalled()
	})
})

describe('resolveOrgId for schedule links and analytics tokens', () => {
	const secret = 'a'.repeat(64)
	const link = (orgId: string) => `slk1.${orgId}.linkid1234.${secret}`

	it('routes /schedule-link by the link token org prefix only', async () => {
		const get = new Request(`${base}/schedule-link/me`, {
			headers: { Authorization: `Bearer ${link(ORG)}` },
		})
		expect(await resolveOrgId(get, env)).toBe(ORG)
		const post = new Request(
			`${base}/schedule-link/me/time-off?orgId=${OTHER}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${link(ORG)}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: OTHER }),
			},
		)
		expect(await resolveOrgId(post, env)).toBe(ORG)
	})

	it('routes a missing or malformed link token nowhere', async () => {
		for (const headers of [
			{},
			{ Authorization: 'Bearer nonsense' },
			{ Authorization: `Bearer slk1.${ORG}.short.${secret}` },
		] as Record<string, string>[]) {
			const request = new Request(`${base}/schedule-link/me`, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: OTHER }),
			})
			expect(await resolveOrgId(request, env)).toBeNull()
		}
	})

	describe('/analytics', () => {
		const previous = {
			op: process.env.OPERATOR_ANALYTICS_TOKEN,
			internal: process.env.INTERNAL_COMMAND_TOKEN,
		}
		const opSecret = 'operator-analytics-secret-0123456789'
		beforeEach(() => {
			process.env.OPERATOR_ANALYTICS_TOKEN = opSecret
			process.env.INTERNAL_COMMAND_TOKEN = 'internal-command-token-9876543210'
		})
		afterEach(() => {
			for (const [key, value] of [
				['OPERATOR_ANALYTICS_TOKEN', previous.op],
				['INTERNAL_COMMAND_TOKEN', previous.internal],
			] as const) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		})

		const query = (token: string) =>
			new Request(`${base}/analytics/query`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: '{}',
			})

		it('resolves an operator analytics token to its org', async () => {
			const { token } = await mintOperatorAnalyticsToken({
				signingSecret: opSecret,
				userId: 'user1',
				orgId: ORG,
				role: 'operator',
			})
			expect(await resolveOrgId(query(token), env)).toBe(ORG)
		})

		it('does not resolve a customer access JWT or a wrongly signed token', async () => {
			const customer = await new SignJWT({ orgId: ORG, type: 'access' })
				.setProtectedHeader({ alg: 'HS256' })
				.setIssuer(brand.slug)
				.setAudience('tenant-api')
				.setExpirationTime('5m')
				.sign(new TextEncoder().encode(env.JWT_SECRET))
			expect(await resolveOrgId(query(customer), env)).toBeNull()
			const { token } = await mintOperatorAnalyticsToken({
				signingSecret: 'some-other-secret-0123456789',
				userId: 'user1',
				orgId: ORG,
				role: 'operator',
			})
			expect(await resolveOrgId(query(token), env)).toBeNull()
		})
	})
})
