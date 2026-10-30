import { describe, expect, it } from '@jest/globals'
import { ApiError, unauthorizedError } from '../api/api-error'
import {
	BookingFlow,
	type BookingFailure,
	holdCountdownLabel,
	holdRemainingMs,
	isRetryableWithSameKey,
	makeIdempotencyKey,
	manageActions,
	mapBookingFailure,
	PaymentPoll,
	reservationDateStrip,
	sameBookingFailure,
	WaitlistFlow,
} from './booking-flow'
import {
	makeGuestDetails,
	NO_ALTERNATIVES,
	partyCeiling,
	needsApproval,
	parseServerTime,
	ReservationApiError,
	reservationAvailabilitySchema,
	reservationBookingSchema,
	reservationErrorFrom,
	reservationHoldSchema,
	reservationManageViewSchema,
	reservationPaymentStatusSchema,
	reservationsConfigSchema,
	reservationWaitlistJoinSchema,
	reservationWaitlistStatusSchema,
	type ReservationHold,
	type ReservationSlot,
} from './models'
import {
	decodeFixture,
	fixtureJson,
	fixtureText,
} from '@/test/reservations/fixtures'

const base = parseServerTime('2030-06-14T16:00:00.000Z')!
const SECOND = 1000

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

/**
 * A hold whose server clock reads `serverNow` and which expires `seconds`
 * after that, regardless of what the device clock says.
 */
function makeHold(
	options: {
		token?: string
		serverNow?: number
		expiresIn?: number
		requiresPayment?: boolean
	} = {},
): ReservationHold {
	const now = options.serverNow ?? base
	const object: Record<string, unknown> = {
		holdToken: options.token ?? 'hold_token_0001',
		expiresAt: iso(now + (options.expiresIn ?? 420) * SECOND),
		now: iso(now),
		locationId: 'loc_pub_main',
		slot: {
			date: '2030-06-24',
			localMin: 1140,
			partySize: 2,
			serviceId: 'svc_pub_dinner',
		},
	}
	if (options.requiresPayment) {
		object.requiresPayment = true
		object.policy = {
			kind: 'deposit',
			purpose: 'deposit',
			termsVersion: 2,
			terms: 'Terms',
			amountMinor: 2500,
			totalAmountMinor: 5000,
			perCover: true,
			currency: 'USD',
			freeCancelUntilMin: 1440,
			lateCancelFeeMinor: 0,
			noShowFeeMinor: 0,
		}
	}
	return reservationHoldSchema.parse(object)
}

const details = makeGuestDetails({
	firstName: 'Ada',
	lastName: 'Lovelace',
	phone: '+14155553001',
	email: '',
})

const availability = () =>
	decodeFixture(reservationAvailabilitySchema, 'availability')

function firstSlot(flow: BookingFlow): ReservationSlot {
	const slot = flow.availability?.slots[0]
	if (!slot) throw new Error('the fixture has no slots')
	return slot
}

function searchedFlow(key = 'key-0001'): BookingFlow {
	const flow = new BookingFlow(() => key)
	flow.beginSearch('loc_pub_main', '2030-06-24', 2)
	flow.receiveAvailability(availability())
	return flow
}

function holdingFlow(
	options: { requiresPayment?: boolean; key?: string } = {},
): BookingFlow {
	const flow = searchedFlow(options.key)
	flow.select(firstSlot(flow))
	flow.receiveHold(makeHold({ requiresPayment: options.requiresPayment }), base)
	return flow
}

function counter(prefix: string) {
	let count = 0
	return {
		get count() {
			return count
		},
		make: () => {
			count += 1
			return `${prefix}-${count}`
		},
	}
}

const paymentStatus = (paymentStatus: string, reservationStatus: string) => ({
	paymentStatus,
	reservationStatus,
	now: '',
})

