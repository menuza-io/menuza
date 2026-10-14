import { type LaborRules } from './rules.ts'
import {
	SCHEDULE_CONFLICT_CODES,
	type ScheduleConflict,
	type ScheduleConflictCode,
} from './schedule-api.ts'
import {
	type EstimateShift,
	overtimeMinutesByShift,
} from './schedule-estimate.ts'
import { type DaySegment, segmentByLocalDay } from './schedule-time.ts'
import { dayOfWeek } from './tz.ts'

/**
 * Conflict detection for scheduled shifts. Pure: callers load a person's
 * shifts, approved time off and availability and ask what is wrong.
 *
 * Conflicts are WARNINGS. Nothing here refuses a write: a manager may
 * knowingly double-book, schedule into time off, or run someone into overtime.
 * The codes are stable (see `SCHEDULE_CONFLICT_CODES`) and the detail carries
 * numbers only, never names or money.
 */

const MS_PER_MINUTE = 60_000

export type ConflictShift = EstimateShift & {
	positionId: string | null
	/** Local date of the start. */
	localDate: string
	timeZone: string
}

export type TimeOffWindow = {
	id: string
	startDate: string
	endDate: string
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
}

export type AvailabilityWindow = {
	id: string
	kind: 'weekly' | 'one_off'
	weekday: number | null
	date: string | null
	availability: 'available' | 'unavailable'
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
	effectiveFrom: string | null
	effectiveTo: string | null
}

export type PersonJob = {
	scopeId: string
	positionId: string
	effectiveFrom: string
	effectiveTo: string | null
}

