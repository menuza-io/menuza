import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staffAuditLog, staffHourLimits } from '@repo/tenant-db'
import {
	makeOrg,
	mintStaffToken,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import {
	at,
	createClockHarness,
	LOC_1,
	ORG_A,
	RIYADH,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const codes = (view: any) => view.conflicts.map((c: any) => c.code).sort()

// 2026-06-01 is a Monday outside Ramadan; Ramadan 1447 covered 2026-02-18 to
// 2026-03-19. The KSA week starts on Saturday.
const NORMAL_DAY = '2026-06-02'
const NORMAL_WEEK = '2026-05-30'

describe('hour caps (#527)', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Riyadh Main', timeZone: RIYADH })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-02-20', '12:00', RIYADH))
	})
	afterEach(async () => {
		vi.unstubAllEnvs()
		await h.cleanup()
	})

	async function ksaScope() {
		await s.setPolicy(LOC_1, { rulePack: 'ksa', weekStartsOn: 6 })
	}

	it('a scope on the KSA pack gets 8 and 48 hours, and a 9th hour warns', async () => {
		await ksaScope()
		const { staffId } = await s.staff()
		const morning = await s.shift({
			staffId,
			date: NORMAL_DAY,
			start: '08:00',
			end: '16:00',
		})
		expect(codes(morning)).toEqual([])
		const ninth = await s.shift({
			staffId,
			date: NORMAL_DAY,
			start: '17:00',
			end: '18:00',
		})
		expect(codes(ninth)).toEqual(['daily_hours_cap'])
		expect(ninth.conflicts[0]).toMatchObject({
			code: 'daily_hours_cap',
			detail: { capMinutes: 480, scheduledMinutes: 540 },
		})
		// A warning: the shift was written.
		expect(ninth.id).toBeTruthy()
	})

	it('a KSA node starts every scope on the KSA hour limits without any setup', async () => {
		vi.stubEnv('DATA_REGION', 'ksa')
		orgs.set(ORG_A, { ...makeOrg(ORG_A), dataRegion: 'ksa' })
		const policy = await h.operator('GET', `/policies/${LOC_1}`, {
			orgId: ORG_A,
			grants: [P.READ_STAFF, P.READ_LABOR_POLICY],
		})
		expect(policy.body).toMatchObject({
			source: 'builtin',
			rulePack: 'ksa',
			hourCaps: { dailyMinutes: 480, weeklyMinutes: 2880 },
		})
		const { staffId } = await s.staff()
		await s.shift({ staffId, date: NORMAL_DAY, start: '08:00', end: '16:00' })
		const ninth = await s.shift({
			staffId,
			date: NORMAL_DAY,
			start: '17:00',
			end: '18:00',
		})
		expect(codes(ninth)).toEqual(['daily_hours_cap'])
	})

	it('another node has no caps unless a scope chooses them', async () => {
		vi.stubEnv('DATA_REGION', 'us')
		const { staffId } = await s.staff()
		await s.shift({ staffId, date: NORMAL_DAY, start: '06:00', end: '18:00' })
		const week = await s.get(`/week?scopeId=${LOC_1}&date=${NORMAL_DAY}`)
		expect(week.body.shifts.flatMap(codes)).toEqual([])
	})

	/** The staff route that owns a person's own limits and the private flag. */
	async function staffRequest(
		method: string,
		path: string,
		grants: readonly string[],
		body?: unknown,
	) {
		const token = await mintStaffToken({
			orgId: ORG_A,
			scope: 'staff',
			grants,
			scopeIds: null,
		})
		const response = await h.app.request(`/operator/staff${path}`, {
			method,
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return { status: response.status, body: await response.json() }
	}

	it('applies the 36 hour weekly cap in Ramadan to people with the flag only', async () => {
		await ksaScope()
		const flagged = await s.staff({ firstName: 'Ahmed' })
		const other = await s.staff({ firstName: 'Omar' })
		const marked = await staffRequest(
			'PUT',
			`/${flagged.staffId}/hour-limits`,
			[P.READ_STAFF, P.UPDATE_STAFF, P.UPDATE_STAFF_PRIVATE],
			{ followsRamadan: true },
		)
		expect(marked.status).toBe(200)
		const days = [
			'2026-02-28',
			'2026-03-01',
			'2026-03-02',
			'2026-03-03',
			'2026-03-04',
			'2026-03-05',
		]
		for (const staffId of [flagged.staffId, other.staffId]) {
			for (const date of days) {
				await s.shift({ staffId, date, start: '09:00', end: '15:00' })
			}
		}
		// 36 hours each: exactly at the cap, no warning for anyone.
		let week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`)
		expect(week.body.shifts.flatMap(codes)).toEqual([])
		// One more hour tips the flagged person (cap 36) but not the other (cap 48).
		for (const staffId of [flagged.staffId, other.staffId]) {
			await s.shift({
				staffId,
				date: '2026-03-06',
				start: '09:00',
				end: '10:00',
			})
		}
		week = await s.get(`/week?scopeId=${LOC_1}&date=2026-03-02`)
		const byStaff = new Map<string, string[]>()
		for (const shift of week.body.shifts) {
			byStaff.set(shift.staffId, [
				...(byStaff.get(shift.staffId) ?? []),
				...codes(shift),
			])
		}
		expect(byStaff.get(flagged.staffId)).toEqual(['weekly_hours_cap'])
		expect(byStaff.get(other.staffId)).toEqual([])
		const warning = week.body.shifts
			.flatMap((shift: any) => shift.conflicts)
			.find((c: any) => c.code === 'weekly_hours_cap')
		expect(warning.detail).toEqual({ capMinutes: 2160, scheduledMinutes: 2220 })
		// The week view never says who follows the Ramadan limit.
		expect(JSON.stringify(week.body)).not.toMatch(/ramadan/i)
	})

	it('keeps the Ramadan flag private to managers who may see private details', async () => {
		const { staffId } = await s.staff()
		// Without the private grant, the flag cannot be changed ...
		const refused = await staffRequest(
			'PUT',
			`/${staffId}/hour-limits`,
			[P.READ_STAFF, P.UPDATE_STAFF],
			{ followsRamadan: true },
		)
		expect(refused.status).toBe(403)
		// ... but a person's own caps can.
		const caps = await staffRequest(
			'PUT',
			`/${staffId}/hour-limits`,
			[P.READ_STAFF, P.UPDATE_STAFF],
			{ dailyMinutes: 360, weeklyMinutes: 1800 },
		)
		expect(caps.status).toBe(200)
		expect(caps.body.limits).toEqual({ dailyMinutes: 360, weeklyMinutes: 1800 })
		// Someone with the private grant sets and reads it.
		const set = await staffRequest(
			'PUT',
			`/${staffId}/hour-limits`,
			[
				P.READ_STAFF,
				P.UPDATE_STAFF,
				P.UPDATE_STAFF_PRIVATE,
				P.READ_STAFF_PRIVATE,
			],
			{ followsRamadan: true },
		)
		expect(set.body.limits.followsRamadan).toBe(true)
		const plain = await staffRequest('GET', `/${staffId}/hour-limits`, [
			P.READ_STAFF,
		])
		expect(plain.body.limits).toEqual({
			dailyMinutes: 360,
			weeklyMinutes: 1800,
		})
		const priv = await staffRequest('GET', `/${staffId}/hour-limits`, [
			P.READ_STAFF,
			P.READ_STAFF_PRIVATE,
		])
		expect(priv.body.limits.followsRamadan).toBe(true)
		// A person's own cap replaces the scope's: 7 hours is over a 6 hour cap.
		await ksaScope()
		const over = await s.shift({
			staffId,
			date: NORMAL_DAY,
			start: '09:00',
			end: '16:00',
		})
		expect(over.conflicts[0]).toMatchObject({
			code: 'daily_hours_cap',
			detail: { capMinutes: 360, scheduledMinutes: 420 },
		})
		// The audit row for the Ramadan flag is private.
		const db = await h.db(ORG_A)
		const rows = await db
			.select()
			.from(staffAuditLog)
			.where(eq(staffAuditLog.action, 'staff.hour_limits.updated'))
		expect(rows.some((row) => row.sensitivity === 'private')).toBe(true)
		const stored = await db
			.select()
			.from(staffHourLimits)
			.where(eq(staffHourLimits.staffId, staffId))
		expect(stored[0]).toMatchObject({
			followsRamadan: true,
			dailyCapMinutes: 360,
		})
	})

	describe('publishing', () => {
		async function overCapWeek() {
			await ksaScope()
			const { staffId } = await s.staff()
			await s.shift({
				staffId,
				date: NORMAL_DAY,
				start: '08:00',
				end: '16:00',
			})
			await s.shift({
				staffId,
				date: NORMAL_DAY,
				start: '17:00',
				end: '18:00',
			})
			return staffId
		}
		const publish = (body: Record<string, unknown>) =>
			s.send('POST', '/publish', {
				scopeId: LOC_1,
				weekStart: NORMAL_WEEK,
				notifyMode: 'nobody',
				...body,
			})

		it('lists every breach and publishes nothing without a reason', async () => {
			const staffId = await overCapWeek()
			const refused = await publish({})
			expect(refused.status).toBe(409)
			expect(refused.body.error).toBe('hour_caps_exceeded')
			expect(refused.body.total).toBe(1)
			expect(refused.body.breaches).toEqual([
				expect.objectContaining({
					staffId,
					kind: 'daily',
					date: NORMAL_DAY,
					capMinutes: 480,
					scheduledMinutes: 540,
				}),
			])
			const week = await s.get(`/week?scopeId=${LOC_1}&date=${NORMAL_DAY}`)
			expect(week.body.shifts.map((shift: any) => shift.state)).toEqual([
				'draft',
				'draft',
			])
		})

		it('publishes with a reason, and audits the reason and the count', async () => {
			await overCapWeek()
			const published = await publish({ capReason: 'Covering a sick call' })
			expect(published.status).toBe(200)
			const db = await h.db(ORG_A)
			const [entry] = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'schedule.week.published'))
			expect(entry!.changes).toMatchObject({
				capBreaches: 1,
				capReason: 'Covering a sick call',
			})
		})

		it('refuses a blank reason, and a week with no breach needs none', async () => {
			await overCapWeek()
			expect((await publish({ capReason: '   ' })).status).toBe(400)
			const clean = await s.staff()
			void clean
		})

		it('a week under the caps publishes as before', async () => {
			await ksaScope()
			const { staffId } = await s.staff()
			await s.shift({ staffId, date: NORMAL_DAY, start: '08:00', end: '16:00' })
			expect((await publish({})).status).toBe(200)
		})
	})
})
