import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTenantDb, staffAuditLog } from '@repo/tenant-db'
import {
	ADMIN_GRANTS,
	createStaffHarness,
	LOC_1,
	MANAGER_GRANTS,
	makeOrg,
	mintStaffToken,
	ORG_A,
	ORG_B,
	staffBody,
	type StaffHarness,
	type TestOrg,
} from '../../tests/staff-harness.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

describe('GET /operator/staff/export', () => {
	let h: StaffHarness
	let staffId: string

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createStaffHarness()
		const created = await h.request('POST', '/', { body: staffBody() })
		staffId = created.body.staff.id
		const assignmentId = created.body.assignments[0].id
		const position = await h.request('POST', '/positions', {
			body: { name: 'Server', defaultRateMinor: 1500, currency: 'USD' },
		})
		await h.request('POST', `/${staffId}/jobs`, {
			body: {
				scopeId: LOC_1,
				positionId: position.body.position.id,
				currency: 'USD',
				rateMinor: 1800,
				effectiveFrom: '2026-01-01',
			},
		})
		await h.request('PUT', `/${staffId}/private`, {
			body: { dateOfBirth: '1990-04-02', addressLine1: '1 Main St' },
		})
		await h.request('POST', `/${staffId}/notes`, { body: { body: 'prompt' } })
		await h.request('POST', `/${staffId}/assignments/${assignmentId}/pin`, {
			body: {},
		})
		await h.request('POST', '/', {
			body: staffBody({ firstName: 'Omar', email: 'omar@example.com' }),
		})
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	it('exports the whole roster for a pay and private holder, without secrets', async () => {
		const reply = await h.request('GET', '/export')
		expect(reply.status).toBe(200)
		expect(reply.headers.get('cache-control')).toBe('private, no-store')
		expect(reply.body).toMatchObject({
			format: 'staff-export/v1',
			orgId: ORG_A,
			region: 'us',
			includes: { pay: true, private: true },
		})
		expect(reply.body.staff).toHaveLength(2)
		const rana = reply.body.staff.find((s: any) => s.id === staffId)
		expect(rana).toMatchObject({
			firstName: 'Rana',
			private: { dateOfBirth: '1990-04-02', addressLine1: '1 Main St' },
		})
		expect(rana.jobs[0]).toMatchObject({ rateMinor: 1800, currency: 'USD' })
		expect(rana.notes).toHaveLength(1)
		expect(rana.assignments[0].hasPin).toBe(true)
		expect(reply.body.positions[0]).toMatchObject({ defaultRateMinor: 1500 })
		expect(reply.body.settings).not.toBeNull()
		expect(reply.body.auditLog.length).toBeGreaterThan(0)
		expect(reply.raw).not.toContain('pinLookup')
		expect(reply.raw).not.toContain('pin_lookup')
		expect(reply.raw).not.toContain('ipHash')
	})

	it('omits pay and private groups, not blanks them, without those grants', async () => {
		const token = await mintStaffToken({ grants: MANAGER_GRANTS })
		const reply = await h.request('GET', '/export', { token })
		expect(reply.status).toBe(200)
		expect(reply.body.includes).toEqual({ pay: false, private: false })
		const rana = reply.body.staff.find((s: any) => s.id === staffId)
		expect(rana).not.toHaveProperty('private')
		expect(rana.jobs[0]).not.toHaveProperty('rateMinor')
		expect(reply.body.positions[0]).not.toHaveProperty('defaultRateMinor')
		// The rate is matched as a key and value: a bare "1800" also appears inside
		// millisecond timestamps (any second ending in 18) and random ids.
		for (const needle of ['"rateMinor":1800', '1990-04-02', '1 Main St']) {
			expect(reply.raw).not.toContain(needle)
		}
		// Audit rows that carry pay or private values are not exported either.
		expect(
			reply.body.auditLog.every((row: any) => row.sensitivity === 'standard'),
		).toBe(true)
	})

	it('can be limited to one person', async () => {
		const reply = await h.request('GET', `/export?staffId=${staffId}`)
		expect(reply.status).toBe(200)
		expect(reply.body.staff).toHaveLength(1)
		expect(reply.raw).not.toContain('Omar')
		expect(reply.body.settings).toBeNull()
	})

	it('writes an audit row before disclosing anything', async () => {
		await h.request('GET', '/export')
		const db = await getTenantDb(ORG_A)
		const rows = (await db.select().from(staffAuditLog)).filter(
			(row) => row.action === 'staff.exported',
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			actorId: 'operator-1',
			sensitivity: 'private',
			changes: { scope: 'all', pay: true, private: true },
		})
	})

	it('refuses tokens without the roster grant, with a scope limit, or for another org', async () => {
		const noGrant = await mintStaffToken({ grants: [] })
		expect((await h.request('GET', '/export', { token: noGrant })).status).toBe(
			403,
		)
		const scoped = await mintStaffToken({ scopeIds: [LOC_1] })
		const scopedReply = await h.request('GET', '/export', { token: scoped })
		expect(scopedReply.status).toBe(403)
		expect(scopedReply.body.error).toBe('unrestricted_scope_required')
		expect(scopedReply.raw).not.toContain('Rana')
		expect((await h.request('GET', '/export', { token: null })).status).toBe(
			401,
		)

		// A token for another org gets that org's (empty) roster, never this one's.
		const other = await mintStaffToken({ orgId: ORG_B })
		const otherReply = await h.request('GET', '/export', { token: other })
		expect(otherReply.status).toBe(200)
		expect(otherReply.body.staff).toHaveLength(0)
		expect(otherReply.raw).not.toContain('Rana')
	})

	it('validates the query and 404s for an unknown person', async () => {
		expect((await h.request('GET', '/export?staffId=../x')).status).toBe(400)
		expect((await h.request('GET', '/export?foo=1')).status).toBe(400)
		expect((await h.request('GET', '/export?staffId=missing')).status).toBe(404)
	})

	it('an impersonated session gets no pay or private data', async () => {
		const token = await mintStaffToken({
			grants: ADMIN_GRANTS,
			impersonated: true,
		})
		const reply = await h.request('GET', '/export', { token })
		expect(reply.status).toBe(200)
		expect(reply.body.includes).toEqual({ pay: false, private: false })
		expect(reply.raw).not.toContain('1990-04-02')
	})
})
