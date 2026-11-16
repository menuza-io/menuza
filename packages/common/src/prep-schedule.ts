import { localParts, zonedLocalToUtc } from '@repo/zoned-time'

import {
	type DayOfWeek,
	DAYS_OF_WEEK,
	type PrepSchedule,
	type PrepScheduleRow,
} from './location-types.ts'
import { DEFAULT_PREP_MINUTES } from './location-availability.ts'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function toMinutes(hhmm: string): number | null {
	const m = HHMM.exec(hhmm)
	if (!m) return null
	return Number(m[1]) * 60 + Number(m[2])
}

function dayName(instantMs: number, timeZone: string): DayOfWeek {
	const p = localParts(instantMs, timeZone)
	const js = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
	const names: DayOfWeek[] = [
		'sunday',
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
	]
	return names[js] ?? 'monday'
}

function inRow(row: PrepScheduleRow, day: DayOfWeek, minute: number): boolean {
	if (!row.days.includes(day)) return false
	const from = toMinutes(row.from)
	const to = toMinutes(row.to)
	if (from === null || to === null) return false
	if (from <= to) return minute >= from && minute <= to
	return minute >= from || minute <= to
}

/**
 * Prep minutes for an instant when the kitchen would start (busy mode is added
 * separately). Falls back to `defaultPrepMinutes` when no row matches.
 */
export function prepMinutesAt(
	schedule: PrepSchedule | null | undefined,
	defaultPrepMinutes: number,
	instantMs: number,
	timeZone: string,
): number {
	const rows = schedule ?? []
	if (rows.length === 0) {
		return Math.max(0, defaultPrepMinutes || DEFAULT_PREP_MINUTES)
	}
	const day = dayName(instantMs, timeZone)
	const p = localParts(instantMs, timeZone)
	const minute = p.hour * 60 + p.minute
	for (const row of rows) {
		if (inRow(row, day, minute)) return row.minutes
	}
	return Math.max(0, defaultPrepMinutes || DEFAULT_PREP_MINUTES)
}

/** Local instant when the kitchen would start for a scheduled ready time. */
export function kitchenStartInstantMs(
	readyAtMs: number,
	prepMinutes: number,
	timeZone: string,
): number {
	const p = localParts(readyAtMs, timeZone)
	let minute = p.hour * 60 + p.minute - prepMinutes
	let y = p.year
	let m = p.month
	let d = p.day
	while (minute < 0) {
		minute += 24 * 60
		const back = new Date(Date.UTC(y, m - 1, d))
		back.setUTCDate(back.getUTCDate() - 1)
		y = back.getUTCFullYear()
		m = back.getUTCMonth() + 1
		d = back.getUTCDate()
	}
	const hh = Math.floor(minute / 60)
	const mm = minute % 60
	return zonedLocalToUtc(y, m, d, hh, mm, timeZone)
}

export function prepRowInForce(
	schedule: PrepSchedule | null | undefined,
	defaultPrepMinutes: number,
	instantMs: number,
	timeZone: string,
): { minutes: number; untilMs: number | null } {
	const minutes = prepMinutesAt(
		schedule,
		defaultPrepMinutes,
		instantMs,
		timeZone,
	)
	const day = dayName(instantMs, timeZone)
	const p = localParts(instantMs, timeZone)
	const minute = p.hour * 60 + p.minute
	const rows = schedule ?? []
	let endMinute: number | null = null
	for (const row of rows) {
		if (!inRow(row, day, minute)) continue
		const to = toMinutes(row.to)
		if (to !== null) endMinute = to
	}
	if (endMinute === null) {
		return { minutes, untilMs: null }
	}
	const hh = Math.floor(endMinute / 60)
	const mm = endMinute % 60
	return {
		minutes,
		untilMs: zonedLocalToUtc(p.year, p.month, p.day, hh, mm, timeZone),
	}
}

export function parsePrepSchedule(raw: unknown): PrepSchedule | null {
	if (raw == null) return null
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw) as unknown
		} catch {
			return null
		}
	}
	if (!Array.isArray(value)) return null
	return value as PrepSchedule
}
