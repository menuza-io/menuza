import { addDays, businessDayStartMs, isValidTimeZone } from '@repo/zoned-time'

import {
	type LocationClosedReason,
	type LocationHours,
	locationLocalClock,
	locationOpenIntervals,
	type OpenInterval,
	ruleForDate,
} from '@repo/opening-hours'

export type EffectiveDaySource =
	'location_hours' | 'location_closed' | 'reservation_special_day' | 'weekly'

export type EffectiveDayClosedReason =
	LocationClosedReason | 'no_open_hours' | 'special_day'

export type EffectiveDay = {
	businessDate: string
	open: boolean
	onlineClosed: boolean
	source: EffectiveDaySource
	closedReason?: EffectiveDayClosedReason
	name?: string | null
	note?: string | null
	intervals: OpenInterval[] | null
}

export type ReservationDayInput = {
	closed: boolean
	onlineClosed: boolean
	specialDay?: {
		type?: string
		name?: string | null
		note?: string | null
	} | null
}

export function buildEffectiveDay(input: {
	businessDate: string
	hours: LocationHours | null | undefined
	dayStartMin: number
	reservation: ReservationDayInput
}): EffectiveDay {
	const { businessDate, hours, reservation } = input
	const specialName = reservation.specialDay?.name ?? null
	const specialNote = reservation.specialDay?.note ?? null
	let intervals: OpenInterval[] | null = null
	let locationNote: string | null = null

	if (hours) {
		if (hours.isActive === false) {
			return {
				businessDate,
				open: false,
				onlineClosed: true,
				source: 'location_closed',
				closedReason: 'inactive',
				name: null,
				note: null,
				intervals: [],
			}
		}
		const zone = isValidTimeZone(hours.timeZone) ? hours.timeZone : 'UTC'
		const dayStart = businessDayStartMs(businessDate, zone, input.dayStartMin)
		const dayEnd = businessDayStartMs(
			addDays(businessDate, 1),
			zone,
			input.dayStartMin,
		)
		const first = locationLocalClock(dayStart, zone).date
		const last = locationLocalClock(dayEnd - 1, zone).date
		intervals = locationOpenIntervals(hours, first, last)
		if (intervals !== null) {
			const overlaps = intervals.some(
				(iv) => iv.startMs < dayEnd && iv.endMs > dayStart,
			)
			if (!overlaps) {
				const rule = ruleForDate(hours, first)
				const closedReason: EffectiveDayClosedReason =
					rule.kind === 'closed' ? rule.reason : 'no_open_hours'
				return {
					businessDate,
					open: false,
					onlineClosed: true,
					source: 'location_closed',
					closedReason,
					name: null,
					note: rule.kind === 'closed' ? (rule.note ?? null) : null,
					intervals,
				}
			}
			const rule = ruleForDate(hours, first)
			if (rule.kind === 'slots' && rule.note) locationNote = rule.note
		}
	}

	if (reservation.closed) {
		return {
			businessDate,
			open: false,
			onlineClosed: true,
			source: 'reservation_special_day',
			closedReason: 'special_day',
			name: specialName,
			note: specialNote,
			intervals,
		}
	}
	if (reservation.onlineClosed || reservation.specialDay) {
		return {
			businessDate,
			open: true,
			onlineClosed: reservation.onlineClosed,
			source: 'reservation_special_day',
			name: specialName,
			note: specialNote ?? locationNote,
			intervals,
		}
	}
	return {
		businessDate,
		open: true,
		onlineClosed: false,
		source: intervals !== null ? 'location_hours' : 'weekly',
		name: null,
		note: locationNote,
		intervals,
	}
}

export function describeLocationClosedReason(
	reason: EffectiveDayClosedReason | undefined,
	note?: string | null,
): string {
	if (note) return note
	switch (reason) {
		case 'inactive':
			return 'Location inactive'
		case 'special_closed':
			return 'Closed for special hours'
		case 'closed_weekday':
			return 'Closed this weekday'
		case 'outside_hours':
		case 'no_open_hours':
			return 'Outside opening hours'
		default:
			return 'Closed'
	}
}
