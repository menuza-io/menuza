import {
	isoTimestampSchema,
	publicAlternativesSchema,
	publicAvailabilityResponseSchema,
	publicBookingResponseSchema,
	publicCalendarResponseSchema,
	publicConfigResponseSchema,
	publicErrorResponseSchema,
	publicHoldResponseSchema,
	publicJoinWaitlistResponseSchema,
	publicManageViewSchema,
	publicMineResponseSchema,
	publicPaymentStatusResponseSchema,
	publicWaitlistStatusResponseSchema,
} from '@repo/reservations'
import { z } from 'zod'
import { ApiError } from '../api/api-error'

// Response models of the public `/reservations/*` contract, decoded with the
// shared schemas of `@repo/reservations`. Status fields are relaxed to plain
// strings, so a status added by a newer server never breaks an older app; the
// helpers below name the ones the app acts on.

// Clock -----------------------------------------------------------------------

const SERVER_TIMESTAMP =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/** Server timestamps (`2030-06-14T16:00:00.000Z`, milliseconds optional) as epoch milliseconds. */
export function parseServerTime(
	value: string | null | undefined,
): number | null {
	if (!value || !SERVER_TIMESTAMP.test(value)) return null
	const ms = Date.parse(value)
	return Number.isNaN(ms) ? null : ms
}

function pad2(value: number): string {
	return String(value).padStart(2, '0')
}

/** `19:30` for minutes after local midnight; values past 24:00 wrap (late-night slots). */
export function timeLabel(localMin: number): string {
	const minutes = ((localMin % 1440) + 1440) % 1440
	return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
}

/** `6:42` for a countdown; partial seconds round up, negatives read `0:00`. */
export function countdownClock(remainingMs: number): string {
	const total = Math.ceil(Math.max(0, remainingMs) / 1000)
	return `${Math.floor(total / 60)}:${pad2(total % 60)}`
}

// Schemas ----------------------------------------------------------------------

export const reservationsConfigSchema = publicConfigResponseSchema

export const reservationAvailabilitySchema =
	publicAvailabilityResponseSchema.extend({ status: z.string() })

export const reservationCalendarSchema = publicCalendarResponseSchema.extend({
	days: z.array(
		publicCalendarResponseSchema.shape.days.element.extend({
			status: z.string(),
		}),
	),
})

export const reservationHoldSchema = publicHoldResponseSchema

export const reservationBookingSchema = publicBookingResponseSchema.extend({
	reservation: publicBookingResponseSchema.shape.reservation.extend({
		status: z.string(),
		paymentStatus: z.string(),
	}),
})

export const reservationManageViewSchema = publicManageViewSchema.extend({
	reservation: publicManageViewSchema.shape.reservation.extend({
		status: z.string(),
	}),
	status: z.string(),
	paymentStatus: z.string(),
})

export const reservationPaymentStatusSchema = publicPaymentStatusResponseSchema
	.extend({
		paymentStatus: z.string(),
		reservationStatus: z.string(),
		now: isoTimestampSchema,
	})
	.strip()

const mineEntrySchema = publicMineResponseSchema.shape.upcoming.element.extend({
	status: z.string(),
})

export const reservationMineSchema = publicMineResponseSchema.extend({
	upcoming: z.array(mineEntrySchema),
	past: z.array(mineEntrySchema),
})

export const reservationWaitlistJoinSchema =
	publicJoinWaitlistResponseSchema.extend({
		entry: publicJoinWaitlistResponseSchema.shape.entry.extend({
			status: z.string(),
		}),
	})

export const reservationWaitlistStatusSchema =
	publicWaitlistStatusResponseSchema.extend({ status: z.string() })

export const holdReleaseSchema = z.object({ released: z.boolean().nullish() })

const errorBodySchema = publicErrorResponseSchema
	.pick({ alternatives: true })
	.extend({
		error: z.string().nullish(),
		reason: z.string().nullish(),
		alternatives: publicAlternativesSchema.nullish(),
	})

// Types ------------------------------------------------------------------------

export type ReservationsConfig = z.infer<typeof reservationsConfigSchema>
export type ReservationLocation = ReservationsConfig['locations'][number]
export type ReservationLargeParty = ReservationLocation['largeParty']
export type ReservationChip = ReservationsConfig['occasions'][number]
export type ReservationAvailability = z.infer<
	typeof reservationAvailabilitySchema
