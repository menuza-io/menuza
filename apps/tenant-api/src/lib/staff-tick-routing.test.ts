import { describe, expect, it } from 'vitest'
import { resolveOrgId } from '../../workers/org-router.ts'
import type { TenantApiWorkerEnv } from '../../workers/bindings.ts'

const env = {
	JWT_SECRET: 'x'.repeat(40),
	TENANT_OPERATOR_TOKEN: 'y'.repeat(40),
} as unknown as TenantApiWorkerEnv

const ORG = 'clw9x0a12000008l00staffa'

function tick(body: unknown, search = '') {
	return new Request(`https://api.test/api/staff/tick${search}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
}

describe('staff tick routing on the Workers edge', () => {
	it('sends a tick that names an organization to that organization', async () => {
		expect(await resolveOrgId(tick({ orgId: ORG }), env)).toBe(ORG)
	})

	it('leaves a tick with no organization to the edge fan-out', async () => {
		expect(await resolveOrgId(tick({}), env)).toBeNull()
	})

	it('does not route on a malformed organization id', async () => {
		expect(await resolveOrgId(tick({ orgId: '../../etc' }), env)).toBeNull()
		expect(await resolveOrgId(tick({ orgId: 7 }), env)).toBeNull()
	})
})
