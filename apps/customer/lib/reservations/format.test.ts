import { describe, expect, it } from '@jest/globals'
import { type BookingFailure } from './booking-flow'
import {
	dateLabel,
	dayNumber,
	failureMessageKey,
	formatMoney,
	isSlotUnavailable,
	clock,
	ltr,
	money,
	RESERVATION_MESSAGE_KEYS,
	reservationStatusKey,
	shortWeekday,
	timeOfDay,
} from './format'

describe('ltr', () => {
	it('wraps in a left-to-right isolate', () => {
		expect(ltr('7:00 PM')).toBe('⁦7:00 PM⁩')
	})
})

describe('business dates', () => {
	it('labels a date in the app language', () => {
		expect(dateLabel('2030-06-24', 'en')).toBe('Mon, Jun 24')
	})

	it('returns an unreadable date as is', () => {
		expect(dateLabel('2030-13-40', 'en')).toBe('2030-13-40')
		expect(dateLabel('soon', 'en')).toBe('soon')
	})

	it('falls back to English for an unknown locale', () => {
		expect(dateLabel('2030-06-24', 'not-a-locale')).toBe('Mon, Jun 24')
	})

	it('gives the short weekday, empty for an unreadable date', () => {
		expect(shortWeekday('2030-06-24', 'en')).toBe('Mon')
		expect(shortWeekday('soon', 'en')).toBe('')
	})

	it('gives the day of the month without a leading zero', () => {
		expect(dayNumber('2030-06-04')).toBe('4')
		expect(dayNumber('2030-06-24')).toBe('24')
	})
})

describe('timeOfDay', () => {
	const instant = Date.parse('2030-06-14T16:00:00.000Z')

	it("formats an instant in the booking's own zone", () => {
		expect(timeOfDay(instant, 'UTC', 'en')).toBe('⁦4:00 PM⁩')
		expect(timeOfDay(instant, 'America/New_York', 'en')).toBe('⁦12:00 PM⁩')
	})

	it('falls back to UTC for an unknown zone', () => {
		expect(timeOfDay(instant, 'Nowhere/Special', 'en')).toBe('⁦4:00 PM⁩')
	})
})

describe('money', () => {
	it('formats minor units with the currency decimals', () => {
		expect(money(2500, 'USD', 'en')).toBe('$25.00')
		expect(money(2500, 'JPY', 'en')).toBe('¥2,500')
		expect(formatMoney({ minor: 10000, currency: 'SAR' }, 'en')).toBe(
			'SAR 100.00',
		)
	})

	it('shows the raw minor units when the currency is unknown', () => {
		expect(money(1234, 'NOPE', 'en')).toBe('1234')
	})
})

describe('clock', () => {
	it('formats a countdown as m:ss', () => {
		expect(clock(7 * 60_000)).toBe('7:00')
		expect(clock(59_000)).toBe('0:59')
		expect(clock(0)).toBe('0:00')
	})
})

describe('failureMessageKey', () => {
	const cases: Array<[BookingFailure, string]> = [
		[
			{
				kind: 'slotUnavailable',
				alternatives: { sameDay: [], otherDates: [] },
			},
			'rsv.error.slotUnavailable',
		],
		[{ kind: 'holdExpired' }, 'rsv.error.holdExpired'],
		[{ kind: 'policyRequired' }, 'rsv.error.policyRequired'],
		[{ kind: 'paymentUnavailable' }, 'rsv.error.paymentUnavailable'],
		[{ kind: 'rateLimited', reason: null }, 'rsv.error.rateLimited'],
		[
			{ kind: 'rateLimited', reason: 'phone_active_limit' },
			'rsv.error.tooManyActive',
		],
		[{ kind: 'signInRequired' }, 'rsv.error.signIn'],
		[{ kind: 'phoneOverlap' }, 'rsv.error.phoneOverlap'],
		[{ kind: 'partySizeInvalid' }, 'rsv.error.partySize'],
		[{ kind: 'invalid' }, 'rsv.error.invalid'],
		[{ kind: 'largePartyOnly' }, 'rsv.error.largeParty'],
		[{ kind: 'requestsClosed' }, 'rsv.error.requestsClosed'],
		[{ kind: 'paused' }, 'rsv.error.paused'],
		[{ kind: 'notFound' }, 'rsv.error.notFound'],
		[{ kind: 'alreadyOnWaitlist' }, 'rsv.error.waitlistDuplicate'],
		[{ kind: 'waitlistFull' }, 'rsv.error.waitlistFull'],
		[{ kind: 'paymentFailed' }, 'rsv.pay.failed'],
		[{ kind: 'paymentRefunded' }, 'rsv.pay.refunded'],
		[{ kind: 'offline' }, 'rsv.error.offline'],
		[{ kind: 'idempotencyConflict' }, 'rsv.error.generic'],
		[{ kind: 'generic' }, 'rsv.error.generic'],
	]

	it.each(cases)('maps %s to %s', (failure, key) => {
		expect(failureMessageKey(failure)).toBe(key)
	})

	it('only produces keys the catalog lists', () => {
		for (const [failure] of cases) {
			expect(RESERVATION_MESSAGE_KEYS).toContain(failureMessageKey(failure))
		}
	})

	it('spots a taken slot', () => {
		expect(isSlotUnavailable({ kind: 'offline' })).toBe(false)
		expect(
			isSlotUnavailable({
				kind: 'slotUnavailable',
				alternatives: { sameDay: [], otherDates: [] },
			}),
		).toBe(true)
	})
})

describe('reservationStatusKey', () => {
	it('maps every known status', () => {
		expect(reservationStatusKey('booked')).toBe('rsv.status.booked')
		expect(reservationStatusKey('pending_payment')).toBe(
			'rsv.status.pending_payment',
		)
		expect(reservationStatusKey('no_show')).toBe('rsv.status.no_show')
	})

	it('falls back to a generic label for a status the app predates', () => {
		expect(reservationStatusKey('waitlisted')).toBe('rsv.status.other')
	})
})

describe('RESERVATION_MESSAGE_KEYS', () => {
	it('has no duplicates', () => {
		expect(new Set(RESERVATION_MESSAGE_KEYS).size).toBe(
			RESERVATION_MESSAGE_KEYS.length,
		)
	})
})
