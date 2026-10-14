import { type StaffDb } from './staff-audit.ts'

/**
 * Where the regional tick learns what is scheduled. Scheduling is a later
 * slice, so there is no shift table yet; the tasks that need one (the "has not
 * clocked in" alert and the pre-shift reminder) are written against this seam
 * and stay inert until scheduling registers a real lister at start-up. The
 * punch engine has the same seam for matching one punch to a shift
 * (`registerShiftMatcher` in `punch-service.ts`).
 *
 * `undefined` from a lister means "the schedule is not available", and the tick
 * reports that instead of guessing; an empty array means it is available and
 * nothing is scheduled.
 */

export type ScheduledShift = {
	id: string
	staffId: string
	scopeId: string
	startAt: number
	endAt: number
	positionId: string | null
}

export type ShiftListQuery = {
	/** Shifts starting at or after this instant... */
	startsFromMs: number
	/** ...and before this one. */
	startsToMs: number
	/** Only this person's shifts. */
	staffId?: string
	/** Only this scope's shifts. */
	scopeId?: string
	/** At most this many (soonest first). */
	limit?: number
}

/**
 * Lists shifts that are assigned to a person and published (a draft, an
 * unassigned open shift and a shift for a terminated person are never listed).
 */
export type ShiftLister = (
	db: StaffDb,
	query: ShiftListQuery,
) => Promise<ScheduledShift[] | undefined>

export const noScheduleLister: ShiftLister = async () => undefined

export const scheduleSeam: { listShifts: ShiftLister } = {
	listShifts: noScheduleLister,
}

/** Scheduling calls this once at start-up. */
export function registerShiftLister(lister: ShiftLister) {
	scheduleSeam.listShifts = lister
}

export function resetShiftLister() {
	scheduleSeam.listShifts = noScheduleLister
}
