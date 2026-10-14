import { count, eq, inArray } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSION_LIST } from '@repo/staffing'
import { onboardingTasks, staffMembers, timeEntries } from '@repo/tenant-db'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
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
import { scopeToScopes, type StaffAuth } from '../lib/staff-auth.ts'
import { seedStaffingHistory } from './staffing-history-demo.ts'
import { summarizeStaff } from './staff-internal-service.ts'
import { createCard } from './timesheet-write-service.ts'

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

describe('demo history', () => {
	let h: ClockHarness
	let s: ScheduleFixture

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		h = await createClockHarness([ORG_A])
		s = scheduleFixture(h)
		// A Wednesday: the two full weeks before it are Mar 2-8 and Mar 9-15.
		h.setClock(at('2026-03-18', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	async function context() {
		const auth: StaffAuth = {
			orgId: ORG_A,
			userId: 'seed-script',
			scope: 'staff',
			grants: STAFFING_PERMISSION_LIST,
			scopeIds: null,
			impersonated: false,
		}
		return {
			db: await h.db(ORG_A),
			auth,
			scope: scopeToScopes(auth),
			ipHash: null,
			now: h.clock.now,
		}
	}

	it('does nothing without a roster', async () => {
		const result = await seedStaffingHistory(await context(), {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(result).toMatchObject({
			cards: 0,
			approved: 0,
			checklists: 0,
		})
	})

	it('adds closed cards for two weeks, approves the older week and leaves one overtime week', async () => {
		for (let i = 0; i < 10; i++) await s.staff()
		// The time clock seed sets this on the organization default; a scope
		// has to ask for approval before cards can be approved.
		await s.setPolicy(LOC_1, { timesheetApprovalMode: 'approve' })
		const ctx = await context()
		const result = await seedStaffingHistory(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		// Eight people: 5 days a week for two weeks, plus one extra day for the
		// overtime person.
		expect(result.cards).toBe(8 * 5 * 2 + 1)
		// The region switch guard sees the cards it would destroy.
		expect(await summarizeStaff(ctx.db)).toMatchObject({
			timeCards: 8 * 5 * 2 + 1,
			shifts: 0,
		})
		expect(result.approved).toBe(8 * 5)
		expect(result.cardsSkipped).toBe(false)

		const rows = await ctx.db.select().from(timeEntries)
		expect(rows.every((row) => row.clockOutAt !== null)).toBe(true)
		expect(rows.every((row) => row.clockOutAt! < ctx.now)).toBe(true)

		// The overtime person has six long cards in the latest week and every
		// card of that week is still waiting for review.
		const latest = rows.filter(
			(row) => row.clockInAt >= at('2026-03-09', '00:00'),
		)
		const perPerson = new Map<string, number>()
		for (const row of latest) {
			perPerson.set(row.staffId, (perPerson.get(row.staffId) ?? 0) + 1)
		}
		expect([...perPerson.values()].sort()).toEqual([5, 5, 5, 5, 5, 5, 5, 6])
		expect(latest.every((row) => row.status !== 'approved')).toBe(true)
		const older = rows.filter(
			(row) => row.clockInAt < at('2026-03-09', '00:00'),
		)
		expect(older.every((row) => row.status === 'approved')).toBe(true)
	})

	it("still adds the history when the time clock seed already left today's closed shift", async () => {
		for (let i = 0; i < 10; i++) await s.staff()
		await s.setPolicy(LOC_1, { timesheetApprovalMode: 'approve' })
		const ctx = await context()
		const [person] = (await ctx.db.select().from(staffMembers)).slice(-1)
		const today = await createCard(ctx, {
			staffId: person!.id,
			scopeId: LOC_1,
			date: '2026-03-18',
			startTime: '06:00',
			endTime: '10:00',
			breaks: [],
			reason: 'Demo data for the sample workplace',
		})
		expect(today.ok).toBe(true)
		const result = await seedStaffingHistory(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(result.cardsSkipped).toBe(false)
		expect(result.cards).toBeGreaterThan(60)
	})

	it('starts a checklist for three people, one part way through, once', async () => {
		for (let i = 0; i < 10; i++) await s.staff()
		const ctx = await context()
		const first = await seedStaffingHistory(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(first.checklists).toBe(3)
		const done = await ctx.db
			.select({ total: count() })
			.from(onboardingTasks)
			.where(eq(onboardingTasks.status, 'done'))
		expect(done[0]?.total).toBe(2)
		const people = await ctx.db
			.selectDistinct({ staffId: onboardingTasks.staffId })
			.from(onboardingTasks)
		expect(people).toHaveLength(3)

		const again = await seedStaffingHistory(ctx, {
			scopeId: LOC_1,
			timeZone: CHI,
		})
		expect(again).toMatchObject({
			cards: 0,
			cardsSkipped: true,
			checklists: 0,
			checklistsSkipped: true,
		})
		const stillThree = await ctx.db
			.selectDistinct({ staffId: onboardingTasks.staffId })
			.from(onboardingTasks)
			.where(
				inArray(
					onboardingTasks.staffId,
					people.map((row) => row.staffId),
				),
			)
		expect(stillThree).toHaveLength(3)
	})
})
