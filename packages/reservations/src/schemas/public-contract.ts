import { z } from 'zod'
import { isoTimestampSchema, partySizeSchema } from './common.ts'

/**
 * Response shapes of the public `/reservations/*` routes, as the native apps and
 * Sites consume them. `apps/tenant-api/src/routes/reservations-contract.test.ts`
 * records fixtures from the real routes and parses them with these schemas, so
 * a route change that breaks a consumer fails a test. See
 * `docs/reservations-contract.md`.
 *
 * Objects are non-strict on purpose: a new optional field must not break an
 * older app, but a removed or retyped field fails the fixture test.
 */

const nullableIso = isoTimestampSchema.nullable()

export const PUBLIC_DAY_STATUSES = [
	'available',
	'full',
	'closed',
	'online_closed',
	'beyond_horizon',
	'large_party',
] as const

export const PUBLIC_RESERVATION_STATUSES = [
	'requested',
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
	'finished',
	'cancelled',
	'no_show',
	'declined',
	'expired',
] as const

export const PUBLIC_PAYMENT_STATUSES = [
	'none',
	'pending',
	'guaranteed',
	'paid',
	'refund_pending',
	'refunded',
	'partially_refunded',
	'fee_pending',
	'fee_charged',
	'fee_failed',
	'review',
	'disputed',
] as const

export const publicSlotSchema = z.object({
	localMin: z.number().int(),
	time: z.string(),
	serviceId: z.string().nullable(),
	serviceName: z.string().nullable(),
	areaId: z.string().nullable(),
	areaLabel: z.string().nullable(),
})

const largePartyBlockSchema = z.object({
	mode: z.string(),
	maxOnlinePartySize: z.number().int(),
	phone: z.string().nullable(),
	contact: z.object({ name: z.string(), phone: z.string().nullable() }),
	note: z.string().nullable(),
})

export const publicConfigResponseSchema = z.object({
	organization: z.object({ name: z.string(), defaultLocale: z.string() }),
	locations: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			address: z
				.object({ formattedAddress: z.string(), city: z.string().nullable() })
				.nullable(),
			timeZone: z.string(),
			phone: z.string().nullable(),
			partySize: z.object({
				min: z.number().int(),
				max: z.number().int(),
			}),
			horizonDays: z.number().int(),
			intervalMin: z.number().int(),
			holdMinutes: z.number().int(),
			largeParty: largePartyBlockSchema,
			waitlist: z.object({ enabled: z.boolean(), online: z.boolean() }),
			notifyMe: z.boolean(),
			areas: z.array(z.object({ id: z.string(), name: z.string() })),
			publicNote: z.string().nullable(),
		}),
	),
	occasions: z.array(z.object({ id: z.string(), name: z.string() })),
	dietary: z.array(z.object({ id: z.string(), name: z.string() })),
	now: isoTimestampSchema,
})

export const publicAlternativesSchema = z.object({
	sameDay: z.array(publicSlotSchema),
	otherDates: z.array(
		z.object({
			date: z.string(),
			firstLocalMin: z.number().int(),
		}),
	),
})

export const publicAvailabilityResponseSchema = z.object({
	dayVersion: z.number().int(),
	settingsVersion: z.number().int(),
	timeZone: z.string(),
	now: isoTimestampSchema,
	locationId: z.string(),
	date: z.string(),
	partySize: partySizeSchema,
	status: z.enum(PUBLIC_DAY_STATUSES),
	slots: z.array(publicSlotSchema),
	alternatives: publicAlternativesSchema,
	largeParty: largePartyBlockSchema.optional(),
	closed: z
		.object({
			reason: z.string().nullable(),
			note: z.string().nullable(),
			name: z.string().nullable(),
			/** Who closed the day: the location hours or a reservations special day. */
			source: z.enum(['location_hours', 'reservation_special_day']).optional(),
		})
		.optional(),
	onlineClosed: z
		.object({ note: z.string().nullable(), name: z.string().nullable() })
		.optional(),
	notifyMe: z.boolean(),
	waitlist: z.boolean(),
})

export const publicCalendarResponseSchema = z.object({
	locationId: z.string(),
	timeZone: z.string(),
	now: isoTimestampSchema,
	partySize: partySizeSchema,
	days: z.array(
		z.object({
			date: z.string(),
			hasAvailability: z.boolean(),
			status: z.enum(PUBLIC_DAY_STATUSES),
			closed: z.boolean(),
			closedSource: z
				.enum(['location_hours', 'reservation_special_day'])
				.optional(),
			slotCount: z.number().int(),
			firstLocalMin: z.number().int().nullable(),
			lastLocalMin: z.number().int().nullable(),
		}),
	),
})