describe('BookingFlow transitions', () => {
	it('goes search, slot, hold, details, review, submit, confirmed', () => {
		const flow = new BookingFlow(() => 'key-0001')
		expect(flow.phase).toEqual({ kind: 'idle' })

		flow.beginSearch('loc_pub_main', '2030-06-24', 2)
		expect(flow.phase).toEqual({ kind: 'searching' })

		flow.receiveAvailability(availability())
		expect(flow.phase).toEqual({ kind: 'choosingTime' })
		expect(flow.offersRequest).toBe(false)

		const slot = firstSlot(flow)
		flow.select(slot)
		expect(flow.phase).toEqual({ kind: 'holding' })
		expect(flow.selectedSlot).toEqual(slot)

		flow.receiveHold(makeHold(), base)
		expect(flow.phase).toEqual({ kind: 'details' })
		expect(flow.hold).not.toBeNull()

		expect(flow.canReview(details, false)).toBe(true)
		flow.proceedToReview()
		expect(flow.phase).toEqual({ kind: 'reviewing' })

		const key = flow.beginSubmit(details)
		expect(key).toBe('key-0001')
		expect(flow.phase).toEqual({ kind: 'submitting' })

		flow.receiveBooking(decodeFixture(reservationBookingSchema, 'booking'))
		expect(flow.phase).toEqual({ kind: 'confirmed' })
		expect(flow.hold).toBeNull()
		expect(flow.idempotencyKey).toBeNull()
		expect(flow.booking?.reservation.status).toBe('booked')
	})

	it('waits for payment on a deposit booking, then confirms on paid', () => {
		const flow = holdingFlow({ requiresPayment: true })
		expect(flow.needsPolicyConsent).toBe(true)
		expect(flow.policyTermsVersion).toBe('2')
		// A policy needs consent.
		expect(flow.canReview(details, false)).toBe(false)
		expect(flow.canReview(details, true)).toBe(true)

		flow.proceedToReview()
		flow.beginSubmit(details)
		flow.receiveBooking(
			decodeFixture(reservationBookingSchema, 'booking-pending-payment'),
		)
		expect(flow.phase).toEqual({ kind: 'awaitingPayment' })

		const pending = flow.receivePaymentStatus(
			decodeFixture(reservationPaymentStatusSchema, 'payment-status-pending'),
		)
		expect(pending).toBe('pending')
		expect(flow.phase).toEqual({ kind: 'awaitingPayment' })

		const paid = flow.receivePaymentStatus(paymentStatus('paid', 'booked'))
		expect(paid).toBe('paid')
		expect(flow.phase).toEqual({ kind: 'confirmed' })
	})

	it('stops the payment wait on final outcomes; expired ends the attempt', () => {
		function awaiting(): BookingFlow {
			const flow = holdingFlow({ requiresPayment: true })
			flow.proceedToReview()
			flow.beginSubmit(details)
			flow.receiveBooking(
				decodeFixture(reservationBookingSchema, 'booking-pending-payment'),
			)
			return flow
		}
		const expired = awaiting()
		expired.receivePaymentStatus(paymentStatus('pending', 'expired'))
		expect(expired.phase).toEqual({ kind: 'expired' })

		const review = awaiting()
		const outcome = review.receivePaymentStatus(
			paymentStatus('review', 'pending_payment'),
		)
		expect(outcome).toBe('review')
		expect(outcome).not.toBe('pending')
		// Review keeps the booking page and says it is being checked.
		expect(review.phase).toEqual({ kind: 'awaitingPayment' })

		const refunded = awaiting()
		refunded.receivePaymentStatus(paymentStatus('refunded', 'cancelled'))
		expect(refunded.phase).toEqual({
			kind: 'failed',
			failure: { kind: 'paymentRefunded' },
		})
	})

	it('ends a large-party request as requested', () => {
		const flow = new BookingFlow(() => 'key-0007')
		flow.beginSearch('loc_pub_main', '2030-06-24', 8)
		// The location is in request mode for this party size.
		const object = fixtureJson('availability')
		object.status = 'large_party'
		object.slots = []
		flow.receiveAvailability(
			decodeFixture(reservationAvailabilitySchema, object),
		)
		expect(flow.offersRequest).toBe(true)
		flow.setRequestTime(19 * 60)
		expect(flow.selectedSlot?.localMin).toBe(1140)
		// A request never holds a table.
		expect(flow.phase).toEqual({ kind: 'choosingTime' })
		expect(flow.beginSubmit(details, true)).toBe('key-0007')
		flow.receiveBooking(decodeFixture(reservationBookingSchema, 'request'))
		expect(flow.phase).toEqual({ kind: 'requested' })
	})
})

