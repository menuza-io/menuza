import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm'
import {
	needsReview,
	type TimeclockTodayRecent,
	type TimeclockTodayResponse,
	type TimeclockTodayRow,
} from '@repo/staffing'
import {
	staffMembers,
	staffPositions,
	timeEntries,
	type TimeEntry,
} from '@repo/tenant-db'
import { type ScopeAccess } from '../lib/staff-auth.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import { type StaffDb } from './staff-audit.ts'
import { issuesForEntry, loadBreaks } from './time-entry-calc.ts'

/**
 * Today's status for the manager's Time clock page: who is clocked in, on a
 * break, running long or missing a clock-out, and who clocked out recently.
 *
 * It is a read of punches, names and positions only. No wage, rate or private
 * field is selected, so it needs no pay grant, and it is limited to the
 * token's scopes. Issues are recomputed from the times and the scope's
 * policy at read time through the shared time math, so a card here never
 * disagrees with the timesheet.
 */

/** How far back "recently clocked out" looks. */
export const RECENT_WINDOW_MS = 12 * 60 * 60 * 1000
export const MAX_PRESENT_ROWS = 300
export const MAX_RECENT_ROWS = 60

/** Issues that put a person on the "needs attention" list while still clocked in. */
const ATTENTION_ISSUES = ['missing_clock_out', 'long_shift'] as const

export type TodayContext = {
	db: StaffDb
	scope: ScopeAccess
}

export async function loadTimeclockToday(
	ctx: TodayContext,
	options: { scopeId?: string | null } = {},
	now = Date.now(),
): Promise<TimeclockTodayResponse> {
	const scopeFilter = options.scopeId
		? eq(timeEntries.scopeId, options.scopeId)
		: undefined

	const openRows = await ctx.db
		.select({
			entry: timeEntries,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			positionName: staffPositions.name,
			positionNameAr: staffPositions.nameAr,
		})
		.from(timeEntries)
		.innerJoin(staffMembers, eq(staffMembers.id, timeEntries.staffId))
		.leftJoin(staffPositions, eq(staffPositions.id, timeEntries.positionId))
		.where(
			and(
				isNull(timeEntries.clockOutAt),
				isNull(timeEntries.voidedAt),
				ctx.scope.where(timeEntries.scopeId),
				scopeFilter,
			),
		)
		.orderBy(timeEntries.clockInAt)
		.limit(MAX_PRESENT_ROWS)

	const breaks = await loadBreaks(
		ctx.db,
		openRows.map((row) => row.entry.id),
	)
	const policies = new Map<string, Awaited<ReturnType<typeof resolvePolicy>>>()
	async function policyFor(scopeId: string) {
		let policy = policies.get(scopeId)
		if (!policy) {
			policy = await resolvePolicy(ctx.db, scopeId)
			policies.set(scopeId, policy)
		}
		return policy
	}

	const present: TimeclockTodayRow[] = []
	for (const row of openRows) {
		const entryBreaks = breaks.get(row.entry.id) ?? []
		const policy = await policyFor(row.entry.scopeId)
		const issues = issuesForEntry(row.entry, entryBreaks, policy, [], now)
		const openBreak = entryBreaks.find(
			(item) => item.endAt === null && item.voidedAt === null,
		)
		present.push({
			entryId: row.entry.id,
			staffId: row.entry.staffId,
			firstName: row.firstName,
			lastName: row.lastName,
			scopeId: row.entry.scopeId,
			timeZone: row.entry.timeZone,
			positionId: row.entry.positionId,
			positionName: row.positionName ?? null,
			positionNameAr: row.positionNameAr ?? null,
			state: openBreak ? 'on_break' : 'in',
			clockInAt: row.entry.clockInAt,
			breakStartAt: openBreak?.startAt ?? null,
			issues,
			late: issues.includes('late'),
			missingClockOut: ATTENTION_ISSUES.some((code) => issues.includes(code)),
		})
	}

	const recentRows = await ctx.db
		.select({
			entry: timeEntries,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
		})
		.from(timeEntries)
		.innerJoin(staffMembers, eq(staffMembers.id, timeEntries.staffId))
		.where(
			and(
				isNotNull(timeEntries.clockOutAt),
				isNull(timeEntries.voidedAt),
				gte(timeEntries.clockOutAt, now - RECENT_WINDOW_MS),
				ctx.scope.where(timeEntries.scopeId),
				scopeFilter,
			),
		)
		.orderBy(desc(timeEntries.clockOutAt))
		.limit(MAX_RECENT_ROWS)
	const recent: TimeclockTodayRecent[] = recentRows.map((row) =>
		toRecent(row.entry, row.firstName, row.lastName),
	)

	return { serverNow: now, present, recent }
}

function toRecent(
	entry: TimeEntry,
	firstName: string,
	lastName: string,
): TimeclockTodayRecent {
	return {
		entryId: entry.id,
		staffId: entry.staffId,
		firstName,
		lastName,
		scopeId: entry.scopeId,
		timeZone: entry.timeZone,
		clockInAt: entry.clockInAt,
		clockOutAt: entry.clockOutAt!,
		issues: entry.issues,
		needsReview: needsReview(entry.issues),
	}
}
