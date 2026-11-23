import {
	type CountAssignee,
	type CountSchedule,
	type CreateCountSchedule,
	type UpdateCountSchedule,
} from '@repo/inventory'

/**
 * The weekly count plan (#490, #491): the pure parts of the Settings panel that
 * lists a location's scheduled counts and who is responsible for each. A
 * schedule is a kind (a full count, a quick count of the key items, or a saved
 * count list), a time of day, the weekdays and an assignee. A change applies
 * from tomorrow; the region says so in `effectiveFrom`.
 */

export const COUNT_SLOTS = ['opening', 'close', 'custom'] as const
export type CountSlot = (typeof COUNT_SLOTS)[number]

/** What a new schedule of each slot starts at; the person can change the time. */
export const SLOT_DEFAULT_TIME: Readonly<Record<CountSlot, string>> = {
	opening: '08:00',
	close: '22:00',
	custom: '12:00',
}

export type ScheduleKindChoice = 'quick' | 'full' | 'list'

export type ScheduleFormValues = {
	kind: ScheduleKindChoice
	listId: string
	slot: CountSlot
	timeLocal: string
	weekdays: number[]
	/** `none`, `staff:<id>` or `member:<id>`. */
	assignee: string
}

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const

export const NO_ASSIGNEE = 'none'

export function assigneeValue(assignee: CountAssignee | null): string {
	return assignee ? `${assignee.kind}:${assignee.id}` : NO_ASSIGNEE
}

export function parseAssignee(value: string): CountAssignee | null {
	const [kind, ...rest] = value.split(':')
	const id = rest.join(':')
	if ((kind === 'staff' || kind === 'member') && id) return { kind, id }
	return null
}

export function emptyScheduleForm(): ScheduleFormValues {
	return {
		kind: 'quick',
		listId: '',
		slot: 'close',
		timeLocal: SLOT_DEFAULT_TIME.close,
		weekdays: [...ALL_WEEKDAYS],
		assignee: NO_ASSIGNEE,
	}
}

export function formFromSchedule(schedule: CountSchedule): ScheduleFormValues {
	return {
		kind:
			schedule.listId !== null
				? 'list'
				: schedule.kind === 'quick'
					? 'quick'
					: 'full',
		listId: schedule.listId ?? '',
		slot: schedule.slot,
		timeLocal: schedule.timeLocal,
		weekdays: [...schedule.weekdays],
		assignee: assigneeValue(schedule.assignee),
	}
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export type ScheduleFormProblem = 'time' | 'weekdays' | 'list' | null

export function scheduleFormProblem(
	values: ScheduleFormValues,
): ScheduleFormProblem {
	if (!TIME.test(values.timeLocal)) return 'time'
	if (values.weekdays.length === 0) return 'weekdays'
	if (values.kind === 'list' && values.listId === '') return 'list'
	return null
}

/** A count list is a full count of that list; the key items are a quick count. */
function kindOf(values: ScheduleFormValues): CreateCountSchedule['kind'] {
	return values.kind === 'quick' ? 'quick' : 'full'
}

export function buildCreateSchedule(
	values: ScheduleFormValues,
	input: { locationId: string; clientId: string },
): CreateCountSchedule {
	return {
		clientId: input.clientId,
		locationId: input.locationId,
		kind: kindOf(values),
		listId: values.kind === 'list' ? values.listId : null,
		slot: values.slot,
		timeLocal: values.timeLocal,
		weekdays: [...values.weekdays].sort((a, b) => a - b),
		assignee: parseAssignee(values.assignee),
	}
}

/** Only what the person changed: the kind and the location never change on an existing schedule. */
export function buildUpdateSchedule(
	values: ScheduleFormValues,
	schedule: CountSchedule,
): UpdateCountSchedule {
	return {
		expectedVersion: schedule.version,
		listId: values.kind === 'list' ? values.listId : null,
		slot: values.slot,
		timeLocal: values.timeLocal,
		weekdays: [...values.weekdays].sort((a, b) => a - b),
		assignee: parseAssignee(values.assignee),
	}
}

/** Weekday names in the viewer's language (0 = Sunday). */
export function weekdayName(
	day: number,
	locale: string,
	style: 'short' | 'long' = 'short',
): string {
	// 4 January 2026 is a Sunday.
	return new Intl.DateTimeFormat(locale, { weekday: style }).format(
		new Date(2026, 0, 4 + day),
	)
}

/** The weekdays in order, or `null` for every day (the screen says "Every day" in words). */
export function weekdaysText(
	days: readonly number[],
	locale: string,
): string | null {
	if (days.length === 7) return null
	return new Intl.ListFormat(locale, {
		style: 'short',
		type: 'conjunction',
	}).format(days.map((day) => weekdayName(day, locale)))
}