export type PersonConflictContext = {
	status: string
	/** Scopes where the person has an active assignment. */
	assignedScopeIds: ReadonlySet<string>
	jobs: readonly PersonJob[]
	/** Approved time off only. */
	timeOff: readonly TimeOffWindow[]
	/** Approved availability only. */
	availability: readonly AvailabilityWindow[]
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function windowBounds(window: {
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
}): [number, number] {
	return window.allDay ||
		window.startMinute === null ||
		window.endMinute === null
		? [0, 1440]
		: [window.startMinute, window.endMinute]
}

/** The rows that apply to a date: its one-off rows, else the weekday's pattern. */
export function availabilityFor(
	date: string,
	windows: readonly AvailabilityWindow[],
): AvailabilityWindow[] {
	const oneOff = windows.filter((w) => w.kind === 'one_off' && w.date === date)
	if (oneOff.length > 0) return oneOff
	const weekday = dayOfWeek(date)
	return windows.filter(
		(w) =>
			w.kind === 'weekly' &&
			w.weekday === weekday &&
			(w.effectiveFrom === null || w.effectiveFrom <= date) &&
			(w.effectiveTo === null || w.effectiveTo >= date),
	)
}

/**
 * Whether one day's piece of a shift breaks the person's availability, and the
 * id of a row that says so. A person with "available" windows that day can work
 * only inside their union; "unavailable" windows are always off limits.
 */
export function availabilityViolation(
	segment: DaySegment,
	windows: readonly AvailabilityWindow[],
): { windowId: string } | null {
	const applicable = availabilityFor(segment.date, windows)
	if (applicable.length === 0) return null

	for (const window of applicable) {
		if (window.availability !== 'unavailable') continue
		const [from, to] = windowBounds(window)
		if (segment.startMinute < to && from < segment.endMinute) {
			return { windowId: window.id }
		}
	}

	const available = applicable.filter((w) => w.availability === 'available')
	if (available.length === 0) return null
	// The piece must lie inside the union of the available windows.
	const spans = available
		.map((w) => windowBounds(w))
		.sort((a, b) => a[0] - b[0] || a[1] - b[1])
	let covered = segment.startMinute
	for (const [from, to] of spans) {
		if (from > covered) break
		covered = Math.max(covered, to)
		if (covered >= segment.endMinute) return null
	}
	return { windowId: available[0]!.id }
}

function timeOffHit(
	segment: DaySegment,
	windows: readonly TimeOffWindow[],
): TimeOffWindow | null {
	for (const window of windows) {
		if (segment.date < window.startDate || segment.date > window.endDate) {
			continue
		}
		if (window.allDay) return window
		const [from, to] = windowBounds(window)
		if (segment.startMinute < to && from < segment.endMinute) return window
	}
	return null
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const CODE_ORDER = new Map<ScheduleConflictCode, number>(
	SCHEDULE_CONFLICT_CODES.map((code, index) => [code, index]),
)

function byShiftOrder(a: ConflictShift, b: ConflictShift): number {
	return a.startsAt - b.startsAt || a.id.localeCompare(b.id)
}

function jobMatches(
	job: PersonJob,
	shift: Pick<ConflictShift, 'scopeId' | 'positionId' | 'localDate'>,
): boolean {
	return (
		job.scopeId === shift.scopeId &&
		job.positionId === shift.positionId &&
		job.effectiveFrom <= shift.localDate &&
		(job.effectiveTo === null || job.effectiveTo >= shift.localDate)
	)
}

export type DetectInput = {
	/**
	 * Every shift of the person that counts (their effective, non-cancelled
	 * shifts at all scopes around the days being checked). Only shifts in
	 * `only` are reported on, but the others take part in overlap, rest and
	 * overtime.
	 */
	shifts: readonly ConflictShift[]
	person: PersonConflictContext
	rules: LaborRules
	/** Zero switches the minimum rest check off. */
	minRestMinutes: number
	/** Report only on these shift ids; default every shift. */
	only?: ReadonlySet<string>
	/** Checks to leave out, for callers that only need the cheap ones. */
	skip?: ReadonlySet<ScheduleConflictCode>
}

export function detectPersonConflicts(input: DetectInput): ScheduleConflict[] {
	const { person, rules, minRestMinutes } = input
	const sorted = [...input.shifts].sort(byShiftOrder)
	const wanted = (id: string) => !input.only || input.only.has(id)
	const check = (code: ScheduleConflictCode) => !input.skip?.has(code)
	const order = new Map(sorted.map((shift, index) => [shift.id, index]))
	const out: ScheduleConflict[] = []

	// Overtime is computed once for the whole set.
	let overtime: Map<string, number> | null = null
	const getOvertime = () => {
		if (!overtime) {
			const zone = sorted[0]?.timeZone ?? 'UTC'
			overtime = overtimeMinutesByShift(sorted, rules, zone)
		}
		return overtime
	}

	for (const [index, shift] of sorted.entries()) {
		if (!wanted(shift.id)) continue

		// Overlap with any other shift of the person, at any scope.
		for (const other of check('overlap') ? sorted : []) {
			if (other.id === shift.id) continue
			if (other.startsAt < shift.endsAt && shift.startsAt < other.endsAt) {
				out.push({
					code: 'overlap',
					shiftId: shift.id,
					relatedId: other.id,
					date: shift.localDate,
				})
			}
		}

		if (person.status === 'on_leave' && check('staff_on_leave')) {
			out.push({
				code: 'staff_on_leave',
				shiftId: shift.id,
				date: shift.localDate,
			})
		}

		const atScope = person.assignedScopeIds.has(shift.scopeId)
		if (!atScope) {
			if (check('not_at_scope')) {
				out.push({
					code: 'not_at_scope',
					shiftId: shift.id,
					date: shift.localDate,
				})
			}
		} else if (
			check('position_mismatch') &&
			shift.positionId !== null &&
			!person.jobs.some((job) => jobMatches(job, shift))
		) {
			out.push({
				code: 'position_mismatch',
				shiftId: shift.id,
				date: shift.localDate,
			})
		}

		// Time off and availability, piece by piece across midnight.
		const segments = segmentByLocalDay(
			shift.startsAt,
			shift.endsAt,
			shift.timeZone,
		)
		const seenTimeOff = new Set<string>()
		let unavailableReported = false
		for (const segment of segments) {
			const off = check('time_off') ? timeOffHit(segment, person.timeOff) : null
			if (off && !seenTimeOff.has(off.id)) {
				seenTimeOff.add(off.id)
				out.push({
					code: 'time_off',
					shiftId: shift.id,
					relatedId: off.id,
					date: segment.date,
				})
			}
			if (!unavailableReported && check('unavailable')) {
				const violation = availabilityViolation(segment, person.availability)
				if (violation) {
					unavailableReported = true
					out.push({
						code: 'unavailable',
						shiftId: shift.id,
						relatedId: violation.windowId,
						date: segment.date,
					})
				}
			}
		}

		// Minimum rest since the previous shift that ended before this one
		// started. Shifts on the same local date are a split shift, not a short
		// night, and are left alone.
		if (minRestMinutes > 0 && check('min_rest')) {
			let previous: ConflictShift | null = null
			for (const other of sorted.slice(0, index)) {
				if (other.endsAt <= shift.startsAt) {
					if (!previous || other.endsAt > previous.endsAt) previous = other
				}
			}
			if (previous && previous.localDate !== shift.localDate) {
				const restMinutes = Math.round(
					(shift.startsAt - previous.endsAt) / MS_PER_MINUTE,
				)
				if (restMinutes < minRestMinutes) {
					out.push({
						code: 'min_rest',
						shiftId: shift.id,
						relatedId: previous.id,
						date: shift.localDate,
						detail: { restMinutes, requiredMinutes: minRestMinutes },
					})
				}
			}
		}
	}

	if (check('overtime') && sorted.some((s) => wanted(s.id))) {
		for (const [shiftId, overtimeMinutes] of getOvertime()) {
			if (!wanted(shiftId)) continue
			const shift = sorted[order.get(shiftId) ?? -1]
			out.push({
				code: 'overtime',
				shiftId,
				date: shift?.localDate,
				detail: { overtimeMinutes },
			})
		}
	}

	return out.sort(
		(a, b) =>
			(order.get(a.shiftId) ?? 0) - (order.get(b.shiftId) ?? 0) ||
			(CODE_ORDER.get(a.code) ?? 0) - (CODE_ORDER.get(b.code) ?? 0) ||
			(a.relatedId ?? '').localeCompare(b.relatedId ?? ''),
	)
}

/** Conflict codes that make a recommended shift go open instead of keeping its person. */
export const BLOCKING_FOR_RECOMMENDATION: readonly ScheduleConflictCode[] = [
	'overlap',
	'time_off',
	'unavailable',
	'not_at_scope',
	'position_mismatch',
]

export function groupConflictsByShift(
	conflicts: readonly ScheduleConflict[],
): Map<string, ScheduleConflict[]> {
	const grouped = new Map<string, ScheduleConflict[]>()
	for (const conflict of conflicts) {
		const list = grouped.get(conflict.shiftId)
		if (list) list.push(conflict)
		else grouped.set(conflict.shiftId, [conflict])
	}
	return grouped
}
