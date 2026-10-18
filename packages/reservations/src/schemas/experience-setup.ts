import { z } from 'zod'
import { MAX_EXPERIENCE_SEATINGS_PER_SCHEDULE } from '../engine/experience-seatings.ts'
import { businessDateStringSchema } from './common.ts'

/**
 * Operator setup input for Experiences (`architecture.md` 4.1). Currency is
 * never part of the input: the service takes it from the location settings.
 * Every refinement reports a path and a code, never the rejected value.
 */

export const SETUP_EXPERIENCE_KINDS = ['ticketed', 'prix_fixe'] as const
export const SETUP_EXPERIENCE_STATUSES = [
	'draft',
	'published',
	'archived',
] as const

/** The six site content locales (`packages/common/src/site-locales.ts`). */
export const EXPERIENCE_I18N_LOCALES = [
	'en',
	'ar',
	'es',
	'fr',
	'de',
	'zh',
] as const

export const EXPERIENCE_NAME_MAX = 140
export const EXPERIENCE_DESCRIPTION_MAX = 4000

const i18nShape = (max: number) =>
	Object.fromEntries(
		EXPERIENCE_I18N_LOCALES.map((l) => [
			l,
			z.string().trim().min(1).max(max).optional(),
		]),
	) as Record<
		(typeof EXPERIENCE_I18N_LOCALES)[number],
		z.ZodOptional<z.ZodString>
	>

export const experienceNameI18nSchema = z
	.strictObject(i18nShape(EXPERIENCE_NAME_MAX))
	.refine((v) => Object.values(v).some(Boolean), { message: 'required' })

export const experienceDescriptionI18nSchema = z.strictObject(
	i18nShape(EXPERIENCE_DESCRIPTION_MAX),
)

export const experienceSlugSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9-]+$/)

export const experienceImageUrlSchema = z
	.string()
	.trim()
	.max(1024)
	.refine(
		(value) => {
			try {
				return new URL(value).protocol === 'https:'
			} catch {
				return false
			}
		},
		{ message: 'https_only' },
	)

const minute = z.number().int().min(0).max(2880)
const partyField = z.number().int().min(1).max(99)
const idRef = z.string().trim().min(1).max(128)

const experienceBaseShape = {
	slug: experienceSlugSchema,
	kind: z.enum(SETUP_EXPERIENCE_KINDS),
	nameI18n: experienceNameI18nSchema,
	descriptionI18n: experienceDescriptionI18nSchema.nullable(),
	imageUrl: experienceImageUrlSchema.nullable(),
	priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
	pricePerCover: z.boolean(),
	policyId: idRef.nullable(),
	partyMin: partyField,
	partyMax: partyField,
	usesTables: z.boolean(),
	exclusive: z.boolean(),
	sort: z.number().int().min(0).max(10_000),
}

function checkPartyRange(
	value: { partyMin?: number; partyMax?: number },
	ctx: z.RefinementCtx,
) {
	if (
		value.partyMin !== undefined &&
		value.partyMax !== undefined &&
		value.partyMin > value.partyMax
	) {
		ctx.addIssue({ code: 'custom', path: ['partyMin'], message: 'range' })
	}
}

export const setupExperienceInputSchema = z
	.strictObject({
		...experienceBaseShape,
		kind: experienceBaseShape.kind.default('ticketed'),
		descriptionI18n: experienceBaseShape.descriptionI18n.optional(),
		imageUrl: experienceBaseShape.imageUrl.optional(),
		priceMinor: experienceBaseShape.priceMinor.optional(),
		pricePerCover: experienceBaseShape.pricePerCover.default(true),
		policyId: experienceBaseShape.policyId.optional(),
		partyMin: experienceBaseShape.partyMin.default(1),
		partyMax: experienceBaseShape.partyMax.default(8),
		usesTables: experienceBaseShape.usesTables.default(true),
		exclusive: experienceBaseShape.exclusive.default(false),
		sort: experienceBaseShape.sort.default(0),
	})
	.superRefine(checkPartyRange)

export const setupExperienceUpdateSchema = z
	.strictObject(experienceBaseShape)
	.partial()
	.extend({ expectedVersion: z.number().int().min(1) })
	.superRefine(checkPartyRange)

