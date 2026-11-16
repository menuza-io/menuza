import {
	buildOnlineLocationHours,
	locationOpenIntervals,
	type LocationHours,
} from '@repo/opening-hours'
import { addDays, localParts, zonedLocalToUtc } from '@repo/zoned-time'

import { parseOnlineOrderingSettings } from './location-settings.ts'

export const ORDER_SLOT_MINUTES = 15

export type AvailableTimesLocation = {
	timezone: string
	isActive?: boolean | null
	storeHours?: unknown
	onlineHours?: unknown
	specialHours?: unknown
	onlineOrderingSettings?: unknown
	prepTime?: number | null
}

export type AvailableTimeSlot = {
	at: string
	available: boolean
}

export function readySlotFloorMs(instantMs: number, timeZone: string): number {
	const p = localParts(instantMs, timeZone)
	const snap = Math.floor(p.minute / ORDER_SLOT_MINUTES) * ORDER_SLOT_MINUTES
	return zonedLocalToUtc(p.year, p.month, p.day, p.hour, snap, timeZone)
}

export function buildOnlineHours(
	location: AvailableTimesLocation,
): LocationHours {
	const settings = parseOnlineOrderingSettings(location.onlineOrderingSettings)
	return buildOnlineLocationHours({
		timeZone: location.timezone,
		isActive: location.isActive,
		storeHours: location.storeHours,
		onlineHours: location.onlineHours,
		specialHours: location.specialHours,
		buffers: settings?.buffers,
	})
}

/** Fifteen-minute ready-time slots for one local date. */
export function slotsForLocalDate(
	hours: LocationHours,
	localDate: string,
	usedBySlotMs: ReadonlyMap<number, number>,
	limit: number | null,
	nowMs: number,
	prepMinutes: number,
): AvailableTimeSlot[] {
	const intervals = locationOpenIntervals(hours, localDate, localDate, 'online')
	if (intervals === null) return []
	if (intervals.length === 0) return []
	const earliest = nowMs + prepMinutes * 60_000
	const out: AvailableTimeSlot[] = []
	for (const iv of intervals) {
		let t = readySlotFloorMs(Math.max(iv.startMs, earliest), hours.timeZone)
		while (t < iv.endMs) {
			const used = usedBySlotMs.get(t) ?? 0
			const available = limit == null || used < limit
			out.push({ at: new Date(t).toISOString(), available })
			t += ORDER_SLOT_MINUTES * 60_000
		}
	}
	return out
}

export function localDateInZone(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function dateRange(fromDate: string, days: number): string[] {
	const out: string[] = []
	let d = fromDate
	for (let i = 0; i < days; i += 1) {
		out.push(d)
		d = addDays(d, 1)
	}
	return out
}
