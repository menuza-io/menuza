import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import {
	addDays,
	BUILTIN_LABOR_POLICY,
	localParts,
	weekStartFor,
} from '@repo/staffing'
import { onboardingTasks, staffJobs, timeEntries } from '@repo/tenant-db'
import { applyChecklist, updateTask } from './onboarding-service.ts'
import { listStaff, type StaffContext } from './staff-service.ts'
import { createCard, runBatch } from './timesheet-write-service.ts'

/**
 * Demo history for local development and the e2e seed: closed time cards for
 * the last two full weeks (the older week approved, the latest left for review,
 * one person on an overtime week) and a new-hire checklist for three people.
 * Goes through the same services as the API. Used only by the seed script;
 * production code never imports this file.
 */

export type StaffingHistoryResult = {
	cards: number
	cardsSkipped: boolean
	approved: number
	checklists: number
	checklistsSkipped: boolean
}

/** Six long days (10 hours on the clock) for the overtime person. */
const OVERTIME_DAYS = 6
const OVERTIME_INDEX = 2

function dateOf(ms: number, timeZone: string): string {
	const parts = localParts(ms, timeZone)
	return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export async function seedStaffingHistory(
	ctx: StaffContext & { now: number },
	input: { scopeId: string; timeZone: string },
): Promise<StaffingHistoryResult> {
	const result: StaffingHistoryResult = {
		cards: 0,
		cardsSkipped: false,
		approved: 0,
		checklists: 0,
		checklistsSkipped: false,
	}
	const roster = await listStaff(ctx, {
		limit: 50,
		offset: 0,
		status: undefined,
	})
	if (roster.total === 0) return result

	// 1. Closed time cards for the last two full weeks. Today's punches from the
	// time clock seed do not count: only a card from before yesterday means the
	// history was already added.
	const [closed] = await ctx.db
		.select({ id: timeEntries.id })
		.from(timeEntries)
		.where(
			and(
				isNotNull(timeEntries.clockOutAt),
				lt(timeEntries.clockInAt, ctx.now - 36 * 60 * 60 * 1000),
			),
		)
		.limit(1)
	if (closed) {
		result.cardsSkipped = true
	} else {
		const thisWeek = weekStartFor(
			dateOf(ctx.now, input.timeZone),
			BUILTIN_LABOR_POLICY.weekStartsOn,
		)
		const weeks = [addDays(thisWeek, -14), addDays(thisWeek, -7)] as const
		const crew = roster.staff.slice(0, 8)
		// A person with more than one role at the scope must say which one a
		// card is for; the demo uses the main role.
		const jobs = await ctx.db
			.select({
				staffId: staffJobs.staffId,
				positionId: staffJobs.positionId,
				isPrimary: staffJobs.isPrimary,
			})
			.from(staffJobs)
			.where(
				and(
					eq(staffJobs.scopeId, input.scopeId),
					isNull(staffJobs.effectiveTo),
				),
			)
		const mainPosition = new Map<string, string>()
		for (const job of jobs) {
			if (job.isPrimary || !mainPosition.has(job.staffId)) {
				mainPosition.set(job.staffId, job.positionId)
			}
		}
		const older: string[] = []
		for (const [weekIndex, weekStart] of weeks.entries()) {
			for (const [index, person] of crew.entries()) {
				const overtime = weekIndex === 1 && index === OVERTIME_INDEX
				const days = overtime ? OVERTIME_DAYS : 5
				// Everyone works 8 paid hours a day (8.5 on the clock, less an unpaid
				// 30-minute meal): 40 hours in five days, so no overtime. The overtime
				// week is six 10-hour days, 57 paid hours.
				const morning = index % 2 === 0
				const start = morning ? '09:00' : '16:00'
				const end = overtime
					? morning
						? '19:00'
						: '02:00'
					: morning
						? '17:30'
						: '00:30'
				for (let day = 0; day < days; day += 1) {
					const created = await createCard(ctx, {
						staffId: person.id,
						scopeId: input.scopeId,
						...(mainPosition.has(person.id)
							? { positionId: mainPosition.get(person.id)! }
							: {}),
						date: addDays(weekStart, (day + index) % 7),
						startTime: start,
						endTime: end,
						breaks: [
							{
								kind: 'meal',
								startTime: morning ? '13:00' : '20:00',
								endTime: morning ? '13:30' : '20:30',
							},
						],
						reason: 'Demo data for the sample workplace',
					})
					if (created.ok) {
						result.cards += 1
						if (weekIndex === 0) older.push(created.value.entryId)
					}
				}
			}
		}
		// The older week is signed off; the latest stays for review.
		if (older.length > 0) {
			const rows = await ctx.db
				.select({ id: timeEntries.id, version: timeEntries.version })
				.from(timeEntries)
			const versions = new Map(rows.map((row) => [row.id, row.version]))
			const approved = await runBatch(
				ctx,
				'approve',
				older.flatMap((id) => {
					const version = versions.get(id)
					return version === undefined ? [] : [{ id, version }]
				}),
				'Reviewed',
			)
			if (approved.ok) result.approved = approved.value.changed
		}
	}

	// 2. A new-hire checklist for the three newest hires.
	const [existingTask] = await ctx.db
		.select({ id: onboardingTasks.id })
		.from(onboardingTasks)
		.limit(1)
	if (existingTask) {
		result.checklistsSkipped = true
	} else {
		for (const [index, person] of roster.staff.slice(-3).entries()) {
			const applied = await applyChecklist(ctx, person.id, {})
			if (!applied.ok) continue
			result.checklists += 1
			// One person is already part way through.
			if (index === 0) {
				for (const task of applied.value.tasks.slice(0, 2)) {
					await updateTask(ctx, person.id, task.id, { status: 'done' })
				}
			}
		}
	}
	return result
}
