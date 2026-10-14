import { type LaborRules } from './rules.ts'
import {
	BLOCKING_FOR_RECOMMENDATION,
	type ConflictShift,
	detectPersonConflicts,
	type PersonConflictContext,
} from './schedule-conflicts.ts'
import {
	type RecommendOpenReason,
	type ScheduleConflictCode,
	type ScheduleScope,
} from './schedule-api.ts'
import { placeWallClock, wallClockOf, type WallClock } from './schedule-time.ts'
import { addDays, dayOfWeek, daysBetween } from './tz.ts'

/**
 * Pure planning for copying a week, applying a template, and recommending a
 * schedule from a base week. Nothing here touches storage: the caller loads
 * the source shifts and people, and writes the plan it gets back.
 *
 * Everything is deterministic: sources are processed in (start, id) order and
 * no step depends on randomness or on the clock.
 */

const MS_PER_MINUTE = 60_000

export type PlanShift = {
	id: string
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	localDate: string
	unpaidBreakMinutes: number
	notes: string | null
}

/** A shift to be created. */
export type NewShiftPlan = {
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	localDate: string
	unpaidBreakMinutes: number
	notes: string | null
	/** The shift it was copied from, when it came from one. */
	sourceShiftId?: string
}

function byStart(a: PlanShift, b: PlanShift): number {
	return a.startsAt - b.startsAt || a.id.localeCompare(b.id)
}

/** Does a shift belong to the scope of a copy, template or recommendation? */
export function inScope(
	shift: Pick<PlanShift, 'staffId' | 'positionId'>,
	scope: ScheduleScope,
	includeOpenShifts: boolean,
): boolean {
	if (shift.staffId === null) {
		// A people scope names people, so an open shift is never part of it.
		if (scope.mode === 'people') return false
		if (!includeOpenShifts) return false
	}
	switch (scope.mode) {
		case 'all':
			return true
		case 'positions':
			return (
				shift.positionId !== null &&
				scope.positionIds.includes(shift.positionId)
			)
		case 'people':
			return shift.staffId !== null && scope.staffIds.includes(shift.staffId)
	}
}

/** The identity two shifts must share to count as the same shift. */
export function shiftIdentity(shift: {
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
}): string {
	return `${shift.staffId ?? '-'}|${shift.positionId ?? '-'}|${shift.startsAt}|${shift.endsAt}`
}

/**
 * Move a shift from its week to the same weekday of another week, keeping its
 * wall-clock times in the scope's zone (9:00 stays 9:00 across a clock
 * change). Null when the shift is not in the source week.
 */
export function projectShift(input: {
	shift: PlanShift
	fromWeekStart: string
	toWeekStart: string
	timeZone: string
}): NewShiftPlan | null {
	const { shift, fromWeekStart, toWeekStart, timeZone } = input
	const offset = daysBetween(fromWeekStart, shift.localDate)
	if (offset < 0 || offset > 6) return null
	const wall = wallClockOf(shift.startsAt, shift.endsAt, timeZone)
	const placed = placeWallClock({
		date: addDays(toWeekStart, offset),
		wallClock: wall,
		timeZone,
		fallbackDurationMinutes: Math.round(
			(shift.endsAt - shift.startsAt) / MS_PER_MINUTE,
		),
	})
	if (!placed.ok) return null
	return {
		staffId: shift.staffId,
		positionId: shift.positionId,
		startsAt: placed.window.startsAt,
		endsAt: placed.window.endsAt,
		localDate: placed.window.localDate,
		unpaidBreakMinutes: shift.unpaidBreakMinutes,
		notes: shift.notes,
		sourceShiftId: shift.id,
	}
}

export type CopyPlan = {
	create: NewShiftPlan[]
	/** Shifts already in the target week exactly as they would be created. */
	skippedDuplicates: number
	/** Shifts that could not be placed (outside the source week, or no valid time). */
	skippedUnplaceable: number
}

