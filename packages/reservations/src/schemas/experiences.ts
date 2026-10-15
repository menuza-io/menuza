import { z } from 'zod'
import {
	businessDateStringSchema,
	partySizeSchema,
	policyModeSchema,
	slotMinSchema,
} from './common.ts'

export const EXPERIENCE_STATUSES = ['draft', 'published', 'archived'] as const
export type ExperienceStatus = (typeof EXPERIENCE_STATUSES)[number]
export const experienceStatusSchema = z.enum(EXPERIENCE_STATUSES)

export const experienceScheduleSchema = z.strictObject({
	daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
	dates: z.array(businessDateStringSchema).optional(),
	excludedDates: z.array(businessDateStringSchema).optional(),
	seatings: z.array(slotMinSchema).min(1),
})

export const upsertExperienceSchema = z.strictObject({
	id: z.string().trim().min(1).optional(),
	locationId: z.string().trim().min(1),
	title: z.string().trim().min(1).max(140),
	slug: z
		.string()
		.trim()
		.min(1)
		.max(80)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	description: z.string().trim().max(4000).optional().nullable(),
	imageUrl: z.string().trim().max(1024).optional().nullable(),
	status: experienceStatusSchema.default('draft'),
	paymentMode: policyModeSchema.default('prepay'),
	pricePerCoverMinor: z.number().int().min(0).max(10_000_000),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Z]{3}$/)
		.default('USD'),
	cancelCutoffMin: z
		.number()
		.int()
		.min(0)
		.max(30 * 1440)
		.default(1440),
	minParty: partySizeSchema.default(2),
	maxParty: partySizeSchema.default(8),
	durationMin: z.number().int().min(15).max(720).default(120),
	usesTables: z.boolean().default(true),
	areaId: z.string().trim().min(1).optional().nullable(),
	coversCapPerSeating: z.number().int().min(1).max(500).default(20),
	schedule: experienceScheduleSchema,
})
