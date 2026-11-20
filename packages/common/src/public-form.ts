import { z } from 'zod'

import { parseLocalizedString } from './site-locales.ts'

export const publicFormFieldTypes = [
	'name',
	'text',
	'email',
	'single_choice',
	'tel',
	'multiple_choice',
	'heading',
	'datetime',
	'paragraph',
	'textarea',
	// Catering and event requests (#239): a street address and a pick of the
	// restaurant's own locations.
	'address',
	'location',
] as const

/** Field types that hold a typed answer (everything but display-only text). */
export const publicFormDisplayFieldTypes = ['heading', 'paragraph'] as const

export const publicFormFieldObjectSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	// Labels are localized JSON, so a cleared label is `{"en":""}` or `{}`.
	label: z
		.string()
		.trim()
		.min(1)
		// A label is localized JSON, so several site languages need more than 100.
		.max(500)
		.refine((label) => Object.keys(parseLocalizedString(label)).length > 0, {
			message: 'Every field needs a label.',
		}),
	type: z.enum(publicFormFieldTypes),
	required: z.boolean(),
	options: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
	/** Text fields only (#239): accept a number, optionally within a range. */
	numeric: z.boolean().optional(),
	min: z.number().finite().optional(),
	max: z.number().finite().optional(),
	/**
	 * Location fields only (#239): the locations offered. Empty or missing
	 * means every active location. A deactivated location is never offered.
	 */
	locationIds: z.array(z.string().min(1).max(100)).max(100).optional(),
	/**
	 * Show this field only for chosen answers of a single-choice field above it
	 * (#357). Option values are the source field's `options` strings.
	 */
	showWhen: z
		.object({
			fieldId: z.string().min(1).max(50),
			values: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
		})
		.optional(),
})

export function validatePublicFormFieldChoices(
	field: z.infer<typeof publicFormFieldObjectSchema>,
	context: z.RefinementCtx,
) {
	if (
		(field.type === 'single_choice' || field.type === 'multiple_choice') &&
		(field.options?.length ?? 0) < 1
	) {
		context.addIssue({
			code: 'custom',
			message: `${field.label} must include at least one choice.`,
			path: ['options'],
		})
	}
	if (field.numeric && field.type !== 'text') {
		context.addIssue({
			code: 'custom',
			message: `${field.label}: only text fields can be numbers.`,
			path: ['numeric'],
		})
	}
	if (
		field.min !== undefined &&
		field.max !== undefined &&
		field.min > field.max
	) {
		context.addIssue({
			code: 'custom',
			message: `${field.label}: the smallest number is above the largest.`,
			path: ['min'],
		})
	}
	if (field.locationIds && field.type !== 'location') {
		context.addIssue({
			code: 'custom',
			message: `${field.label}: only a location field lists locations.`,
			path: ['locationIds'],
		})
	}
}

export const publicFormFieldSchema = publicFormFieldObjectSchema.superRefine(
	validatePublicFormFieldChoices,
)

export const publicFormFieldsSchema = z
	.array(publicFormFieldSchema)
	.min(1)
	.max(20)
	.refine(
		(fields) => new Set(fields.map((field) => field.id)).size === fields.length,
		{ message: 'Field ids must be unique.' },
	)
	.refine((fields) => brokenConditionFieldIds(fields).length === 0, {
		message:
			'A field can only be shown by a single-choice field placed above it.',
	})

/**
 * Fields whose `showWhen` does not point at a single-choice field placed
 * above them (a deleted source, a moved field, a wrong type). Because a
 * condition must point upward, chains are allowed and loops are impossible.
 */
export function brokenConditionFieldIds(
	fields: ReadonlyArray<Pick<PublicFormFieldShape, 'id' | 'type' | 'showWhen'>>,
): string[] {
	const broken: string[] = []
	fields.forEach((field, index) => {
		if (!field.showWhen) return
		const source = fields
			.slice(0, index)
			.find((candidate) => candidate.id === field.showWhen!.fieldId)
		if (!source || source.type !== 'single_choice') broken.push(field.id)
	})
	return broken
}

