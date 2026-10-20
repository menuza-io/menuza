import {
	addDays,
	minuteOfDayFromHhmm,
	type ScheduleScope,
} from '@repo/staffing'
import {
	type CreateShiftsInput,
	type UpdateShiftInput,
} from './schedule-api.ts'
import { type ScheduleShiftRow } from './schedule-types.ts'
import { OPEN_ROW, shiftTimes } from './schedule-view.ts'

/**
 * The shift editor's form: state, validation and the request bodies. Kept apart
 * from the sheet so each rule has a unit test. Times are local wall-clock
 * `HH:MM` strings; an end at or before the start means the next day.
 */

export const NO_POSITION = 'none'
export const MAX_NOTE_LENGTH = 500
export const DEFAULT_START = '09:00'
export const DEFAULT_END = '17:00'

export type ShiftForm = {
	/** A staff id, or `open`. */
	staffId: string
	/** A position id, or `none`. */
	positionId: string
	startTime: string
	endTime: string
	/** Whole minutes as typed. */
	unpaidBreak: string
	notes: string
	/** New shifts only: the days to create the shift on. */
	dates: string[]
	/** A second shift on the same day (a split shift). New shifts and edits. */
	split: boolean
	startTime2: string
	endTime2: string
}

export type ShiftFormErrors = Partial<
	Record<'endTime' | 'unpaidBreak' | 'notes' | 'dates' | 'time2', FormIssue>
>

export type FormIssue =
	| 'same_time'
	| 'break_too_long'
	| 'break_invalid'
	| 'note_too_long'
	| 'no_dates'
	| 'second_same_time'
	| 'second_overlaps'

export function emptyForm(input: {
	rowKey: string
	date: string
	positionId?: string | null
	startTime?: string
	endTime?: string
}): ShiftForm {
	return {
		staffId: input.rowKey,
		positionId: input.positionId ?? NO_POSITION,
		startTime: input.startTime ?? DEFAULT_START,
		endTime: input.endTime ?? DEFAULT_END,
		unpaidBreak: '0',
		notes: '',
		dates: [input.date],
		split: false,
		startTime2: '18:00',
		endTime2: '22:00',
	}
}

export function formFromShift(shift: ScheduleShiftRow): ShiftForm {
	const times = shiftTimes(shift)
	return {
		staffId: shift.staffId ?? OPEN_ROW,
		positionId: shift.positionId ?? NO_POSITION,
		startTime: times.startTime,
		endTime: times.endTime,
		unpaidBreak: String(shift.unpaidBreakMinutes),
		notes: shift.notes ?? '',
		dates: [shift.localDate],
		split: false,
		startTime2: '18:00',
		endTime2: '22:00',
	}
}

/** Minutes from `start` to `end`, the end being the next day when it is not later. */
export function spanMinutes(start: string, end: string): number {
	const from = minuteOfDayFromHhmm(start)
	const to = minuteOfDayFromHhmm(end)
	return to > from ? to - from : to + 1440 - from
}

function parseBreak(value: string): number | null {
	const trimmed = value.trim()
	if (trimmed === '') return 0
	if (!/^\d{1,3}$/.test(trimmed)) return null
	const minutes = Number(trimmed)
	return minutes <= 720 ? minutes : null
}

export function validateShiftForm(
	form: ShiftForm,
	options: { creating: boolean },
): ShiftFormErrors {
	const errors: ShiftFormErrors = {}
	if (form.startTime === form.endTime) errors.endTime = 'same_time'
	const unpaid = parseBreak(form.unpaidBreak)
	if (unpaid === null) errors.unpaidBreak = 'break_invalid'
	else if (
		form.startTime !== form.endTime &&
		unpaid >= spanMinutes(form.startTime, form.endTime)
	) {
		errors.unpaidBreak = 'break_too_long'
	}
	if (form.notes.trim().length > MAX_NOTE_LENGTH) errors.notes = 'note_too_long'
	if (options.creating && form.dates.length === 0) errors.dates = 'no_dates'
	if (form.split) {
		if (form.startTime2 === form.endTime2) errors.time2 = 'second_same_time'
		else if (form.startTime !== form.endTime) {
			// Two shifts on one day must not overlap (the first may run past midnight).
			const firstStart = minuteOfDayFromHhmm(form.startTime)
			const firstEnd = firstStart + spanMinutes(form.startTime, form.endTime)
			const secondStart = minuteOfDayFromHhmm(form.startTime2)
			const secondEnd =
				secondStart + spanMinutes(form.startTime2, form.endTime2)
			if (secondStart < firstEnd && secondEnd > firstStart) {
				errors.time2 = 'second_overlaps'
			}
		}
	}
	return errors
}

