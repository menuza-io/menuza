import { z } from 'zod'
import {
	normalizedPhoneSchema,
	partySizeSchema,
	seatingPreferenceSchema,
} from './common.ts'

export const WAITLIST_STATUSES = [
	'waiting',
	'notified',
	'seated',
	'cancelled',
	'expired',
] as const

export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number]

export const waitlistStatusSchema = z.enum(WAITLIST_STATUSES)

export const publicJoinWaitlistSchema = z.strictObject({
	locationSlug: z.string().trim().min(1).max(80),
	partySize: partySizeSchema,
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema,
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	seatingPreference: seatingPreferenceSchema.default('any'),
	notes: z.string().trim().max(500).optional().nullable(),
	smsOptIn: z.boolean().default(true),
	turnstileToken: z.string().trim().max(2048).optional().nullable(),
	website: z.string().max(0).optional(),
})

export const operatorAddWaitlistEntrySchema = z.strictObject({
	locationId: z.string().trim().min(1),
	partySize: partySizeSchema,
	guestName: z.string().trim().min(1).max(120),
	guestPhone: normalizedPhoneSchema.optional().nullable(),
	guestEmail: z.string().trim().email().max(160).optional().nullable(),
	seatingPreference: seatingPreferenceSchema.default('any'),
	quotedWaitMin: z.number().int().min(0).max(480).optional().nullable(),
	notes: z.string().trim().max(500).optional().nullable(),
	smsOptIn: z.boolean().default(false),
})

export const operatorSeatWaitlistEntrySchema = z.strictObject({
	tableIds: z.array(z.string().trim().min(1)).min(1),
	durationMin: z.number().int().min(15).max(720).optional(),
})
