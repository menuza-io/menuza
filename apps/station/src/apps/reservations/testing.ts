import { type WaitlistEntry } from '@repo/reservations'
import {
	dayFeedSchema,
	reservationSchema,
	type DayFeed,
	type DayReservation,
} from './feed.ts'

/**
 * Small builders for the host stand's tests: a day in UTC with a few tables,
 * and bookings written by clock time (minutes after midnight).
 */

export const DATE = '2026-03-02'
export const MIDNIGHT = Date.UTC(2026, 2, 2)
export const MIN = 60_000
let counter = 0

/** The instant of a clock time on `DATE` (UTC). */
export const at = (minutes: number) => MIDNIGHT + minutes * MIN

export function rsv(
	over: Partial<Record<string, unknown>> & { start: number },
): DayReservation {
	const { start, ...rest } = over as { start: number } & Record<string, unknown>
	const duration = (rest.durationMin as number | undefined) ?? 90
	counter += 1
	return reservationSchema.parse({
		id: `r${counter}`,
		version: 1,
		status: 'booked',
		partySize: 2,
		localStartMin: start,
		time: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
		startAt: at(start),
		endAt: at(start + duration),
		durationMin: duration,
		tableIds: [],
		tableLabels: [],
		...rest,
	})
}

export function day(
	reservations: DayReservation[],
	extra: Partial<Record<string, unknown>> = {},
): DayFeed {
	return dayFeedSchema.parse({
		locationId: 'loc',
		businessDate: DATE,
		settings: { timeZone: 'UTC' },
		areas: [
			{ id: 'a1', name: 'Main', sort: 0 },
			{ id: 'a2', name: 'Patio', sort: 1 },
		],
		tables: [
			{ id: 't1', areaId: 'a1', label: '1', minCovers: 1, maxCovers: 2 },
			{ id: 't2', areaId: 'a1', label: '2', minCovers: 1, maxCovers: 4 },
			{ id: 't10', areaId: 'a1', label: '10', minCovers: 4, maxCovers: 8 },
			{ id: 'p1', areaId: 'a2', label: 'P1', minCovers: 1, maxCovers: 2 },
		],
		reservations,
		...extra,
	})
}

export const SERVICES = [
	{
		id: 'lunch',
		name: 'Lunch',
		firstSeatingMin: 11 * 60,
		lastSeatingMin: 14 * 60,
		endMin: 15 * 60,
	},
	{
		id: 'dinner',
		name: 'Dinner',
		firstSeatingMin: 17 * 60,
		lastSeatingMin: 21 * 60,
		endMin: 23 * 60,
	},
]

export function entry(over: Partial<WaitlistEntry> = {}): WaitlistEntry {
	counter += 1
	return {
		id: `w${counter}`,
		locationId: 'loc',
		businessDate: DATE,
		guestId: null,
		displayName: 'Rana Khalid',
		firstName: 'Rana',
		lastName: 'Khalid',
		phone: null,
		email: null,
		partySize: 2,
		areaPrefId: null,
		channel: 'walk_in',
		status: 'waiting',
		quotedMin: 10,
		quotedReadyAt: null,
		notifiedAt: null,
		responseDeadlineAt: null,
		reservationId: null,
		sortKey: counter,
		notes: null,
		smsOptIn: false,
		locale: null,
		version: 1,
		joinedAt: at(12 * 60),
		createdAt: at(12 * 60),
		position: counter,
		...over,
	}
}
