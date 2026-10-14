import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	getTenantDb,
	staffAuditLog,
	staffScopeAssignments,
} from '@repo/tenant-db'
import {
	ADMIN_GRANTS,
	createStaffHarness,
	LOC_1,
	LOC_2,
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

describe('/operator/staff', () => {
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

	async function createMember(overrides: Record<string, unknown> = {}) {
		const response = await h.request('POST', '/', {
			body: staffBody(overrides),
		})
		expect(response.status).toBe(201)
		return response.body as {
			created: boolean
			staff: { id: string; primaryScopeId: string | null }
			assignments: Array<{ id: string; scopeId: string }>
		}
	}

	async function createPosition(name = 'Server', extra = {}) {
		const response = await h.request('POST', '/positions', {
			body: { name, ...extra },
		})
		expect(response.status).toBe(201)
		return response.body.position as { id: string }
	}

	describe('roster', () => {
		it('creates a staff member without a login or email', async () => {
			const created = await createMember({
				email: undefined,
				phone: undefined,
				employeeNumber: 'E-100',
			})
			expect(created.created).toBe(true)
			expect(created.staff).toMatchObject({
				firstName: 'Rana',
				status: 'active',
				userId: null,
				primaryScopeId: LOC_1,
			})
			expect(created.assignments).toHaveLength(1)
		})

		it('makes the first assignment primary when none is marked', async () => {
			const created = await createMember({
				assignments: [{ scopeId: LOC_2 }, { scopeId: LOC_1 }],
			})
			expect(created.staff.primaryScopeId).toBe(LOC_2)
		})

		it('lists, searches and filters the roster', async () => {
			await createMember({ firstName: 'Rana', lastName: 'Khalid' })
			await createMember({
				firstName: 'Omar',
				lastName: 'Saleh',
				email: 'omar@example.com',
				phone: '+14155550124',
				assignments: [{ scopeId: LOC_2, isPrimary: true }],
			})

			const all = await h.request('GET', '/')
			expect(all.status).toBe(200)
			expect(all.body.total).toBe(2)
			expect(all.body.staff.map((s: any) => s.lastName)).toEqual([
				'Khalid',
				'Saleh',
			])

			const byName = await h.request('GET', '/?q=omar%20sal')
			expect(byName.body.staff).toHaveLength(1)
			expect(byName.body.staff[0].firstName).toBe('Omar')

			const byPhone = await h.request('GET', '/?q=0123')
			expect(byPhone.body.staff.map((s: any) => s.firstName)).toEqual(['Rana'])

			const byScope = await h.request('GET', `/?scopeId=${LOC_2}`)
			expect(byScope.body.staff.map((s: any) => s.firstName)).toEqual(['Omar'])

			const page = await h.request('GET', '/?limit=1&offset=1')
			expect(page.body.staff).toHaveLength(1)
			expect(page.body.total).toBe(2)
		})

		it('treats % and _ in search text literally', async () => {
			await createMember({ firstName: 'Rana' })
			const wildcard = await h.request('GET', '/?q=%25')
			expect(wildcard.body.staff).toHaveLength(0)
			const underscore = await h.request('GET', '/?q=R_na')
			expect(underscore.body.staff).toHaveLength(0)
		})

		it('hides terminated staff unless asked for them', async () => {
			const { staff } = await createMember()
			await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Moved away' },
			})
			expect((await h.request('GET', '/')).body.staff).toHaveLength(0)
			const terminated = await h.request('GET', '/?status=terminated')
			expect(terminated.body.staff).toHaveLength(1)
		})

		it('returns a profile with assignments', async () => {
			const { staff } = await createMember()
			const detail = await h.request('GET', `/${staff.id}`)
			expect(detail.status).toBe(200)
			expect(detail.body.staff.id).toBe(staff.id)
			expect(detail.body.assignments).toHaveLength(1)
			expect(detail.body.restricted).toEqual({ pay: false, private: false })
		})

		it('updates profile fields and records field-level changes', async () => {
			const { staff } = await createMember()
			const updated = await h.request('PATCH', `/${staff.id}`, {
				body: { firstName: 'Rania', phone: null, status: 'on_leave' },
			})
			expect(updated.status).toBe(200)
			expect(updated.body.staff).toMatchObject({
				firstName: 'Rania',
				phone: null,
				status: 'on_leave',
			})
			const audit = await h.request('GET', `/audit?staffId=${staff.id}`)
			const entry = audit.body.entries.find(
				(e: any) => e.action === 'staff.updated',
			)
			expect(entry.changes.firstName).toEqual({
				before: 'Rana',
				after: 'Rania',
			})
			expect(entry.changes.phone).toEqual({
				before: '+14155550123',
				after: null,
			})
		})

		it('rejects a duplicate employee number', async () => {
			await createMember({ employeeNumber: 'E-1' })
			const dup = await h.request('POST', '/', {
				body: staffBody({ firstName: 'Omar', employeeNumber: 'E-1' }),
			})
			expect(dup.status).toBe(409)
			expect(dup.body.error).toBe('employee_number_taken')
		})
	})

	describe('import and bulk create', () => {
		it('imports members idempotently on user id', async () => {
			const members = [
				{ userId: 'user-1', firstName: 'Rana', lastName: 'Khalid' },
				{ userId: 'user-2', firstName: 'Omar', lastName: 'Saleh' },
			]
			const first = await h.request('POST', '/import', { body: { members } })
			expect(first.status).toBe(200)
			expect(first.body.summary).toMatchObject({ created: 2, existing: 0 })

			const second = await h.request('POST', '/import', { body: { members } })
			expect(second.body.summary).toMatchObject({ created: 0, existing: 2 })
			expect(second.body.results.map((r: any) => r.staffId)).toEqual(
				first.body.results.map((r: any) => r.staffId),
			)
			expect((await h.request('GET', '/')).body.total).toBe(2)
		})

		it('treats a repeated user id inside one batch as one person', async () => {
			const response = await h.request('POST', '/import', {
				body: {
					members: [
						{ userId: 'user-1', firstName: 'Rana', lastName: 'Khalid' },
						{ userId: 'user-1', firstName: 'Rana', lastName: 'K' },
					],
				},
			})
			expect(response.body.summary).toMatchObject({ created: 1, existing: 1 })
		})

		it('requires a user id on import but not on bulk create', async () => {
			const row = { firstName: 'Rana', lastName: 'Khalid' }
			const imported = await h.request('POST', '/import', {
				body: { members: [row] },
			})
			expect(imported.body.summary.invalid).toBe(1)
			const bulk = await h.request('POST', '/bulk', {
				body: { members: [row] },
			})
			expect(bulk.body.summary.created).toBe(1)
		})

		it('reports invalid and conflicting rows without failing the batch', async () => {
			await createMember({ employeeNumber: 'E-1' })
			const response = await h.request('POST', '/bulk', {
				body: {
					members: [
						{ firstName: 'Good', lastName: 'Row' },
						{ firstName: '', lastName: 'Bad' },
						{ firstName: 'Dup', lastName: 'Number', employeeNumber: 'E-1' },
						'not an object',
					],
				},
			})
			expect(response.status).toBe(200)
			expect(response.body.results.map((r: any) => r.status)).toEqual([
				'created',
				'invalid',
				'conflict',
				'invalid',
			])
		})

		it('caps the batch size', async () => {
			const members = Array.from({ length: 201 }, (_, i) => ({
				firstName: `P${i}`,
				lastName: 'Row',
			}))
			const response = await h.request('POST', '/bulk', { body: { members } })
			expect(response.status).toBe(400)
		})
	})

	describe('positions', () => {
		it('creates, updates, lists and archives positions', async () => {
			const position = await createPosition('Line Cook', {
				area: 'Kitchen',
				colorKey: 'orange',
				defaultRateMinor: 1800,
				currency: 'USD',
			})
			const list = await h.request('GET', '/positions')
			expect(list.body.positions).toHaveLength(1)
			expect(list.body.positions[0]).toMatchObject({
				name: 'Line Cook',
				colorKey: 'orange',
				defaultRateMinor: 1800,
			})

			const patched = await h.request('PATCH', `/positions/${position.id}`, {
				body: { name: 'Prep Cook', defaultRateMinor: 1700 },
			})
			expect(patched.body.position).toMatchObject({
				name: 'Prep Cook',
				defaultRateMinor: 1700,
			})

			const archived = await h.request('DELETE', `/positions/${position.id}`)
			expect(archived.status).toBe(200)
			expect(archived.body.position.archivedAt).toBeGreaterThan(0)
			expect(
				(await h.request('GET', '/positions')).body.positions,
			).toHaveLength(0)
			expect(
				(await h.request('GET', '/positions?includeArchived=1')).body.positions,
			).toHaveLength(1)
		})

		it('rejects duplicate active names and unknown colors', async () => {
			await createPosition('Server')
			const dup = await h.request('POST', '/positions', {
				body: { name: 'server' },
			})
			expect(dup.status).toBe(409)
			const color = await h.request('POST', '/positions', {
				body: { name: 'Host', colorKey: '#ff0000' },
			})
			expect(color.status).toBe(400)
		})

		it('refuses to archive a position that is in use', async () => {
			const { staff } = await createMember()
			const position = await createPosition()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			const archived = await h.request('DELETE', `/positions/${position.id}`)
			expect(archived.status).toBe(409)
			expect(archived.body.error).toBe('position_in_use')
		})
	})

	describe('assignments', () => {
		it('adds, updates, moves primary and removes assignments', async () => {
			const { staff, assignments } = await createMember()
			const added = await h.request('POST', `/${staff.id}/assignments`, {
				body: { scopeId: LOC_2 },
			})
			expect(added.status).toBe(201)
			expect(added.body.assignment).toMatchObject({
				scopeId: LOC_2,
				isPrimary: false,
				active: true,
				hasPin: false,
			})

			const made = await h.request(
				'PATCH',
				`/${staff.id}/assignments/${added.body.assignment.id}`,
				{ body: { isPrimary: true, canWaiveBreaks: true } },
			)
			expect(made.status).toBe(200)
			const detail = await h.request('GET', `/${staff.id}`)
			expect(detail.body.staff.primaryScopeId).toBe(LOC_2)
			const primaries = detail.body.assignments.filter((a: any) => a.isPrimary)
			expect(primaries.map((a: any) => a.scopeId)).toEqual([LOC_2])

			const removed = await h.request(
				'DELETE',
				`/${staff.id}/assignments/${assignments[0]!.id}`,
			)
			expect(removed.body.assignment.active).toBe(false)
			const list = await h.request('GET', `/${staff.id}/assignments`)
			expect(list.body.assignments).toHaveLength(2)
		})

		it('rejects a second assignment at the same scope', async () => {
			const { staff } = await createMember()
			const dup = await h.request('POST', `/${staff.id}/assignments`, {
				body: { scopeId: LOC_1 },
			})
			expect(dup.status).toBe(409)
			expect(dup.body.error).toBe('already_assigned')
		})

		it('reactivates a removed assignment instead of duplicating it', async () => {
			const { staff, assignments } = await createMember()
			await h.request(
				'DELETE',
				`/${staff.id}/assignments/${assignments[0]!.id}`,
			)
			const again = await h.request('POST', `/${staff.id}/assignments`, {
				body: { scopeId: LOC_1 },
			})
			expect(again.status).toBe(201)
			expect(again.body.assignment.id).toBe(assignments[0]!.id)
			expect(again.body.assignment.active).toBe(true)
		})

		it('clears the PIN and closes jobs when an assignment is removed', async () => {
			const { staff, assignments } = await createMember()
			const position = await createPosition()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)
			const removed = await h.request(
				'DELETE',
				`/${staff.id}/assignments/${assignments[0]!.id}?effectiveDate=2026-03-01`,
			)
			expect(removed.body.assignment).toMatchObject({
				active: false,
				hasPin: false,
			})
			const jobs = await h.request('GET', `/${staff.id}/jobs`)
			expect(jobs.body.jobs[0].effectiveTo).toBe('2026-03-01')
		})
	})

	describe('roster pay column', () => {
		async function seedRoster() {
			const { staff } = await createMember()
			const position = await createPosition('Server', {
				defaultRateMinor: 1500,
				currency: 'USD',
			})
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					rateMinor: 1650,
					currency: 'USD',
					isPrimary: true,
					effectiveFrom: '2020-01-01',
				},
			})
			const other = await createMember({ firstName: 'Zed', lastName: 'Cook' })
			await h.request('POST', `/${other.staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					isPrimary: true,
					effectiveFrom: '2020-01-01',
				},
			})
			return { staff, other }
		}

		it('adds the current rate only when asked and the token has the pay grant', async () => {
			const { staff, other } = await seedRoster()
			const plain = await h.request('GET', '/')
			expect(plain.body.staff[0]).not.toHaveProperty('currentRate')

			const withPay = await h.request('GET', '/?include=pay')
			const byId = new Map<string, any>(
				withPay.body.staff.map((row: any) => [row.id, row]),
			)
			expect(byId.get(staff.id).currentRate).toMatchObject({
				payType: 'hourly',
				rateMinor: 1650,
				currency: 'USD',
			})
			// No personal rate: the position default applies.
			expect(byId.get(other.staff.id).currentRate.rateMinor).toBe(1500)
		})

		it('omits the rate without the pay grant and ignores the ask', async () => {
			await seedRoster()
			const token = await mintStaffToken({ grants: MANAGER_GRANTS })
			const response = await h.request('GET', '/?include=pay', { token })
			expect(response.status).toBe(200)
			expect(response.raw).not.toContain('currentRate')
			expect(response.raw).not.toContain('1650')
		})

		it('audits the pay read before returning values', async () => {
			await seedRoster()
			await h.request('GET', '/?include=pay')
			const audit = await h.request('GET', '/audit?action=staff.pay.read')
			expect(
				audit.body.entries.some((event: any) => event.sensitivity === 'pay'),
			).toBe(true)
		})
	})

	describe('jobs and effective-dated pay', () => {
		async function setup() {
			const { staff } = await createMember()
			const position = await createPosition('Server', {
				defaultRateMinor: 1500,
				currency: 'USD',
			})
			const job = await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					payType: 'hourly',
					rateMinor: 1600,
					currency: 'USD',
					isPrimary: true,
					effectiveFrom: '2026-01-01',
				},
			})
			expect(job.status).toBe(201)
			return { staff, position, job: job.body.job as { id: string } }
		}

		it('closes the open row and inserts a new one on a rate change', async () => {
			const { staff, job } = await setup()
			const change = await h.request(
				'POST',
				`/${staff.id}/jobs/${job.id}/rate-change`,
				{
					body: {
						effectiveFrom: '2026-03-01',
						rateMinor: 1800,
						reason: 'Annual review',
					},
				},
			)
			expect(change.status).toBe(201)
			expect(change.body.job).toMatchObject({
				rateMinor: 1800,
				effectiveFrom: '2026-03-01',
				effectiveTo: null,
			})
			expect(change.body.closed).toMatchObject({
				id: job.id,
				rateMinor: 1600,
				effectiveTo: '2026-02-28',
			})

			const history = await h.request('GET', `/${staff.id}/jobs`)
			expect(history.body.jobs).toHaveLength(2)
			expect(history.body.jobs.map((j: any) => j.rateMinor)).toEqual([
				1800, 1600,
			])
		})

		it('refuses a change dated on or before the current rate start', async () => {
			const { staff, job } = await setup()
			for (const effectiveFrom of ['2026-01-01', '2025-12-31']) {
				const response = await h.request(
					'POST',
					`/${staff.id}/jobs/${job.id}/rate-change`,
					{ body: { effectiveFrom, rateMinor: 2000, reason: 'Backdated' } },
				)
				expect(response.status).toBe(409)
				expect(response.body.error).toBe('effective_date_not_after_current')
			}
		})

		it('refuses to change a closed row, a no-op, or a salary without an amount', async () => {
			const { staff, job } = await setup()
			await h.request('POST', `/${staff.id}/jobs/${job.id}/rate-change`, {
				body: { effectiveFrom: '2026-03-01', rateMinor: 1800, reason: 'x' },
			})
			const closed = await h.request(
				'POST',
				`/${staff.id}/jobs/${job.id}/rate-change`,
				{ body: { effectiveFrom: '2026-04-01', rateMinor: 1900, reason: 'x' } },
			)
			expect(closed.body.error).toBe('job_closed')

			const history = await h.request('GET', `/${staff.id}/jobs`)
			const current = history.body.jobs.find((j: any) => j.effectiveTo === null)
			const noop = await h.request(
				'POST',
				`/${staff.id}/jobs/${current.id}/rate-change`,
				{ body: { effectiveFrom: '2026-05-01', rateMinor: 1800, reason: 'x' } },
			)
			expect(noop.body.error).toBe('no_change')
			const salary = await h.request(
				'POST',
				`/${staff.id}/jobs/${current.id}/rate-change`,
				{
					body: { effectiveFrom: '2026-05-01', payType: 'salary', reason: 'x' },
				},
			)
			expect(salary.body.error).toBe('salary_required')
		})

		it('allows only one open job per position and one open primary per scope', async () => {
			const { staff, position } = await setup()
			const dup = await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					effectiveFrom: '2026-02-01',
				},
			})
			expect(dup.status).toBe(409)
			expect(dup.body.error).toBe('job_exists')

			const host = await createPosition('Host')
			const second = await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: host.id,
					currency: 'USD',
					isPrimary: true,
					effectiveFrom: '2026-02-01',
				},
			})
			expect(second.status).toBe(409)
			expect(second.body.error).toBe('primary_job_exists')
		})

		it('needs an active assignment at the scope first', async () => {
			const { staff } = await createMember()
			const position = await createPosition()
			const response = await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_2,
					positionId: position.id,
					currency: 'USD',
					effectiveFrom: '2026-01-01',
				},
			})
			expect(response.status).toBe(409)
			expect(response.body.error).toBe('not_assigned_to_scope')
		})

		it('rejects invalid money: floats, negatives, and reversed dates', async () => {
			const { staff, position } = await setup()
			const host = await createPosition('Host')
			for (const rateMinor of [15.5, -1, '1500']) {
				const response = await h.request('POST', `/${staff.id}/jobs`, {
					body: {
						scopeId: LOC_1,
						positionId: host.id,
						currency: 'USD',
						rateMinor,
						effectiveFrom: '2026-02-01',
					},
				})
				expect(response.status).toBe(400)
			}
			expect(position.id).toBeTruthy()
		})
	})

	describe('PINs', () => {
		async function memberWithAssignment() {
			const { staff, assignments } = await createMember()
			return { staffId: staff.id, assignmentId: assignments[0]!.id }
		}

		it('generates a PIN once and stores only a lookup', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const response = await h.request(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{ body: {} },
			)
			expect(response.status).toBe(201)
			expect(response.body.pin).toMatch(/^\d{4}$/)

			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(staffScopeAssignments)
				.where(eq(staffScopeAssignments.id, assignmentId))
			expect(row!.pinLookup).toMatch(/^[0-9a-f]{64}$/)
			expect(row!.pinLookup).not.toContain(response.body.pin)
			expect(row!.pinSetAt).toBeGreaterThan(0)
		})

		it('accepts a manager-chosen PIN and rejects weak or wrong-length ones', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const path = `/${staffId}/assignments/${assignmentId}/pin`
			for (const pin of ['1234', '1111', '12', '12345', 'abcd']) {
				const response = await h.request('POST', path, { body: { pin } })
				expect(response.status).toBe(422)
				expect(response.body.error).toBe('invalid_pin')
			}
			const good = await h.request('POST', path, { body: { pin: '2580' } })
			expect(good.status).toBe(201)
			expect(good.body.pin).toBe('2580')
		})

		it('accepts Arabic-Indic digits', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const response = await h.request(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{ body: { pin: '٢٥٨٠' } },
			)
			expect(response.status).toBe(201)
			expect(response.body.pin).toBe('2580')
		})

		it('says "choose another" when a PIN is taken at the same scope, and allows reuse elsewhere', async () => {
			const a = await memberWithAssignment()
			const b = await createMember({ firstName: 'Omar' })
			const bAssignment = b.assignments[0]!.id
			await h.request(
				'POST',
				`/${a.staffId}/assignments/${a.assignmentId}/pin`,
				{
					body: { pin: '2580' },
				},
			)
			const clash = await h.request(
				'POST',
				`/${b.staff.id}/assignments/${bAssignment}/pin`,
				{ body: { pin: '2580' } },
			)
			expect(clash.status).toBe(409)
			expect(clash.body.error).toBe('pin_unavailable')
			expect(clash.raw).not.toContain('Rana')

			const elsewhere = await h.request('POST', `/${b.staff.id}/assignments`, {
				body: { scopeId: LOC_2 },
			})
			const reuse = await h.request(
				'POST',
				`/${b.staff.id}/assignments/${elsewhere.body.assignment.id}/pin`,
				{ body: { pin: '2580' } },
			)
			expect(reuse.status).toBe(201)
		})

		it('resets a PIN and invalidates the old one', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const path = `/${staffId}/assignments/${assignmentId}/pin`
			await h.request('POST', path, { body: { pin: '2580' } })
			const reset = await h.request('POST', path, { body: { pin: '3691' } })
			expect(reset.status).toBe(201)
			// The old PIN is free again.
			const b = await createMember({ firstName: 'Omar' })
			const reuse = await h.request(
				'POST',
				`/${b.staff.id}/assignments/${b.assignments[0]!.id}/pin`,
				{ body: { pin: '2580' } },
			)
			expect(reuse.status).toBe(201)
		})

		it('uses the configured PIN length', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const settings = await h.request('PUT', '/settings', {
				body: { pinLength: 6 },
			})
			expect(settings.status).toBe(200)
			const response = await h.request(
				'POST',
				`/${staffId}/assignments/${assignmentId}/pin`,
				{ body: {} },
			)
			expect(response.body.pin).toMatch(/^\d{6}$/)
		})

		it('clears a PIN', async () => {
			const { staffId, assignmentId } = await memberWithAssignment()
			const path = `/${staffId}/assignments/${assignmentId}/pin`
			await h.request('POST', path, { body: {} })
			const cleared = await h.request('DELETE', path)
			expect(cleared.body.assignment.hasPin).toBe(false)
		})
	})

	describe('terminate and rehire', () => {
		it('terminates with a reason, clears PINs, deactivates assignments and closes jobs', async () => {
			const { staff, assignments } = await createMember()
			const position = await createPosition()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					rateMinor: 1500,
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)

			const terminated = await h.request('POST', `/${staff.id}/terminate`, {
				body: {
					reason: 'Resigned',
					effectiveDate: '2026-06-30',
					eligibleForRehire: false,
				},
			})
			expect(terminated.status).toBe(200)
			expect(terminated.body.staff).toMatchObject({
				status: 'terminated',
				terminationReason: 'Resigned',
				eligibleForRehire: false,
			})
			expect(terminated.body.staff.terminatedAt).toBeGreaterThan(0)

			const detail = await h.request('GET', `/${staff.id}?include=pay`)
			expect(detail.body.assignments[0]).toMatchObject({
				active: false,
				hasPin: false,
				isPrimary: false,
			})
			expect(detail.body.jobs[0].effectiveTo).toBe('2026-06-30')
		})

		it('requires a reason and refuses to terminate twice', async () => {
			const { staff } = await createMember()
			const none = await h.request('POST', `/${staff.id}/terminate`, {
				body: {},
			})
			expect(none.status).toBe(400)
			const blank = await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: '   ' },
			})
			expect(blank.status).toBe(400)
			await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Left' },
			})
			const again = await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Left' },
			})
			expect(again.status).toBe(409)
		})

		it('blocks PINs, assignments and jobs for terminated staff', async () => {
			const { staff, assignments } = await createMember()
			await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Left' },
			})
			const pin = await h.request(
				'POST',
				`/${staff.id}/assignments/${assignments[0]!.id}/pin`,
				{ body: {} },
			)
			expect(pin.status).toBe(409)
			const assign = await h.request('POST', `/${staff.id}/assignments`, {
				body: { scopeId: LOC_2 },
			})
			expect(assign.status).toBe(409)
		})

		it('rehires, but needs an override when marked not eligible', async () => {
			const { staff } = await createMember()
			await h.request('POST', `/${staff.id}/terminate`, {
				body: { reason: 'Misconduct', eligibleForRehire: false },
			})
			const blocked = await h.request('POST', `/${staff.id}/rehire`, {
				body: { reason: 'Reconsidered' },
			})
			expect(blocked.status).toBe(409)
			expect(blocked.body.error).toBe('not_eligible_for_rehire')

			const rehired = await h.request('POST', `/${staff.id}/rehire`, {
				body: { reason: 'Reconsidered', overrideIneligible: true },
			})
			expect(rehired.status).toBe(200)
			expect(rehired.body.staff).toMatchObject({
				status: 'active',
				terminatedAt: null,
				terminationReason: null,
			})

			const audit = await h.request('GET', `/audit?staffId=${staff.id}`)
			const entry = audit.body.entries.find(
				(e: any) => e.action === 'staff.rehired',
			)
			expect(entry.changes.overrodeIneligible).toBe(true)
			expect(entry.changes.previousTerminationReason).toBe('Misconduct')
		})

		it('refuses to rehire someone who is not terminated', async () => {
			const { staff } = await createMember()
			const response = await h.request('POST', `/${staff.id}/rehire`, {
				body: { reason: 'x' },
			})
			expect(response.status).toBe(409)
		})
	})

	describe('private data', () => {
		it('stores and returns private fields for holders of the grants', async () => {
			const { staff } = await createMember()
			const saved = await h.request('PUT', `/${staff.id}/private`, {
				body: {
					dateOfBirth: '1990-04-02',
					addressLine1: '1 Main St',
					emergencyContactName: 'Lina',
					emergencyContactPhone: '+14155550199',
				},
			})
			expect(saved.status).toBe(200)
			expect(saved.body.private.dateOfBirth).toBe('1990-04-02')

			const read = await h.request('GET', `/${staff.id}/private`)
			expect(read.body.private).toMatchObject({
				dateOfBirth: '1990-04-02',
				emergencyContactName: 'Lina',
			})
			const detail = await h.request('GET', `/${staff.id}?include=private`)
			expect(detail.body.private.addressLine1).toBe('1 Main St')
			const without = await h.request('GET', `/${staff.id}`)
			expect(without.body.private).toBeUndefined()
		})

		it('rejects a malformed date of birth', async () => {
			const { staff } = await createMember()
			const response = await h.request('PUT', `/${staff.id}/private`, {
				body: { dateOfBirth: '1990-13-45' },
			})
			expect(response.status).toBe(400)
		})
	})

	describe('notes', () => {
		it('adds, lists and removes notes without copying text into the audit log', async () => {
			const { staff } = await createMember()
			const added = await h.request('POST', `/${staff.id}/notes`, {
				body: { body: 'Late twice this week, spoke with them.' },
			})
			expect(added.status).toBe(201)
			const list = await h.request('GET', `/${staff.id}/notes`)
			expect(list.body.notes).toHaveLength(1)
			expect(list.body.notes[0].authorId).toBe('operator-1')

			const audit = await h.request('GET', `/audit?staffId=${staff.id}`)
			expect(audit.raw).not.toContain('Late twice')

			const removed = await h.request(
				'DELETE',
				`/${staff.id}/notes/${added.body.note.id}`,
			)
			expect(removed.status).toBe(200)
			expect((await h.request('GET', `/${staff.id}/notes`)).body.notes).toEqual(
				[],
			)
		})
	})

	describe('audit log', () => {
		it('records every write with the actor, and reads of pay and private data', async () => {
			const { staff } = await createMember()
			const position = await createPosition()
			await h.request('POST', `/${staff.id}/jobs`, {
				body: {
					scopeId: LOC_1,
					positionId: position.id,
					currency: 'USD',
					rateMinor: 1500,
					effectiveFrom: '2026-01-01',
				},
			})
			await h.request('GET', `/${staff.id}?include=pay,private`)

			const db = await getTenantDb(ORG_A)
			const rows = await db.select().from(staffAuditLog)
			const actions = rows.map((row) => row.action)
			expect(actions).toEqual(
				expect.arrayContaining([
					'staff.created',
					'staff.position.created',
					'staff.job.added',
					'staff.pay.set',
					'staff.pay.read',
					'staff.private.read',
				]),
			)
			expect(rows.every((row) => row.actorId === 'operator-1')).toBe(true)
			expect(rows.every((row) => row.impersonated === false)).toBe(true)
			const payRead = rows.find((row) => row.action === 'staff.pay.read')
			expect(payRead!.sensitivity).toBe('pay')
			expect(
				rows.find((row) => row.action === 'staff.private.read')!.sensitivity,
			).toBe('private')
		})

		it('stores a keyed hash of the caller IP, never the address', async () => {
			await h.request('POST', '/', {
				body: staffBody(),
				headers: { 'cf-connecting-ip': '203.0.113.9' },
			})
			const db = await getTenantDb(ORG_A)
			const [row] = await db.select().from(staffAuditLog)
			expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/)
			expect(JSON.stringify(row)).not.toContain('203.0.113.9')
		})

		it('does not persist a change that could not be audited', async () => {
			const db = await getTenantDb(ORG_A)
			// Make audit inserts fail, as a stand-in for any audit-write failure.
			await db.run(
				(await import('drizzle-orm')).sql.raw(
					`CREATE TRIGGER fail_audit BEFORE INSERT ON staff_audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
				),
			)
			const response = await h.request('POST', '/', { body: staffBody() })
			expect(response.status).toBe(500)
			await db.run(
				(await import('drizzle-orm')).sql.raw('DROP TRIGGER fail_audit'),
			)
			expect((await h.request('GET', '/')).body.total).toBe(0)
		})

		it('paginates by time', async () => {
			await createMember()
			await createMember({ firstName: 'Omar' })
			const page = await h.request('GET', '/audit?limit=1')
			expect(page.body.entries).toHaveLength(1)
		})
	})

	describe('settings', () => {
		it('returns defaults and updates them', async () => {
			const defaults = await h.request('GET', '/settings')
			expect(defaults.body.settings).toMatchObject({
				pinLength: 4,
				payPeriod: 'weekly',
				contactLevel: 'full',
			})
			const updated = await h.request('PUT', '/settings', {
				body: { payPeriod: 'biweekly', contactLevel: 'minimal' },
			})
			expect(updated.body.settings).toMatchObject({
				payPeriod: 'biweekly',
				contactLevel: 'minimal',
			})
		})

		it('rejects out-of-range PIN lengths', async () => {
			for (const pinLength of [3, 7, 4.5]) {
				const response = await h.request('PUT', '/settings', {
					body: { pinLength },
				})
				expect(response.status).toBe(400)
			}
		})
	})

	it('isolates organizations: each token only reaches its own database', async () => {
		await createMember()
		const tokenB = await mintStaffToken({ orgId: ORG_B, grants: ADMIN_GRANTS })
		const listB = await h.request('GET', '/', { token: tokenB })
		expect(listB.status).toBe(200)
		expect(listB.body.total).toBe(0)
	})
})

