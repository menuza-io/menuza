import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	notificationOutbox,
	schedulePublications,
	scheduleWeeks,
	shiftRequests,
	shifts,
	staffAuditLog,
	staffMembers,
} from '@repo/tenant-db'
import {
	at,
	CHI,
	createClockHarness,
	LOC_1,
	ORG_A,
	scheduleFixture,
	type ClockHarness,
	type ScheduleFixture,
} from '../../tests/schedule-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	resetStaffTickTasks,
	resetTickLocks,
	runStaffTickForOrg,
	type TickDeps,
} from '../services/staff-tick-service.ts'

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

const WEEK = '2026-03-02'

type Sent = { to: string; subject: string; html: string; text: string }

describe('approving a swap, cover or drop applies it (#528)', () => {
	let h: ClockHarness
	let s: ScheduleFixture
	const sent: Sent[] = []
	let deps: Partial<TickDeps>

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		sent.length = 0
		resetTickLocks()
		resetStaffTickTasks()
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		h.setClock(at('2026-03-02', '12:00'))
		vi.stubEnv('STAFFING_EMAIL_ENABLED', '')
		deps = {
			now: () => h.clock.now,
			getFeatures: async () => ({
				features: {
					enabled: true,
					timeclock: true,
					scheduling: true,
					hiring: false,
				},
				dataRegion: 'us',
			}),
			getScope: async (_org, scope) => facts.get(scope) ?? null,
			listShifts: async () => [],
			sendEmail: async (input) => {
				sent.push(input)
				return { status: 'success' }
			},
			notifyManagers: async () => ({
				status: 'delivered',
				result: { inApp: 1, emailed: 0 },
			}),
			emailEnabled: () => true,
		}
	})
	afterEach(async () => {
		vi.unstubAllEnvs()
		await h.cleanup()
	})

	async function person(first: string, email: string) {
		const made = await s.staff({ firstName: first })
		await (
			await h.db(ORG_A)
		)
			.update(staffMembers)
			.set({ email })
			.where(eq(staffMembers.id, made.staffId))
		return made
	}

	async function published() {
		const ana = await person('Ana', 'ana@example.com')
		const ben = await person('Ben', 'ben@example.com')
		const anaShift = await s.shift({
			staffId: ana.staffId,
			date: '2026-03-03',
			start: '09:00',
			end: '13:00',
		})
		const benShift = await s.shift({
			staffId: ben.staffId,
			date: '2026-03-04',
			start: '14:00',
			end: '18:00',
		})
		expect(
			(await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })).status,
		).toBe(200)
		return { ana, ben, anaShift, benShift }
	}

	async function request(body: Record<string, unknown>) {
		const created = await s.send('POST', '/requests', body)
		expect(created.status).toBe(201)
		return created.body.request.id as string
	}

	const decide = (id: string, body: Record<string, unknown> = {}) =>
		s.send('POST', `/requests/${id}/decision`, { decision: 'approve', ...body })

	it('approving a swap moves both shifts and emails both people', async () => {
		const { ana, ben, anaShift, benShift } = await published()
		const id = await request({
			kind: 'swap',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
			targetShiftId: benShift.id,
		})
		const decided = await decide(id)
		expect(decided.status).toBe(200)

		// The live shifts changed hands: nothing is left to publish by hand.
		const db = await h.db(ORG_A)
		const rows = await db.select().from(shifts)
		const byId = new Map(rows.map((row) => [row.id, row]))
		expect(byId.get(anaShift.id)).toMatchObject({
			staffId: ben.staffId,
			draftPatch: null,
		})
		expect(byId.get(benShift.id)).toMatchObject({
			staffId: ana.staffId,
			draftPatch: null,
		})
		const [week] = await db.select().from(scheduleWeeks)
		expect(week!.version).toBe(2)

		// One publication records it (ids only) and the request points at it.
		const publications = await db.select().from(schedulePublications)
		const swap = publications.find((p) => p.version === 2)!
		expect(swap.summary).toMatchObject({ changed: 2, swaps: 1 })
		const [row] = await db
			.select()
			.from(shiftRequests)
			.where(eq(shiftRequests.id, id))
		expect(row).toMatchObject({
			status: 'approved',
			appliedPublicationId: swap.id,
		})

		// Both people are emailed, and only about their own shifts.
		const queued = (await db.select().from(notificationOutbox)).filter(
			(entry) => entry.kind === 'schedule_published',
		)
		expect(queued.map((entry) => entry.staffId).sort()).toEqual(
			[ana.staffId, ben.staffId].sort(),
		)
		await runStaffTickForOrg(ORG_A, { db, deps })
		expect(sent.map((mail) => mail.to).sort()).toEqual([
			'ana@example.com',
			'ben@example.com',
		])
		const toAna = sent.find((mail) => mail.to === 'ana@example.com')!
		const toBen = sent.find((mail) => mail.to === 'ben@example.com')!
		// Ana now has Ben's 2:00-6:00 PM shift; Ben has Ana's 9:00 AM-1:00 PM one.
		expect(toAna.text).toMatch(/2:00\sPM - 6:00\sPM/)
		expect(toBen.text).toMatch(/9:00\sAM - 1:00\sPM/)

		// Audited as a swap approval, with ids and counts.
		const audit = await db
			.select()
			.from(staffAuditLog)
			.where(eq(staffAuditLog.action, 'schedule.swap.approved'))
		expect(audit).toHaveLength(1)
		expect(audit[0]!.changes).toMatchObject({
			publicationId: swap.id,
			shifts: 2,
		})
	})

	it('a cover tells the person who gave the shift up and the one who took it', async () => {
		const { ana, ben, anaShift } = await published()
		const id = await request({
			kind: 'cover',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
		})
		expect((await decide(id)).status).toBe(200)
		const db = await h.db(ORG_A)
		await runStaffTickForOrg(ORG_A, { db, deps })
		expect(sent.map((mail) => mail.to).sort()).toEqual([
			'ana@example.com',
			'ben@example.com',
		])
	})

	it('a drop leaves the shift open and tells the person', async () => {
		const { ana, anaShift } = await published()
		const id = await request({
			kind: 'drop',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
		})
		expect((await decide(id)).status).toBe(200)
		const [row] = await (
			await h.db(ORG_A)
		)
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(row!.staffId).toBeNull()
		await runStaffTickForOrg(ORG_A, { db: await h.db(ORG_A), deps })
		expect(sent.map((mail) => mail.to)).toEqual(['ana@example.com'])
	})

	it('asks the manager to review instead when the shift changed since the request', async () => {
		const { ana, ben, anaShift } = await published()
		const id = await request({
			kind: 'cover',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
		})
		h.setClock(at('2026-03-02', '12:05'))
		await s.send('PATCH', `/shifts/${anaShift.id}`, {
			startTime: '17:00',
			endTime: '21:00',
		})
		const stale = await decide(id)
		expect(stale.status).toBe(409)
		expect(stale.body.error).toBe('request_stale')
		// Nothing was applied and nobody was told.
		const db = await h.db(ORG_A)
		const [row] = await db
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(row!.staffId).toBe(ana.staffId)
		expect(
			(await db.select().from(notificationOutbox)).filter(
				(entry) => entry.kind === 'schedule_published',
			),
		).toEqual([])
		const [request_] = await db
			.select()
			.from(shiftRequests)
			.where(eq(shiftRequests.id, id))
		expect(request_!.status).toBe('pending')
	})

	it('keeps an unrelated pending edit to the same shift pending', async () => {
		const { ana, ben, anaShift } = await published()
		const id = await request({
			kind: 'cover',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
		})
		h.setClock(at('2026-03-02', '12:05'))
		await s.send('PATCH', `/shifts/${anaShift.id}`, { notes: 'Bring the keys' })
		expect((await decide(id)).status).toBe(200)
		const [row] = await (
			await h.db(ORG_A)
		)
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(row!.staffId).toBe(ben.staffId)
		// The note is still a draft: only the person changed hands.
		expect(row!.draftPatch).toEqual({ notes: 'Bring the keys' })
		expect(row!.notes).not.toBe('Bring the keys')
	})

	it('re-checks hour caps: over a cap it needs a reason, and audits it', async () => {
		await s.setPolicy(LOC_1, {
			hourCaps: {
				dailyMinutes: 480,
				weeklyMinutes: null,
				ramadanDailyMinutes: null,
				ramadanWeeklyMinutes: null,
			},
		})
		const ana = await person('Ana', 'ana@example.com')
		const ben = await person('Ben', 'ben@example.com')
		await s.shift({
			staffId: ben.staffId,
			date: '2026-03-03',
			start: '06:00',
			end: '12:00',
		})
		const anaShift = await s.shift({
			staffId: ana.staffId,
			date: '2026-03-03',
			start: '13:00',
			end: '17:00',
		})
		await s.publish(LOC_1, WEEK, { notifyMode: 'nobody' })
		const id = await request({
			kind: 'cover',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
		})
		// Ben would work 10 hours that day.
		const refused = await decide(id)
		expect(refused.status).toBe(409)
		expect(refused.body.error).toBe('hour_caps_exceeded')
		expect(refused.body.breaches[0]).toMatchObject({
			staffId: ben.staffId,
			kind: 'daily',
			capMinutes: 480,
			scheduledMinutes: 600,
		})
		const db = await h.db(ORG_A)
		const [still] = await db
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(still!.staffId).toBe(ana.staffId)

		expect((await decide(id, { capReason: 'Short staffed' })).status).toBe(200)
		const [moved] = await db
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(moved!.staffId).toBe(ben.staffId)
		const audit = await db
			.select()
			.from(staffAuditLog)
			.where(eq(staffAuditLog.action, 'schedule.cover.approved'))
		expect(audit[0]!.changes).toMatchObject({
			capBreaches: 1,
			capReason: 'Short staffed',
		})
	})

	it('a rejection changes nothing and tells nobody', async () => {
		const { ana, ben, anaShift } = await published()
		const id = await request({
			kind: 'cover',
			shiftId: anaShift.id,
			requesterStaffId: ana.staffId,
			targetStaffId: ben.staffId,
		})
		const rejected = await s.send('POST', `/requests/${id}/decision`, {
			decision: 'reject',
		})
		expect(rejected.status).toBe(200)
		const db = await h.db(ORG_A)
		expect(
			(await db.select().from(notificationOutbox)).filter(
				(entry) => entry.kind === 'schedule_published',
			),
		).toEqual([])
		const [row] = await db
			.select()
			.from(shifts)
			.where(eq(shifts.id, anaShift.id))
		expect(row!.staffId).toBe(ana.staffId)
	})
})