describe('BookingFlow countdown', () => {
	it('uses the server clock, not the device clock', () => {
		// The device clock runs 3 minutes behind the server.
		const deviceNow = base - 180 * SECOND
		const flow = searchedFlow()
		flow.select(firstSlot(flow))
		flow.receiveHold(makeHold({ serverNow: base, expiresIn: 420 }), deviceNow)

		const hold = flow.hold!
		expect(hold.clockOffsetMs).toBe(180 * SECOND)
		expect(holdRemainingMs(hold, deviceNow)).toBe(420 * SECOND)
		expect(holdCountdownLabel(hold, deviceNow)).toBe('7:00')

		// 419 seconds later on the device the hold has 1 second left.
		expect(holdRemainingMs(hold, deviceNow + 419 * SECOND)).toBe(SECOND)
		expect(flow.tick(deviceNow + 419 * SECOND)).toBe(false)
		expect(flow.phase).toEqual({ kind: 'details' })

		// A naive "device now + 7 minutes" deadline would still be open here.
		expect(flow.tick(deviceNow + 420 * SECOND)).toBe(true)
		expect(flow.phase).toEqual({ kind: 'expired' })
		expect(flow.hold).toBeNull()
	})

	it('expires a hold while reviewing but not while submitting', () => {
		const reviewing = holdingFlow()
		reviewing.proceedToReview()
		expect(reviewing.tick(base + 500 * SECOND)).toBe(true)
		expect(reviewing.phase).toEqual({ kind: 'expired' })

		const submitting = holdingFlow()
		submitting.proceedToReview()
		submitting.beginSubmit(details)
		// The server decides an in-flight booking.
		expect(submitting.tick(base + 500 * SECOND)).toBe(false)
		expect(submitting.phase).toEqual({ kind: 'submitting' })
	})

	it('formats the countdown label as minutes and seconds', () => {
		const hold = holdingFlow().hold!
		expect(holdCountdownLabel(hold, base + 375 * SECOND)).toBe('0:45')
		expect(holdCountdownLabel(hold, base + 1000 * SECOND)).toBe('0:00')
	})
})