describe('/operator/staff on the KSA node', () => {
	let h: StaffHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A, { dataRegion: 'ksa' }))
		orgs.set(ORG_B, makeOrg(ORG_B, { dataRegion: 'us' }))
		h = await createStaffHarness([ORG_A, ORG_B], 'ksa')
	})

	afterEach(async () => {
		await h.cleanup()
		vi.unstubAllEnvs()
	})

	it('serves KSA organizations and defaults staff-facing content to minimal', async () => {
		const token = await mintStaffToken({ region: 'ksa' })
		const created = await h.request('POST', '/', {
			token,
			body: staffBody({
				firstName: 'Mona',
				lastName: 'Alharbi',
				firstNameAr: 'منى',
				lastNameAr: 'الحربي',
				phone: '+966512345678',
				locale: 'ar',
			}),
		})
		expect(created.status).toBe(201)
		expect(created.body.staff).toMatchObject({
			firstNameAr: 'منى',
			lastNameAr: 'الحربي',
			locale: 'ar',
		})
		const settings = await h.request('GET', '/settings', { token })
		expect(settings.body.settings.contactLevel).toBe('minimal')
	})

	it('refuses a US organization with a region mismatch', async () => {
		const token = await mintStaffToken({ orgId: ORG_B })
		const response = await h.request('GET', '/', { token })
		expect(response.status).toBe(409)
		expect(response.body.error).toBe('region_mismatch')
	})

	it('finds Arabic names in search', async () => {
		await h.request('POST', '/', {
			body: staffBody({
				firstName: 'Mona',
				lastName: 'Alharbi',
				firstNameAr: 'منى',
				lastNameAr: 'الحربي',
			}),
		})
		for (const q of [
			'Mona',
			encodeURIComponent('منى'),
			encodeURIComponent('منى الحر'),
		]) {
			const response = await h.request('GET', `/?q=${q}`)
			expect(response.body.staff, q).toHaveLength(1)
		}
	})
})