>
export type ReservationSlot = ReservationAvailability['slots'][number]
export type ReservationAlternatives = ReservationAvailability['alternatives']
export type ReservationAlternativeDate =
	ReservationAlternatives['otherDates'][number]
export type ReservationCalendar = z.infer<typeof reservationCalendarSchema>
export type ReservationCalendarDay = ReservationCalendar['days'][number]
export type ReservationHold = z.infer<typeof reservationHoldSchema>
export type ReservationPolicy = NonNullable<ReservationHold['policy']>
export type ReservationBooking = z.infer<typeof reservationBookingSchema>
export type ReservationSummary = ReservationBooking['reservation']
export type ReservationPaymentBlock = NonNullable<ReservationBooking['payment']>
export type ReservationManageView = z.infer<typeof reservationManageViewSchema>
export type ReservationManageDetails = ReservationManageView['reservation']
export type ReservationMine = z.infer<typeof reservationMineSchema>
export type ReservationMineEntry = ReservationMine['upcoming'][number]
export type ReservationPaymentStatus = z.infer<
	typeof reservationPaymentStatusSchema
>
export type ReservationWaitlistJoin = z.infer<
	typeof reservationWaitlistJoinSchema
>
export type ReservationWaitlistEntry = ReservationWaitlistJoin['entry']
export type ReservationWaitlistStatus = z.infer<
	typeof reservationWaitlistStatusSchema
>

// Slots and alternatives -------------------------------------------------------

/** A slot the app makes up (a large-party request time); `time` defaults to the clock label. */
export function makeSlot(
	fields: Partial<ReservationSlot> & { localMin: number },
): ReservationSlot {
	return {
		localMin: fields.localMin,
		time: fields.time ?? timeLabel(fields.localMin),
		serviceId: fields.serviceId ?? null,
		serviceName: fields.serviceName ?? null,
		areaId: fields.areaId ?? null,
		areaLabel: fields.areaLabel ?? null,
	}
}

export const NO_ALTERNATIVES: ReservationAlternatives = Object.freeze({
	sameDay: [],
	otherDates: [],
}) as ReservationAlternatives

export function isAlternativesEmpty(
	alternatives: ReservationAlternatives,
): boolean {
	return (
		alternatives.sameDay.length === 0 && alternatives.otherDates.length === 0
	)
}

export function hasSlots(availability: ReservationAvailability): boolean {
	return availability.slots.length > 0
}

export function isLargePartyAvailability(
	availability: ReservationAvailability,
): boolean {
	return availability.status === 'large_party'
}

// Locations --------------------------------------------------------------------

/** `request`: the guest sends a request. Any other mode means calling the restaurant. */
export function acceptsRequests(
	largeParty: Pick<ReservationLargeParty, 'mode'>,
): boolean {
	return largeParty.mode === 'request'
}

/** The API limit on party size. */
export const LARGE_PARTY_CEILING = 99

/**
 * The most a guest can step to. Above `partySize.max` the booking is a
 * large-party request or a call; only a location that turned large parties
 * off stops at the online maximum.
 */
export function partyCeiling(
	location: Pick<ReservationLocation, 'largeParty' | 'partySize'>,
): number {
	return location.largeParty.mode === 'disabled'
		? location.partySize.max
		: Math.max(location.partySize.max, LARGE_PARTY_CEILING)
}

/** True when `size` is above the online maximum and large parties are not switched off. */
export function needsApproval(
	location: Pick<ReservationLocation, 'largeParty' | 'partySize'>,
	size: number,
): boolean {
	return (
		size > location.partySize.max && location.largeParty.mode !== 'disabled'
	)
}

// Manage -----------------------------------------------------------------------

const RUN_LATE_GRACE_MS = 30 * 60 * 1000

/** Running late only makes sense for a live booking, until shortly after its start (server clock). */
export function canRunLate(view: ReservationManageView): boolean {
	if (view.status !== 'booked' && view.status !== 'confirmed') return false
	const startAt = parseServerTime(view.reservation.startAt)
	const now = parseServerTime(view.now)
	if (startAt === null || now === null) return false
	return now < startAt + RUN_LATE_GRACE_MS
}

