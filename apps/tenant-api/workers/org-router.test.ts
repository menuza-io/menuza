import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantApiWorkerEnv } from './bindings.ts'

const findActiveOrganizationById = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findActiveOrganizationById,
}))

import { assertOrgOnUsNode } from './org-router.ts'

const TOKEN = 'internal-command-token-for-tests-1234'
const env = { TENANT_API_RUNTIME: 'workers' } as TenantApiWorkerEnv

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
