import { SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
		const t = encodeURIComponent(token())
		for (const path of [
			'/subscriptions/unsubscribe',
			'/subscriptions/confirm',
		]) {
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
		const request = new Request(`${base}/subscriptions/unsubscribe`, {
			method: 'POST',
			body: new URLSearchParams({ token: token() }),
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
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
		const post = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://acme.example',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ slug: 'acme', orgId: OTHER }),
		})
		expect(await resolveOrgId(post, env)).toBe(ORG)
		const foreign = new Request(`${base}/forms/f1/submissions`, {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ slug: 'acme', orgId: OTHER }),
		})
		expect(await resolveOrgId(foreign, env)).toBeNull()
	})
})
