import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import {
	STAFF_AUDIT_SENSITIVITIES,
	PAY_TYPES,
	STAFF_STATUSES,
	STAFFING_PERMISSIONS as P,
	WORKER_TYPES,
} from '@repo/staffing'
import {
	STAFF_AUDIT_SENSITIVITY_VALUES,
	STAFF_PAY_TYPE_VALUES,
	STAFF_STATUS_VALUES,
	STAFF_WORKER_TYPE_VALUES,
} from '@repo/tenant-db'
import { operatorRoutes } from '../routes/operator.ts'
import { createTenantApiApp } from '../app.ts'
import { resolveOrgId } from '../../workers/org-router.ts'
import {
	ADMIN_GRANTS,
	makeOrg,
	mintStaffToken,
	OPERATOR_SECRET,
	ORG_A,
	ORG_B,
	stubStaffEnv,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import {
	authenticateStaffOperator,
	hasGrant,
	requireWriteGrant,
	scopeToScopes,
	type StaffAuth,
} from './staff-auth.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))
vi.mock('@repo/sms', () => ({ sendSms: vi.fn() }))
vi.mock('@repo/email', () => ({
	sendOciEmail: vi.fn(),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

beforeEach(() => {
	orgs.clear()
	orgs.set(ORG_A, makeOrg(ORG_A))
	orgs.set(ORG_B, makeOrg(ORG_B))
	stubStaffEnv('/tmp/staff-auth-unused')
})

afterEach(() => {
	vi.unstubAllEnvs()
})

function probeApp() {
	const app = new Hono()
	app.get('/probe', async (c) => {
		const result = await authenticateStaffOperator(c, 'staff')
		if ('error' in result) return result.error
		return c.json({ auth: result.auth })
	})
	return app
}

async function probe(token: string) {
	const response = await probeApp().request('/probe', {
		headers: { Authorization: `Bearer ${token}` },
	})
	return { status: response.status, body: (await response.json()) as any }
}

describe('authenticateStaffOperator', () => {
	it('returns the verified claims', async () => {
		const token = await mintStaffToken({
			sub: 'user-9',
			grants: [P.READ_STAFF, P.UPDATE_STAFF],
			scopeIds: ['loc-1'],
		})
		const { status, body } = await probe(token)
		expect(status).toBe(200)
		expect(body.auth).toEqual({
			orgId: ORG_A,
			userId: 'user-9',
			scope: 'staff',
			grants: [P.READ_STAFF, P.UPDATE_STAFF],
			scopeIds: ['loc-1'],
			impersonated: false,
		})
	})

	it('strips write, pay and private grants from an impersonated token', async () => {
		const token = await mintStaffToken({
			grants: [...ADMIN_GRANTS, P.APPROVE_TIMESHEET],
			impersonated: true,
		})
		const { body } = await probe(token)
		expect(body.auth.impersonated).toBe(true)
		expect(body.auth.grants).toEqual([P.READ_STAFF])
	})

	it('is not satisfied by a token signed with the wrong secret', async () => {
		const token = await mintStaffToken({ secret: `${OPERATOR_SECRET}-x` })
		expect((await probe(token)).status).toBe(401)
	})

	it('fails closed when the operator secret is not configured', async () => {
		vi.stubEnv('TENANT_OPERATOR_TOKEN', 'short')
		const token = await mintStaffToken()
		expect((await probe(token)).status).toBe(503)
	})
})

describe('token confusion between principals', () => {
	it('lets a staff token reach no other operator surface', async () => {
		const token = await mintStaffToken({ grants: ADMIN_GRANTS })
		const app = new Hono()
		app.route('/operator', operatorRoutes)
		for (const path of ['/operator/customers']) {
			const response = await app.request(path, {
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(response.status, path).toBe(401)
		}
	})

	it('lets no generic operator token reach the staff routes, even with a staff scope string', async () => {
		const app = createTenantApiApp()
		const secret = new TextEncoder().encode(OPERATOR_SECRET)
		const generic = await new SignJWT({
			orgId: ORG_A,
			role: 'operator',
			scope: 'staff',
			grants: ADMIN_GRANTS,
			scopeIds: null,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setSubject('operator-1')
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(secret)
		const response = await app.request('/operator/staff', {
			headers: { Authorization: `Bearer ${generic}` },
		})
		expect(response.status).toBe(401)
	})

	it('mounts /operator/staff in the shared app', async () => {
		const app = createTenantApiApp()
		const noToken = await app.request('/operator/staff')
		expect(noToken.status).toBe(401)
		const response = await app.request('/operator/staff', {
			headers: { Authorization: `Bearer ${await mintStaffToken()}` },
		})
		// Authenticated and authorized; only the missing database stops it here.
		expect([200, 500]).toContain(response.status)
		expect(response.headers.get('cache-control')).toContain('no-store')
	})
})

describe('Durable Object routing of staff tokens', () => {
	const env = {
		get TENANT_OPERATOR_TOKEN() {
			return OPERATOR_SECRET
		},
	} as never

	it('routes a staff token to its own organization', async () => {
		const token = await mintStaffToken({ orgId: ORG_B })
		const orgId = await resolveOrgId(
			new Request('https://api.test/operator/staff', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			env,
		)
		expect(orgId).toBe(ORG_B)
	})

	it('does not route unsigned, foreign-audience or foreign-secret tokens', async () => {
		for (const token of [
			await mintStaffToken({ secret: 'another-secret-another-secret-123' }),
			await mintStaffToken({ audience: 'tenant-api' }),
			'not-a-token',
		]) {
			const orgId = await resolveOrgId(
				new Request('https://api.test/operator/staff', {
					headers: { Authorization: `Bearer ${token}` },
				}),
				env,
			)
			expect(orgId).toBeNull()
		}
	})
})

describe('scopeToScopes', () => {
	const scope = (scopeIds: string[] | null) =>
		scopeToScopes({ scopeIds } as Pick<StaffAuth, 'scopeIds'>)

	it('treats null as every scope', () => {
		const all = scope(null)
		expect(all.unrestricted).toBe(true)
		expect(all.allows('anything')).toBe(true)
		expect(all.allowsAll(['a', 'b'])).toBe(true)
		expect(all.allowsAny([])).toBe(true)
		expect(all.where({} as never)).toBeUndefined()
		const rows = [{ scopeId: 'a' }, { scopeId: 'b' }]
		expect(all.filter(rows)).toEqual(rows)
	})

	it('restricts to the listed scopes', () => {
		const some = scope(['a', 'b'])
		expect(some.unrestricted).toBe(false)
		expect(some.allows('a')).toBe(true)
		expect(some.allows('c')).toBe(false)
		expect(some.allowsAll(['a', 'b'])).toBe(true)
		expect(some.allowsAll(['a', 'c'])).toBe(false)
		expect(some.allowsAny(['c', 'b'])).toBe(true)
		expect(some.allowsAny(['c'])).toBe(false)
		expect(
			some.filter([{ scopeId: 'a' }, { scopeId: 'c' }, { scopeId: 'b' }]),
		).toEqual([{ scopeId: 'a' }, { scopeId: 'b' }])
	})

	it('treats an empty list as no access, not as everything', () => {
		const none = scope([])
		expect(none.unrestricted).toBe(false)
		expect(none.allows('a')).toBe(false)
		expect(none.allowsAll([])).toBe(true)
		expect(none.allowsAny(['a'])).toBe(false)
		expect(none.filter([{ scopeId: 'a' }])).toEqual([])
	})

	it('does not let scope ids act as patterns', () => {
		const odd = scope(['a%', 'b_'])
		expect(odd.allows('a')).toBe(false)
		expect(odd.allows('ab')).toBe(false)
		expect(odd.allows('a%')).toBe(true)
	})
})

describe('grant helpers', () => {
	it('accepts a stronger grant for a read requirement, never the reverse', () => {
		expect(hasGrant({ grants: [P.UPDATE_STAFF] }, P.READ_STAFF)).toBe(true)
		expect(hasGrant({ grants: [P.READ_STAFF] }, P.UPDATE_STAFF)).toBe(false)
		expect(hasGrant({ grants: [P.UPDATE_STAFF_PAY] }, P.READ_STAFF)).toBe(false)
		expect(hasGrant({ grants: [] }, P.READ_STAFF)).toBe(false)
	})

	it('refuses writes for impersonated sessions regardless of grants', () => {
		const auth = {
			orgId: ORG_A,
			userId: 'u',
			scope: 'staff',
			grants: [P.UPDATE_STAFF],
			scopeIds: null,
			impersonated: true,
		} as StaffAuth
		expect(requireWriteGrant(auth, P.UPDATE_STAFF)?.status).toBe(403)
		expect(
			requireWriteGrant({ ...auth, impersonated: false }, P.UPDATE_STAFF),
		).toBeNull()
	})

	it('refuses to treat a read permission as a write check', () => {
		const auth = {
			orgId: ORG_A,
			userId: 'u',
			scope: 'staff',
			grants: [P.READ_STAFF],
			scopeIds: null,
			impersonated: false,
		} as StaffAuth
		expect(() => requireWriteGrant(auth, P.READ_STAFF)).toThrow()
	})
})

describe('tenant-db enums stay in step with @repo/staffing', () => {
	it('matches statuses, worker types, pay types and audit sensitivities', () => {
		expect([...STAFF_STATUS_VALUES]).toEqual([...STAFF_STATUSES])
		expect([...STAFF_WORKER_TYPE_VALUES]).toEqual([...WORKER_TYPES])
		expect([...STAFF_PAY_TYPE_VALUES]).toEqual([...PAY_TYPES])
		expect([...STAFF_AUDIT_SENSITIVITY_VALUES]).toEqual([
			...STAFF_AUDIT_SENSITIVITIES,
		])
	})
})
