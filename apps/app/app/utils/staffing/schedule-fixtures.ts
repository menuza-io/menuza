import {
	type DemandGuide,
	type ScheduleShiftView,
	type ScheduleWeekView,
	type SchedulePersonView,
} from '@repo/staffing'

/**
 * Typed fixtures for the schedule tests. They are declared with the server's
 * own response types, so a change to those types breaks compilation here, and
 * the schema tests then parse them to prove the browser still accepts what the
 * node sends.
 */

export const HOUR = 3_600_000
export const TZ = 'America/Chicago'
/** 2026-03-02 (a Monday) 15:00 UTC = 09:00 in Chicago (CST, UTC-6). */
export const NINE_AM = Date.UTC(2026, 2, 2, 15, 0)
export const WEEK_START = '2026-03-02'
export const DATES = [
	'2026-03-02',
	'2026-03-03',
	'2026-03-04',
	'2026-03-05',
	'2026-03-06',
	'2026-03-07',
	'2026-03-08',
]

export function shift(
	overrides: Partial<ScheduleShiftView> = {},
): ScheduleShiftView {
	return {
		id: 'sh1',
		scopeId: 'loc-1',
		staffId: 's1',
		positionId: 'p1',
		startsAt: NINE_AM,
		endsAt: NINE_AM + 8 * HOUR,
		localDate: '2026-03-02',
		timeZone: TZ,
		unpaidBreakMinutes: 30,
		paidMinutes: 450,
		notes: null,
		state: 'draft',
		published: null,
		version: 1,
		conflicts: [],
		...overrides,
	}
}

export function person(
	overrides: Partial<SchedulePersonView> = {},
): SchedulePersonView {
	return {
		id: 's1',
		firstName: 'Rana',
		lastName: 'Khalid',
		firstNameAr: null,
		lastNameAr: null,
		status: 'active',
		positionIds: ['p1'],
		showInSchedule: true,
		eligibleOpenShifts: true,
		weekMinutes: 0,
		overtimeMinutes: 0,
		...overrides,
	}
}

export function week(
	overrides: Partial<ScheduleWeekView> = {},
): ScheduleWeekView {
	return {
		estimate: true,
		scopeId: 'loc-1',
		timeZone: TZ,
		weekStart: WEEK_START,
		weekEnd: '2026-03-08',
		weekStartsOn: 1,
		dates: DATES,
		version: 0,
		lastPublishedAt: null,
		unpublishedCount: 0,
		people: [person()],
		shifts: [],
		overlays: [],
		footers: DATES.map((date) => ({
			date,
			minutes: 0,
			overtimeMinutes: 0,
			headcount: 0,
			openShifts: 0,
			openMinutes: 0,
		})),
		totals: { minutes: 0, overtimeMinutes: 0, openShifts: 0, openMinutes: 0 },
		pending: { timeOff: 0, availability: 0, shiftRequests: 0 },
		positions: [
			{ id: 'p1', name: 'Server', nameAr: null, colorKey: 'blue' },
			{ id: 'p2', name: 'Cook', nameAr: null, colorKey: 'orange' },
		],
		currencies: ['USD'],
		...overrides,
	}
}

export function demand(): DemandGuide {
	return {
		kind: 'guide',
		estimate: true,
		source: 'online_orders',
		statistic: 'median',
		weeks: 8,
		windowStart: '2026-01-05',
		windowEnd: '2026-03-01',
		daysWithOrders: 40,
		timeZone: TZ,
		days: DATES.map((date, index) => ({
			date,
			weekday: (index + 1) % 7,
			hours: Array.from({ length: 24 }, (ignored, hour) =>
				hour >= 11 && hour <= 14 ? 4 + (index % 3) : 0,
			),
			totalOrders: 20,
		})),
	}
}
