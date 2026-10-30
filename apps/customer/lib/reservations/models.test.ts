import { describe, expect, it } from '@jest/globals'
import { ApiError } from '../api/api-error'
import {
	acceptsRequests,
	canRunLate,
	countdownClock,
	hasSlots,
	interpretPaymentStatus,
	isAlternativesEmpty,
	isFinalPaymentOutcome,
	makeGuestDetails,
	makeSlot,
	parseServerTime,
	ReservationApiError,
	reservationAvailabilitySchema,
	reservationBookingSchema,
	reservationCalendarSchema,
	reservationErrorFrom,
	reservationHoldSchema,
	reservationManageViewSchema,
	reservationMineSchema,
	reservationPaymentStatusSchema,
	reservationsConfigSchema,
	reservationWaitlistJoinSchema,
	reservationWaitlistStatusSchema,
	sameGuestDetails,
	timeLabel,
} from './models'
import {
	decodeFixture,
	FIXTURE_NAMES,
	fixtureJson,
	fixtureText,
} from '@/test/reservations/fixtures'

describe('reservation models', () => {
	it('lists every fixture file and each has content', () => {
		expect(FIXTURE_NAMES).toHaveLength(20)
		for (const name of FIXTURE_NAMES) {
			expect([name, fixtureText(name).length > 2]).toEqual([name, true])
		}
	})

	it('decodes the config', () => {
		const config = decodeFixture(reservationsConfigSchema, 'config')
		expect(config.organization.name).toBe('Acme Bistro')
		const location = config.locations[0]!
		expect(location.id).toBe('loc_pub_main')
		expect(location.partySize).toEqual({ min: 1, max: 4 })
		expect(location.holdMinutes).toBe(7)
		expect(acceptsRequests(location.largeParty)).toBe(true)
		expect(location.waitlist.online).toBe(true)
		expect(location.notifyMe).toBe(true)
		expect(location.areas.map((area) => area.name)).toEqual(['Main Room'])
		expect(config.occasions.map((chip) => chip.name)).toEqual(['Birthday'])
		expect(config.dietary.map((chip) => chip.name)).toEqual(['Nut allergy'])
	})

	it('decodes availability with slots', () => {
		const availability = decodeFixture(
			reservationAvailabilitySchema,
			'availability',
		)
		expect(availability.status).toBe('available')
		expect(hasSlots(availability)).toBe(true)
		expect(availability.slots[0]?.time).toHaveLength(5)
		expect(availability.timeZone).toBe('UTC')
		expect(availability.waitlist).toBe(true)
	})

	it('decodes the alternatives when the preferred time is taken', () => {
		const availability = decodeFixture(
			reservationAvailabilitySchema,
			'availability-preferred-taken',
		)
		expect(isAlternativesEmpty(availability.alternatives)).toBe(false)
		expect(availability.alternatives.sameDay.length).toBeGreaterThan(0)
		expect(availability.alternatives.otherDates.length).toBeGreaterThan(0)
		expect(availability.slots.some((slot) => slot.localMin === 18 * 60)).toBe(
			false,
		)
	})

	it('decodes the calendar', () => {
		const calendar = decodeFixture(reservationCalendarSchema, 'calendar')
		expect(calendar.days).toHaveLength(4)
		expect(calendar.days.every((day) => day.hasAvailability)).toBe(true)
	})

	it('decodes a hold and a hold with a policy', () => {
		const hold = decodeFixture(reservationHoldSchema, 'hold')
		expect(hold.holdToken.startsWith('hold_fixture_token_')).toBe(true)
		expect(hold.requiresPayment).toBeUndefined()
		expect(hold.policy).toBeUndefined()

		const paid = decodeFixture(reservationHoldSchema, 'hold-requires-payment')
		expect(paid.requiresPayment).toBe(true)
		expect(paid.policy?.purpose).toBe('deposit')
		expect(paid.policy?.totalAmountMinor).toBe(10_000)
		expect(paid.policy?.termsVersion).toBe(2)
	})

	it('decodes a booking, a request and a pending payment', () => {
		const booked = decodeFixture(reservationBookingSchema, 'booking')
		expect(booked.reservation.status).toBe('booked')
		expect(booked.reservation.channel).toBe('native')
		expect(booked.reservation.confirmationCode).toHaveLength(8)
		expect(booked.payment).toBeUndefined()

		const requested = decodeFixture(reservationBookingSchema, 'request')
		expect(requested.reservation.status).toBe('requested')

		const pending = decodeFixture(
			reservationBookingSchema,
			'booking-pending-payment',
		)
		expect(pending.reservation.status).toBe('pending_payment')
		expect(pending.reservation.paymentStatus).toBe('pending')
		expect(pending.payment?.purpose).toBe('deposit')
		expect(pending.payment?.amountMinor).toBe(10_000)
		expect(pending.payment?.payUrl).toContain('/reserve/pay#')
	})

	it('decodes the manage view', () => {
		const view = decodeFixture(reservationManageViewSchema, 'manage')
		expect(view.status).toBe('booked')
		expect(view.canModify).toBe(true)
		expect(view.canCancel).toBe(true)
		expect(view.cancelDeadline).not.toBeNull()
		expect(view.policy).toBeNull()
		expect(view.paymentStatus).toBe('none')
		expect(view.reservation.location.id).toBe('loc_pub_main')
		expect(view.contact.phone).not.toBeNull()
	})

	it('decodes mine', () => {
		const mine = decodeFixture(reservationMineSchema, 'mine')
		expect(mine.upcoming).toHaveLength(1)
		expect(mine.past).toHaveLength(0)
		expect(mine.upcoming[0]!.manageToken.length).toBeGreaterThan(0)
	})

	it('reads a payment status of exactly three fields', () => {
		const status = decodeFixture(
			reservationPaymentStatusSchema,
			'payment-status-pending',
		)
		expect(status.paymentStatus).toBe('pending')
		expect(status.reservationStatus).toBe('pending_payment')
		expect(new Set(Object.keys(fixtureJson('payment-status-pending')))).toEqual(
			new Set(['paymentStatus', 'reservationStatus', 'now']),
		)

		const none = decodeFixture(
			reservationPaymentStatusSchema,
			'payment-status-none',
		)
		expect(none.paymentStatus).toBe('none')
	})

	it('tolerates fields and statuses a newer server adds', () => {
		const status = decodeFixture(reservationPaymentStatusSchema, {
			...fixtureJson('payment-status-pending'),
			paymentStatus: 'something_new',
			extra: true,
		})
		expect(status).toEqual({
			paymentStatus: 'something_new',
			reservationStatus: 'pending_payment',
			now: fixtureJson('payment-status-pending').now,
		})
		const view = fixtureJson('manage')
		view.status = 'something_new'
		expect(decodeFixture(reservationManageViewSchema, view).status).toBe(
			'something_new',
		)
	})

	it('decodes the waitlist', () => {
		const joined = decodeFixture(reservationWaitlistJoinSchema, 'waitlist-join')
		expect(joined.entry.status).toBe('waiting')
		expect(joined.entry.position).toBe(1)
		expect(joined.statusToken.length).toBeGreaterThan(0)

		const status = decodeFixture(
			reservationWaitlistStatusSchema,
			'waitlist-status',
		)
		expect(status.status).toBe('waiting')
		expect(status.canLeave).toBe(true)
		expect(status.canOnMyWay).toBe(true)
		expect(status.notifiedAt).toBeNull()
	})

	it('decodes every error fixture', () => {
		const slot = reservationErrorFrom(
			409,
			fixtureText('error-slot-unavailable'),
		)
		expect(slot.code).toBe('slot_unavailable')
		expect(slot.alternatives?.sameDay.length).toBeGreaterThan(0)

		expect(
			reservationErrorFrom(410, fixtureText('error-hold-expired')).code,
		).toBe('hold_expired')
		expect(
			reservationErrorFrom(400, fixtureText('error-policy-required')).code,
		).toBe('policy_required')

		const limited = reservationErrorFrom(429, fixtureText('error-rate-limited'))
		expect(limited.code).toBe('rate_limited')
		expect(limited.reason).toBe('phone_active_limit')

		expect(reservationErrorFrom(400, fixtureText('error-invalid')).code).toBe(
			'invalid',
		)
	})

	it('makes reservation errors API errors, with a fallback code', () => {
		const error = reservationErrorFrom(500, 'not json')
		expect(error).toBeInstanceOf(ApiError)
		expect(error).toBeInstanceOf(ReservationApiError)
		expect(error.status).toBe(500)
		expect(error.errorCode).toBe('error')
		expect(error.reason).toBeNull()
		expect(error.alternatives).toBeNull()
	})

	it('parses server timestamps with and without milliseconds', () => {
		const withMs = parseServerTime('2030-06-14T16:00:00.000Z')
		const without = parseServerTime('2030-06-14T16:00:00Z')
		expect(withMs).not.toBeNull()
		expect(withMs).toBe(without)
		expect(parseServerTime('not a date')).toBeNull()
		expect(parseServerTime('')).toBeNull()
	})

	it('wraps late-night slots in the time label', () => {
		expect(timeLabel(19 * 60 + 5)).toBe('19:05')
		expect(timeLabel(24 * 60 + 30)).toBe('00:30')
		expect(makeSlot({ localMin: 1140 })).toEqual({
			localMin: 1140,
			time: '19:00',
			serviceId: null,
			serviceName: null,
			areaId: null,
			areaLabel: null,
		})
	})

	it('formats a countdown clock', () => {
		expect(countdownClock(420_000)).toBe('7:00')
		expect(countdownClock(44_001)).toBe('0:45')
		expect(countdownClock(-5)).toBe('0:00')
	})

	it('follows the Sites rules for the payment outcome', () => {
		const outcome = (paymentStatus: string, reservationStatus: string) =>
			interpretPaymentStatus({ paymentStatus, reservationStatus })
		expect(outcome('paid', 'booked')).toBe('paid')
		expect(outcome('guaranteed', 'booked')).toBe('paid')
		expect(outcome('pending', 'pending_payment')).toBe('pending')
		expect(outcome('pending', 'expired')).toBe('expired')
		expect(outcome('pending', 'cancelled')).toBe('expired')
		expect(outcome('review', 'pending_payment')).toBe('review')
		expect(outcome('disputed', 'booked')).toBe('review')
		expect(outcome('refunded', 'cancelled')).toBe('refunded')
		expect(outcome('fee_failed', 'booked')).toBe('failed')
		// An unknown future status keeps polling rather than claiming success.
		expect(outcome('something_new', 'pending_payment')).toBe('pending')
		expect(isFinalPaymentOutcome('pending')).toBe(false)
		expect(isFinalPaymentOutcome('paid')).toBe(true)
	})

	it('offers running late until 30 minutes after the start, on the server clock', () => {
		const view = decodeFixture(reservationManageViewSchema, 'manage')
		const startAt = parseServerTime(view.reservation.startAt)!
		const at = (ms: number) => ({ ...view, now: new Date(ms).toISOString() })
		expect(canRunLate(at(startAt + 29 * 60_000))).toBe(true)
		expect(canRunLate(at(startAt + 30 * 60_000))).toBe(false)
		expect(canRunLate({ ...at(startAt), status: 'requested' })).toBe(false)
	})

	it('compares guest details field by field', () => {
		const details = makeGuestDetails({
			firstName: 'Ada',
			phone: '+14155553001',
		})
		expect(sameGuestDetails(details, { ...details })).toBe(true)
		expect(sameGuestDetails(details, { ...details, dietary: 'x' })).toBe(false)
		expect(makeGuestDetails().locale).toBe('en')
	})
})