describe('BookingFlow alternatives and errors', () => {
	it('surfaces the alternatives of a slot_unavailable answer', () => {
		const flow = holdingFlow()
		flow.proceedToReview()
		flow.beginSubmit(details)
		flow.receiveError(
			reservationErrorFrom(409, fixtureText('error-slot-unavailable')),
		)

		const current = flow.phase
		if (
			current.kind !== 'failed' ||
			current.failure.kind !== 'slotUnavailable'
		) {
			throw new Error(
				`expected slotUnavailable, got ${JSON.stringify(current)}`,
			)
		}
		const offered = current.failure.alternatives
		expect(offered.sameDay.length).toBeGreaterThan(0)
		expect(flow.alternatives).toEqual(offered)
		expect(flow.hold).toBeNull()
		// A refused booking never reuses its key.
		expect(flow.idempotencyKey).toBeNull()

		// Choosing an alternative goes back through a fresh hold.
		flow.select(offered.sameDay[0]!)
		expect(flow.phase).toEqual({ kind: 'holding' })
	})

	it('replaces an expired hold when the guest picks a time again', () => {
		const flow = holdingFlow()
		expect(flow.tick(base + 900 * SECOND)).toBe(true)
		expect(flow.phase).toEqual({ kind: 'expired' })
		flow.receiveAvailability(availability())
		expect(flow.phase).toEqual({ kind: 'choosingTime' })
		flow.select(firstSlot(flow))
		expect(flow.phase).toEqual({ kind: 'holding' })
		flow.receiveHold(
			makeHold({ token: 'hold_token_0002' }),
			base + 900 * SECOND,
		)
		expect(flow.phase).toEqual({ kind: 'details' })
		expect(flow.hold?.token).toBe('hold_token_0002')
	})

	it('keeps the hold when the times refresh while details are open', () => {
		const flow = holdingFlow()
		flow.receiveAvailability(availability())
		expect(flow.phase).toEqual({ kind: 'details' })
		expect(flow.hold).not.toBeNull()
	})

	it('keeps the availability alternatives when the preferred time is taken', () => {
		const flow = new BookingFlow()
		flow.beginSearch('loc_pub_main', '2030-06-25', 4)
		flow.receiveAvailability(
			decodeFixture(
				reservationAvailabilitySchema,
				'availability-preferred-taken',
			),
		)
		expect(flow.alternatives.sameDay.length).toBeGreaterThan(0)
		expect(flow.alternatives.otherDates.length).toBeGreaterThan(0)
		flow.selectAlternative(flow.alternatives.otherDates[0]!.date)
		expect(flow.phase).toEqual({ kind: 'searching' })
		expect(flow.alternatives).toEqual(NO_ALTERNATIVES)
	})

	it('maps the documented error codes', () => {
		const map = (status: number, code: string, reason: string | null = null) =>
			mapBookingFailure(new ReservationApiError(status, code, { reason }))
		expect(map(409, 'slot_unavailable')).toEqual({
			kind: 'slotUnavailable',
			alternatives: NO_ALTERNATIVES,
		})
		expect(map(410, 'hold_expired')).toEqual({ kind: 'holdExpired' })
		expect(map(400, 'policy_required')).toEqual({ kind: 'policyRequired' })
		expect(map(429, 'rate_limited')).toEqual({
			kind: 'rateLimited',
			reason: null,
		})
		expect(map(429, 'rate_limited', 'phone_active_limit')).toEqual({
			kind: 'rateLimited',
			reason: 'phone_active_limit',
		})
		expect(map(403, 'verification_failed')).toEqual({ kind: 'signInRequired' })
		expect(map(503, 'unavailable')).toEqual({ kind: 'paused' })
		expect(map(404, 'not_found')).toEqual({ kind: 'notFound' })
		expect(map(409, 'phone_overlap')).toEqual({ kind: 'phoneOverlap' })
		expect(map(410, 'something_else')).toEqual({ kind: 'holdExpired' })
		expect(mapBookingFailure(new ApiError(0, 'x'))).toEqual({ kind: 'offline' })
		expect(mapBookingFailure(unauthorizedError())).toEqual({
			kind: 'signInRequired',
		})
	})

	it('maps every remaining code and status fallback', () => {
		const map = (status: number, code: string) =>
			mapBookingFailure(new ReservationApiError(status, code)).kind
		expect(map(422, 'policy_unavailable')).toBe('paymentUnavailable')
		expect(map(403, 'forbidden')).toBe('signInRequired')
		expect(map(401, 'unauthorized')).toBe('signInRequired')
		expect(map(400, 'party_size_invalid')).toBe('partySizeInvalid')
		expect(map(400, 'invalid')).toBe('invalid')
		expect(map(400, 'large_party')).toBe('largePartyOnly')
		expect(map(400, 'requests_closed')).toBe('requestsClosed')
		expect(map(409, 'already_on_waitlist')).toBe('alreadyOnWaitlist')
		expect(map(409, 'waitlist_full')).toBe('waitlistFull')
		expect(map(409, 'idempotency_conflict')).toBe('idempotencyConflict')
		expect(map(429, 'error')).toBe('rateLimited')
		expect(map(503, 'error')).toBe('paused')
		expect(map(404, 'error')).toBe('notFound')
		expect(map(401, 'error')).toBe('signInRequired')
		expect(map(403, 'error')).toBe('signInRequired')
		expect(map(500, 'error')).toBe('generic')
		expect(mapBookingFailure(new ApiError(403, 'x')).kind).toBe(
			'signInRequired',
		)
		expect(mapBookingFailure(new ApiError(429, 'x')).kind).toBe('rateLimited')
		expect(mapBookingFailure(new ApiError(404, 'x')).kind).toBe('notFound')
		expect(mapBookingFailure(new ApiError(200, 'x')).kind).toBe('generic')
		expect(mapBookingFailure(new TypeError('x')).kind).toBe('offline')
	})

	it('ends the attempt when the server says the hold expired', () => {
		const flow = holdingFlow()
		flow.proceedToReview()
		flow.beginSubmit(details)
		flow.receiveError(new ReservationApiError(410, 'hold_expired'))
		expect(flow.phase).toEqual({ kind: 'expired' })
		expect(flow.hold).toBeNull()
	})
})

