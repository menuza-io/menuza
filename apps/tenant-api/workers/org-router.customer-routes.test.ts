import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import type { TenantApiWorkerEnv } from './bindings.ts'
import { resolveOrgId } from './org-router.ts'

const JWT_SECRET = 'test-jwt-secret-123456789'
const ORG = 'clw9x0a12000008l00test77'
const env = {
	TENANT_API_RUNTIME: 'workers',
	JWT_SECRET,
} as unknown as TenantApiWorkerEnv

async function customerToken(orgId = ORG) {
	return new SignJWT({ customerId: 'c1', orgId, orgSlug: 'x', type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(JWT_SECRET))
}

describe('the guest’s own order, push, and photo routes pick the organization from the customer token (#112, #105, #148)', () => {
	it('routes /customer/*, /push/*, and /photos* by the signed customer token only', async () => {
		const bearer = await customerToken()
		for (const path of [
			'/customer/orders',
			'/customer/orders/abc',
			'/customer/orders/abc/reorder',
			'/push/devices',
			'/push/preferences',
			'/photos',
			'/photos/eligibility',
			'/photos/upload',
		]) {
			const request = new Request(`https://tenant.example.test${path}`, {
				headers: { Authorization: `Bearer ${bearer}` },
			})
			expect(await resolveOrgId(request, env), path).toBe(ORG)
		}
	})

	it('never routes on a query or body orgId, and routes nowhere without a valid token', async () => {
		const forged = new Request(
			`https://tenant.example.test/customer/orders?orgId=${ORG}`,
			{
				headers: { Authorization: 'Bearer not-a-token' },
			},
		)
		expect(await resolveOrgId(forged, env)).toBeNull()
		const forgedPhotos = new Request(
			`https://tenant.example.test/photos/eligibility?orgId=${ORG}`,
			{
				headers: { Authorization: 'Bearer not-a-token' },
			},
		)
		expect(await resolveOrgId(forgedPhotos, env)).toBeNull()
		const nonePhotos = new Request(
			`https://tenant.example.test/photos/upload?orgId=${ORG}`,
			{
				method: 'POST',
			},
		)
		expect(await resolveOrgId(nonePhotos, env)).toBeNull()
		const none = new Request(
			`https://tenant.example.test/push/devices?orgId=${ORG}`,
			{
				method: 'POST',
				body: JSON.stringify({ orgId: ORG }),
			},
		)
		expect(await resolveOrgId(none, env)).toBeNull()
	})
})
