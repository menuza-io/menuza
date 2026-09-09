import { publicFormFieldsSchema } from '@repo/common/public-form'
import { z } from 'zod'

const tenantFormResponseSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	description: z.string().nullable(),
	fields: publicFormFieldsSchema,
	status: z.enum(['draft', 'published']),
	submitLabel: z.string(),
	successMessage: z.string(),
})

export type TenantFormResponse = z.infer<typeof tenantFormResponseSchema>

export function parseTenantFormResponse(
	payload: unknown,
): TenantFormResponse | null {
	if (!payload || typeof payload !== 'object') return null
	const form = (payload as { form?: unknown }).form
	const parsed = tenantFormResponseSchema.safeParse(form)
	return parsed.success ? parsed.data : null
}