export function planCopyWeek(input: {
	sources: readonly PlanShift[]
	existing: readonly {
		staffId: string | null
		positionId: string | null
		startsAt: number
		endsAt: number
	}[]
	fromWeekStart: string
	toWeekStart: string
	timeZone: string
	scope: ScheduleScope
	includeOpenShifts: boolean
}): CopyPlan {
	const taken = new Set(input.existing.map(shiftIdentity))
	const create: NewShiftPlan[] = []
	let skippedDuplicates = 0
	let skippedUnplaceable = 0
	for (const shift of [...input.sources].sort(byStart)) {
		if (!inScope(shift, input.scope, input.includeOpenShifts)) continue
		const projected = projectShift({
			shift,
			fromWeekStart: input.fromWeekStart,
			toWeekStart: input.toWeekStart,
			timeZone: input.timeZone,
		})
		if (!projected) {
			skippedUnplaceable += 1
			continue
		}
		const identity = shiftIdentity(projected)
		if (taken.has(identity)) {
			skippedDuplicates += 1
			continue
		}
		taken.add(identity)
		create.push(projected)
	}
	return { create, skippedDuplicates, skippedUnplaceable }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateSlot = {
	weekday: number
	startMinute: number
	endDayOffset: number
	endMinute: number
	positionId: string | null
	staffId: string | null
	unpaidBreakMinutes: number
	notes: string | null
}

export function slotsFromShifts(input: {
	shifts: readonly PlanShift[]
	timeZone: string
	scope: ScheduleScope
	keepAssignments: boolean
}): TemplateSlot[] {
	const slots: TemplateSlot[] = []
	for (const shift of [...input.shifts].sort(byStart)) {
		if (!inScope(shift, input.scope, true)) continue
		const wall = wallClockOf(shift.startsAt, shift.endsAt, input.timeZone)
		slots.push({
			weekday: dayOfWeek(wall.date),
			startMinute: wall.startMinute,
			endDayOffset: wall.endDayOffset,
			endMinute: wall.endMinute,
			positionId: shift.positionId,
			staffId: input.keepAssignments ? shift.staffId : null,
			unpaidBreakMinutes: shift.unpaidBreakMinutes,
			notes: shift.notes,
		})
	}
	return slots
}

/** The date in the week starting `weekStart` that falls on `weekday`. */
export function dateForWeekday(weekStart: string, weekday: number): string {
	return addDays(weekStart, (weekday - dayOfWeek(weekStart) + 7) % 7)
}

export function planTemplateApply(input: {
	slots: readonly TemplateSlot[]
	weekStart: string
	timeZone: string
	assignments: 'keep' | 'open'
	existing: readonly {
		staffId: string | null
		positionId: string | null
		startsAt: number
		endsAt: number
	}[]
}): CopyPlan {
	const taken = new Set(input.existing.map(shiftIdentity))
	const create: NewShiftPlan[] = []
	let skippedDuplicates = 0
	let skippedUnplaceable = 0
	for (const slot of input.slots) {
		const wall: WallClock = {
			startMinute: slot.startMinute,
			endDayOffset: slot.endDayOffset,
			endMinute: slot.endMinute,
		}
		const placed = placeWallClock({
			date: dateForWeekday(input.weekStart, slot.weekday),
			wallClock: wall,
			timeZone: input.timeZone,
			fallbackDurationMinutes: 60,
		})
		if (!placed.ok) {
			skippedUnplaceable += 1
			continue
		}
		const plan: NewShiftPlan = {
			staffId: input.assignments === 'open' ? null : slot.staffId,
			positionId: slot.positionId,
			startsAt: placed.window.startsAt,
			endsAt: placed.window.endsAt,
			localDate: placed.window.localDate,
			unpaidBreakMinutes: slot.unpaidBreakMinutes,
			notes: slot.notes,
		}
		const identity = shiftIdentity(plan)
		if (taken.has(identity)) {
			skippedDuplicates += 1
			continue
		}
		taken.add(identity)
		create.push(plan)
	}
	return { create, skippedDuplicates, skippedUnplaceable }
}

// ---------------------------------------------------------------------------
// Recommend a schedule
// ---------------------------------------------------------------------------

export type RecommendedShift = NewShiftPlan & {
	/** Set when the base shift's person could not keep it. */
	openReason?: RecommendOpenReason
	/** The person the base shift had, when it was opened. */
	previousStaffId?: string | null
}

export type RecommendPlan = {
	shifts: RecommendedShift[]
	skippedDuplicates: number
	skippedUnplaceable: number
	/** Shifts opened because their person could not keep them. */
	opened: number
}

const REASON_BY_CODE: Partial<
	Record<ScheduleConflictCode, RecommendOpenReason>
> = {
	time_off: 'time_off',
	unavailable: 'unavailable',
	overlap: 'overlap',
	not_at_scope: 'not_at_scope',
	position_mismatch: 'position_mismatch',
}

/**
 * Deterministic recommendation from a base week: copy it to the target week,
 * keep each person where approved availability and time off allow, and turn
 * everything that conflicts into an open shift for a manager to fill. Overtime
 * and minimum rest stay warnings: they are the manager's call, not a reason to
 * take a shift away.
 */
export function planRecommendation(input: {
	sources: readonly PlanShift[]
	/** Shifts already scheduled around the target week, keyed by person. */
	existingByStaff: ReadonlyMap<string, readonly ConflictShift[]>
	/** Shifts already in the target week, for skipping exact duplicates. */
	existingTarget: readonly {
		staffId: string | null
		positionId: string | null
		startsAt: number
		endsAt: number
	}[]
	people: ReadonlyMap<string, PersonConflictContext>
	fromWeekStart: string
	toWeekStart: string
	timeZone: string
	scopeId: string
	scope: ScheduleScope
	includeOpenShifts: boolean
	rules: LaborRules
}): RecommendPlan {
	const taken = new Set(input.existingTarget.map(shiftIdentity))
	const planned = new Map<string, ConflictShift[]>()
	const shifts: RecommendedShift[] = []
	let skippedDuplicates = 0
	let skippedUnplaceable = 0
	let opened = 0
	const skip = new Set<ScheduleConflictCode>(['overtime', 'min_rest'])

	for (const source of [...input.sources].sort(byStart)) {
		if (!inScope(source, input.scope, input.includeOpenShifts)) continue
		const projected = projectShift({
			shift: source,
			fromWeekStart: input.fromWeekStart,
			toWeekStart: input.toWeekStart,
			timeZone: input.timeZone,
		})
		if (!projected) {
			skippedUnplaceable += 1
			continue
		}

		// Running it again must add nothing: a shift that is already there as
		// proposed is a duplicate, not a double booking of its own person.
		if (taken.has(shiftIdentity(projected))) {
			skippedDuplicates += 1
			continue
		}

		let result: RecommendedShift = projected
		const staffId = projected.staffId
		if (staffId !== null) {
			const person = input.people.get(staffId)
			let reason: RecommendOpenReason | undefined
			if (!person || person.status === 'terminated') {
				reason = 'inactive'
			} else {
				const probe: ConflictShift = {
					id: '__candidate__',
					scopeId: input.scopeId,
					positionId: projected.positionId,
					startsAt: projected.startsAt,
					endsAt: projected.endsAt,
					localDate: projected.localDate,
					timeZone: input.timeZone,
					unpaidBreakMinutes: projected.unpaidBreakMinutes,
				}
				const conflicts = detectPersonConflicts({
					shifts: [
						...(input.existingByStaff.get(staffId) ?? []),
						...(planned.get(staffId) ?? []),
						probe,
					],
					person,
					rules: input.rules,
					minRestMinutes: 0,
					only: new Set([probe.id]),
					skip,
				})
				const blocking = conflicts.find((c) =>
					BLOCKING_FOR_RECOMMENDATION.includes(c.code),
				)
				if (blocking) reason = REASON_BY_CODE[blocking.code]
			}
			if (reason) {
				opened += 1
				result = {
					...projected,
					staffId: null,
					openReason: reason,
					previousStaffId: staffId,
				}
			}
		}

		const identity = shiftIdentity(result)
		if (taken.has(identity)) {
			skippedDuplicates += 1
			continue
		}
		taken.add(identity)
		if (result.staffId !== null) {
			const list = planned.get(result.staffId) ?? []
			list.push({
				id: `planned-${shifts.length}`,
				scopeId: input.scopeId,
				positionId: result.positionId,
				startsAt: result.startsAt,
				endsAt: result.endsAt,
				localDate: result.localDate,
				timeZone: input.timeZone,
				unpaidBreakMinutes: result.unpaidBreakMinutes,
			})
			planned.set(result.staffId, list)
		}
		shifts.push(result)
	}
	return { shifts, skippedDuplicates, skippedUnplaceable, opened }
}
