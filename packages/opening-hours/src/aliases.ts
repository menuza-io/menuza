import { addDays, zonedLocalToUtc } from '@repo/zoned-time'

import {
	type HoursScheduleKind,
	type LocationHours,
	isLocationOpenAt,
	locationLocalClock,
	type LocationOpenResult,
	ruleForDate,
} from './hours.ts'

export const isOpenAt = isLocationOpenAt

/** Primary on-site weekly hours (`store` in persistence). */
export const HOURS_SCHEDULE_PRIMARY: HoursScheduleKind = 'store'
/** Online ordering weekly hours. */
export const HOURS_SCHEDULE_ONLINE: HoursScheduleKind = 'online'

export type HoursInForce = {
	open: boolean
	reason: LocationOpenResult['reason']
	note?: string
	localDate: string
	localTime: string
}

function formatLocalTime(minute: number): string {
	const h = Math.floor(minute / 60)
	const m = minute % 60
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Whether the schedule is open at `instantMs` plus local clock fields. */
export function hoursInForce(
	hours: LocationHours,
	instantMs: number,
	kind: HoursScheduleKind = 'store',
): HoursInForce {
	const { date, minute } = locationLocalClock(instantMs, hours.timeZone)
	const result = isLocationOpenAt(hours, instantMs, kind)
	return {
		open: result.open,
		reason: result.reason,
		...(result.note ? { note: result.note } : {}),
		localDate: date,
		localTime: formatLocalTime(minute),
	}
}

export type NextBoundary = {
	atMs: number
	localDate: string
	localTime: string
} | null

function instantFromLocal(
	hours: LocationHours,
	date: string,
	hhmm: string,
): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number]
	const [hh, mm] = hhmm.split(':').map(Number) as [number, number, number]
	return zonedLocalToUtc(y, m, d, hh, mm, hours.timeZone)
}

/** Next moment hours become open at or after `fromMs`. */
export function nextOpening(
	hours: LocationHours,
	fromMs: number,
	kind: HoursScheduleKind = 'online',
	lookaheadDays = 8,
): NextBoundary {
	if (hours.isActive === false) return null
	const start = locationLocalClock(fromMs, hours.timeZone)
	let date = start.date
	for (let i = 0; i < lookaheadDays; i += 1) {
		const rule = ruleForDate(hours, date, kind)
		if (rule.kind === 'slots') {
			const sorted = [...rule.slots].sort((a, b) =>
				a.start.localeCompare(b.start),
			)
			for (const slot of sorted) {
				if (slot.start > slot.end) continue
				const atMs = instantFromLocal(hours, date, slot.start)
				const endMs = instantFromLocal(hours, date, slot.end) + 60_000
				if (endMs <= fromMs) continue
				if (atMs >= fromMs) {
					return { atMs, localDate: date, localTime: slot.start }
				}
				if (fromMs < endMs) {
					return {
						atMs: fromMs,
						localDate: date,
						localTime: formatLocalTime(start.minute),
					}
				}
			}
		}
		date = addDays(date, 1)
	}
	return null
}

/** Next closing instant after `fromMs` while inside a slot. */
export function nextClosing(
	hours: LocationHours,
	fromMs: number,
	kind: HoursScheduleKind = 'online',
): NextBoundary {
	const { date, minute } = locationLocalClock(fromMs, hours.timeZone)
	const rule = ruleForDate(hours, date, kind)
	if (rule.kind !== 'slots') return null
	const hhmm = formatLocalTime(minute)
	for (const slot of rule.slots) {
		if (slot.start <= hhmm && hhmm <= slot.end) {
			const atMs = instantFromLocal(hours, date, slot.end) + 60_000
			return { atMs, localDate: date, localTime: slot.end }
		}
	}
	return null
}

/** True when every day is open 00:00–23:59 (weekly pattern only). */
export function isOpen24Hours(
	hours: LocationHours,
	kind: HoursScheduleKind = 'store',
): boolean {
	const weekly =
		kind === 'online'
			? (hours.onlineHours ?? hours.storeHours)
			: hours.storeHours
	if (!weekly?.length) return false
	return weekly.every(
		(day) =>
			day.isOpen &&
			day.slots.some((s) => s.start === '00:00' && s.end === '23:59'),
	)
}
