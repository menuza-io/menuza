import {
	type TimesheetCard,
	type TimesheetDayView,
	type TimesheetPerson,
} from '@repo/staffing'

/**
 * Typed fixtures for the timesheet tests. They are declared with the server's
 * own response types, so a change to those types breaks compilation here, and
 * the schema tests then parse them to prove the browser still accepts what the
 * node sends.
 */

export const HOUR = 3_600_000
/** 2026-03-02 15:00 UTC = 09:00 in Chicago (CST, UTC-6). */
export const NINE_AM = Date.UTC(2026, 2, 2, 15, 0)

export function card(overrides: Partial<TimesheetCard> = {}): TimesheetCard {
	return {
		id: 'c1',
		staffId: 's1',
		scopeId: 'loc-1',
		positionId: 'p1',
		positionName: 'Server',
		positionNameAr: null,
		timeZone: 'America/Chicago',
		localDate: '2026-03-02',
		clockInAt: NINE_AM,
		clockOutAt: NINE_AM + 8 * HOUR,
		status: 'closed',
		issues: [],
		reviewed: false,
		edited: false,
		clockOutKind: 'manual',
		breaks: [],
		minutes: {
			regularMinutes: 480,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: 480,
			unpaidBreakMinutes: 0,
		},
		figuresChanged: false,
		managerNote: null,
		version: 1,
		approvedAt: null,
		lockedAt: null,
		...overrides,
	}
}

export function person(
	overrides: Partial<Omit<TimesheetPerson, 'cards' | 'totals'>> = {},
	cards: TimesheetCard[] = [card()],
): TimesheetPerson {
	const paid = cards.reduce((sum, c) => sum + c.minutes.paidMinutes, 0)
	return {
		staffId: 's1',
		firstName: 'Rana',
		lastName: 'Khalid',
		firstNameAr: null,
		lastNameAr: null,
		employeeNumber: null,
		terminated: false,
		cards,
		totals: {
			regularMinutes: paid,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: paid,
			unpaidBreakMinutes: 0,
			cards: cards.length,
			open: 0,
			needsReview: cards.filter((c) => c.status === 'needs_review').length,
			approved: 0,
			locked: 0,
		},
		...overrides,
	}
}

export function dayView(
	people: TimesheetPerson[] = [person()],
	overrides: Partial<TimesheetDayView> = {},
): TimesheetDayView {
	const cards = people.flatMap((p) => p.cards)
	const paid = cards.reduce((sum, c) => sum + c.minutes.paidMinutes, 0)
	return {
		serverNow: NINE_AM + 10 * HOUR,
		date: '2026-03-02',
		people,
		totals: {
			regularMinutes: paid,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: paid,
			unpaidBreakMinutes: 0,
			cards: cards.length,
			open: 0,
			needsReview: cards.filter((c) => c.status === 'needs_review').length,
			approved: 0,
			locked: 0,
		},
		filters: {
			scopeId: null,
			positionId: null,
			staffId: null,
			status: null,
		},
		truncated: false,
		...overrides,
	}
}