export function hasErrors(errors: ShiftFormErrors): boolean {
	return Object.keys(errors).length > 0
}

function noteValue(notes: string): string | null {
	const trimmed = notes.trim()
	return trimmed === '' ? null : trimmed
}

/** One request for a new shift, or two for a split shift. */
export function buildCreateBodies(
	form: ShiftForm,
	scopeId: string,
): CreateShiftsInput[] {
	const base = {
		scopeId,
		staffId: form.staffId === OPEN_ROW ? null : form.staffId,
		positionId: form.positionId === NO_POSITION ? null : form.positionId,
		dates: [...form.dates].sort(),
		unpaidBreakMinutes: parseBreak(form.unpaidBreak) ?? 0,
		notes: noteValue(form.notes),
	}
	const bodies: CreateShiftsInput[] = [
		{ ...base, startTime: form.startTime, endTime: form.endTime },
	]
	if (form.split) {
		// The break belongs to the first shift; the second one is its own block.
		bodies.push({
			...base,
			unpaidBreakMinutes: 0,
			startTime: form.startTime2,
			endTime: form.endTime2,
		})
	}
	return bodies
}

/**
 * The update for an edited shift: only what changed, with the version the
 * editor was looking at. Null when nothing changed.
 */
export function buildUpdateBody(
	form: ShiftForm,
	original: ScheduleShiftRow,
): UpdateShiftInput | null {
	const before = formFromShift(original)
	const body: UpdateShiftInput = { expectedVersion: original.version }
	let changed = false
	if (form.startTime !== before.startTime || form.endTime !== before.endTime) {
		body.startTime = form.startTime
		body.endTime = form.endTime
		changed = true
	}
	if (form.staffId !== before.staffId) {
		body.staffId = form.staffId === OPEN_ROW ? null : form.staffId
		changed = true
	}
	if (form.positionId !== before.positionId) {
		body.positionId = form.positionId === NO_POSITION ? null : form.positionId
		changed = true
	}
	if (parseBreak(form.unpaidBreak) !== original.unpaidBreakMinutes) {
		body.unpaidBreakMinutes = parseBreak(form.unpaidBreak) ?? 0
		changed = true
	}
	if (noteValue(form.notes) !== (original.notes ?? null)) {
		body.notes = noteValue(form.notes)
		changed = true
	}
	if (form.dates[0] && form.dates[0] !== original.localDate) {
		body.date = form.dates[0]
		changed = true
	}
	return changed ? body : null
}

/** Two shifts the form would create on the same date for the same person, for a heads-up. */
export function repeatCount(form: ShiftForm): number {
	return form.dates.length * (form.split ? 2 : 1)
}

// ---------------------------------------------------------------------------
// Copy, template and recommendation scope
// ---------------------------------------------------------------------------

export type ScopeState = {
	mode: 'all' | 'positions' | 'people'
	positionIds: string[]
	staffIds: string[]
}

export const EMPTY_SCOPE: ScopeState = {
	mode: 'all',
	positionIds: [],
	staffIds: [],
}

/** The request scope for the picker's state; null while a narrower scope has nothing chosen. */
export function scopeFromState(state: ScopeState): ScheduleScope | null {
	if (state.mode === 'all') return { mode: 'all' }
	if (state.mode === 'positions') {
		return state.positionIds.length > 0
			? { mode: 'positions', positionIds: state.positionIds }
			: null
	}
	return state.staffIds.length > 0
		? { mode: 'people', staffIds: state.staffIds }
		: null
}

/** Week starts around `weekStart`, `before` weeks back to `after` weeks ahead, nearest first within each side. */
export function weekChoices(
	weekStart: string,
	before: number,
	after: number,
): string[] {
	const out: string[] = []
	for (let k = -before; k <= after; k++) out.push(addDays(weekStart, k * 7))
	return out
}
