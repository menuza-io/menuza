import { dayOfWeek, hhmmFromMinuteOfDay } from '@repo/staffing'
import { type AvailabilityRowInput } from './schedule-api.ts'
import { type AvailabilityRow, type TimeOffRow } from './schedule-types.ts'
import { formatHhmm } from './schedule-view.ts'
import { formatDateLabel, formatPeriodLabel } from './timesheet-view.ts'

/**
 * Wording and form logic for time off and availability: how a request reads in
 * a list, and how the availability editor's drafts become request rows. Pure,
 * so each rule has a unit test.
 */

/** "9 AM" for minute 540; the end of the day (1440) reads as midnight. */
export function formatMinute(minute: number, locale: string): string {
	return formatHhmm(hhmmFromMinuteOfDay(minute >= 1440 ? 0 : minute), locale)
}

function timeRange(
	row: { startMinute: number | null; endMinute: number | null },
	locale: string,
): string {
	return `${formatMinute(row.startMinute ?? 0, locale)} – ${formatMinute(row.endMinute ?? 1440, locale)}`
}

/** "Mon, Mar 2", "Mar 2 – Mar 6" or "Mon, Mar 2, 2 PM – 6 PM". */
export function timeOffWhen(row: TimeOffRow, locale: string): string {
	if (!row.allDay) {
		return `${formatDateLabel(row.startDate, locale)}, ${timeRange(row, locale)}`
	}
	return row.startDate === row.endDate
		? formatDateLabel(row.startDate, locale)
		: formatPeriodLabel(row.startDate, row.endDate, locale)
}

/** The days a time-off request covers, counting both ends. */
export function timeOffDays(
	row: Pick<TimeOffRow, 'startDate' | 'endDate'>,
): number {
	const [y1, m1, d1] = row.startDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const [y2, m2, d2] = row.endDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return (
		Math.round(
			(Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000,
		) + 1
	)
}

/** "Mondays", in the viewer's language, from a weekday number (0 = Sunday). */
export function weekdayName(weekday: number, locale: string): string {
	// 2026-03-01 is a Sunday.
	return formatDateLabel(
		`2026-03-${String(1 + weekday).padStart(2, '0')}`,
		locale,
		{
			weekday: 'long',
		},
	)
}

export type AvailabilityWhen = {
	/** "Monday" or "Mon, Mar 2". */
	day: string
	/** "All day" or "9 AM – 5 PM". Null when `allDay` (the caller words that). */
	hours: string | null
	allDay: boolean
	recurring: boolean
}

export function availabilityWhen(
	row: AvailabilityRow,
	locale: string,
): AvailabilityWhen {
	return {
		day:
			row.kind === 'weekly' && row.weekday !== null
				? weekdayName(row.weekday, locale)
				: row.date
					? formatDateLabel(row.date, locale)
					: '',
		hours: row.allDay ? null : timeRange(row, locale),
		allDay: row.allDay,
		recurring: row.kind === 'weekly',
	}
}

// ---------------------------------------------------------------------------
// The availability editor
// ---------------------------------------------------------------------------

export const DAY_MODES = [
	'unset',
	'available_all',
	'unavailable_all',
	'available_hours',
	'unavailable_hours',
] as const
export type DayMode = (typeof DAY_MODES)[number]

export type DayDraft = {
	weekday: number
	mode: DayMode
	startTime: string
	endTime: string
}

export const WEEKDAYS_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const

export function emptyDays(): DayDraft[] {
	return WEEKDAYS_MONDAY_FIRST.map((weekday) => ({
		weekday,
		mode: 'unset',
		startTime: '09:00',
		endTime: '17:00',
	}))
}

function minutes(value: string): number {
	if (value === '24:00') return 1440
	const [h = 0, m = 0] = value.split(':').map(Number)
	return h * 60 + m
}

/** The days whose hours do not end after they start. */
export function invalidDays(days: readonly DayDraft[]): number[] {
	return days
		.filter(
			(day) =>
				(day.mode === 'available_hours' || day.mode === 'unavailable_hours') &&
				minutes(day.endTime) <= minutes(day.startTime),
		)
		.map((day) => day.weekday)
}

/** Weekly request rows for the days the manager filled in. Days left unset are left out. */
export function weeklyRows(
	days: readonly DayDraft[],
	effectiveFrom?: string,
): AvailabilityRowInput[] {
	const rows: AvailabilityRowInput[] = []
	for (const day of days) {
		if (day.mode === 'unset') continue
		const availability =
			day.mode === 'available_all' || day.mode === 'available_hours'
				? 'available'
				: 'unavailable'
		const allDay =
			day.mode === 'available_all' || day.mode === 'unavailable_all'
		rows.push({
			kind: 'weekly',
			weekday: day.weekday,
			availability,
			allDay,
			...(allDay ? {} : { startTime: day.startTime, endTime: day.endTime }),
			...(effectiveFrom ? { effectiveFrom } : {}),
		})
	}
	return rows
}

/** Which weekday a date falls on, for describing a one-off date. */
export function weekdayOf(date: string): number {
	return dayOfWeek(date)
}