describe('BookingFlow idempotency', () => {
	it('reuses the idempotency key for a retry after a network error', () => {
		const keys = counter('key')
		const flow = new BookingFlow(keys.make)
		flow.beginSearch('loc_pub_main', '2030-06-24', 2)
		flow.receiveAvailability(availability())
		flow.select(firstSlot(flow))
		flow.receiveHold(makeHold(), base)
		flow.proceedToReview()

		expect(flow.beginSubmit(details)).toBe('key-1')
		flow.receiveError(new ApiError(0, 'offline'))
		expect(flow.phase).toEqual({ kind: 'failed', failure: { kind: 'offline' } })
		expect(flow.idempotencyKey).toBe('key-1')

		// Same details, same key: the server replays instead of booking twice.
		expect(flow.beginSubmit(details)).toBe('key-1')
		expect(flow.phase).toEqual({ kind: 'submitting' })
		flow.receiveError(new ApiError(0, 'offline'))

		// Changed details are a different request and need a different key.
		const edited = { ...details, requests: 'Quiet table' }
		flow.backToDetails()
		expect(flow.phase).toEqual({ kind: 'details' })
		flow.proceedToReview()
		expect(flow.beginSubmit(edited)).toBe('key-2')
		expect(keys.count).toBe(2)
	})

	it('does not keep the key of a refused booking', () => {
		const flow = holdingFlow()
		flow.proceedToReview()
		flow.beginSubmit(details)
		flow.receiveError(new ReservationApiError(400, 'invalid'))
		expect(flow.idempotencyKey).toBeNull()
		expect(flow.phase).toEqual({ kind: 'failed', failure: { kind: 'invalid' } })
	})

	it('never retries a rate limit for too many active bookings', () => {
		expect(
			isRetryableWithSameKey({
				kind: 'rateLimited',
				reason: 'phone_active_limit',
			}),
		).toBe(false)
		expect(isRetryableWithSameKey({ kind: 'rateLimited', reason: null })).toBe(
			true,
		)
		expect(isRetryableWithSameKey({ kind: 'offline' })).toBe(true)
		expect(isRetryableWithSameKey({ kind: 'holdExpired' })).toBe(false)
	})

	it('compares failures by value', () => {
		const a: BookingFailure = { kind: 'rateLimited', reason: 'x' }
		expect(sameBookingFailure(a, { kind: 'rateLimited', reason: 'x' })).toBe(
			true,
		)
		expect(sameBookingFailure(a, { kind: 'rateLimited', reason: null })).toBe(
			false,
		)
		expect(sameBookingFailure({ kind: 'offline' }, { kind: 'paused' })).toBe(
			false,
		)
		expect(
			sameBookingFailure(
				{ kind: 'slotUnavailable', alternatives: NO_ALTERNATIVES },
				{
					kind: 'slotUnavailable',
					alternatives: { sameDay: [], otherDates: [] },
				},
			),
		).toBe(true)
	})
})

describe('BookingFlow holds', () => {
	it('asks the store to release an abandoned hold', () => {
		const flow = holdingFlow()
		flow.beginSearch('loc_pub_main', '2030-06-25', 2)
		expect(flow.holdToRelease).toBe('hold_token_0001')
		expect(flow.hold).toBeNull()
		flow.acknowledgeRelease()
		expect(flow.holdToRelease).toBeNull()
	})

	it('releases a late hold answer after the guest moved on, never uses it', () => {
		const flow = searchedFlow()
		flow.select(firstSlot(flow))
		flow.reset()
		flow.receiveHold(makeHold({ token: 'hold_token_late' }), base)
		expect(flow.phase).toEqual({ kind: 'idle' })
		expect(flow.hold).toBeNull()
		expect(flow.holdToRelease).toBe('hold_token_late')
	})

	it('needs a first name and a valid phone to review', () => {
		const flow = holdingFlow()
		expect(
			flow.canReview(
				makeGuestDetails({ firstName: ' ', phone: '+14155553001' }),
				false,
			),
		).toBe(false)
		expect(
			flow.canReview(
				makeGuestDetails({ firstName: 'Ada', phone: '12' }),
				false,
			),
		).toBe(false)
		expect(
			flow.canReview(
				makeGuestDetails({ firstName: 'Ada', phone: '+1 (415) 555-3001' }),
				false,
			),
		).toBe(true)
	})
})

