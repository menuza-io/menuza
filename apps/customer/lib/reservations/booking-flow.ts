import {
	addDays,
	formatDate,
	isValidTimeZone,
	localParts,
} from '@repo/zoned-time'
import * as Crypto from 'expo-crypto'
import { ApiError } from '../api/api-error'
import { isValidPhone, normalizePhone } from '../support/phone-number'
import {
	countdownClock,
	interpretPaymentStatus,
	isAlternativesEmpty,
	isLargePartyAvailability,
	makeSlot,
	NO_ALTERNATIVES,
	parseServerTime,
	type PaymentOutcome,
	ReservationApiError,
	type ReservationAlternatives,
	type ReservationAvailability,
	type ReservationBooking,
	type ReservationGuestDetails,
	type ReservationHold,
	type ReservationManageView,
	type ReservationPaymentStatus,
	type ReservationPolicy,
	type ReservationSlot,
	type ReservationWaitlistJoin,
	type ReservationWaitlistStatus,
	canRunLate,
	sameGuestDetails,
} from './models'

// The pure booking state machine behind the screens. It performs no I/O: the
// store calls the client, then feeds each answer into the flow, so every
// transition is unit-tested. Times are epoch milliseconds.
//
//   idle -> searching -> choosingTime -> holding -> details -> reviewing
//        -> submitting -> confirmed | requested | awaitingPayment
//   awaitingPayment -> confirmed | expired | failed   (status poll)
//   details | reviewing -> expired                    (hold countdown reaches zero)
//   any -> failed(BookingFailure)                     (a mapped server error)

// Idempotency keys ---------------------------------------------------------------

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