/**
 * Clears every condition that no longer points at a single-choice field above
 * its own (#357), so the builder can warn about what it removed.
 */
export function clearBrokenConditions<T extends PublicFormFieldShape>(
	fields: T[],
): { fields: T[]; cleared: string[] } {
	const cleared = brokenConditionFieldIds(fields)
	if (cleared.length === 0) return { fields, cleared }
	return {
		fields: fields.map((field) => {
			if (!cleared.includes(field.id)) return field
			const { showWhen: ignoredShowWhen, ...rest } = field
			return rest as T
		}),
		cleared,
	}
}

type PublicFormFieldShape = {
	id: string
	type: (typeof publicFormFieldTypes)[number]
	required: boolean
	label: string
	options?: string[] | undefined
	numeric?: boolean | undefined
	min?: number | undefined
	max?: number | undefined
	locationIds?: string[] | undefined
	showWhen?: { fieldId: string; values: string[] } | undefined
}

/** The labels a choice option answers to: every locale of a localized option. */
export function choiceOptionLabels(option: string): string[] {
	const localized = parseLocalizedString(option)
	const labels = Object.values(localized)
		.map((label) => label?.trim())
		.filter(Boolean) as string[]
	return labels.length > 0 ? labels : [option.trim()]
}

export function isValidChoice(choice: string, options: readonly string[]) {
	return options.some((option) =>
		choiceOptionLabels(option).includes(choice.trim()),
	)
}

export type FormAnswers = Record<string, string | string[] | undefined | null>

/**
 * The fields a visitor sees for the answers given so far (#357). A field with
 * a condition is visible only when its source field is visible and the source
 * answer is one of the chosen values. One implementation: Sites uses it to
 * show and hide fields and tenant-api to drop what was hidden.
 */
export function visibleFields<T extends PublicFormFieldShape>(
	fields: readonly T[],
	answers: FormAnswers,
): T[] {
	const visibleIds = new Set<string>()
	const visible: T[] = []
	for (const field of fields) {
		const condition = field.showWhen
		if (condition) {
			if (!visibleIds.has(condition.fieldId)) continue
			const raw = answers[condition.fieldId]
			const answer = (Array.isArray(raw) ? raw[0] : raw)?.toString().trim()
			if (!answer || !isValidChoice(answer, condition.values)) continue
		}
		visibleIds.add(field.id)
		visible.push(field)
	}
	return visible
}

export const publicFormProjectionSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1).max(120),
	description: z.string().max(500).nullable(),
	fields: z.array(publicFormFieldSchema).min(1).max(20),
	submitLabel: z.string().min(1).max(50),
	successMessage: z.string().min(1).max(300),
	status: z.literal('published'),
	revision: z.string().min(1),
})

export type PublicFormField = z.infer<typeof publicFormFieldSchema>
export type PublicFormProjection = z.infer<typeof publicFormProjectionSchema>

export function publicFormKvKey(organizationId: string, formId: string) {
	return `public-form:v1:${organizationId}:${formId}`
}

/** Self-heal stale published-form projections when KV deletes fail. */
export const PUBLIC_FORM_CACHE_TTL_SECONDS = 60 * 60 * 24

export function toPublicFormProjection(form: {
	id: string
	name: string
	description: string | null
	fields: PublicFormField[]
	submitLabel: string
	successMessage: string
	status: string
	updatedAt?: string | Date | null
}): PublicFormProjection | null {
	if (form.status !== 'published') return null
	return {
		id: form.id,
		name: form.name,
		description: form.description,
		fields: form.fields,
		submitLabel: form.submitLabel,
		successMessage: form.successMessage,
		status: 'published',
		revision:
			form.updatedAt instanceof Date
				? form.updatedAt.toISOString()
				: form.updatedAt || new Date(0).toISOString(),
	}
}
