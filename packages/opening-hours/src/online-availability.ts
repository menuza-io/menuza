import {
	type HoursScheduleKind,
	type LocationHours,
	isLocationOpenAt,
	locationLocalClock,
	type LocationOpenResult,
	parseLocationHours,
	rangesForDate,
} from './hours.ts'

export type OrderFulfillmentKind = 'pickup' | 'delivery' | 'catering'

export type OnlineOrderingBuffers = {
	/** Minutes after opening before the first online ready time (0–120). */
	openingBufferMinutes: number
	/** Minutes before closing when online ordering stops (0–120). */
	closingBufferMinutes: number
}

export type FulfillmentHoursMode = 'follow_online' | 'custom' | 'closed'

export type OnlineHoursSettings = {
	buffers: OnlineOrderingBuffers
	pickup: FulfillmentHoursMode
	delivery: FulfillmentHoursMode
	catering: FulfillmentHoursMode
}

export const DEFAULT_ONLINE_BUFFERS: OnlineOrderingBuffers = {
	openingBufferMinutes: 0,
	closingBufferMinutes: 0,
}

export type OnlineAvailabilityInput = {
	timeZone: string
	isActive?: boolean | null
	storeHours?: unknown
	onlineHours?: unknown
	specialHours?: unknown
	buffers?: Partial<OnlineOrderingBuffers> | null
}

export type OnlineAvailabilityResult = LocationOpenResult & {
	/** Locale-neutral phrase keys for each app catalog. */
	messageKey?:
		| 'opens_later_today'
		| 'opens_tomorrow'
		| 'opens_on_date'
		| 'closed_special'
		| 'closed_weekday'
		| 'outside_online_hours'
		| 'inactive'
	messageParams?: Record<string, string>
	/** Earliest instant a ready time may be scheduled (buffers applied). */
	earliestReadyMs?: number
	/** Last instant an order may be placed for online fulfillment. */
	latestOrderMs?: number
}

function clampBuffer(n: unknown): number {
	const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0
	return Math.min(120, Math.max(0, v))
}

function applyBuffersToRanges(
	ranges: Array<[number, number]>,
	buffers: OnlineOrderingBuffers,
): Array<[number, number]> {
	const openBump = buffers.openingBufferMinutes
	const closeShrink = buffers.closingBufferMinutes
	if (openBump === 0 && closeShrink === 0) return ranges
	return ranges
		.map(
			([from, to]) => [from + openBump, to - closeShrink] as [number, number],
		)
		.filter(([from, to]) => from <= to)
}

/**
 * Online ordering availability at an instant: online hours, optional buffers, fail
 * closed on malformed stored hours.
 */
export function onlineAvailabilityAt(
	raw: OnlineAvailabilityInput,
	instantMs: number,
	kind: HoursScheduleKind = 'online',
): OnlineAvailabilityResult {
	const { hours } = parseLocationHours(raw, { malformedPolicy: 'closed' })
	const buffers: OnlineOrderingBuffers = {
		openingBufferMinutes: clampBuffer(raw.buffers?.openingBufferMinutes),
		closingBufferMinutes: clampBuffer(raw.buffers?.closingBufferMinutes),
	}
	if (hours.isActive === false) {
		return { open: false, reason: 'inactive', messageKey: 'inactive' }
	}
	const { date, minute } = locationLocalClock(instantMs, hours.timeZone)
	let { ranges, rule } = rangesForDate(hours, date, kind)
	ranges = applyBuffersToRanges(ranges, buffers)
	const open = ranges.some(([from, to]) => minute >= from && minute <= to)
	if (open) {
		const base = isLocationOpenAt(hours, instantMs, kind)
		return { ...base, open: true, reason: null }
	}
	const reason =
		rule.kind === 'closed' ? rule.reason : ('outside_hours' as const)
	const messageKey =
		reason === 'special_closed'
			? 'closed_special'
			: reason === 'closed_weekday'
				? 'closed_weekday'
				: 'outside_online_hours'
	return {
		open: false,
		reason,
		messageKey,
		...(rule.kind === 'closed' && rule.note ? { note: rule.note } : {}),
	}
}

export function buildOnlineLocationHours(
	raw: OnlineAvailabilityInput,
): LocationHours {
	return parseLocationHours(raw, { malformedPolicy: 'closed' }).hours
}
