import { type TodayRow } from './timeclock-types.ts'

export const TODAY_FILTERS = ['all', 'in', 'on_break', 'attention'] as const
export type TodayFilter = (typeof TODAY_FILTERS)[number]

/** Late arrivals and forgotten clock-outs need a manager's eyes. */
export function needsAttention(row: TodayRow): boolean {
	return row.missingClockOut || row.late
}

/**
 * Attention first, then people who have been in the longest, so the list reads
 * top to bottom in order of urgency and then of arrival. Stable and pure.
 */
export function sortTodayRows(rows: readonly TodayRow[]): TodayRow[] {
	return [...rows].sort((a, b) => {
		const attention = Number(needsAttention(b)) - Number(needsAttention(a))
		if (attention !== 0) return attention
		if (a.clockInAt !== b.clockInAt) return a.clockInAt - b.clockInAt
		return `${a.lastName} ${a.firstName}`.localeCompare(
			`${b.lastName} ${b.firstName}`,
		)
	})
}

export function filterTodayRows(
	rows: readonly TodayRow[],
	filter: TodayFilter,
): TodayRow[] {
	switch (filter) {
		case 'in':
			return rows.filter((row) => row.state === 'in')
		case 'on_break':
			return rows.filter((row) => row.state === 'on_break')
		case 'attention':
			return rows.filter(needsAttention)
		default:
			return [...rows]
	}
}

export function summarizeToday(rows: readonly TodayRow[]) {
	return {
		total: rows.length,
		working: rows.filter((row) => row.state === 'in').length,
		onBreak: rows.filter((row) => row.state === 'on_break').length,
		attention: rows.filter(needsAttention).length,
	}
}

/** Whole minutes since the person clocked in (breaks included). */
export function minutesSinceClockIn(row: TodayRow, now: number): number {
	return Math.max(0, Math.floor((now - row.clockInAt) / 60_000))
}