function fallbackUuid(): string {
	const bytes = new Uint8Array(16)
	try {
		Crypto.getRandomValues(bytes)
	} catch {
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = Math.floor(Math.random() * 256)
		}
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function randomUuid(): string {
	try {
		const value: unknown = Crypto.randomUUID()
		if (typeof value === 'string' && IDEMPOTENCY_KEY.test(value)) return value
	} catch {
		// No native module (tests, a web build without it): fall through.
	}
	const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
		.crypto
	if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
	return fallbackUuid()
}

/** A fresh `Idempotency-Key`: a lowercase UUID, which matches the server's `[A-Za-z0-9._:-]{8,128}`. */
export function makeIdempotencyKey(): string {
	return randomUuid().toLowerCase()
}

export type KeyMaker = () => string

// Failures -----------------------------------------------------------------------

/**
 * The failures the screens show a message for, mapped from the stable server
 * codes (see `docs/reservations-contract.md`). Never holds a request value.
 */
export type BookingFailure =
	/** 409 `slot_unavailable`; alternatives come from the answer. */
	| { kind: 'slotUnavailable'; alternatives: ReservationAlternatives }
	/** 429 `rate_limited`; `reason` is `phone_active_limit` when the guest has too many bookings. */
	| { kind: 'rateLimited'; reason: string | null }
	| { kind: SimpleBookingFailureKind }

export type SimpleBookingFailureKind =
	/** 410 `hold_expired` (or an unknown hold token). */
	| 'holdExpired'
	/** 400 `policy_required`: the payment policy was not accepted. */
	| 'policyRequired'
	/** `policy_unavailable`: the payment setup cannot take this booking. */
	| 'paymentUnavailable'
	/** 401, 403 or `verification_failed`: sign in again. */
	| 'signInRequired'
	| 'phoneOverlap'
	| 'partySizeInvalid'
	| 'invalid'
	| 'largePartyOnly'
	| 'requestsClosed'
	/** 503 `unavailable`: online booking is paused. */
	| 'paused'
	| 'notFound'
	| 'alreadyOnWaitlist'
	| 'waitlistFull'
	| 'idempotencyConflict'
	| 'paymentFailed'
	| 'paymentRefunded'
	/**
	 * Offline or timed out; the booking may or may not have been recorded, so a
	 * retry reuses the same `Idempotency-Key`.
	 */
	| 'offline'
	| 'generic'

export type BookingFailureKind = BookingFailure['kind']

function failure(kind: SimpleBookingFailureKind): BookingFailure {
	return { kind }
}

const CODE_FAILURES = new Map<string, SimpleBookingFailureKind>([
	['hold_expired', 'holdExpired'],
	['policy_required', 'policyRequired'],
	['policy_unavailable', 'paymentUnavailable'],
	['verification_failed', 'signInRequired'],
	['forbidden', 'signInRequired'],
	['unauthorized', 'signInRequired'],
	['phone_overlap', 'phoneOverlap'],
	['party_size_invalid', 'partySizeInvalid'],
	['invalid', 'invalid'],
	['large_party', 'largePartyOnly'],
	['requests_closed', 'requestsClosed'],
	['unavailable', 'paused'],
	['already_on_waitlist', 'alreadyOnWaitlist'],
	['waitlist_full', 'waitlistFull'],
	['idempotency_conflict', 'idempotencyConflict'],
	['not_found', 'notFound'],
])

export function mapBookingFailure(error: unknown): BookingFailure {
	if (error instanceof ReservationApiError) {
		const code = error.errorCode
		if (code === 'slot_unavailable') {
			return {
				kind: 'slotUnavailable',
				alternatives: error.alternatives ?? NO_ALTERNATIVES,
			}
		}
		if (code === 'rate_limited')
			return { kind: 'rateLimited', reason: error.reason }
		const known = CODE_FAILURES.get(code)
		if (known) return failure(known)
		switch (error.status) {
			case 410:
				return failure('holdExpired')
			case 429:
				return { kind: 'rateLimited', reason: error.reason }
			case 503:
				return failure('paused')
			case 404:
				return failure('notFound')
			case 401:
			case 403:
				return failure('signInRequired')
			default:
				return failure('generic')
		}
	}
	if (error instanceof ApiError) {
		// Any status 0 never got an HTTP answer (offline, timeout, no region).
		if (error.status === 0) return failure('offline')
		if (error.isUnauthorized || error.isForbidden)
			return failure('signInRequired')
		if (error.isRateLimited) return { kind: 'rateLimited', reason: null }
		if (error.isNotFound) return failure('notFound')
		return failure('generic')
	}
	return failure('offline')
}

/** A retry of the same request makes sense (and must reuse the idempotency key). */
export function isRetryableWithSameKey(value: BookingFailure): boolean {
	switch (value.kind) {
		case 'offline':
		case 'paused':
		case 'generic':
			return true
		case 'rateLimited':
			return value.reason !== 'phone_active_limit'
		default:
			return false
	}
}

function sameAlternatives(
	a: ReservationAlternatives,
	b: ReservationAlternatives,
): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

export function sameBookingFailure(
	a: BookingFailure,
	b: BookingFailure,
): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === 'slotUnavailable' && b.kind === 'slotUnavailable') {
		return sameAlternatives(a.alternatives, b.alternatives)
	}
	if (a.kind === 'rateLimited' && b.kind === 'rateLimited')
		return a.reason === b.reason
	return true
}

// Hold and clock ----------------------------------------------------------------

/**
 * A hold with its countdown pinned to the server's clock: the deadline is
 * `expiresAt` on the server timeline, so a device clock that is minutes off
 * still expires the hold at the right moment.
 */
export type ActiveHold = {
	readonly token: string
	readonly locationId: string
	readonly date: string
	readonly localMin: number
	readonly partySize: number
	readonly serviceId: string | null
	readonly expiresAt: number
	/** Server time minus device time when the hold answer arrived, in milliseconds. */
	readonly clockOffsetMs: number
	readonly requiresPayment: boolean
	readonly policy: ReservationPolicy | null
}

/** Milliseconds left on the server timeline (never negative). */
export function holdRemainingMs(hold: ActiveHold, deviceNow: number): number {
	return Math.max(0, hold.expiresAt - (deviceNow + hold.clockOffsetMs))
}

export function isHoldExpired(hold: ActiveHold, deviceNow: number): boolean {
	return holdRemainingMs(hold, deviceNow) <= 0
}

/** `6:42` style countdown. */
export function holdCountdownLabel(
	hold: ActiveHold,
	deviceNow: number,
): string {
	return countdownClock(holdRemainingMs(hold, deviceNow))
}

