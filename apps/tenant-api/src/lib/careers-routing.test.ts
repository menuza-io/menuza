import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveOrgId } from '../../workers/org-router.ts'
import type { TenantApiWorkerEnv } from '../../workers/bindings.ts'

const resolve = vi.hoisted(() => vi.fn())

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	resolveOrganizationForBrowserAuth: resolve,
}))

const env = {
	JWT_SECRET: 'x'.repeat(40),
	TENANT_OPERATOR_TOKEN: 'y'.repeat(40),
} as unknown as TenantApiWorkerEnv

const ORG_FROM_ORIGIN = 'clw9x0a12000008l00staffa'
const ORG_CLAIMED = 'clw9x0a12000008l00staffb'

function apply(body: unknown, origin: string | null, search = '') {
	return new Request(`https://api.test/careers/apply${search}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(origin ? { Origin: origin } : {}),
		},
		body: JSON.stringify(body),
	})
}

describe('careers routing on the Workers edge', () => {
	beforeEach(() => {
		resolve.mockReset()
		resolve.mockImplementation(async (origin: string | undefined) =>
			origin === 'https://acme.menuza.test' ? { id: ORG_FROM_ORIGIN } : null,
		)
	})

	it('routes to the organization the Origin names', async () => {
		expect(
			await resolveOrgId(
				apply({ slug: 'acme' }, 'https://acme.menuza.test'),
				env,
			),
		).toBe(ORG_FROM_ORIGIN)
	})

	it('never routes on a client-supplied orgId, in the body or the query', async () => {
		expect(
			await resolveOrgId(
				apply({ orgId: ORG_CLAIMED }, 'https://acme.menuza.test'),
				env,
			),
		).toBe(ORG_FROM_ORIGIN)
		expect(
			await resolveOrgId(
				apply({}, 'https://acme.menuza.test', `?orgId=${ORG_CLAIMED}`),
				env,
			),
		).toBe(ORG_FROM_ORIGIN)
	})

	it('routes nowhere when the Origin names nothing, whatever the body claims', async () => {
		expect(
			await resolveOrgId(apply({ orgId: ORG_CLAIMED }, null), env),
		).toBeNull()
		expect(
			await resolveOrgId(
				apply({ orgId: ORG_CLAIMED }, 'https://unknown.menuza.test'),
				env,
			),
		).toBeNull()
	})
})
