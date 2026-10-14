import { and, asc, eq } from 'drizzle-orm'
import { addDays, localDateOf, weekDates } from '@repo/staffing'
import { shifts, staffScopeAssignments, staffMembers } from '@repo/tenant-db'
import { copyWeek } from './schedule-plan-service.ts'
import { publishWeek } from './schedule-publish-service.ts'
import { FrameCache, loadPeople, snapWeekStart } from './schedule-shared.ts'
import {
	createShifts,
	updateShift,
	type ScheduleWriteContext,
} from './schedule-shift-service.ts'
import {
	createAvailability,
	createTimeOff,
} from './schedule-timeoff-service.ts'

/**
 * Demo schedule for local development (`npm run seed:schedule`). It goes
 * through the same service functions as the API, so every row passes the
 * production validation and writes its audit record. The seed refuses to add
 * anything to a scope that already has shifts.
 *
 * It leaves the current week published, with one pending edit on it, and the
 * next week copied as drafts, so every state the grid shows is on screen.
 */

export type DemoScheduleResult =
	| { seeded: false; reason: 'no_staff' | 'shifts_exist' | 'no_time_zone' }
	| {
			seeded: true
			weekStart: string
			nextWeekStart: string
			people: number
			shifts: number
	  }

const PATTERNS: Array<{ start: string; end: string }> = [
	{ start: '09:00', end: '17:00' },
	{ start: '11:00', end: '19:00' },
	{ start: '16:00', end: '23:00' },
]

export async function seedDemoSchedule(
	ctx: ScheduleWriteContext,
	input: { scopeId: string; timeZone: string },
): Promise<DemoScheduleResult> {
	const [existing] = await ctx.db
		.select({ id: shifts.id })
		.from(shifts)
		.where(eq(shifts.scopeId, input.scopeId))
		.limit(1)
	if (existing) return { seeded: false, reason: 'shifts_exist' }

	const roster = await ctx.db
		.select({ id: staffMembers.id })
		.from(staffMembers)
		.innerJoin(
			staffScopeAssignments,
			eq(staffScopeAssignments.staffId, staffMembers.id),
		)
		.where(
			and(
				eq(staffScopeAssignments.scopeId, input.scopeId),
				eq(staffScopeAssignments.active, true),
				eq(staffMembers.status, 'active'),
			),
		)
		.orderBy(asc(staffMembers.lastName), asc(staffMembers.firstName))
		.limit(12)
	if (roster.length === 0) return { seeded: false, reason: 'no_staff' }

	const frame = await new FrameCache(ctx).get(input.scopeId, input.timeZone)
	if (!frame) return { seeded: false, reason: 'no_time_zone' }
	const weekStart = snapWeekStart(localDateOf(ctx.now, frame.timeZone), frame)
	const dates = weekDates(weekStart)
	const people = await loadPeople(
		ctx.db,
		roster.map((r) => r.id),
	)

	let created = 0
	for (const [index, { id }] of roster.entries()) {
		const pattern = PATTERNS[index % PATTERNS.length]!
		const job = people
			.get(id)
			?.jobs.find((j) => j.job.scopeId === input.scopeId)
		// Everyone works five days; the days off rotate through the week.
		const days = dates.filter(
			(_, day) => day !== index % 7 && day !== (index + 3) % 7,
		)
		const result = await createShifts(ctx, {
			scopeId: input.scopeId,
			staffId: id,
			positionId: job?.position.id ?? null,
			dates: days,
			startTime: pattern.start,
			endTime: pattern.end,
			unpaidBreakMinutes: 30,
			notes: null,
		})
		if (result.ok) created += result.value.shifts.length
	}
	// Two shifts nobody holds yet.
	for (const date of [dates[4]!, dates[5]!]) {
		const result = await createShifts(ctx, {
			scopeId: input.scopeId,
			staffId: null,
			positionId: null,
			dates: [date],
			startTime: '17:00',
			endTime: '23:00',
			unpaidBreakMinutes: 0,
			notes: null,
		})
		if (result.ok) created += result.value.shifts.length
	}

	// Time off, a waiting request and availability, around the first people.
	const [first, second, third] = roster
	if (first) {
		await createTimeOff(ctx, {
			staffId: first.id,
			category: 'pto',
			startDate: addDays(weekStart, 8),
			endDate: addDays(weekStart, 9),
			allDay: true,
			submission: 'manager_entered',
		})
	}
	if (second) {
		await createTimeOff(ctx, {
			staffId: second.id,
			category: 'unpaid',
			startDate: addDays(weekStart, 10),
			endDate: addDays(weekStart, 10),
			allDay: true,
			submission: 'staff_request',
		})
	}
	if (third) {
		await createAvailability(ctx, {
			staffId: third.id,
			replaceWeekly: false,
			submission: 'manager_entered',
			rows: [
				{
					kind: 'weekly',
					weekday: 0,
					availability: 'unavailable',
					allDay: true,
				},
			],
		})
	}

	await publishWeek(ctx, {
		scopeId: input.scopeId,
		weekStart,
		notifyMode: 'nobody',
	})

	// One pending edit on a published shift, so "changed" shows on the grid.
	const [edited] = await ctx.db
		.select({ id: shifts.id })
		.from(shifts)
		.where(
			and(eq(shifts.scopeId, input.scopeId), eq(shifts.status, 'published')),
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(1)
	if (edited) await updateShift(ctx, edited.id, { notes: 'Bring the new rota' })

	const nextWeekStart = addDays(weekStart, 7)
	const copied = await copyWeek(ctx, {
		scopeId: input.scopeId,
		fromWeekStart: weekStart,
		toWeekStart: nextWeekStart,
		scope: { mode: 'all' },
		includeOpenShifts: true,
	})
	if (copied.ok) created += copied.value.created

	return {
		seeded: true,
		weekStart,
		nextWeekStart,
		people: roster.length,
		shifts: created,
	}
}
