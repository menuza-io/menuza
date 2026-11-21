import { SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import { GUEST_PHOTO_TOKEN_AUDIENCE } from '@repo/common/guest-photos'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantApiWorkerEnv } from './bindings.ts'

const findActiveOrganizationById = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findActiveOrganizationById,
}))

import { assertOrgOnUsNode, resolveOrgId } from './org-router.ts'

const TOKEN = 'internal-command-token-for-tests-1234'
const OP_SECRET = 'test-operator-secret-key-32-chars!!'
const env = {
	TENANT_API_RUNTIME: 'workers',
	TENANT_OPERATOR_TOKEN: OP_SECRET,
} as TenantApiWorkerEnv

function request(path: string, bearer?: string) {
	return new Request(`https://tenant.example.test${path}`, {
		method: 'POST',
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	})
}

describe('assertOrgOnUsNode and unknown organizations', () => {
	beforeEach(() => {
		process.env.INTERNAL_COMMAND_TOKEN = TOKEN
		findActiveOrganizationById.mockResolvedValue(null)
	})

	it('answers 404 for an anonymous call naming an unknown organization', async () => {
		for (const path of [
			'/api/staff/tick',
			'/internal/provision',
			'/auth/send-code',
		]) {
			const res = await assertOrgOnUsNode('unknown_org', env, request(path))
			expect(res?.status, path).toBe(404)
		}
	})

	it('answers 404 for a wrong internal token', async () => {
		const res = await assertOrgOnUsNode(
			'unknown_org',
			env,
			request('/api/staff/tick', 'wrong-token-wrong-token-wrong'),
		)
		expect(res?.status).toBe(404)
	})

	it('lets an authenticated server call through for an organization not listed yet', async () => {
		for (const path of ['/api/staff/tick', '/internal/provision']) {
			expect(
				await assertOrgOnUsNode('new_org', env, request(path, TOKEN)),
			).toBeNull()
		}
	})

	it('does not let the internal token open a public path for an unknown organization', async () => {
		const res = await assertOrgOnUsNode(
			'unknown_org',
			env,
			request('/auth/send-code', TOKEN),
		)
		expect(res?.status).toBe(404)
	})

	it('refuses a known US organization whose database is not provisioned', async () => {
		// Mid region switch or after a failed one: waking the object would
		// rebuild an empty database.
		findActiveOrganizationById.mockResolvedValue({
			id: 'org_1',
			dataRegion: 'us',
			hasProvisionedDb: false,
		})
		for (const [path, bearer] of [
			['/auth/me', undefined],
			['/api/staff/tick', TOKEN],
		] as const) {
			const res = await assertOrgOnUsNode('org_1', env, request(path, bearer))
			expect(res?.status, path).toBe(404)
			expect(await res?.json()).toEqual({ error: 'org_not_provisioned' })
		}
	})

	it('still allows a known US organization', async () => {
		findActiveOrganizationById.mockResolvedValue({
			id: 'org_1',
			dataRegion: 'us',
			hasProvisionedDb: true,
		})
		expect(
			await assertOrgOnUsNode('org_1', env, request('/auth/me')),
		).toBeNull()
	})
})

describe('resolveOrgId for guest photos operator JWT and popular/guest-photo ticks', () => {
	it('routes /operator/photos* by signed pho+jwt with GUEST_PHOTO_TOKEN_AUDIENCE', async () => {
		const orgId = 'clw9x0a12000008l00test77'
		const jwt = await new SignJWT({ orgId, role: 'operator' })
			.setProtectedHeader({ alg: 'HS256', typ: 'pho+jwt' })
			.setAudience(GUEST_PHOTO_TOKEN_AUDIENCE)
			.setIssuer(brand.shortName)
			.setSubject('user_1')
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(OP_SECRET))

		expect(
			await resolveOrgId(
				new Request('https://tenant.example.test/operator/photos', {
					headers: { Authorization: `Bearer ${jwt}` },
				}),
				env,
			),
		).toBe(orgId)
		expect(
			await resolveOrgId(
				new Request(
					'https://tenant.example.test/operator/photos/sub_1/decide',
					{
						method: 'POST',
						headers: { Authorization: `Bearer ${jwt}` },
					},
				),
				env,
			),
		).toBe(orgId)
	})

	it('resolves orgId from JSON body (or null for fan-out) on /api/menu/popular/tick and /api/guest-photos/tick', async () => {
		const orgId = 'clw9x0a12000008l00test77'
		for (const tickPath of [
			'/api/menu/popular/tick',
			'/api/guest-photos/tick',
		]) {
			expect(
				await resolveOrgId(
					new Request(`https://tenant.example.test${tickPath}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ orgId }),
					}),
					env,
				),
				tickPath,
			).toBe(orgId)

			expect(
				await resolveOrgId(
					new Request(`https://tenant.example.test${tickPath}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({}),
					}),
					env,
				),
				tickPath,
			).toBeNull()
		}
	})
})