describe('PaymentPoll', () => {
	it('backs off and times out', () => {
		expect(PaymentPoll.delayAfterAttempt(0)).toBe(1500)
		expect(PaymentPoll.delayAfterAttempt(1)).toBe(2500)
		expect(PaymentPoll.delayAfterAttempt(4)).toBe(10_000)
		expect(PaymentPoll.delayAfterAttempt(40)).toBe(10_000)
		const start = base
		expect(PaymentPoll.hasTimedOut(start, start + 179 * SECOND)).toBe(false)
		expect(PaymentPoll.hasTimedOut(start, start + 180 * SECOND)).toBe(true)
		expect(PaymentPoll.stops(new ReservationApiError(404, 'not_found'))).toBe(
			true,
		)
		expect(PaymentPoll.stops(new ReservationApiError(403, 'forbidden'))).toBe(
			true,
		)
		expect(PaymentPoll.stops(new ApiError(0, 'offline'))).toBe(false)
	})
})

describe('manageActions', () => {
	it('follows the server payload', () => {
		const actions = manageActions(
			decodeFixture(reservationManageViewSchema, 'manage'),
		)
		expect(actions.canModify).toBe(true)
		expect(actions.canCancel).toBe(true)
		// A booked reservation can run late until shortly after its start.
		expect(actions.canRunLate).toBe(true)
		expect(actions.isLive).toBe(true)
	})

	it('offers nothing once the window has closed', () => {
		const object = fixtureJson('manage')
		object.canModify = false
		object.canCancel = false
		object.status = 'cancelled'
		const actions = manageActions(
			decodeFixture(reservationManageViewSchema, object),
		)
		expect(actions).toEqual({
			canModify: false,
			canCancel: false,
			canRunLate: false,
			isLive: false,
		})
	})
})