// Payment outcome --------------------------------------------------------------

export type PaymentOutcome =
	'paid' | 'expired' | 'failed' | 'review' | 'refunded' | 'pending'

const PAID_STATUSES = new Set(['paid', 'guaranteed', 'fee_charged'])
const REFUNDED_STATUSES = new Set([
	'refunded',
	'partially_refunded',
	'refund_pending',
])
const DEAD_RESERVATION_STATUSES = new Set([
	'cancelled',
	'expired',
	'declined',
	'no_show',
	'finished',
])

/**
 * What the guest sees for a payment status answer, as `interpretPay` in Sites:
 * only a status answer can say "paid"; returning from the browser never does.
 */
export function interpretPaymentStatus(
	status: Pick<ReservationPaymentStatus, 'paymentStatus' | 'reservationStatus'>,
): PaymentOutcome {
	if (PAID_STATUSES.has(status.paymentStatus)) return 'paid'
	if (status.paymentStatus === 'fee_failed') return 'failed'
	if (
		status.paymentStatus === 'review' ||
		status.paymentStatus === 'disputed'
	) {
		return 'review'
	}
	if (REFUNDED_STATUSES.has(status.paymentStatus)) return 'refunded'
	if (DEAD_RESERVATION_STATUSES.has(status.reservationStatus)) return 'expired'
	return 'pending'
}

/** The poll stops on every outcome except `pending`. */
export function isFinalPaymentOutcome(outcome: PaymentOutcome): boolean {
	return outcome !== 'pending'
}

// Errors -----------------------------------------------------------------------

/**
 * A non-2xx answer from `/reservations/*`: the stable `error` code (also the
 * message), the `reason` of a `rate_limited` and the alternatives of a
 * `slot_unavailable`. The server never echoes a request value, so it is safe
 * to keep; it is still never logged.
 */
export class ReservationApiError extends ApiError {
	readonly reason: string | null
	readonly alternatives: ReservationAlternatives | null

	constructor(
		status: number,
		code: string,
		options: {
			reason?: string | null
			alternatives?: ReservationAlternatives | null
		} = {},
	) {
		super(status, code, code)
		this.name = 'ReservationApiError'
		this.reason = options.reason ?? null
		this.alternatives = options.alternatives ?? null
	}

	get errorCode(): string {
		return this.code ?? 'error'
	}
}

export function reservationErrorFrom(
	status: number,
	body: string,
): ReservationApiError {
	let value: unknown = null
	try {
		value = JSON.parse(body)
	} catch {
		value = null
	}
	const parsed = errorBodySchema.safeParse(value)
	const data = parsed.success ? parsed.data : null
	return new ReservationApiError(status, data?.error ?? 'error', {
		reason: data?.reason ?? null,
		alternatives: data?.alternatives ?? null,
	})
}

// Guest details ----------------------------------------------------------------

/**
 * What the guest typed for one booking. The phone is the signed-in customer's
 * verified number; the app never shows a phone field.
 */
export type ReservationGuestDetails = {
	firstName: string
	lastName: string
	phone: string
	email: string
	occasionTagId: string | null
	requests: string
	dietary: string
	areaId: string | null
	smsOptIn: boolean
	locale: string
	/** Set once the guest ticks the consent box for a payment policy. */
	policyTermsVersion: string | null
}

export function makeGuestDetails(
	fields: Partial<ReservationGuestDetails> = {},
): ReservationGuestDetails {
	return {
		firstName: '',
		lastName: '',
		phone: '',
		email: '',
		occasionTagId: null,
		requests: '',
		dietary: '',
		areaId: null,
		smsOptIn: false,
		locale: 'en',
		policyTermsVersion: null,
		...fields,
	}
}

const DETAIL_FIELDS = [
	'firstName',
	'lastName',
	'phone',
	'email',
	'occasionTagId',
	'requests',
	'dietary',
	'areaId',
	'smsOptIn',
	'locale',
	'policyTermsVersion',
] as const satisfies ReadonlyArray<keyof ReservationGuestDetails>

export function sameGuestDetails(
	a: ReservationGuestDetails,
	b: ReservationGuestDetails,
): boolean {
	return DETAIL_FIELDS.every((field) => a[field] === b[field])
}
