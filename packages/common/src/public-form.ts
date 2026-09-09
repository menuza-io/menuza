import { z } from 'zod'

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
] as const

export const publicFormFieldObjectSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	label: z.string().trim().min(1).max(100),
	type: z.enum(publicFormFieldTypes),
	required: z.boolean(),
	options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
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