describe('WaitlistFlow', () => {
	it('reuses its key after a network error and stores the status token', () => {
		const keys = counter('wl')
		const flow = new WaitlistFlow(keys.make)
		expect(flow.beginJoin('loc_pub_main', 'Ada', 2)).toBe('wl-1')
		flow.receiveError(new ApiError(0, 'offline'))
		expect(flow.phase).toEqual({ kind: 'failed', failure: { kind: 'offline' } })
		expect(flow.beginJoin('loc_pub_main', 'Ada', 2)).toBe('wl-1')
		expect(flow.beginJoin('loc_pub_main', 'Ada', 3)).toBe('wl-2')

		flow.receiveJoin(
			decodeFixture(reservationWaitlistJoinSchema, 'waitlist-join'),
		)
		expect(flow.phase).toEqual({ kind: 'waiting' })
		expect(flow.statusToken).not.toBeNull()
		expect(flow.idempotencyKey).toBeNull()

		flow.receiveStatus(
			decodeFixture(reservationWaitlistStatusSchema, 'waitlist-status'),
		)
		expect(flow.phase).toEqual({ kind: 'waiting' })
		expect(flow.status?.position).toBe(1)
	})

	it('reads left, seated and a dead link', () => {
		const flow = new WaitlistFlow(() => 'wl-1')
		flow.receiveJoin(
			decodeFixture(reservationWaitlistJoinSchema, 'waitlist-join'),
		)
		const object = fixtureJson('waitlist-status')
		object.status = 'left'
		flow.receiveStatus(decodeFixture(reservationWaitlistStatusSchema, object))
		expect(flow.phase).toEqual({ kind: 'left' })

		object.status = 'seated'
		flow.receiveStatus(decodeFixture(reservationWaitlistStatusSchema, object))
		expect(flow.phase).toEqual({ kind: 'seated' })

		flow.receiveError(new ReservationApiError(404, 'not_found'))
		expect(flow.phase).toEqual({ kind: 'linkInvalid' })
	})

	it('keeps the place in line with a soft failure when a status refresh fails', () => {
		const flow = new WaitlistFlow()
		flow.restore('tok_wait_0001')
		flow.receiveStatus(
			decodeFixture(reservationWaitlistStatusSchema, 'waitlist-status'),
		)

		flow.receiveError(new ApiError(0, 'offline'))

		// One failed poll must not send the guest back to the join form.
		expect(flow.phase).toEqual({ kind: 'waiting' })
		expect(flow.statusToken).toBe('tok_wait_0001')
		expect(flow.refreshFailure).toEqual({ kind: 'offline' })
		expect(flow.state.refreshFailure).toEqual({ kind: 'offline' })
		expect(flow.status?.position).toBe(1)

		flow.receiveError(new ReservationApiError(503, 'unavailable'))
		expect(flow.phase).toEqual({ kind: 'waiting' })
		expect(flow.refreshFailure).toEqual({ kind: 'paused' })

		flow.receiveStatus(
			decodeFixture(reservationWaitlistStatusSchema, 'waitlist-status'),
		)
		expect(flow.phase).toEqual({ kind: 'waiting' })
		expect(flow.refreshFailure).toBeNull()
	})

	it('keeps a finished entry finished when a later call fails', () => {
		const flow = new WaitlistFlow()
		flow.restore('tok_wait_0001')
		const object = fixtureJson('waitlist-status')
		object.status = 'left'
		flow.receiveStatus(decodeFixture(reservationWaitlistStatusSchema, object))

		flow.receiveError(new ApiError(0, 'offline'))

		expect(flow.phase).toEqual({ kind: 'left' })
		expect(flow.refreshFailure).toEqual({ kind: 'offline' })
	})

	it('gives back the status capability when a token is restored', () => {
		const flow = new WaitlistFlow()
		expect(flow.statusToken).toBeNull()
		flow.restore('tok_wait_0001')
		expect(flow.statusToken).toBe('tok_wait_0001')
		expect(flow.phase).toEqual({ kind: 'waiting' })
		// A 404 on the restored token is a dead link, not a generic failure.
		flow.receiveError(new ReservationApiError(404, 'not_found'))
		expect(flow.phase).toEqual({ kind: 'linkInvalid' })
		expect(WaitlistFlow.isFinished('left')).toBe(true)
		expect(WaitlistFlow.isFinished('seated')).toBe(true)
		expect(WaitlistFlow.isFinished('waiting')).toBe(false)
		expect(WaitlistFlow.isFinished('notified')).toBe(false)
	})
})

describe('reservationDateStrip', () => {
	it('starts today in the location time zone and respects the horizon', () => {
		// 23:30 UTC on June 14 is already June 15 in Riyadh (UTC+3).
		const lateUtc = parseServerTime('2030-06-14T23:30:00.000Z')!
		expect(reservationDateStrip(lateUtc, 'Asia/Riyadh', 3, 60)).toEqual([
			'2030-06-15',
			'2030-06-16',
			'2030-06-17',
		])
		expect(reservationDateStrip(lateUtc, 'UTC', 3, 60)[0]).toBe('2030-06-14')
		expect(reservationDateStrip(lateUtc, 'UTC', 14, 2)).toHaveLength(3)
		expect(reservationDateStrip(lateUtc, 'Not/AZone', 1, 60)).toEqual([
			'2030-06-14',
		])
	})
})

describe('makeIdempotencyKey', () => {
	it('matches the server pattern', () => {
		const key = makeIdempotencyKey()
		expect(key).toMatch(/^[A-Za-z0-9._:-]{8,128}$/)
		expect(key).toBe(key.toLowerCase())
		expect(key).not.toBe(makeIdempotencyKey())
	})
})

describe('party ceiling', () => {
	it('allows large parties unless they are disabled', () => {
		const cases: Array<[string, number]> = [
			['request', 99],
			['contact', 99],
			['call_only', 99],
			['disabled', 4],
		]
		for (const [mode, ceiling] of cases) {
			const config = fixtureJson('config')
			config.locations[0]!.largeParty.mode = mode
			const location = decodeFixture(reservationsConfigSchema, config)
				.locations[0]!
			expect([mode, partyCeiling(location)]).toEqual([mode, ceiling])
			expect([mode, needsApproval(location, 5)]).toEqual([
				mode,
				mode !== 'disabled',
			])
		}
	})
})