const scheduleBaseShape = {
	fromDate: businessDateStringSchema,
	toDate: businessDateStringSchema,
	daysMask: z.number().int().min(1).max(127),
	seatingMins: z
		.array(minute)
		.min(1)
		.max(MAX_EXPERIENCE_SEATINGS_PER_SCHEDULE)
		.nullable(),
	startMin: minute.nullable(),
	endMin: minute.nullable(),
	intervalMin: z.number().int().min(1).max(2880).nullable(),
	turnMin: z.number().int().min(15).max(480),
	coversCapPerSeating: z.number().int().min(1).max(9999).nullable(),
	coversCapPerDay: z.number().int().min(1).max(99_999).nullable(),
	areaIds: z.array(idRef).min(1).max(50).nullable(),
	serviceId: idRef.nullable(),
}

export type SetupExperienceScheduleShape = {
	fromDate?: string
	toDate?: string
	seatingMins?: number[] | null
	startMin?: number | null
	endMin?: number | null
	intervalMin?: number | null
}

/** Shared by create and by the service when it validates a merged update. */
export function checkScheduleShape(
	value: SetupExperienceScheduleShape,
	ctx: z.RefinementCtx,
) {
	if (
		value.fromDate !== undefined &&
		value.toDate !== undefined &&
		value.toDate < value.fromDate
	) {
		ctx.addIssue({ code: 'custom', path: ['toDate'], message: 'range' })
	}
	const explicit = value.seatingMins != null && value.seatingMins.length > 0
	const stepped =
		value.startMin != null || value.endMin != null || value.intervalMin != null
	if (explicit && stepped) {
		ctx.addIssue({ code: 'custom', path: ['seatingMins'], message: 'one_mode' })
		return
	}
	if (!explicit) {
		if (
			value.startMin == null ||
			value.endMin == null ||
			value.intervalMin == null
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['seatingMins'],
				message: 'seatings_required',
			})
			return
		}
		if (value.endMin <= value.startMin) {
			ctx.addIssue({ code: 'custom', path: ['endMin'], message: 'range' })
			return
		}
		const count =
			Math.floor((value.endMin - value.startMin) / value.intervalMin) + 1
		if (count > MAX_EXPERIENCE_SEATINGS_PER_SCHEDULE) {
			ctx.addIssue({
				code: 'custom',
				path: ['intervalMin'],
				message: 'too_many_seatings',
			})
		}
	}
}

export const setupExperienceScheduleInputSchema = z
	.strictObject({
		...scheduleBaseShape,
		daysMask: scheduleBaseShape.daysMask.default(127),
		seatingMins: scheduleBaseShape.seatingMins.optional(),
		startMin: scheduleBaseShape.startMin.optional(),
		endMin: scheduleBaseShape.endMin.optional(),
		intervalMin: scheduleBaseShape.intervalMin.optional(),
		turnMin: scheduleBaseShape.turnMin.default(90),
		coversCapPerSeating: scheduleBaseShape.coversCapPerSeating.optional(),
		coversCapPerDay: scheduleBaseShape.coversCapPerDay.optional(),
		areaIds: scheduleBaseShape.areaIds.optional(),
		serviceId: scheduleBaseShape.serviceId.optional(),
		expectedVersion: z.number().int().min(1).optional(),
	})
	.superRefine(checkScheduleShape)

export const setupExperienceScheduleUpdateSchema = z
	.strictObject(scheduleBaseShape)
	.partial()
	.extend({ expectedVersion: z.number().int().min(1).optional() })

export const experienceActionSchema = z.strictObject({
	expectedVersion: z.number().int().min(1).optional(),
})

export type SetupExperienceInput = z.infer<typeof setupExperienceInputSchema>
export type SetupExperienceUpdate = z.infer<typeof setupExperienceUpdateSchema>
export type SetupExperienceScheduleInput = z.infer<
	typeof setupExperienceScheduleInputSchema
>
export type SetupExperienceScheduleUpdate = z.infer<
	typeof setupExperienceScheduleUpdateSchema
>
