import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import {
	getTenantDb,
	staffAuditLog,
	staffScopeAssignments,
	staffMembers,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import {
	ADMIN_GRANTS,
	createStaffHarness,
	LOC_1,
	LOC_2,
	LOC_3,
	MANAGER_GRANTS,
	makeOrg,
	mintStaffToken,
	OPERATOR_SECRET,
	ORG_A,
	ORG_B,
	READ_ONLY_GRANTS,
	staffBody,
	UPDATE_ONLY_GRANTS,
	type StaffHarness,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { describeStaffError } from '../services/staff-audit.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

/**
 * Random ids and epoch timestamps can hold any four digits; the PIN and pay
 * checks look at the rest.
 */
const withoutIds = (text: string) =>
	text
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			'',
		)
		.replace(/\b\d{13}\b/g, '')

describe('Adversarial: /operator/staff', () => {
	let h: StaffHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createStaffHarness()
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	const admin = () => mintStaffToken({ grants: ADMIN_GRANTS })

	async function seed(token?: string) {
		const t = token ?? (await admin())
		const created = await h.request('POST', '/', {
			token: t,
			body: staffBody({ employeeNumber: 'E-1' }),
		})
		expect(created.status).toBe(201)
		const staffId = created.body.staff.id as string
		const assignmentId = created.body.assignments[0].id as string
		const position = await h.request('POST', '/positions', {
			token: t,
			body: { name: 'Server', defaultRateMinor: 1500, currency: 'USD' },
		})
		const job = await h.request('POST', `/${staffId}/jobs`, {
			token: t,
			body: {
				scopeId: LOC_1,
				positionId: position.body.position.id,
				currency: 'USD',
				rateMinor: 1642,
				isPrimary: true,
				effectiveFrom: '2026-01-01',
			},
		})
		expect(job.status).toBe(201)
		await h.request('PUT', `/${staffId}/private`, {
			token: t,
			body: { dateOfBirth: '1987-06-15', addressLine1: '77 Secret Lane' },
		})
		return {
			staffId,
			assignmentId,
			positionId: position.body.position.id as string,
			jobId: job.body.job.id as string,
		}
	}

	describe('token verification', () => {
		it('rejects missing, malformed and foreign-signed tokens', async () => {
			const cases: Array<string | null> = [
				null,
				'',
				'garbage',
				'a.b.c',
				await mintStaffToken({
					secret: 'a-completely-different-secret-value-123',
				}),
			]
			for (const token of cases) {
				const response = await h.request('GET', '/', {
					token,
					headers: token === '' ? { Authorization: 'Bearer ' } : undefined,
				})
				expect(response.status).toBe(401)
			}
		})

		it('rejects expired tokens, wrong issuers, and non-operator roles', async () => {
			const expired = await mintStaffToken({
				issuedAt: Math.floor(Date.now() / 1000) - 3600,
				lifetimeSeconds: 300,
			})
			expect((await h.request('GET', '/', { token: expired })).status).toBe(401)
			const issuer = await mintStaffToken({ issuer: 'someone-else' })
			expect((await h.request('GET', '/', { token: issuer })).status).toBe(401)
			const role = await mintStaffToken({ role: 'customer' })
			expect((await h.request('GET', '/', { token: role })).status).toBe(401)
		})

		it('rejects tokens with the generic operator audience, or a wrong typ header', async () => {
			for (const audience of [
				'tenant-api-operator',
				'tenant-api',
				'tenant-api-staff',
			]) {
				const token = await mintStaffToken({ audience })
				expect((await h.request('GET', '/', { token })).status).toBe(401)
			}
			const wrongTyp = await mintStaffToken({ typ: 'JWT' })
			expect((await h.request('GET', '/', { token: wrongTyp })).status).toBe(
				401,
			)
		})

		it('rejects an orders or mailbox operator token on the staff routes', async () => {
			const secret = new TextEncoder().encode(OPERATOR_SECRET)
			for (const scope of ['orders:write', 'mailbox', 'phone_calls', 'staff']) {
				const token = await new SignJWT({
					orgId: ORG_A,
					role: 'operator',
					scope,
					canUpdate: true,
					canDelete: true,
				})
					.setProtectedHeader({ alg: 'HS256' })
					.setAudience('tenant-api-operator')
					.setIssuer(brand.shortName)
					.setSubject('operator-1')
					.setIssuedAt()
					.setExpirationTime('10m')
					.sign(secret)
				expect((await h.request('GET', '/', { token })).status).toBe(401)
			}
		})

		it('rejects tokens minted with a longer life than the App ever issues', async () => {
			const hour = await mintStaffToken({
				grants: READ_ONLY_GRANTS,
				lifetimeSeconds: 3600,
			})
			expect((await h.request('GET', '/', { token: hour })).status).toBe(401)
			// Pay and private grants cap at 5 minutes, not 15.
			const sensitive = await mintStaffToken({
				grants: ADMIN_GRANTS,
				lifetimeSeconds: 900,
			})
			expect((await h.request('GET', '/', { token: sensitive })).status).toBe(
				401,
			)
			// The honest TTLs work.
			const ok = await mintStaffToken({
				grants: READ_ONLY_GRANTS,
				lifetimeSeconds: 900,
			})
			expect((await h.request('GET', '/', { token: ok })).status).toBe(200)
			const okSensitive = await mintStaffToken({
				grants: ADMIN_GRANTS,
				lifetimeSeconds: 300,
			})
			expect((await h.request('GET', '/', { token: okSensitive })).status).toBe(
				200,
			)
		})

		it('rejects an old token even if its exp was set far in the future after the fact', async () => {
			const stale = await mintStaffToken({
				grants: READ_ONLY_GRANTS,
				issuedAt: Math.floor(Date.now() / 1000) - 3 * 3600,
				lifetimeSeconds: 900,
			})
			expect((await h.request('GET', '/', { token: stale })).status).toBe(401)
		})

		it('rejects tokens without iat, exp or sub, and alg=none', async () => {
			const secret = new TextEncoder().encode(OPERATOR_SECRET)
			const claims = {
				orgId: ORG_A,
				role: 'operator',
				scope: 'staff',
				grants: ['read:staff:any'],
				scopeIds: null,
			}
			const noIat = await new SignJWT(claims)
				.setProtectedHeader({ alg: 'HS256', typ: 'staff+jwt' })
				.setAudience('tenant-api-staff-operator')
				.setIssuer(brand.shortName)
				.setSubject('operator-1')
				.setExpirationTime('10m')
				.sign(secret)
			expect((await h.request('GET', '/', { token: noIat })).status).toBe(401)
			const noSub = await new SignJWT(claims)
				.setProtectedHeader({ alg: 'HS256', typ: 'staff+jwt' })
				.setAudience('tenant-api-staff-operator')
				.setIssuer(brand.shortName)
				.setIssuedAt()
				.setExpirationTime('10m')
				.sign(secret)
			expect((await h.request('GET', '/', { token: noSub })).status).toBe(401)

			const header = Buffer.from(
				JSON.stringify({ alg: 'none', typ: 'staff+jwt' }),
			).toString('base64url')
			const now = Math.floor(Date.now() / 1000)
			const payload = Buffer.from(
				JSON.stringify({
					...claims,
					sub: 'operator-1',
					aud: 'tenant-api-staff-operator',
					iss: brand.shortName,
					iat: now,
					exp: now + 300,
				}),
			).toString('base64url')
			expect(
				(await h.request('GET', '/', { token: `${header}.${payload}.` }))
					.status,
			).toBe(401)
		})

		it('rejects malformed claim shapes', async () => {
			const bad: Array<Parameters<typeof mintStaffToken>[0]> = [
				{ grants: ['update:member:any'] },
				{ grants: ['read:staff:any', 'drop table'] },
				{ extraClaims: { grants: 'read:staff:any' } },
				{ extraClaims: { scopeIds: 'loc-1' } },
				{ extraClaims: { scopeIds: [1, 2] } },
				{ extraClaims: { orgId: '' } },
				{ extraClaims: { orgId: '../../etc/passwd' } },
				{ extraClaims: { orgId: ['a', 'b'] } },
				{ extraClaims: { region: 'eu' } },
			]
			for (const options of bad) {
				const token = await mintStaffToken(options)
				expect((await h.request('GET', '/', { token })).status).toBe(401)
			}
		})

		it('never lets the query string choose the organization', async () => {
			await seed()
			const tokenB = await mintStaffToken({
				orgId: ORG_B,
				grants: ADMIN_GRANTS,
			})
			const response = await h.request('GET', `/?orgId=${ORG_A}`, {
				token: tokenB,
			})
			expect(response.status).toBe(200)
			expect(response.body.total).toBe(0)
		})
	})

	describe('scope escalation', () => {
		it('rejects tokens minted for other scopes', async () => {
			for (const scope of ['schedule', 'timeclock', 'hiring', 'admin', '']) {
				const token = await mintStaffToken({ scope })
				const response = await h.request('GET', '/', { token })
				expect([401, 403]).toContain(response.status)
				expect(response.status === 401 || response.status === 403).toBe(true)
			}
			const schedule = await mintStaffToken({ scope: 'schedule' })
			expect((await h.request('GET', '/', { token: schedule })).status).toBe(
				403,
			)
		})

		it('does not grant staff access from schedule, labor or hiring permissions', async () => {
			const token = await mintStaffToken({
				grants: [
					P.READ_SCHEDULE,
					P.UPDATE_SCHEDULE,
					P.READ_LABOR,
					P.READ_HIRING,
					P.UPDATE_HIRING,
					P.READ_TIMESHEET,
				],
			})
			expect((await h.request('GET', '/', { token })).status).toBe(403)
			expect(
				(await h.request('POST', '/', { token, body: staffBody() })).status,
			).toBe(403)
		})

		it('does not let a pay or private grant stand in for staff access', async () => {
			const token = await mintStaffToken({
				grants: [P.READ_STAFF_PAY, P.READ_STAFF_PRIVATE],
			})
			const { staffId } = await seed()
			expect((await h.request('GET', '/', { token })).status).toBe(403)
			expect(
				(await h.request('GET', `/${staffId}/jobs`, { token })).status,
			).toBe(403)
			expect(
				(await h.request('GET', `/${staffId}/private`, { token })).status,
			).toBe(403)
		})

		it('lets a stronger update grant satisfy the read requirement', async () => {
			const token = await mintStaffToken({ grants: UPDATE_ONLY_GRANTS })
			const { staffId } = await seed()
			expect((await h.request('GET', '/', { token })).status).toBe(200)
			expect(
				(await h.request('GET', `/${staffId}/jobs`, { token })).status,
			).toBe(200)
		})
	})

	describe('writes with a read grant', () => {
		it('refuses every mutating route', async () => {
			const { staffId, assignmentId, jobId, positionId } = await seed()
			const token = await mintStaffToken({ grants: READ_ONLY_GRANTS })
			const note = await h.request('POST', `/${staffId}/notes`, {
				body: { body: 'keep' },
			})
			const mutations: Array<[string, string, unknown?]> = [
				['POST', '/', staffBody({ firstName: 'X' })],
				[
					'POST',
					'/import',
					{ members: [{ userId: 'u', firstName: 'A', lastName: 'B' }] },
				],
				['POST', '/bulk', { members: [{ firstName: 'A', lastName: 'B' }] }],
				['PATCH', `/${staffId}`, { firstName: 'Hacked' }],
				['PUT', `/${staffId}/private`, { city: 'x' }],
				[
					'POST',
					`/${staffId}/jobs`,
					{
						scopeId: LOC_1,
						positionId,
						currency: 'USD',
						effectiveFrom: '2026-02-01',
					},
				],
				[
					'POST',
					`/${staffId}/jobs/${jobId}/rate-change`,
					{ effectiveFrom: '2026-03-01', rateMinor: 9999, reason: 'r' },
				],
				['POST', `/${staffId}/assignments`, { scopeId: LOC_2 }],
				[
					'PATCH',
					`/${staffId}/assignments/${assignmentId}`,
					{ canWaiveBreaks: true },
				],
				['DELETE', `/${staffId}/assignments/${assignmentId}`],
				['POST', `/${staffId}/assignments/${assignmentId}/pin`, {}],
				['DELETE', `/${staffId}/assignments/${assignmentId}/pin`],
				['POST', `/${staffId}/terminate`, { reason: 'x' }],
				['POST', `/${staffId}/rehire`, { reason: 'x' }],
				['POST', `/${staffId}/notes`, { body: 'x' }],
				['DELETE', `/${staffId}/notes/${note.body.note.id}`],
				['POST', '/positions', { name: 'New' }],
				['PATCH', `/positions/${positionId}`, { name: 'Renamed' }],
				['DELETE', `/positions/${positionId}`],
				['PUT', '/settings', { pinLength: 6 }],
			]
			for (const [method, path, body] of mutations) {
				const response = await h.request(method, path, { token, body })
				expect(
					response.status,
					`${method} ${path} should be forbidden for a read grant`,
				).toBe(403)
			}

			// Nothing changed.
			const detail = await h.request('GET', `/${staffId}`)
			expect(detail.body.staff.firstName).toBe('Rana')
			expect(detail.body.staff.status).toBe('active')
			expect(detail.body.assignments[0].hasPin).toBe(false)
			const jobs = await h.request('GET', `/${staffId}/jobs`)
			expect(jobs.body.jobs).toHaveLength(1)
			expect(jobs.body.jobs[0].rateMinor).toBe(1642)
		})

		it('refuses pay changes with only the general update grant', async () => {
			const { staffId, jobId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			const response = await h.request(
				'POST',
				`/${staffId}/jobs/${jobId}/rate-change`,
				{
					token,
					body: {
						effectiveFrom: '2026-03-01',
						rateMinor: 9999,
						reason: 'raise',
					},
				},
			)
			expect(response.status).toBe(403)
		})

		it('refuses private edits with only the general update grant', async () => {
			const { staffId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			const response = await h.request('PUT', `/${staffId}/private`, {
				token,
				body: { dateOfBirth: '2000-01-01' },
			})
			expect(response.status).toBe(403)
		})
	})

	describe('pay is omitted without the pay grant', () => {
		it('omits money everywhere a manager without staff_pay reads', async () => {
			const { staffId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })

			const responses = [
				await h.request('GET', '/', { token }),
				await h.request('GET', `/${staffId}`, { token }),
				await h.request('GET', `/${staffId}?include=pay`, { token }),
				await h.request('GET', '/positions', { token }),
				await h.request('GET', '/positions?includeArchived=1', { token }),
				await h.request('GET', `/${staffId}/assignments`, { token }),
				await h.request('GET', '/audit', { token }),
			]
			for (const response of responses) {
				expect(response.status).toBe(200)
				for (const needle of [
					'1642',
					'1500',
					'rateMinor',
					'annualSalaryMinor',
					'defaultRateMinor',
					'payType',
					'overtimeExempt',
				]) {
					// Numbers match on digit boundaries so a timestamp that merely
					// contains the digits is not a false positive.
					const pattern = /^\d+$/.test(needle)
						? new RegExp(`(?<!\\d)${needle}(?!\\d)`)
						: new RegExp(needle)
					expect(
						pattern.test(response.raw),
						`"${needle}" leaked to a manager without staff_pay`,
					).toBe(false)
				}
			}
			const detail = await h.request('GET', `/${staffId}?include=pay`, {
				token,
			})
			expect(detail.body.restricted.pay).toBe(true)
			// The job still shows where the person works, just not what they earn.
			expect(detail.body.jobs).toHaveLength(1)
			expect(detail.body.jobs[0]).toMatchObject({ scopeId: LOC_1 })
		})

		it('refuses the pay history route and does not audit a pay read that never happened', async () => {
			const { staffId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			expect(
				(await h.request('GET', `/${staffId}/jobs`, { token })).status,
			).toBe(403)
			await h.request('GET', `/${staffId}?include=pay`, { token })
			const db = await getTenantDb(ORG_A)
			const reads = (await db.select().from(staffAuditLog)).filter(
				(row) =>
					row.action === 'staff.pay.read' && row.actorId === 'operator-1',
			)
			// Only the admin's own reads during seeding (none), never the manager's.
			expect(reads).toHaveLength(0)
		})

		it('refuses to set a pay rate, salary or overtime exemption with only the general grant', async () => {
			const { staffId, positionId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			const host = await h.request('POST', '/positions', {
				body: { name: 'Host' },
			})
			const base = {
				scopeId: LOC_1,
				positionId: host.body.position.id,
				currency: 'USD',
				effectiveFrom: '2026-02-01',
			}
			for (const extra of [
				{ rateMinor: 5000 },
				{ payType: 'salary', annualSalaryMinor: 6_000_000 },
				{ overtimeExempt: true },
			]) {
				const response = await h.request('POST', `/${staffId}/jobs`, {
					token,
					body: { ...base, ...extra },
				})
				expect(response.status).toBe(403)
			}
			// Assigning a position with no pay figures is allowed.
			const plain = await h.request('POST', `/${staffId}/jobs`, {
				token,
				body: base,
			})
			expect(plain.status).toBe(201)
			expect(plain.raw).not.toContain('rateMinor')
			expect(positionId).toBeTruthy()

			const pos = await h.request('POST', '/positions', {
				token,
				body: { name: 'Bar', defaultRateMinor: 1000, currency: 'USD' },
			})
			expect(pos.status).toBe(403)
		})

		it('hides pay audit rows from readers without the pay grant', async () => {
			const { staffId, jobId } = await seed()
			await h.request('POST', `/${staffId}/jobs/${jobId}/rate-change`, {
				body: { effectiveFrom: '2026-03-01', rateMinor: 7777, reason: 'raise' },
			})
			const adminAudit = await h.request('GET', '/audit?limit=200')
			expect(adminAudit.raw).toContain('7777')
			const manager = await mintStaffToken({ grants: MANAGER_GRANTS })
			const managerAudit = await h.request('GET', '/audit?limit=200', {
				token: manager,
			})
			expect(withoutIds(managerAudit.raw)).not.toContain('7777')
			expect(withoutIds(managerAudit.raw)).not.toContain('1642')
			expect(
				managerAudit.body.entries.every(
					(e: any) => e.sensitivity === 'standard',
				),
			).toBe(true)
		})
	})

	describe('private fields are omitted without the private grant', () => {
		it('never returns private data to a manager without staff_private', async () => {
			const { staffId } = await seed()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			const detail = await h.request('GET', `/${staffId}?include=private,pay`, {
				token,
			})
			expect(detail.status).toBe(200)
			expect(detail.body.private).toBeUndefined()
			expect(detail.body.restricted.private).toBe(true)
			for (const response of [
				detail,
				await h.request('GET', '/', { token }),
				await h.request('GET', '/audit?limit=200', { token }),
			]) {
				expect(response.raw).not.toContain('1987-06-15')
				expect(response.raw).not.toContain('77 Secret Lane')
			}
			expect(
				(await h.request('GET', `/${staffId}/private`, { token })).status,
			).toBe(403)
		})

		it('audits reads of private and pay data and fails closed when the audit cannot be written', async () => {
			const { staffId } = await seed()
			const db = await getTenantDb(ORG_A)
			const { sql } = await import('drizzle-orm')
			await db.run(
				sql.raw(
					`CREATE TRIGGER no_audit BEFORE INSERT ON staff_audit_log BEGIN SELECT RAISE(ABORT, 'down'); END`,
				),
			)
			const blocked = await h.request('GET', `/${staffId}/private`)
			expect(blocked.status).toBe(500)
			expect(blocked.raw).not.toContain('1987-06-15')
			const blockedPay = await h.request('GET', `/${staffId}?include=pay`)
			expect(blockedPay.status).toBe(500)
			expect(withoutIds(blockedPay.raw)).not.toContain('1642')
			await db.run(sql.raw('DROP TRIGGER no_audit'))
		})
	})

	describe('PINs are shown once', () => {
		it('never returns the PIN, or its lookup, from any later read', async () => {
			const { staffId, assignmentId } = await seed()
			const set = await h.request(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{ body: { pin: '7391' } },
			)
			expect(set.body.pin).toBe('7391')

			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.id, assignmentId))
			const lookup = row!.pinLookup!
			expect(lookup).toBeTruthy()

			const reads = [
				await h.request('GET', '/'),
				await h.request('GET', `/${staffId}`),
				await h.request('GET', `/${staffId}?include=pay,private`),
				await h.request('GET', `/${staffId}/assignments`),
				await h.request('GET', `/${staffId}/jobs`),
				await h.request('GET', `/${staffId}/notes`),
				await h.request('GET', '/audit?limit=200'),
				await h.request('GET', '/settings'),
				await h.request('GET', '/positions'),
				await h.request('GET', `/?q=7391`),
			]
			for (const response of reads) {
				expect(response.status).toBe(200)
				expect(withoutIds(response.raw)).not.toContain('7391')
				expect(response.raw).not.toContain(lookup)
				expect(response.raw).not.toMatch(/pin_?lookup/i)
				expect(response.raw).not.toMatch(/pin_?failed/i)
			}
			// What a client may learn is only that a PIN exists.
			const assignments = await h.request('GET', `/${staffId}/assignments`)
			expect(assignments.body.assignments[0].hasPin).toBe(true)
		})

		it('keeps the PIN out of the audit log', async () => {
			const { staffId, assignmentId } = await seed()
			await h.request('POST', `/${staffId}/assignments/${assignmentId}/pin`, {
				body: { pin: '7391' },
			})
			const db = await getTenantDb(ORG_A)
			const text = JSON.stringify(await db.select().from(staffAuditLog))
			expect(withoutIds(text)).not.toContain('7391')
			const [row] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.id, assignmentId))
			expect(text).not.toContain(row!.pinLookup!)
		})

		it('does not echo a rejected PIN in the error', async () => {
			const { staffId, assignmentId } = await seed()
			const response = await h.request(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{ body: { pin: '1111' } },
			)
			expect(response.status).toBe(422)
			expect(response.raw).not.toContain('1111')
		})

		it('keys the lookup by org and scope, so the same PIN at two scopes differs', async () => {
			const { staffId, assignmentId } = await seed()
			const second = await h.request('POST', `/${staffId}/assignments`, {
				body: { scopeId: LOC_2 },
			})
			await h.request('POST', `/${staffId}/assignments/${assignmentId}/pin`, {
				body: { pin: '7391' },
			})
			await h.request(
				'POST',
				`/${staffId}/assignments/${second.body.assignment.id}/pin`,
				{ body: { pin: '7391' } },
			)
			const db = await getTenantDb(ORG_A)
			const rows = await db.select().from(staffScopeAssignments)
			const lookups = rows.map((r) => r.pinLookup).filter(Boolean)
			expect(lookups).toHaveLength(2)
			expect(new Set(lookups).size).toBe(2)
		})

		it('two people cannot end up with the same PIN at one scope, even concurrently', async () => {
			const a = await seed()
			const bCreated = await h.request('POST', '/', {
				body: staffBody({
					firstName: 'Omar',
					email: 'omar@example.com',
					phone: '+14155550999',
				}),
			})
			const results = await Promise.all([
				h.request('POST', `/${a.staffId}/assignments/${a.assignmentId}/pin`, {
					body: { pin: '7391' },
				}),
				h.request(
					'POST',
					`/${bCreated.body.staff.id}/assignments/${bCreated.body.assignments[0].id}/pin`,
					{ body: { pin: '7391' } },
				),
			])
			expect(results.map((r) => r.status).sort()).toEqual([201, 409])
			const db = await getTenantDb(ORG_A)
			const rows = await db.select().from(staffScopeAssignments)
			expect(rows.filter((r) => r.pinLookup !== null)).toHaveLength(1)
		})

		it('keeps generated PINs unique across many people at one scope', async () => {
			const created: Array<{ staffId: string; assignmentId: string }> = []
			for (let i = 0; i < 25; i++) {
				const response = await h.request('POST', '/', {
					body: staffBody({
						firstName: `P${i}`,
						email: `p${i}@example.com`,
						phone: undefined,
					}),
				})
				created.push({
					staffId: response.body.staff.id,
					assignmentId: response.body.assignments[0].id,
				})
			}
			const pins = new Set<string>()
			for (const { staffId, assignmentId } of created) {
				const response = await h.request(
					'POST',
					`/${staffId}/assignments/${assignmentId}/pin`,
					{ body: {} },
				)
				expect(response.status).toBe(201)
				pins.add(response.body.pin)
			}
			expect(pins.size).toBe(25)
		})
	})

	describe('impersonated sessions', () => {
		it('are read-only and never see pay or private data, whatever the token claims', async () => {
			const { staffId, assignmentId, jobId } = await seed()
			const token = await mintStaffToken({
				grants: ADMIN_GRANTS,
				impersonated: true,
			})
			const detail = await h.request('GET', `/${staffId}?include=pay,private`, {
				token,
			})
			expect(detail.status).toBe(200)
			expect(withoutIds(detail.raw)).not.toContain('1642')
			expect(detail.raw).not.toContain('1987-06-15')
			expect(detail.body.restricted).toEqual({ pay: true, private: true })

			const writes: Array<[string, string, unknown?]> = [
				['POST', '/', staffBody({ firstName: 'X' })],
				['PATCH', `/${staffId}`, { firstName: 'X' }],
				['POST', `/${staffId}/assignments/${assignmentId}/pin`, {}],
				[
					'POST',
					`/${staffId}/jobs/${jobId}/rate-change`,
					{ effectiveFrom: '2026-03-01', rateMinor: 1, reason: 'x' },
				],
				['POST', `/${staffId}/terminate`, { reason: 'x' }],
				['PUT', `/${staffId}/private`, { city: 'x' }],
			]
			for (const [method, path, body] of writes) {
				const response = await h.request(method, path, { token, body })
				expect(response.status, `${method} ${path}`).toBe(403)
			}
			expect(
				(await h.request('GET', `/${staffId}/jobs`, { token })).status,
			).toBe(403)
			expect(
				(await h.request('GET', `/${staffId}/private`, { token })).status,
			).toBe(403)
		})

		it('needs the short lifetime', async () => {
			const token = await mintStaffToken({
				grants: READ_ONLY_GRANTS,
				impersonated: true,
				lifetimeSeconds: 900,
			})
			// Impersonated tokens carry no sensitive grants, so 15 minutes is the cap.
			expect((await h.request('GET', '/', { token })).status).toBe(200)
		})
	})

	describe('cross-organization and region isolation', () => {
		it('never exposes one org to another org token', async () => {
			const { staffId, assignmentId, jobId, positionId } = await seed()
			const tokenB = await mintStaffToken({
				orgId: ORG_B,
				grants: ADMIN_GRANTS,
			})

			const list = await h.request('GET', '/', { token: tokenB })
			expect(list.body.total).toBe(0)
			const probes: Array<[string, string, unknown?]> = [
				['GET', `/${staffId}`],
				['GET', `/${staffId}?include=pay,private`],
				['GET', `/${staffId}/jobs`],
				['GET', `/${staffId}/private`],
				['GET', `/${staffId}/notes`],
				['GET', `/${staffId}/assignments`],
				['PATCH', `/${staffId}`, { firstName: 'Hacked' }],
				['PUT', `/${staffId}/private`, { city: 'x' }],
				['POST', `/${staffId}/terminate`, { reason: 'x' }],
				['POST', `/${staffId}/assignments/${assignmentId}/pin`, {}],
				['DELETE', `/${staffId}/assignments/${assignmentId}`],
				[
					'POST',
					`/${staffId}/jobs/${jobId}/rate-change`,
					{ effectiveFrom: '2026-03-01', rateMinor: 1, reason: 'x' },
				],
				['PATCH', `/positions/${positionId}`, { name: 'Hacked' }],
			]
			for (const [method, path, body] of probes) {
				const response = await h.request(method, path, { token: tokenB, body })
				expect(response.status, `${method} ${path}`).toBe(404)
				expect(response.raw).not.toContain('Rana')
			}
			// Org A is untouched.
			const detail = await h.request('GET', `/${staffId}`)
			expect(detail.body.staff.firstName).toBe('Rana')
			const audit = await h.request('GET', '/audit?limit=200', {
				token: tokenB,
			})
			expect(audit.body.entries).toEqual([])
		})

		it('refuses a token for an organization this node does not know', async () => {
			const token = await mintStaffToken({ orgId: 'clw9x0a12000008l00nobody' })
			expect((await h.request('GET', '/', { token })).status).toBe(404)
		})

		it('refuses a token for an org owned by another region with 409', async () => {
			orgs.set(ORG_A, makeOrg(ORG_A, { dataRegion: 'ksa' }))
			const response = await h.request('GET', '/')
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('region_mismatch')
			const write = await h.request('POST', '/', { body: staffBody() })
			expect(write.status).toBe(409)
		})

		it('refuses a token whose region claim does not match this node', async () => {
			const token = await mintStaffToken({ region: 'ksa' })
			const response = await h.request('GET', '/', { token })
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('region_mismatch')
			const ok = await mintStaffToken({ region: 'us' })
			expect((await h.request('GET', '/', { token: ok })).status).toBe(200)
		})

		it('refuses an org with no database in this region', async () => {
			orgs.set(ORG_A, makeOrg(ORG_A, { hasProvisionedDb: false }))
			expect((await h.request('GET', '/')).status).toBe(404)
		})

		it('refuses ids that belong to a different staff member (IDOR)', async () => {
			const a = await seed()
			const b = await h.request('POST', '/', {
				body: staffBody({
					firstName: 'Omar',
					email: 'o@example.com',
					phone: undefined,
					employeeNumber: 'E-2',
				}),
			})
			const bId = b.body.staff.id as string
			const bAssignmentId = b.body.assignments[0].id as string
			const note = await h.request('POST', `/${a.staffId}/notes`, {
				body: { body: 'a note' },
			})
			const probes: Array<[string, string, unknown?]> = [
				['POST', `/${bId}/assignments/${a.assignmentId}/pin`, {}],
				[
					'PATCH',
					`/${bId}/assignments/${a.assignmentId}`,
					{ canWaiveBreaks: true },
				],
				['DELETE', `/${bId}/assignments/${a.assignmentId}`],
				[
					'POST',
					`/${bId}/jobs/${a.jobId}/rate-change`,
					{ effectiveFrom: '2026-03-01', rateMinor: 1, reason: 'x' },
				],
				['DELETE', `/${bId}/notes/${note.body.note.id}`],
			]
			for (const [method, path, body] of probes) {
				const response = await h.request(method, path, { body })
				expect(response.status, `${method} ${path}`).toBe(404)
			}
			// B's own assignment is unaffected.
			const detail = await h.request('GET', `/${bId}`)
			expect(detail.body.assignments[0].id).toBe(bAssignmentId)
			expect(detail.body.assignments[0].hasPin).toBe(false)
		})
	})

	describe('scope limit', () => {
		async function seedTwoScopes() {
			// A: only LOC_1. B: LOC_1 and LOC_2. C: only LOC_2.
			const make = async (
				firstName: string,
				assignments: unknown[],
				extra = {},
			) => {
				const response = await h.request('POST', '/', {
					body: staffBody({
						firstName,
						email: `${firstName.toLowerCase()}@example.com`,
						phone: undefined,
						assignments,
						...extra,
					}),
				})
				expect(response.status).toBe(201)
				return response.body as {
					staff: { id: string }
					assignments: Array<{ id: string; scopeId: string }>
				}
			}
			const a = await make('Alma', [{ scopeId: LOC_1, isPrimary: true }])
			const b = await make('Basem', [
				{ scopeId: LOC_1, isPrimary: true },
				{ scopeId: LOC_2 },
			])
			const c = await make('Carim', [{ scopeId: LOC_2, isPrimary: true }])
			const d = await h.request('POST', '/', {
				body: staffBody({
					firstName: 'Dina',
					email: 'dina@example.com',
					phone: undefined,
					assignments: [],
				}),
			})
			return { a, b, c, d: d.body as { staff: { id: string } } }
		}

		const scoped = (scopeIds: string[] | null, grants = ADMIN_GRANTS) =>
			mintStaffToken({ grants, scopeIds })

		it('lists only people assigned to the allowed scopes', async () => {
			await seedTwoScopes()
			const token = await scoped([LOC_1])
			const list = await h.request('GET', '/', { token })
			expect(list.body.staff.map((s: any) => s.firstName)).toEqual([
				'Alma',
				'Basem',
			])
			// People with no assignment at all are unrestricted-only.
			expect(list.raw).not.toContain('Dina')
			expect(list.raw).not.toContain('Carim')
			expect(h.request).toBeTruthy()
		})

		it('shows a shared employee, but only the assignments inside the scope', async () => {
			const { b } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			const detail = await h.request('GET', `/${b.staff.id}`, { token })
			expect(detail.body.assignments.map((a: any) => a.scopeId)).toEqual([
				LOC_1,
			])
			expect(detail.raw).not.toContain(LOC_2)
			const list = await h.request('GET', '/', { token })
			const row = list.body.staff.find((s: any) => s.firstName === 'Basem')
			expect(row.assignments.map((a: any) => a.scopeId)).toEqual([LOC_1])
		})

		it('answers 404, not 403, for people outside the scope', async () => {
			const { c, d } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			for (const id of [c.staff.id, d.staff.id]) {
				for (const [method, path, body] of [
					['GET', `/${id}`],
					['PATCH', `/${id}`, { firstName: 'X' }],
					['GET', `/${id}/notes`],
					['POST', `/${id}/notes`, { body: 'x' }],
					['POST', `/${id}/terminate`, { reason: 'x' }],
					['PUT', `/${id}/private`, { city: 'x' }],
					['GET', `/${id}/private`],
					['GET', `/${id}/jobs`],
				] as Array<[string, string, unknown?]>) {
					const response = await h.request(method, path, { token, body })
					expect(response.status, `${method} ${path}`).toBe(404)
				}
			}
		})

		it('filters by scope only inside the scope', async () => {
			await seedTwoScopes()
			const token = await scoped([LOC_1])
			const outside = await h.request('GET', `/?scopeId=${LOC_2}`, { token })
			expect(outside.body.staff).toEqual([])
			const inside = await h.request('GET', `/?scopeId=${LOC_1}`, { token })
			expect(inside.body.staff).toHaveLength(2)
		})

		it('refuses to create people, assignments and jobs outside the scope', async () => {
			const { a, b } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			const outside = await h.request('POST', '/', {
				token,
				body: staffBody({ assignments: [{ scopeId: LOC_2 }] }),
			})
			expect(outside.status).toBe(403)
			const mixed = await h.request('POST', '/', {
				token,
				body: staffBody({
					employeeNumber: 'E-9',
					assignments: [{ scopeId: LOC_1 }, { scopeId: LOC_2 }],
				}),
			})
			expect(mixed.status).toBe(403)
			// Without any scope the new person would be invisible to the creator.
			const none = await h.request('POST', '/', {
				token,
				body: staffBody({ employeeNumber: 'E-10', assignments: [] }),
			})
			expect(none.status).toBe(403)
			const inside = await h.request('POST', '/', {
				token,
				body: staffBody({
					employeeNumber: 'E-11',
					assignments: [{ scopeId: LOC_1 }],
				}),
			})
			expect(inside.status).toBe(201)

			const add = await h.request('POST', `/${a.staff.id}/assignments`, {
				token,
				body: { scopeId: LOC_2 },
			})
			expect(add.status).toBe(403)
			const position = await h.request('POST', '/positions', {
				body: { name: 'Cook' },
			})
			const job = await h.request('POST', `/${b.staff.id}/jobs`, {
				token,
				body: {
					scopeId: LOC_2,
					positionId: position.body.position.id,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			expect(job.status).toBe(403)
		})

		it('cannot touch the out-of-scope assignment of a shared employee', async () => {
			const { b } = await seedTwoScopes()
			const otherAssignment = b.assignments.find((x) => x.scopeId === LOC_2)!
			const token = await scoped([LOC_1])
			for (const [method, path, body] of [
				['POST', `/${b.staff.id}/assignments/${otherAssignment.id}/pin`, {}],
				[
					'PATCH',
					`/${b.staff.id}/assignments/${otherAssignment.id}`,
					{ active: false },
				],
				['DELETE', `/${b.staff.id}/assignments/${otherAssignment.id}`],
				['DELETE', `/${b.staff.id}/assignments/${otherAssignment.id}/pin`],
			] as Array<[string, string, unknown?]>) {
				const response = await h.request(method, path, { token, body })
				expect(response.status, `${method} ${path}`).toBe(404)
			}
			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.id, otherAssignment.id))
			expect(row!.active).toBe(true)
			expect(row!.pinLookup).toBeNull()
		})

		it('hides other scopes pay rows and jobs', async () => {
			const { b } = await seedTwoScopes()
			const position = await h.request('POST', '/positions', {
				body: { name: 'Cook' },
			})
			for (const [scopeId, rateMinor] of [
				[LOC_1, 1111],
				[LOC_2, 2222],
			] as const) {
				await h.request('POST', `/${b.staff.id}/jobs`, {
					body: {
						scopeId,
						positionId:
							scopeId === LOC_1
								? position.body.position.id
								: (
										await h.request('POST', '/positions', {
											body: { name: 'Cook 2' },
										})
									).body.position.id,
						currency: 'USD',
						rateMinor,
						effectiveFrom: '2026-01-01',
					},
				})
			}
			const token = await scoped([LOC_1])
			const detail = await h.request('GET', `/${b.staff.id}?include=pay`, {
				token,
			})
			expect(detail.raw).toContain('1111')
			expect(detail.raw).not.toContain('2222')
			const jobs = await h.request('GET', `/${b.staff.id}/jobs`, { token })
			expect(jobs.raw).not.toContain('2222')
			const jobIds = (await h.request('GET', `/${b.staff.id}/jobs`)).body
				.jobs as Array<{ id: string; scopeId: string }>
			const hidden = jobIds.find((j) => j.scopeId === LOC_2)!
			const change = await h.request(
				'POST',
				`/${b.staff.id}/jobs/${hidden.id}/rate-change`,
				{
					token,
					body: { effectiveFrom: '2026-06-01', rateMinor: 1, reason: 'x' },
				},
			)
			expect(change.status).toBe(404)
		})

		it('lets a scoped manager end employment only when every scope is theirs', async () => {
			const { a, b } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			const shared = await h.request('POST', `/${b.staff.id}/terminate`, {
				token,
				body: { reason: 'x' },
			})
			expect(shared.status).toBe(403)
			expect((await h.request('GET', `/${b.staff.id}`)).body.staff.status).toBe(
				'active',
			)
			const own = await h.request('POST', `/${a.staff.id}/terminate`, {
				token,
				body: { reason: 'x' },
			})
			expect(own.status).toBe(200)
			const both = await scoped([LOC_1, LOC_2])
			expect(
				(
					await h.request('POST', `/${b.staff.id}/terminate`, {
						token: both,
						body: { reason: 'x' },
					})
				).status,
			).toBe(200)
		})

		it('lets a scoped manager edit the person only when every scope is theirs', async () => {
			const { a, b } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			const shared = await h.request('PATCH', `/${b.staff.id}`, {
				token,
				body: { status: 'on_leave' },
			})
			expect(shared.status).toBe(403)
			const rename = await h.request('PATCH', `/${b.staff.id}`, {
				token,
				body: { email: 'new@example.com' },
			})
			expect(rename.status).toBe(403)
			const detail = await h.request('GET', `/${b.staff.id}`)
			expect(detail.body.staff.status).toBe('active')
			expect(detail.body.staff.email).not.toBe('new@example.com')
			// Re-pointing the primary among in-scope scopes stays allowed, and a
			// person entirely inside the scope can be edited.
			const primary = await h.request('PATCH', `/${b.staff.id}`, {
				token,
				body: { primaryScopeId: LOC_1 },
			})
			expect(primary.status).toBe(200)
			const own = await h.request('PATCH', `/${a.staff.id}`, {
				token,
				body: { status: 'on_leave' },
			})
			expect(own.status).toBe(200)
		})

		it('keeps org-wide settings, positions and linking for unrestricted tokens', async () => {
			await seedTwoScopes()
			const token = await scoped([LOC_1])
			expect(
				(await h.request('PUT', '/settings', { token, body: { pinLength: 5 } }))
					.status,
			).toBe(403)
			expect(
				(
					await h.request('POST', '/positions', {
						token,
						body: { name: 'New' },
					})
				).status,
			).toBe(403)
			expect(
				(
					await h.request('POST', '/import', {
						token,
						body: {
							members: [{ userId: 'u1', firstName: 'A', lastName: 'B' }],
						},
					})
				).status,
			).toBe(403)
			const bulk = await h.request('POST', '/bulk', {
				token,
				body: {
					members: [
						{
							firstName: 'A',
							lastName: 'B',
							userId: 'u1',
							assignments: [{ scopeId: LOC_1 }],
						},
						{
							firstName: 'C',
							lastName: 'D',
							assignments: [{ scopeId: LOC_1 }],
						},
					],
				},
			})
			expect(bulk.body.results.map((r: any) => r.status)).toEqual([
				'invalid',
				'created',
			])
			// Reading is fine.
			expect((await h.request('GET', '/positions', { token })).status).toBe(200)
			expect((await h.request('GET', '/settings', { token })).status).toBe(200)
		})

		it('treats an empty scope list as no access at all', async () => {
			await seedTwoScopes()
			const token = await scoped([])
			const list = await h.request('GET', '/', { token })
			expect(list.body.staff).toEqual([])
			expect(list.body.total).toBe(0)
			expect(
				(
					await h.request('POST', '/', {
						token,
						body: staffBody({ assignments: [{ scopeId: LOC_1 }] }),
					})
				).status,
			).toBe(403)
			expect(
				(await h.request('GET', '/audit', { token })).body.entries,
			).toEqual([])
		})

		it('limits the audit trail to rows tied to the scope', async () => {
			const { a, c } = await seedTwoScopes()
			const token = await scoped([LOC_1])
			const audit = await h.request('GET', '/audit?limit=200', { token })
			const ids = audit.body.entries.map((e: any) => e.staffId)
			expect(ids).toContain(a.staff.id)
			expect(ids).not.toContain(c.staff.id)
			expect(audit.body.entries.every((e: any) => e.scopeId === LOC_1)).toBe(
				true,
			)
			expect(LOC_3).toBeTruthy()
		})
	})

	describe('log hygiene and linking', () => {
		it('never links a login through the bulk (CSV) route', async () => {
			const response = await h.request('POST', '/bulk', {
				body: {
					members: [
						{ userId: 'someone-elses-login', firstName: 'A', lastName: 'B' },
						{ firstName: 'C', lastName: 'D' },
					],
				},
			})
			expect(response.status).toBe(200)
			expect(response.body.results.map((r: any) => r.status)).toEqual([
				'invalid',
				'created',
			])
			const db = await getTenantDb(ORG_A)
			const linked = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.userId, 'someone-elses-login'))
			expect(linked).toEqual([])
		})

		it('describes errors without the SQL parameters Drizzle puts in its message', () => {
			const driver = new Error(
				'SQLITE_CONSTRAINT: UNIQUE constraint failed: x.y',
			)
			const wrapped = Object.assign(
				new Error(
					'Failed query: insert ...\nparams: Rana,Khalid,rana@example.com',
				),
				{ query: 'insert ...', params: ['Rana'], cause: driver },
			)
			const described = describeStaffError(wrapped)
			expect(described).toContain('UNIQUE constraint failed')
			expect(described).not.toContain('rana@example.com')
			const bare = Object.assign(new Error('Failed query: ... params: 1200'), {
				params: [1200],
			})
			expect(describeStaffError(bare)).toBe('Database query failed')
			expect(describeStaffError('weird')).toBe('Unknown error')
		})
	})

	describe('input hardening', () => {
		it('rejects unknown keys so protected columns cannot be set (mass assignment)', async () => {
			const { staffId, assignmentId, positionId } = await seed()
			const attacks: Array<[string, string, unknown]> = [
				['POST', '/', staffBody({ status: 'terminated' })],
				['POST', '/', staffBody({ userId: 'someone-elses-login' })],
				['POST', '/', staffBody({ id: 'fixed-id' })],
				['POST', '/', staffBody({ terminatedAt: 1, createdBy: 'ghost' })],
				['PATCH', `/${staffId}`, { userId: 'someone-elses-login' }],
				['PATCH', `/${staffId}`, { status: 'terminated' }],
				['PATCH', `/${staffId}`, { eligibleForRehire: true }],
				[
					'PATCH',
					`/${staffId}`,
					{ __proto__: { admin: true }, firstName: 'x' },
				],
				[
					'PATCH',
					`/${staffId}/assignments/${assignmentId}`,
					{ pinLookup: 'aaaa' },
				],
				[
					'POST',
					`/${staffId}/assignments`,
					{ scopeId: LOC_2, pinLookup: 'aaaa' },
				],
				[
					'POST',
					`/${staffId}/assignments/${assignmentId}/pin`,
					{ pinLookup: 'aaaa' },
				],
				['PATCH', `/positions/${positionId}`, { archivedAt: null, id: 'x' }],
				['POST', '/positions', { name: 'Y', createdBy: 'ghost' }],
				['PUT', `/${staffId}/private`, { staffId: 'other' }],
				['PUT', '/settings', { id: 'other' }],
				['POST', `/${staffId}/terminate`, { reason: 'x', terminatedAt: 5 }],
				['POST', `/${staffId}/notes`, { body: 'x', authorId: 'someone-else' }],
			]
			for (const [method, path, body] of attacks) {
				const response = await h.request(method, path, {
					rawBody:
						(body as { __proto__?: unknown }).__proto__ !== undefined
							? '{"__proto__":{"admin":true},"firstName":"x"}'
							: undefined,
					body:
						(body as { __proto__?: unknown }).__proto__ !== undefined
							? undefined
							: body,
				})
				expect(response.status, `${method} ${path}`).toBe(400)
			}
			const detail = await h.request('GET', `/${staffId}`)
			expect(detail.body.staff.userId).toBeNull()
			expect(detail.body.staff.status).toBe('active')
		})

		it('rejects invalid bodies without echoing values', async () => {
			const secretish = 'ZZ-do-not-echo-9f3'
			const cases: Array<[string, string, unknown]> = [
				['POST', '/', staffBody({ firstName: '' })],
				['POST', '/', staffBody({ firstName: 'x'.repeat(81) })],
				['POST', '/', staffBody({ phone: secretish })],
				['POST', '/', staffBody({ email: secretish })],
				['POST', '/', staffBody({ workerType: secretish })],
				['POST', '/', staffBody({ locale: secretish })],
				['POST', '/', staffBody({ hiredDate: '2026-02-30' })],
				['POST', '/', staffBody({ assignments: [{ scopeId: '' }] })],
				[
					'POST',
					'/',
					staffBody({
						assignments: Array.from({ length: 26 }, (_, i) => ({
							scopeId: `l${i}`,
						})),
					}),
				],
				[
					'POST',
					'/',
					staffBody({
						assignments: [{ scopeId: LOC_1 }, { scopeId: LOC_1 }],
					}),
				],
				[
					'POST',
					'/',
					staffBody({
						assignments: [
							{ scopeId: LOC_1, isPrimary: true },
							{ scopeId: LOC_2, isPrimary: true },
						],
					}),
				],
			]
			for (const [method, path, body] of cases) {
				const response = await h.request(method, path, { body })
				expect([400, 422]).toContain(response.status)
				expect(response.raw).not.toContain(secretish)
			}
			for (const rawBody of ['', '{', 'null', '[]', '"x"', '1']) {
				const response = await h.request('POST', '/', { rawBody })
				expect(response.status).toBe(400)
			}
		})

		it('treats search text and ids as data, not SQL', async () => {
			await seed()
			const payloads = [
				"'; DROP TABLE staff_members; --",
				"' OR '1'='1",
				'%',
				'\\',
				'"',
				'\u0000',
			]
			for (const q of payloads) {
				const response = await h.request('GET', `/?q=${encodeURIComponent(q)}`)
				// Control characters are refused outright (a NUL would truncate the
				// LIKE pattern and match everyone); everything else is just data.
				expect(response.status, `q=${JSON.stringify(q)}`).toBe(
					q === '\u0000' ? 400 : 200,
				)
				if (response.status === 200) expect(response.body.staff).toEqual([])
			}
			for (const id of ["' OR 1=1 --", '../../x', '%00']) {
				const response = await h.request('GET', `/${encodeURIComponent(id)}`)
				expect(response.status).toBe(404)
			}
			expect((await h.request('GET', '/')).body.total).toBe(1)
		})

		it('rejects out-of-range pagination and malformed filters', async () => {
			for (const query of [
				'limit=0',
				'limit=1000',
				'limit=abc',
				'offset=-1',
				'status=hacker',
			]) {
				const response = await h.request('GET', `/?${query}`)
				expect(response.status, query).toBe(400)
			}
		})

		it('keeps money to integer minor units', async () => {
			const { staffId, jobId, positionId } = await seed()
			const host = await h.request('POST', '/positions', {
				body: { name: 'Host' },
			})
			for (const body of [
				{
					scopeId: LOC_1,
					positionId: host.body.position.id,
					currency: 'USD',
					rateMinor: 15.99,
					effectiveFrom: '2026-02-01',
				},
				{
					scopeId: LOC_1,
					positionId: host.body.position.id,
					currency: 'USD',
					rateMinor: -5,
					effectiveFrom: '2026-02-01',
				},
				{
					scopeId: LOC_1,
					positionId: host.body.position.id,
					currency: 'EUR',
					rateMinor: 5,
					effectiveFrom: '2026-02-01',
				},
				{
					scopeId: LOC_1,
					positionId: host.body.position.id,
					currency: 'USD',
					rateMinor: 1e15,
					effectiveFrom: '2026-02-01',
				},
			]) {
				const response = await h.request('POST', `/${staffId}/jobs`, { body })
				expect(response.status).toBe(400)
			}
			const change = await h.request(
				'POST',
				`/${staffId}/jobs/${jobId}/rate-change`,
				{
					body: { effectiveFrom: '2026-03-01', rateMinor: 18.5, reason: 'x' },
				},
			)
			expect(change.status).toBe(400)
			expect(positionId).toBeTruthy()
		})

		it('requires a reason on pay changes and termination, and rejects blank ones', async () => {
			const { staffId, jobId } = await seed()
			for (const reason of [undefined, '', '   ']) {
				const pay = await h.request(
					'POST',
					`/${staffId}/jobs/${jobId}/rate-change`,
					{
						body: { effectiveFrom: '2026-03-01', rateMinor: 2000, reason },
					},
				)
				expect(pay.status).toBe(400)
				const term = await h.request('POST', `/${staffId}/terminate`, {
					body: { reason },
				})
				expect(term.status).toBe(400)
			}
		})
	})

	describe('integrity under concurrency', () => {
		it('lets exactly one of two simultaneous rate changes win', async () => {
			const { staffId, jobId } = await seed()
			const results = await Promise.all(
				[1800, 1900].map((rateMinor) =>
					h.request('POST', `/${staffId}/jobs/${jobId}/rate-change`, {
						body: { effectiveFrom: '2026-03-01', rateMinor, reason: 'race' },
					}),
				),
			)
			expect(results.map((r) => r.status).sort()).toEqual([201, 409])
			const jobs = await h.request('GET', `/${staffId}/jobs`)
			const open = jobs.body.jobs.filter((j: any) => j.effectiveTo === null)
			expect(open).toHaveLength(1)
			expect(jobs.body.jobs).toHaveLength(2)
		})

		it('creates one person for two simultaneous imports of the same login', async () => {
			const row = { userId: 'user-1', firstName: 'Rana', lastName: 'Khalid' }
			const results = await Promise.all([
				h.request('POST', '/import', { body: { members: [row] } }),
				h.request('POST', '/import', { body: { members: [row] } }),
			])
			for (const result of results) expect(result.status).toBe(200)
			const created = results.reduce(
				(total, r) => total + r.body.summary.created,
				0,
			)
			expect(created).toBe(1)
			expect((await h.request('GET', '/')).body.total).toBe(1)
		})

		it('keeps a single primary scope per person under concurrent updates', async () => {
			const { staffId } = await seed()
			const second = await h.request('POST', `/${staffId}/assignments`, {
				body: { scopeId: LOC_2 },
			})
			await Promise.all([
				h.request(
					'PATCH',
					`/${staffId}/assignments/${second.body.assignment.id}`,
					{
						body: { isPrimary: true },
					},
				),
				h.request('PATCH', `/${staffId}`, {
					body: { primaryScopeId: LOC_1 },
				}),
			])
			const detail = await h.request('GET', `/${staffId}`)
			const primaries = detail.body.assignments.filter((a: any) => a.isPrimary)
			expect(primaries).toHaveLength(1)
			expect(detail.body.staff.primaryScopeId).toBe(primaries[0].scopeId)
		})
	})

	describe('append-only history', () => {
		it('exposes no route that edits or deletes audit rows or wage history', async () => {
			const { staffId, jobId } = await seed()
			const before = await h.request('GET', '/audit?limit=200')
			for (const [method, path] of [
				['DELETE', '/audit'],
				['PATCH', '/audit'],
				['PUT', '/audit'],
				['POST', '/audit'],
				['DELETE', `/${staffId}/jobs/${jobId}`],
				['PATCH', `/${staffId}/jobs/${jobId}`],
				['PUT', `/${staffId}/jobs/${jobId}`],
				['DELETE', `/${staffId}`],
			] as Array<[string, string]>) {
				const response = await h.request(method, path, { body: { x: 1 } })
				expect([404, 405, 400]).toContain(response.status)
			}
			const after = await h.request('GET', '/audit?limit=200')
			expect(after.body.entries).toHaveLength(before.body.entries.length)
			const jobs = await h.request('GET', `/${staffId}/jobs`)
			expect(jobs.body.jobs).toHaveLength(1)
			expect(jobs.body.jobs[0].rateMinor).toBe(1642)
		})

		it('keeps the pre-change rate readable after a rate change', async () => {
			const { staffId, jobId } = await seed()
			await h.request('POST', `/${staffId}/jobs/${jobId}/rate-change`, {
				body: { effectiveFrom: '2026-03-01', rateMinor: 2000, reason: 'raise' },
			})
			const jobs = await h.request('GET', `/${staffId}/jobs`)
			expect(
				jobs.body.jobs.map((j: any) => [
					j.rateMinor,
					j.effectiveFrom,
					j.effectiveTo,
				]),
			).toEqual([
				[2000, '2026-03-01', null],
				[1642, '2026-01-01', '2026-02-28'],
			])
		})
	})
})