// Phases ------------------------------------------------------------------------

export type BookingPhase =
	| { kind: 'idle' }
	| { kind: 'searching' }
	| { kind: 'choosingTime' }
	/** A hold request is in flight. */
	| { kind: 'holding' }
	/** A hold is active and the guest fills in the details (countdown running). */
	| { kind: 'details' }
	| { kind: 'reviewing' }
	/** `POST /reservations` is in flight. */
	| { kind: 'submitting' }
	| { kind: 'awaitingPayment' }
	| { kind: 'confirmed' }
	/** A large-party request was sent; the restaurant still has to approve it. */
	| { kind: 'requested' }
	| { kind: 'expired' }
	| { kind: 'failed'; failure: BookingFailure }

export type BookingPhaseKind = BookingPhase['kind']

function phase(kind: Exclude<BookingPhaseKind, 'failed'>): BookingPhase {
	return { kind }
}

export function sameBookingPhase(a: BookingPhase, b: BookingPhase): boolean {
	if (a.kind === 'failed' && b.kind === 'failed')
		return sameBookingFailure(a.failure, b.failure)
	return a.kind === b.kind
}

/** Everything the flow knows, as one immutable value (new identity after each change). */
export type BookingFlowState = {
	readonly phase: BookingPhase
	readonly locationId: string | null
	readonly date: string
	readonly partySize: number
	readonly availability: ReservationAvailability | null
	readonly alternatives: ReservationAlternatives
	readonly selectedSlot: ReservationSlot | null
	readonly hold: ActiveHold | null
	readonly booking: ReservationBooking | null
	readonly paymentOutcome: PaymentOutcome | null
	/** Set while a booking attempt may be retried after a network error. */
	readonly idempotencyKey: string | null
	/** A hold the guest abandoned; the store releases it, then clears this. */
	readonly holdToRelease: string | null
}

// Flow --------------------------------------------------------------------------

export class BookingFlow {
	#phase: BookingPhase = phase('idle')
	#locationId: string | null = null
	#date = ''
	#partySize = 2
	#availability: ReservationAvailability | null = null
	#alternatives: ReservationAlternatives = NO_ALTERNATIVES
	#selectedSlot: ReservationSlot | null = null
	#hold: ActiveHold | null = null
	#booking: ReservationBooking | null = null
	#paymentOutcome: PaymentOutcome | null = null
	#idempotencyKey: string | null = null
	#lastSubmitted: ReservationGuestDetails | null = null
	#holdToRelease: string | null = null
	readonly #makeKey: KeyMaker

	constructor(makeKey: KeyMaker = makeIdempotencyKey) {
		this.#makeKey = makeKey
	}

	get phase(): BookingPhase {
		return this.#phase
	}
	get locationId(): string | null {
		return this.#locationId
	}
	get date(): string {
		return this.#date
	}
	get partySize(): number {
		return this.#partySize
	}
	get availability(): ReservationAvailability | null {
		return this.#availability
	}
	get alternatives(): ReservationAlternatives {
		return this.#alternatives
	}
	get selectedSlot(): ReservationSlot | null {
		return this.#selectedSlot
	}
	get hold(): ActiveHold | null {
		return this.#hold
	}
	get booking(): ReservationBooking | null {
		return this.#booking
	}
	get paymentOutcome(): PaymentOutcome | null {
		return this.#paymentOutcome
	}
	get idempotencyKey(): string | null {
		return this.#idempotencyKey
	}
	get holdToRelease(): string | null {
		return this.#holdToRelease
	}

	get state(): BookingFlowState {
		return {
			phase: this.#phase,
			locationId: this.#locationId,
			date: this.#date,
			partySize: this.#partySize,
			availability: this.#availability,
			alternatives: this.#alternatives,
			selectedSlot: this.#selectedSlot,
			hold: this.#hold,
			booking: this.#booking,
			paymentOutcome: this.#paymentOutcome,
			idempotencyKey: this.#idempotencyKey,
			holdToRelease: this.#holdToRelease,
		}
	}

	// Search

