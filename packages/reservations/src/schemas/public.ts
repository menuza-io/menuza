import { z } from 'zod'
import {
	attributeTagSchema,
	businessDateStringSchema,
	guestOccasionSchema,
	isoTimestampSchema,
	normalizedPhoneSchema,
	partySizeSchema,
	seatingPreferenceSchema,
	slotMinSchema,
} from './common.ts'

export const publicAvailabilityQuerySchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80),
	businessDate: businessDateStringSchema,
	partySize: z.coerce.number().int().min(1).max(99),
	preferredSlotMin: z.coerce.number().int().min(0).max(2880).optional(),
	seatingPreference: seatingPreferenceSchema.optional().default('any'),
	areaId: z.string().trim().min(1).optional(),
	serviceId: z.string().trim().min(1).optional(),
})

export const publicCalendarQuerySchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80),
	fromDate: businessDateStringSchema,
	toDate: businessDateStringSchema,
	partySize: z.coerce.number().int().min(1).max(99),
})

export const createHoldRequestSchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80),
	businessDate: businessDateStringSchema,
	slotMin: slotMinSchema,
	partySize: partySizeSchema,
	seatingPreference: seatingPreferenceSchema.optional().default('any'),
	requestedAttributes: z.array(attributeTagSchema).optional(),
	areaId: z.string().trim().min(1).optional().nullable(),
	serviceId: z.string().trim().min(1).optional().nullable(),
	experienceId: z.string().trim().min(1).optional().nullable(),
})

export const createReservationFromHoldRequestSchema = z.strictObject({
	holdId: z.string().trim().min(1),
	holdToken: z.string().trim().min(8).max(256),
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema,
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	occasion: guestOccasionSchema.optional().nullable(),
	dietaryNotes: z.string().trim().max(500).optional().nullable(),
	guestNotes: z.string().trim().max(1000).optional().nullable(),
	smsOptIn: z.boolean().default(false),
	marketingOptIn: z.boolean().default(false),
	turnstileToken: z.string().trim().max(2048).optional().nullable(),
	website: z.string().max(0).optional(), // Honeypot must be empty if present
	idempotencyKey: z.string().trim().min(8).max(128),
})

export const createLargePartyRequestSchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80),
	businessDate: businessDateStringSchema,
	preferredSlotMin: slotMinSchema,
	partySize: partySizeSchema,
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema,
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	occasion: guestOccasionSchema.optional().nullable(),
	dietaryNotes: z.string().trim().max(500).optional().nullable(),
	guestNotes: z.string().trim().max(1000).optional().nullable(),
	smsOptIn: z.boolean().default(false),
	turnstileToken: z.string().trim().max(2048).optional().nullable(),
	website: z.string().max(0).optional(),
	idempotencyKey: z.string().trim().min(8).max(128),
})

export const publicModifyReservationRequestSchema = z.strictObject({
	businessDate: businessDateStringSchema.optional(),
	slotMin: slotMinSchema.optional(),
	partySize: partySizeSchema.optional(),
	seatingPreference: seatingPreferenceSchema.optional(),
	occasion: guestOccasionSchema.optional().nullable(),
	dietaryNotes: z.string().trim().max(500).optional().nullable(),
	guestNotes: z.string().trim().max(1000).optional().nullable(),
})

export const publicCancelReservationRequestSchema = z.strictObject({
	reason: z.string().trim().max(500).optional().nullable(),
})

export const publicConfirmReservationRequestSchema = z.strictObject({
	confirmed: z.literal(true).default(true),
})

export const publicNotifyMeRequestSchema = z.object({
	locationId: z.string().trim().min(1).max(128),
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))),
	partySize: z.number().int().min(1).max(99),
	fromLocalMin: z.number().int().min(0).max(2880),
	toLocalMin: z.number().int().min(0).max(2880),
	areaId: z.string().trim().min(1).max(128).optional().nullable(),
	phone: z.string().trim().max(32).optional().nullable(),
	email: z.string().trim().max(254).optional().nullable(),
	locale: z.string().trim().min(2).max(16).optional(),
	website: z.string().max(200).optional(),
	turnstileToken: z.string().max(4096).optional(),
})

/** `POST /notify-me`; `cancelToken` is shown once and cancels the request. */
export const publicNotifyMeResponseSchema = z.object({
	request: z.object({
		id: z.string(),
		status: z.literal('active'),
		locationId: z.string(),
		date: z.string(),
		partySize: partySizeSchema,
		fromLocalMin: z.number().int(),
		toLocalMin: z.number().int(),
	}),
	cancelToken: z.string(),
	now: isoTimestampSchema,
})

export const publicNotifyMeCancelResponseSchema = z.object({
	cancelled: z.literal(true),
	now: isoTimestampSchema,
})

export const createHoldResponseSchema = z.strictObject({
	holdId: z.string().trim().min(1),
	holdToken: z.string().trim().min(8).max(256),
	businessDate: businessDateStringSchema,
	slotMin: slotMinSchema,
	partySize: partySizeSchema,
	tableIds: z.array(z.string().trim().min(1)).min(1).optional(),
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
})

export const largePartyRequestResponseSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	status: z.enum(['requested', 'pending_approval']),
	businessDate: businessDateStringSchema.optional(),
	slotMin: slotMinSchema.optional(),
	partySize: partySizeSchema.optional(),
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
})

export const notifyMeOfferResponseSchema = z.strictObject({
	subscriptionId: z.string().trim().min(1).optional(),
	notifyRequestId: z.string().trim().min(1).optional(),
	status: z.enum([
		'watching',
		'offered',
		'notified',
		'booked',
		'cancelled',
		'expired',
	]),
	businessDate: businessDateStringSchema,
	partySize: partySizeSchema,
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
})
