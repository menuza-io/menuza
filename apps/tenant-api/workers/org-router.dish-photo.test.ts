import { SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import { describe, expect, it, vi } from 'vitest'
import type { TenantApiWorkerEnv } from './bindings.ts'

const resolveOrganizationForBrowserAuth = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveOrganizationForBrowserAuth,
}))

import { resolveOrgId } from './org-router.ts'

const OP_SECRET = 'test-operator-secret-key-32-chars!!'
const env = {
	TENANT_API_RUNTIME: 'workers',
	TENANT_OPERATOR_TOKEN: OP_SECRET,
} as TenantApiWorkerEnv

describe('Workers routing of dish photo tests (#192)', () => {
	it('routes the public counter beacon by the browser Origin and the body hints', async () => {
		resolveOrganizationForBrowserAuth.mockImplementation(
			async (origin: string | undefined, identity?: { slug?: string }) =>
				origin === 'https://acme.example.test' && identity?.slug === 'acme'
					? { id: 'clw9x0a12000008l00test78' }
					: null,
		)
		const post = (origin: string, body: unknown) =>
			resolveOrgId(
				new Request('https://tenant.example.test/forms/dish-photo-events', {
					method: 'POST',
					headers: { Origin: origin, 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env,
			)
		expect(await post('https://acme.example.test', { slug: 'acme' })).toBe(
			'clw9x0a12000008l00test78',
		)
		// A different Origin, or a slug the Origin does not own, wakes nobody.
		expect(await post('https://evil.example', { slug: 'acme' })).toBeNull()
		expect(
			await post('https://acme.example.test', { slug: 'other' }),
		).toBeNull()
		// A client-sent orgId never names the organization.
		expect(
			await post('https://evil.example', {
				slug: 'acme',
				orgId: 'clw9x0a12000008l00test78',
			}),
		).toBeNull()
	})

	it('routes /operator/photo-tests/results by the operator token org', async () => {
		const orgId = 'clw9x0a12000008l00test79'
		const jwt = await new SignJWT({
			orgId,
			role: 'operator',
			scope: 'photo_tests',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setSubject('user_1')
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode(OP_SECRET))
		const request = (token: string) =>
			new Request('https://tenant.example.test/operator/photo-tests/results', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: '{}',
			})
		expect(await resolveOrgId(request(jwt), env)).toBe(orgId)
		expect(await resolveOrgId(request('not-a-token'), env)).toBeNull()
	})
})