	beginSearch(locationId: string, date: string, partySize: number): void {
		this.abandonHold()
		this.#locationId = locationId
		this.#date = date
		this.#partySize = partySize
		this.#availability = null
		this.#alternatives = NO_ALTERNATIVES
		this.#selectedSlot = null
		this.#booking = null
		this.#paymentOutcome = null
		this.#clearAttempt()
		this.#phase = phase('searching')
	}

	receiveAvailability(availability: ReservationAvailability): void {
		switch (this.#phase.kind) {
			case 'searching':
			case 'choosingTime':
			case 'expired':
				this.#phase = phase('choosingTime')
				break
			case 'failed':
				if (!this.#isFailedSlot) return
				this.#phase = phase('choosingTime')
				break
			case 'details':
				// A live hold stays; only the list of times refreshes.
				break
			default:
				return
		}
		this.#availability = availability
		this.#alternatives = availability.alternatives
	}

	get #isFailedSlot(): boolean {
		return (
			this.#phase.kind === 'failed' &&
			this.#phase.failure.kind === 'slotUnavailable'
		)
	}

	/** A large party goes through a request instead of a hold. */
	get offersRequest(): boolean {
		return (
			this.#availability !== null &&
			isLargePartyAvailability(this.#availability)
		)
	}

	/** A large party sends a request with a preferred time; there is no hold. */
	setRequestTime(localMin: number): void {
		if (!this.offersRequest || this.#phase.kind !== 'choosingTime') return
		this.#selectedSlot = makeSlot({ localMin })
	}

	// Hold

	/** The guest picked a time (or one of the alternatives). */
	select(slot: ReservationSlot): void {
		const kind = this.#phase.kind
		if (
			kind !== 'choosingTime' &&
			kind !== 'details' &&
			kind !== 'expired' &&
			!this.#isFailedSlot
		) {
			return
		}
		this.#selectedSlot = slot
		this.#phase = phase('holding')
	}

	/** The guest picked an alternative day; searching restarts for that date. */
	selectAlternative(date: string): void {
		if (this.#locationId === null) return
		this.beginSearch(this.#locationId, date, this.#partySize)
	}

	receiveHold(response: ReservationHold, deviceNow: number): void {
		if (this.#phase.kind !== 'holding') {
			// A late answer for a search the guest left: release it, never use it.
			this.#holdToRelease = response.holdToken
			return
		}
		const expiresAt = parseServerTime(response.expiresAt)
		const serverNow = parseServerTime(response.now)
		if (expiresAt === null || serverNow === null) {
			this.#holdToRelease = response.holdToken
			this.#phase = { kind: 'failed', failure: failure('generic') }
			return
		}
		this.#hold = {
			token: response.holdToken,
			locationId: response.locationId,
			date: response.slot.date,
			localMin: response.slot.localMin,
			partySize: response.slot.partySize,
			serviceId: response.slot.serviceId,
			expiresAt,
			clockOffsetMs: serverNow - deviceNow,
			requiresPayment: response.requiresPayment ?? false,
			policy: response.policy ?? null,
		}
		this.#clearAttempt()
		this.#phase = phase('details')
	}

	acknowledgeRelease(): void {
		this.#holdToRelease = null
	}

	/** The token a replacing hold request should send, if a hold is active. */
	get replaceableHoldToken(): string | null {
		return this.#hold?.token ?? null
	}

	remainingMs(deviceNow: number): number | null {
		return this.#hold ? holdRemainingMs(this.#hold, deviceNow) : null
	}

	/**
	 * Call on every countdown tick. Moves to `expired` when the server deadline
	 * passes while the guest is still filling in or reviewing. A request that is
	 * already in flight is left to the server to decide.
	 */
	tick(deviceNow: number): boolean {
		const kind = this.#phase.kind
		if ((kind !== 'details' && kind !== 'reviewing') || !this.#hold)
			return false
		if (!isHoldExpired(this.#hold, deviceNow)) return false
		this.#hold = null
		this.#clearAttempt()
		this.#phase = phase('expired')
		return true
	}

	/** The guest went back out of the booking; releases the held table. */
	abandonHold(): void {
		if (this.#hold) this.#holdToRelease = this.#hold.token
		this.#hold = null
	}

	// Details and review

	get needsPolicyConsent(): boolean {
		return this.#hold?.requiresPayment === true && this.#hold.policy !== null
	}

	/** The `termsVersion` to send once the guest consents; null when no policy applies. */
	get policyTermsVersion(): string | null {
		if (!this.needsPolicyConsent || !this.#hold?.policy) return null
		return String(this.#hold.policy.termsVersion)
	}

	/** First name and a phone are required; a payment policy also needs consent. */
	canReview(details: ReservationGuestDetails, consented: boolean): boolean {
		if (details.firstName.trim() === '') return false
		if (!isValidPhone(normalizePhone(details.phone))) return false
		if (this.needsPolicyConsent && !consented) return false
		return true
	}

	proceedToReview(): void {
		if (this.#phase.kind !== 'details') return
		this.#phase = phase('reviewing')
	}

	backToDetails(): void {
		if (this.#phase.kind !== 'reviewing' && !this.#isRecoverable) return
		if (this.#hold) this.#phase = phase('details')
	}

	get #isRecoverable(): boolean {
		if (this.#phase.kind !== 'failed') return false
		const failed = this.#phase.failure
		return isRetryableWithSameKey(failed) || failed.kind === 'invalid'
	}

	// Submit

	/**
	 * Starts `POST /reservations` (or the large-party request when `isRequest`).
	 * Returns the `Idempotency-Key` to send: a new one for new details, the same
	 * one for a retry of the same details after a network error, so the server
	 * replays the first answer instead of booking twice.
	 */
	beginSubmit(
		details: ReservationGuestDetails,
		isRequest = false,
	): string | null {
		let canSubmit: boolean
		switch (this.#phase.kind) {
			case 'reviewing':
				canSubmit = true
				break
			case 'failed':
				canSubmit =
					isRetryableWithSameKey(this.#phase.failure) &&
					this.#idempotencyKey !== null
				break
			case 'choosingTime':
				canSubmit = isRequest
				break
			default:
				canSubmit = false
		}
		if (!canSubmit) return null
		if (
			this.#idempotencyKey !== null &&
			this.#lastSubmitted !== null &&
			sameGuestDetails(this.#lastSubmitted, details)
		) {
			this.#phase = phase('submitting')
			return this.#idempotencyKey
		}
		const key = this.#makeKey()
		this.#idempotencyKey = key
		this.#lastSubmitted = { ...details }
		this.#phase = phase('submitting')
		return key
	}

	receiveBooking(response: ReservationBooking): void {
		if (this.#phase.kind !== 'submitting') return
		this.#booking = response
		this.#hold = null
		this.#clearAttempt()
		this.#paymentOutcome = null
		const status = response.reservation.status
		if (response.payment !== undefined || status === 'pending_payment') {
			this.#phase = phase('awaitingPayment')
		} else if (status === 'requested') {
			this.#phase = phase('requested')
		} else {
			this.#phase = phase('confirmed')
		}
	}

	/**
	 * Maps a failed request to a phase. A hold that is gone ends the attempt; a
	 * taken slot offers the server's alternatives; an offline or paused answer
	 * keeps the idempotency key so the retry is safe.
	 */
	receiveError(error: unknown): void {
		const mapped = mapBookingFailure(error)
		switch (mapped.kind) {
			case 'holdExpired':
				this.#hold = null
				this.#clearAttempt()
				this.#phase = phase('expired')
				return
			case 'slotUnavailable':
				this.#hold = null
				this.#clearAttempt()
				if (!isAlternativesEmpty(mapped.alternatives))
					this.#alternatives = mapped.alternatives
				this.#phase = { kind: 'failed', failure: mapped }
				return
			default:
				if (!isRetryableWithSameKey(mapped)) this.#clearAttempt()
				this.#phase = { kind: 'failed', failure: mapped }
		}
	}

	// Payment

	/** Applies a payment status answer. `pending` keeps polling; every other outcome ends the wait. */
	receivePaymentStatus(
		status: Pick<
			ReservationPaymentStatus,
			'paymentStatus' | 'reservationStatus'
		>,
	): PaymentOutcome {
		const outcome = interpretPaymentStatus(status)
		if (this.#phase.kind !== 'awaitingPayment') return outcome
		this.#paymentOutcome = outcome
		switch (outcome) {
			case 'paid':
				this.#phase = phase('confirmed')
				break
			case 'expired':
				this.#phase = phase('expired')
				break
			case 'failed':
				this.#phase = { kind: 'failed', failure: failure('paymentFailed') }
				break
			case 'refunded':
				this.#phase = { kind: 'failed', failure: failure('paymentRefunded') }
				break
			case 'review':
			case 'pending':
				break
		}
		return outcome
	}

	/** The payment window of the booking, on the server clock. */
	paymentRemainingMs(deviceNow: number, serverOffsetMs: number): number | null {
		const raw =
			this.#booking?.payment?.expiresAt ??
			this.#booking?.reservation.paymentExpiresAt
		const expiresAt = parseServerTime(raw)
		if (expiresAt === null) return null
		return Math.max(0, expiresAt - (deviceNow + serverOffsetMs))
	}

	// Reset

	reset(): void {
		this.abandonHold()
		this.#phase = phase('idle')
		this.#availability = null
		this.#alternatives = NO_ALTERNATIVES
		this.#selectedSlot = null
		this.#booking = null
		this.#paymentOutcome = null
		this.#clearAttempt()
	}

	#clearAttempt(): void {
		this.#idempotencyKey = null
		this.#lastSubmitted = null
	}
}

// Payment poll -------------------------------------------------------------------

/**
 * Back-off for the payment status poll, the same schedule as the Sites pay
 * page: 1.5, 2.5, 4, 6, then every 10 seconds, for at most three minutes.
 */
export const PaymentPoll = {
	delaysMs: [1500, 2500, 4000, 6000, 10_000] as readonly number[],
	maxDurationMs: 180_000,

	delayAfterAttempt(attempt: number): number {
		const delays = PaymentPoll.delaysMs
		return delays[Math.min(Math.max(attempt, 0), delays.length - 1)] ?? 10_000
	},

	hasTimedOut(start: number, now: number): boolean {
		return now - start >= PaymentPoll.maxDurationMs
	},

	/** 401, 403 and 404 mean the link is dead: polling stops for good. */
	stops(error: unknown): boolean {
		if (error instanceof ReservationApiError)
			return [401, 403, 404].includes(error.status)
		if (error instanceof ApiError)
			return error.isUnauthorized || error.isNotFound
		return false
	},
} as const

// Manage eligibility -------------------------------------------------------------

/**
 * What the reservation detail screen offers, from the manage payload: the
 * server decides `canModify` and `canCancel` (cutoff windows, status); running
 * late is offered for a live booking until shortly after its start.
 */
export type ReservationManageActions = {
	readonly canModify: boolean
	readonly canCancel: boolean
	readonly canRunLate: boolean
	readonly isLive: boolean
}

const LIVE_STATUSES = new Set([
	'booked',
	'confirmed',
	'requested',
	'pending_payment',
])

export function manageActions(
	view: ReservationManageView,
): ReservationManageActions {
	return {
		isLive: LIVE_STATUSES.has(view.status),
		canModify: view.canModify,
		canCancel: view.canCancel,
		canRunLate: canRunLate(view),
	}
}

// Waitlist ------------------------------------------------------------------------

export type WaitlistPhase =
	| { kind: 'idle' }
	| { kind: 'joining' }
	| { kind: 'waiting' }
	| { kind: 'left' }
	| { kind: 'seated' }
	| { kind: 'failed'; failure: BookingFailure }
	/** The status link no longer resolves (404). */
	| { kind: 'linkInvalid' }

export type WaitlistFlowState = {
	readonly phase: WaitlistPhase
	readonly status: ReservationWaitlistStatus | null
	readonly statusToken: string | null
	readonly idempotencyKey: string | null
	/**
	 * The last call on an entry the guest holds failed (a poll, leave, on my
	 * way): shown beside the place in line, which stays as it was.
	 */
	readonly refreshFailure: BookingFailure | null
}

const LEFT_STATUSES = new Set([
	'left',
	'cancelled',
	'removed',
	'no_show',
	'expired',
])

/**
 * Join and status for the waitlist. The `Idempotency-Key` is reused when the
 * same join is retried after a network error.
 */
export class WaitlistFlow {
	#phase: WaitlistPhase = { kind: 'idle' }
	#status: ReservationWaitlistStatus | null = null
	#statusToken: string | null = null
	#idempotencyKey: string | null = null
	#lastJoin: string | null = null
	#refreshFailure: BookingFailure | null = null
	readonly #makeKey: KeyMaker

	constructor(makeKey: KeyMaker = makeIdempotencyKey) {
		this.#makeKey = makeKey
	}

	get refreshFailure(): BookingFailure | null {
		return this.#refreshFailure
	}

	get phase(): WaitlistPhase {
		return this.#phase
	}
	get status(): ReservationWaitlistStatus | null {
		return this.#status
	}
	get statusToken(): string | null {
		return this.#statusToken
	}
	get idempotencyKey(): string | null {
		return this.#idempotencyKey
	}

	get state(): WaitlistFlowState {
		return {
			phase: this.#phase,
			status: this.#status,
			statusToken: this.#statusToken,
			idempotencyKey: this.#idempotencyKey,
			refreshFailure: this.#refreshFailure,
		}
	}

	beginJoin(locationId: string, name: string, partySize: number): string {
		const signature = `${locationId}|${name}|${partySize}`
		let key: string
		if (this.#idempotencyKey !== null && this.#lastJoin === signature) {
			key = this.#idempotencyKey
		} else {
			key = this.#makeKey()
			this.#idempotencyKey = key
			this.#lastJoin = signature
		}
		this.#phase = { kind: 'joining' }
		return key
	}

	receiveJoin(join: ReservationWaitlistJoin): void {
		this.#statusToken = join.statusToken
		this.#idempotencyKey = null
		this.#lastJoin = null
		this.#refreshFailure = null
		this.#phase = { kind: 'waiting' }
	}

	/** Statuses after which the entry can no longer be inspected or changed. */
	static isFinished(status: string): boolean {
		return LEFT_STATUSES.has(status) || status === 'seated'
	}

	/**
	 * Puts a persisted status token back into the flow (after a relaunch) so the
	 * guest can see, refresh and leave the entry instead of joining again.
	 */
	restore(token: string): void {
		this.#statusToken = token
		this.#idempotencyKey = null
		this.#lastJoin = null
		this.#refreshFailure = null
		this.#phase = { kind: 'waiting' }
	}

	receiveStatus(status: ReservationWaitlistStatus): void {
		this.#status = status
		this.#refreshFailure = null
		if (LEFT_STATUSES.has(status.status)) this.#phase = { kind: 'left' }
		else if (status.status === 'seated') this.#phase = { kind: 'seated' }
		else this.#phase = { kind: 'waiting' }
	}

	receiveError(error: unknown): void {
		const mapped = mapBookingFailure(error)
		if (mapped.kind === 'notFound' && this.#statusToken !== null) {
			this.#phase = { kind: 'linkInvalid' }
			return
		}
		if (this.#statusToken !== null) {
			// The guest is on the line: keep their place and say the update failed.
			this.#refreshFailure = mapped
			return
		}
		if (!isRetryableWithSameKey(mapped)) {
			this.#idempotencyKey = null
			this.#lastJoin = null
		}
		this.#phase = { kind: 'failed', failure: mapped }
	}
}

// Dates ---------------------------------------------------------------------------

/**
 * `count` business dates (`yyyy-MM-dd`) starting today in the location's time
 * zone, capped by the booking horizon. An unknown zone falls back to UTC.
 */
export function reservationDateStrip(
	now: number,
	timeZone: string,
	count: number,
	horizonDays: number,
): string[] {
	const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
	const today = localParts(now, zone)
	const first = formatDate(today.year, today.month, today.day)
	const limit = Math.max(1, Math.min(count, horizonDays + 1))
	return Array.from({ length: limit }, (_, offset) => addDays(first, offset))
}
