import { z } from 'zod'
import {
	businessDateStringSchema,
	normalizedPhoneSchema,
	partySizeSchema,
	seatingPreferenceSchema,
	slotMinSchema,
} from './common.ts'

export const voiceCheckAvailabilitySchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80).optional(),
	businessDate: businessDateStringSchema,
	partySize: partySizeSchema,
	preferredSlotMin: slotMinSchema,
	seatingPreference: seatingPreferenceSchema.default('any'),
})

export const voiceCreateReservationSchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80).optional(),
	businessDate: businessDateStringSchema,
	slotMin: slotMinSchema,
	partySize: partySizeSchema,
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema,
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	seatingPreference: seatingPreferenceSchema.default('any'),
	notes: z.string().trim().max(500).optional().nullable(),
	smsOptIn: z.boolean().default(true),
	idempotencyKey: z.string().trim().min(8).max(128),
})

export const voiceLookupByPhoneSchema = z.strictObject({
	guestPhone: normalizedPhoneSchema,
	locationSlug: z.string().trim().min(1).max(80).optional(),
})

export const voiceCancelReservationSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	guestPhone: normalizedPhoneSchema,
	reason: z.string().trim().max(500).optional().nullable(),
})