export const publicPolicyViewSchema = z.object({
	kind: z.string(),
	purpose: z.string(),
	termsVersion: z.number().int(),
	terms: z.string().nullable(),
	amountMinor: z.number().int(),
	totalAmountMinor: z.number().int(),
	perCover: z.boolean(),
	currency: z.string(),
	freeCancelUntilMin: z.number().int(),
	lateCancelFeeMinor: z.number().int(),
	noShowFeeMinor: z.number().int(),
})

/** `POST /holds` (201). `requiresPayment` and `policy` appear together. */
export const publicHoldResponseSchema = z.object({
	holdToken: z.string().min(8),
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
	locationId: z.string(),
	slot: z.object({
		date: z.string(),
		localMin: z.number().int(),
		partySize: partySizeSchema,
		serviceId: z.string().nullable(),
	}),
	experienceId: z.string().optional(),
	requiresPayment: z.boolean().optional(),
	policy: publicPolicyViewSchema.optional(),
})

export const publicReservationSummarySchema = z.object({
	id: z.string(),
	confirmationCode: z.string(),
	status: z.enum(PUBLIC_RESERVATION_STATUSES),
	channel: z.string(),
	locationId: z.string(),
	locationName: z.string().nullable(),
	date: z.string(),
	localMin: z.number().int(),
	time: z.string(),
	startAt: isoTimestampSchema,
	endAt: isoTimestampSchema,
	partySize: partySizeSchema,
	timeZone: z.string(),
})

export const publicPaymentBlockSchema = z.object({
	paymentToken: z.string(),
	purpose: z.string(),
	amountMinor: z.number().int(),
	currency: z.string(),
	expiresAt: isoTimestampSchema,
	payUrl: z.string().url(),
})

/** `POST /` and `POST /requests` (201) and an idempotent replay (200). */
export const publicBookingResponseSchema = z.object({
	reservation: publicReservationSummarySchema.extend({
		paymentStatus: z.enum(PUBLIC_PAYMENT_STATUSES),
		paymentExpiresAt: isoTimestampSchema.optional(),
	}),
	manageToken: z.string(),
	payment: publicPaymentBlockSchema.optional(),
})

/** `GET /manage` and the answer of every manage mutation. */
export const publicManageViewSchema = z.object({
	now: isoTimestampSchema,
	reservation: publicReservationSummarySchema.extend({
		experience: z.unknown().nullable(),
		firstName: z.string().nullable(),
		occasion: z.object({ id: z.string(), name: z.string() }).nullable(),
		requests: z.string().nullable(),
		dietary: z.string().nullable(),
		runningLateMin: z.number().int().nullable(),
		smsOptIn: z.boolean(),
		location: z.object({
			id: z.string(),
			name: z.string().nullable(),
			address: z.string().nullable(),
			phone: z.string().nullable(),
			timeZone: z.string(),
		}),
	}),
	status: z.enum(PUBLIC_RESERVATION_STATUSES),
	firstName: z.string().nullable(),
	contact: z.object({
		phone: z.string().nullable(),
		email: z.string().nullable(),
	}),
	policy: z
		.object({
			kind: z.string(),
			terms: z.string().nullable(),
			freeCancelUntilMin: z.number().int(),
			currency: z.string(),
		})
		.nullable(),
	paymentStatus: z.enum(PUBLIC_PAYMENT_STATUSES),
	canModify: z.boolean(),
	canCancel: z.boolean(),
	cancelDeadline: nullableIso,
})

/** `GET /manage/payment`: exactly these three fields. */
export const publicPaymentStatusResponseSchema = z.strictObject({
	paymentStatus: z.enum(PUBLIC_PAYMENT_STATUSES),
	reservationStatus: z.enum(PUBLIC_RESERVATION_STATUSES),
	now: isoTimestampSchema,
})

/** `GET /mine`: the signed-in customer's bookings with fresh manage tokens. */
export const publicMineResponseSchema = z.object({
	now: isoTimestampSchema,
	upcoming: z.array(
		publicReservationSummarySchema.extend({ manageToken: z.string() }),
	),
	past: z.array(
		publicReservationSummarySchema.extend({ manageToken: z.string() }),
	),
})

/** Every non-2xx answer: a stable `error` code plus optional detail. */
export const publicErrorResponseSchema = z.object({
	error: z.string(),
	reason: z.string().optional(),
	issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
	alternatives: publicAlternativesSchema.optional(),
})
