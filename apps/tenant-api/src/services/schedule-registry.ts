import { and, asc, eq, gt, lt, lte, ne } from 'drizzle-orm'
import { schedulePublications, shifts, staffMembers } from '@repo/tenant-db'
import { registerShiftMatcher, type ShiftMatcher } from './punch-service.ts'
import { registerShiftLister, type ShiftLister } from './schedule-seam.ts'
import { type StaffDb } from './staff-audit.ts'

/**
 * Plugs the schedule into the two places the time clock asks "what is
 * scheduled": the punch engine (which shift does this punch belong to) and the
 * regional tick (who should have clocked in by now).
 *
 * Only published shifts count, and only for people still on the roster; a
 * draft, an open shift and a pending edit never reach the clock. A scope
 * that has never published a schedule answers "not available" (`undefined`),
 * so turning the time clock on before scheduling does not make every punch
 * "unscheduled".
 */

/** How long before its start a shift is still the one a clock-in belongs to. */
export const SHIFT_MATCH_LEAD_MS = 6 * 60 * 60 * 1000

async function scopeHasSchedule(
	db: StaffDb,
	scopeId?: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: schedulePublications.id })
		.from(schedulePublications)
		.where(scopeId ? eq(schedulePublications.scopeId, scopeId) : undefined)
		.limit(1)
	return Boolean(row)
}

export const matchPublishedShift: ShiftMatcher = async (db, input) => {
	if (!(await scopeHasSchedule(db, input.scopeId))) return undefined
	const [row] = await db
		.select({
			id: shifts.id,
			startsAt: shifts.startsAt,
			endsAt: shifts.endsAt,
			positionId: shifts.positionId,
		})
		.from(shifts)
		.where(
			and(
				eq(shifts.staffId, input.staffId),
				eq(shifts.scopeId, input.scopeId),
				eq(shifts.status, 'published'),
				gt(shifts.endsAt, input.atMs),
				lte(shifts.startsAt, input.atMs + SHIFT_MATCH_LEAD_MS),
			),
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		startAt: row.startsAt,
		endAt: row.endsAt,
		positionId: row.positionId,
	}
}

export const listPublishedShifts: ShiftLister = async (db, query) => {
	if (!(await scopeHasSchedule(db, query.scopeId))) return undefined
	const rows = await db
		.select({
			id: shifts.id,
			staffId: shifts.staffId,
			scopeId: shifts.scopeId,
			startsAt: shifts.startsAt,
			endsAt: shifts.endsAt,
			positionId: shifts.positionId,
		})
		.from(shifts)
		.innerJoin(staffMembers, eq(staffMembers.id, shifts.staffId))
		.where(
			and(
				eq(shifts.status, 'published'),
				ne(staffMembers.status, 'terminated'),
				gt(shifts.startsAt, query.startsFromMs - 1),
				lt(shifts.startsAt, query.startsToMs),
				query.staffId ? eq(shifts.staffId, query.staffId) : undefined,
				query.scopeId ? eq(shifts.scopeId, query.scopeId) : undefined,
			),
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(query.limit ?? 100_000)
	return rows.flatMap((row) =>
		row.staffId
			? [
					{
						id: row.id,
						staffId: row.staffId,
						scopeId: row.scopeId,
						startAt: row.startsAt,
						endAt: row.endsAt,
						positionId: row.positionId,
					},
				]
			: [],
	)
}

let registered = false

/** Idempotent: called when the schedule routes load. */
export function registerSchedule() {
	if (registered) return
	registered = true
	registerShiftMatcher(matchPublishedShift)
	registerShiftLister(listPublishedShifts)
}
