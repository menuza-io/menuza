import { z } from 'zod'
import { normalizedPhoneSchema } from './common.ts'

export const GUEST_TAGS = [
	'vip',
	'regular',
	'friend_of_house',
	'press',
	'investor',
	'allergy',
	'high_value',
	'watch_no_show',
] as const

export const guestTagSchema = z.enum(GUEST_TAGS)

export const upsertGuestProfileSchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	phone: normalizedPhoneSchema.optional().nullable(),
	email: z.string().trim().email().max(160).optional().nullable(),
	vip: z.boolean().default(false),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
	dietaryPreferences: z.string().trim().max(500).optional().nullable(),
	seatingPreferences: z.string().trim().max(240).optional().nullable(),
	internalNotes: z.string().trim().max(2000).optional().nullable(),
	birthdayMonth: z.number().int().min(1).max(12).optional().nullable(),
	birthdayDay: z.number().int().min(1).max(31).optional().nullable(),
	anniversaryMonth: z.number().int().min(1).max(12).optional().nullable(),
	anniversaryDay: z.number().int().min(1).max(31).optional().nullable(),
	smsOptIn: z.boolean().default(false),
	marketingOptIn: z.boolean().default(false),
})

export const mergeGuestProfilesSchema = z.strictObject({
	sourceGuestId: z.string().trim().min(1),
	targetGuestId: z.string().trim().min(1),
})
