import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getTenantDb,
	staffAuditLog,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffNotes,
	staffPrivate,
	timeOffRequests,
} from '@repo/tenant-db'
import {
	createStaffHarness,
	INTERNAL_TOKEN,
	LOC_1,
	makeOrg,
	mintStaffToken,
	ORG_A,
	ORG_B,
	staffBody,
	type StaffHarness,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { resolveOrgId } from '../../workers/org-router.ts'
import { staffInternalRoutes } from './staff-internal.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

type Reply = { status: number; body: any; raw: string }

describe('/internal/staff', () => {
	let h: StaffHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		h = await createStaffHarness()
		h.app.route('/internal/staff', staffInternalRoutes)
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	async function internal(
		path: string,
		body: unknown,
		options: { token?: string | null; raw?: string } = {},
	): Promise<Reply> {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
		}
		const token = options.token === undefined ? INTERNAL_TOKEN : options.token
		if (token !== null) headers.Authorization = `Bearer ${token}`
		const response = await h.app.request(`/internal/staff${path}`, {
			method: 'POST',
			headers,
			body: options.raw ?? JSON.stringify(body),
		})
		const raw = await response.text()
		let parsed: any = null
		try {
			parsed = raw ? JSON.parse(raw) : null
		} catch {
			parsed = null
		}
		return { status: response.status, body: parsed, raw }
	}

	async function createMember(
		overrides: Record<string, unknown> = {},
		orgId = ORG_A,
	) {
		const token = await mintStaffToken({ orgId })
		const response = await h.request('POST', '/', {
			token,
			body: staffBody(overrides),
		})
		expect(response.status).toBe(201)
		return response.body as {
			staff: { id: string }
			assignments: Array<{ id: string }>
		}
	}

	async function positionId(orgId = ORG_A) {
		const response = await h.request('POST', '/positions', {
			token: await mintStaffToken({ orgId }),
			body: { name: 'Server', defaultRateMinor: 1500, currency: 'USD' },
		})
		return response.body.position.id as string
	}

	describe('authentication and validation', () => {
		it('requires the internal command token', async () => {
			const body = { orgId: ORG_A }
			expect((await internal('/summary', body, { token: null })).status).toBe(
				401,
			)
			expect((await internal('/summary', body, { token: 'nope' })).status).toBe(
				401,
			)
			// An operator or staff token is never accepted here.
			const operator = await mintStaffToken()
			expect(
				(await internal('/summary', body, { token: operator })).status,
			).toBe(401)
			expect((await internal('/summary', body)).status).toBe(200)
		})

		it('refuses to run without a configured token', async () => {
			vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
			expect(
				(await internal('/summary', { orgId: ORG_A }, { token: 'short' }))
					.status,
			).toBe(503)
		})

		it('rejects malformed, extra and PII-shaped fields without echoing them', async () => {
			const cases: unknown[] = [
				{},
				{ orgId: '' },
				{ orgId: ORG_A, email: 'rana@example.com' },
				{ orgId: 'rana@example.com' },
				{ orgId: ORG_A, staffMemberId: '../x', userId: 'u1' },
			]
			for (const body of cases) {
				const path = (body as any).staffMemberId ? '/link-user' : '/summary'
				const reply = await internal(path, body)
				expect(reply.status).toBe(400)
				expect(reply.raw).not.toContain('rana@example.com')
			}
			const link = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: 's1',
				userId: 'u1',
				name: 'Rana',
			})
			expect(link.status).toBe(400)
			expect(link.raw).not.toContain('Rana')
			expect((await internal('/summary', null, { raw: '{nope' })).status).toBe(
				400,
			)
		})

		it('fails closed for unknown, foreign-region and unprovisioned organizations', async () => {
			expect((await internal('/summary', { orgId: 'unknownorg' })).status).toBe(
				404,
			)
			orgs.set(ORG_B, makeOrg(ORG_B, { dataRegion: 'ksa' }))
			const foreign = await internal('/summary', { orgId: ORG_B })
			expect(foreign.status).toBe(409)
			expect(foreign.body.error).toBe('region_mismatch')
			orgs.set(ORG_B, makeOrg(ORG_B, { hasProvisionedDb: false }))
			const missing = await internal('/summary', { orgId: ORG_B })
			expect(missing.status).toBe(404)
			expect(missing.body.error).toBe('org_not_provisioned')
		})
	})

	describe('summary', () => {
		it('counts what a region switch would destroy, and nothing else', async () => {
			const empty = await internal('/summary', { orgId: ORG_A })
			expect(empty.body).toMatchObject({ staff: 0, linkedLogins: 0 })

			const a = await createMember()
			await createMember({
				firstName: 'Omar',
				email: 'omar@example.com',
				phone: '+14155550124',
			})
			await h.request('POST', `/${a.staff.id}/notes`, {
				body: { body: 'late twice' },
			})
			const position = await positionId()
			await h.request('POST', `/${a.staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request('POST', `/${a.staff.id}/terminate`, {
				body: { reason: 'Moved away' },
			})

			const reply = await internal('/summary', { orgId: ORG_A })
			expect(reply.status).toBe(200)
			expect(reply.body).toMatchObject({
				staff: 2,
				byStatus: { active: 1, terminated: 1, invited: 0, on_leave: 0 },
				scopeAssignments: 2,
				positions: 1,
				payRecords: 1,
				notes: 1,
			})
			expect(reply.body.auditEntries).toBeGreaterThan(0)
			// Time cards and shifts are counted too (none here).
			expect(reply.body).toMatchObject({ timeCards: 0, shifts: 0 })
			// Numbers only: no name, email, phone or id of a person.
			for (const value of Object.values(reply.body)) {
				expect(['number', 'object']).toContain(typeof value)
			}
			for (const needle of [
				'Rana',
				'Omar',
				'example.com',
				'+1415',
				a.staff.id,
			]) {
				expect(reply.raw).not.toContain(needle)
			}
		})

		it('is scoped to the organization it names', async () => {
			await createMember({}, ORG_A)
			const other = await internal('/summary', { orgId: ORG_B })
			expect(other.body.staff).toBe(0)
			expect((await internal('/summary', { orgId: ORG_A })).body.staff).toBe(1)
		})
	})

	describe('link-user', () => {
		it('links a login to a staff row and audits it as the control plane', async () => {
			const { staff } = await createMember()
			const reply = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			expect(reply.status).toBe(200)
			expect(reply.body).toEqual({ linked: true, alreadyLinked: false })

			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, staff.id))
			expect(row!.userId).toBe('user-1')
			const audit = (await db.select().from(staffAuditLog)).filter(
				(entry) => entry.action === 'staff.user_linked',
			)
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({
				actorKind: 'system',
				actorId: 'control-plane',
				staffId: staff.id,
				ipHash: null,
			})
		})

		it('is idempotent for the same pair and writes one audit row', async () => {
			const { staff } = await createMember()
			const body = { orgId: ORG_A, staffMemberId: staff.id, userId: 'user-1' }
			await internal('/link-user', body)
			const again = await internal('/link-user', body)
			expect(again.status).toBe(200)
			expect(again.body).toEqual({ linked: true, alreadyLinked: true })
			const db = await getTenantDb(ORG_A)
			const audit = (await db.select().from(staffAuditLog)).filter(
				(entry) => entry.action === 'staff.user_linked',
			)
			expect(audit).toHaveLength(1)
		})

		it('never takes over a row linked to another login, or gives a login two rows', async () => {
			const first = await createMember()
			const second = await createMember({ firstName: 'Omar' })
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: first.staff.id,
				userId: 'user-1',
			})
			const takeover = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: first.staff.id,
				userId: 'user-2',
			})
			expect(takeover.status).toBe(409)
			expect(takeover.body.error).toBe('staff_linked_to_other_user')
			const twice = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: second.staff.id,
				userId: 'user-1',
			})
			expect(twice.status).toBe(409)
			expect(twice.body.error).toBe('user_already_linked')
		})

		it('404s for an unknown staff id and for a staff id from another organization', async () => {
			const { staff } = await createMember({}, ORG_A)
			const unknown = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: 'nope',
				userId: 'user-1',
			})
			expect(unknown.status).toBe(404)
			expect(unknown.body.error).toBe('staff_not_found')
			const cross = await internal('/link-user', {
				orgId: ORG_B,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			expect(cross.status).toBe(404)
			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, staff.id))
			expect(row!.userId).toBeNull()
		})

		it('refuses to link a terminated row', async () => {
			const { staff } = await createMember()
			await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Moved away' },
			})
			const reply = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			expect(reply.status).toBe(409)
			expect(reply.body.error).toBe('staff_terminated')
		})
	})

	describe('unlink-user', () => {
		it('clears the link and leaves the person employed, with their PIN and pay', async () => {
			const { staff, assignments } = await createMember()
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			const position = await positionId()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)

			const reply = await internal('/unlink-user', {
				orgId: ORG_A,
				userId: 'user-1',
			})
			expect(reply.body).toEqual({ unlinked: 1 })

			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, staff.id))
			expect(row).toMatchObject({
				userId: null,
				status: 'active',
				terminatedAt: null,
			})
			const [assignment] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.staffId, staff.id))
			expect(assignment).toMatchObject({ active: true })
			expect(assignment!.pinLookup).not.toBeNull()
			const jobs = await db
				.select()
				.from(staffJobs)
				.where(eq(staffJobs.staffId, staff.id))
			expect(jobs).toHaveLength(1)
			expect(jobs[0]!.effectiveTo).toBeNull()
			const audit = (await db.select().from(staffAuditLog)).filter(
				(entry) => entry.action === 'staff.user_unlinked',
			)
			expect(audit).toHaveLength(1)
		})

		it('is idempotent and only touches the named login', async () => {
			const a = await createMember()
			const b = await createMember({ firstName: 'Omar' })
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: a.staff.id,
				userId: 'user-1',
			})
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: b.staff.id,
				userId: 'user-2',
			})
			expect(
				(await internal('/unlink-user', { orgId: ORG_A, userId: 'user-1' }))
					.body.unlinked,
			).toBe(1)
			expect(
				(await internal('/unlink-user', { orgId: ORG_A, userId: 'user-1' }))
					.body.unlinked,
			).toBe(0)
			const db = await getTenantDb(ORG_A)
			const [other] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, b.staff.id))
			expect(other!.userId).toBe('user-2')
		})

		it('does not reach another organization with the same user id', async () => {
			const a = await createMember({}, ORG_A)
			const b = await createMember({}, ORG_B)
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: a.staff.id,
				userId: 'user-1',
			})
			await internal('/link-user', {
				orgId: ORG_B,
				staffMemberId: b.staff.id,
				userId: 'user-1',
			})
			await internal('/unlink-user', { orgId: ORG_A, userId: 'user-1' })
			const dbB = await getTenantDb(ORG_B)
			const [row] = await dbB
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, b.staff.id))
			expect(row!.userId).toBe('user-1')
		})
	})

	describe('erase-user', () => {
		async function seedPerson() {
			const { staff, assignments } = await createMember({
				firstNameAr: 'رنا',
				employeeNumber: 'E-7',
			})
			const bystander = await createMember({
				firstName: 'Omar',
				email: 'omar@example.com',
				phone: '+14155550124',
			})
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			await h.request('PUT', `/${staff.id}/private`, {
				body: {
					dateOfBirth: '1990-04-02',
					addressLine1: '1 Main St',
					emergencyContactName: 'Lina',
				},
			})
			await h.request('POST', `/${staff.id}/notes`, {
				body: { body: 'Rana was late again' },
			})
			await h.request('POST', `/${bystander.staff.id}/notes`, {
				body: { body: 'keeps their note' },
			})
			await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)
			const position = await positionId()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position,
					currency: 'USD',
					rateMinor: 1800,
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request('PATCH', `/${staff.id}`, {
				body: { firstName: 'Rania', email: 'rania@example.com' },
			})
			return { staff, bystander }
		}

		it('anonymizes the linked row and keeps pay history under a pseudonym', async () => {
			const { staff, bystander } = await seedPerson()
			const reply = await internal('/erase-user', {
				orgId: ORG_A,
				userId: 'user-1',
			})
			expect(reply.body).toEqual({ erased: 1 })

			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, staff.id))
			expect(row).toMatchObject({
				firstName: 'Erased',
				lastName: `Staff ${staff.id.slice(0, 8)}`,
				firstNameAr: null,
				lastNameAr: null,
				email: null,
				phone: null,
				userId: null,
				employeeNumber: null,
				status: 'terminated',
				terminationReason: 'erased',
				eligibleForRehire: false,
			})
			expect(row!.terminatedAt).not.toBeNull()

			expect(
				await db
					.select()
					.from(staffPrivate)
					.where(eq(staffPrivate.staffId, staff.id)),
			).toHaveLength(0)
			expect(
				await db
					.select()
					.from(staffNotes)
					.where(eq(staffNotes.staffId, staff.id)),
			).toHaveLength(0)
			const [assignment] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.staffId, staff.id))
			expect(assignment).toMatchObject({
				active: false,
				pinLookup: null,
				isPrimary: false,
			})
			// Wage records outlive the account: kept, with open rows closed.
			const jobs = await db
				.select()
				.from(staffJobs)
				.where(eq(staffJobs.staffId, staff.id))
			expect(jobs).toHaveLength(1)
			expect(jobs[0]!.rateMinor).toBe(1800)
			expect(jobs[0]!.effectiveTo).not.toBeNull()

			// Nobody else is touched.
			const [other] = await db
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, bystander.staff.id))
			expect(other).toMatchObject({
				firstName: 'Omar',
				email: 'omar@example.com',
				status: 'active',
			})
			expect(
				await db
					.select()
					.from(staffNotes)
					.where(eq(staffNotes.staffId, bystander.staff.id)),
			).toHaveLength(1)
		})

		it('clears the free text on their schedule requests and leaves everyone else', async () => {
			const { staff, bystander } = await seedPerson()
			const db = await getTenantDb(ORG_A)
			const request = (staffId: string, note: string) => ({
				staffId,
				startDate: '2026-03-02',
				endDate: '2026-03-02',
				note,
				decisionNote: `about ${note}`,
				source: 'staff' as const,
			})
			await db
				.insert(timeOffRequests)
				.values([
					request(staff.id, 'clinic visit'),
					request(bystander.staff.id, 'keeps its note'),
				])

			await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })

			const rows = await db.select().from(timeOffRequests)
			const mine = rows.find((row) => row.staffId === staff.id)
			const theirs = rows.find((row) => row.staffId === bystander.staff.id)
			expect(mine).toMatchObject({
				note: null,
				decisionNote: null,
				startDate: '2026-03-02',
			})
			expect(theirs).toMatchObject({
				note: 'keeps its note',
				decisionNote: 'about keeps its note',
			})
		})

		it('redacts the audit values about the person but keeps who, what and when', async () => {
			const { staff } = await seedPerson()
			const db = await getTenantDb(ORG_A)
			const before = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.staffId, staff.id))
			expect(JSON.stringify(before)).toContain('Rania')

			await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })

			const after = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.staffId, staff.id))
			const text = JSON.stringify(after)
			for (const needle of [
				'Rania',
				'rania@example.com',
				'Rana',
				'1990-04-02',
			]) {
				expect(text).not.toContain(needle)
			}
			// Every earlier row survives with its action and timestamp.
			expect(after.length).toBe(before.length + 1)
			for (const entry of before) {
				const kept = after.find((row) => row.id === entry.id)
				expect(kept).toMatchObject({
					action: entry.action,
					at: entry.at,
					actorId: entry.actorId,
				})
				if (entry.changes !== null) {
					expect(kept!.changes).toEqual({ redacted: true })
				}
			}
			const erased = after.find((row) => row.action === 'staff.erased')
			expect(erased).toMatchObject({ actorKind: 'system' })
			expect(erased!.changes).toMatchObject({
				notesDeleted: 1,
				privateRecordDeleted: true,
			})
		})

		it('is idempotent, and an unknown user erases nothing', async () => {
			await seedPerson()
			expect(
				(await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })).body
					.erased,
			).toBe(1)
			expect(
				(await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })).body
					.erased,
			).toBe(0)
			expect(
				(await internal('/erase-user', { orgId: ORG_A, userId: 'ghost' })).body
					.erased,
			).toBe(0)
		})

		it('does not erase a same-named login in another organization', async () => {
			const a = await createMember({}, ORG_A)
			const b = await createMember({}, ORG_B)
			for (const [orgId, id] of [
				[ORG_A, a.staff.id],
				[ORG_B, b.staff.id],
			] as const) {
				await internal('/link-user', {
					orgId,
					staffMemberId: id,
					userId: 'user-1',
				})
			}
			await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })
			const dbB = await getTenantDb(ORG_B)
			const [row] = await dbB
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, b.staff.id))
			expect(row).toMatchObject({ firstName: 'Rana', userId: 'user-1' })
		})

		it('cannot be undone by a rehire, and the login can be linked to a new row', async () => {
			const { staff } = await seedPerson()
			await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })
			const rehire = await h.request('POST', `/${staff.id}/rehire`, {
				body: { reason: 'Back', overrideIneligible: true },
			})
			expect(rehire.status).toBe(409)
			expect(rehire.body.error).toBe('erased')
			const fresh = await createMember({ firstName: 'New' })
			const link = await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: fresh.staff.id,
				userId: 'user-1',
			})
			expect(link.status).toBe(200)
		})

		it('keeps the append-only guard for every other audit edit', async () => {
			await seedPerson()
			await internal('/erase-user', { orgId: ORG_A, userId: 'user-1' })
			const db = await getTenantDb(ORG_A)
			const [entry] = await db.select().from(staffAuditLog).limit(1)
			await expect(
				db
					.update(staffAuditLog)
					.set({ action: 'edited' })
					.where(eq(staffAuditLog.id, entry!.id)),
			).rejects.toThrow()
			await expect(
				db.delete(staffAuditLog).where(eq(staffAuditLog.id, entry!.id)),
			).rejects.toThrow()
		})
	})

	describe('export-user (subject access)', () => {
		it('returns only the data subject’s own record, without secrets', async () => {
			const { staff, assignments } = await createMember()
			const other = await createMember({
				firstName: 'Omar',
				email: 'omar@example.com',
			})
			await internal('/link-user', {
				orgId: ORG_A,
				staffMemberId: staff.id,
				userId: 'user-1',
			})
			await h.request('PUT', `/${staff.id}/private`, {
				body: { dateOfBirth: '1990-04-02' },
			})
			await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)
			const position = await positionId()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position,
					currency: 'USD',
					rateMinor: 1800,
					effectiveFrom: '2026-01-01',
				},
			})

			const reply = await internal('/export-user', {
				orgId: ORG_A,
				userId: 'user-1',
			})
			expect(reply.status).toBe(200)
			const bundle = reply.body.export
			expect(bundle.format).toBe('staff-export/v1')
			expect(bundle.staff).toHaveLength(1)
			expect(bundle.staff[0]).toMatchObject({
				id: staff.id,
				firstName: 'Rana',
				private: { dateOfBirth: '1990-04-02' },
			})
			expect(bundle.staff[0].jobs[0].rateMinor).toBe(1800)
			expect(bundle.staff[0].assignments[0].hasPin).toBe(true)
			expect(reply.raw).not.toContain('pinLookup')
			expect(reply.raw).not.toContain('pin_lookup')
			expect(reply.raw).not.toContain('Omar')
			expect(reply.raw).not.toContain(other.staff.id)
			// Operators' ids and client hashes are not part of the person's copy.
			expect(reply.raw).not.toContain('operator-1')
			expect(reply.raw).not.toContain('ipHash')
			expect(bundle.settings).toBeNull()

			const db = await getTenantDb(ORG_A)
			const audit = (await db.select().from(staffAuditLog)).filter(
				(entry) => entry.action === 'staff.exported',
			)
			expect(audit).toHaveLength(1)
			expect(audit[0]).toMatchObject({
				actorKind: 'system',
				sensitivity: 'private',
			})
		})

		it('answers null when the login has no staff record', async () => {
			const reply = await internal('/export-user', {
				orgId: ORG_A,
				userId: 'user-1',
			})
			expect(reply.status).toBe(200)
			expect(reply.body).toEqual({ export: null })
		})
	})
})

describe('/internal/staff on a Saudi-region node', () => {
	let h: StaffHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A, { dataRegion: 'ksa' }))
		h = await createStaffHarness([ORG_A], 'ksa')
		h.app.route('/internal/staff', staffInternalRoutes)
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	it('refuses to release a person’s record to the control plane', async () => {
		const created = await h.request('POST', '/', {
			body: staffBody(),
		})
		const staffId = created.body.staff.id as string
		const headers = {
			'content-type': 'application/json',
			Authorization: `Bearer ${INTERNAL_TOKEN}`,
		}
		await h.app.request('/internal/staff/link-user', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				orgId: ORG_A,
				staffMemberId: staffId,
				userId: 'user-1',
			}),
		})
		const response = await h.app.request('/internal/staff/export-user', {
			method: 'POST',
			headers,
			body: JSON.stringify({ orgId: ORG_A, userId: 'user-1' }),
		})
		const raw = await response.text()
		expect(response.status).toBe(409)
		expect(JSON.parse(raw).error).toBe('export_requires_regional_delivery')
		expect(raw).not.toContain('Rana')

		// The operator export, reached browser-direct, still works.
		const operator = await h.request('GET', '/export')
		expect(operator.status).toBe(200)
		expect(operator.body.region).toBe('ksa')
		expect(operator.body.staff).toHaveLength(1)
	})

	it('still answers counts and handles unlink and erase in-region', async () => {
		const headers = {
			'content-type': 'application/json',
			Authorization: `Bearer ${INTERNAL_TOKEN}`,
		}
		const summary = await h.app.request('/internal/staff/summary', {
			method: 'POST',
			headers,
			body: JSON.stringify({ orgId: ORG_A }),
		})
		expect(summary.status).toBe(200)
		const erase = await h.app.request('/internal/staff/erase-user', {
			method: 'POST',
			headers,
			body: JSON.stringify({ orgId: ORG_A, userId: 'user-1' }),
		})
		expect(erase.status).toBe(200)
	})
})

describe('Workers org routing for /internal/staff', () => {
	const env = { TENANT_OPERATOR_TOKEN: 'x'.repeat(32) } as never

	it.each(['summary', 'link-user', 'unlink-user', 'erase-user', 'export-user'])(
		'routes %s to the organization named in the body',
		async (path) => {
			const orgId = await resolveOrgId(
				new Request(`https://api.test/internal/staff/${path}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ orgId: ORG_B, userId: 'u1' }),
				}),
				env,
			)
			expect(orgId).toBe(ORG_B)
		},
	)

	it('routes nowhere without a valid org id in the body', async () => {
		for (const body of [{}, { orgId: 'bad id!' }, { orgId: 42 }, null]) {
			const orgId = await resolveOrgId(
				new Request('https://api.test/internal/staff/summary', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env,
			)
			expect(orgId).toBeNull()
		}
	})
})
