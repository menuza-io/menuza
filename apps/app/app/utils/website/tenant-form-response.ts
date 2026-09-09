type TenantFormResponse = {
	id: string
	name: string
	description: string | null
	fields: unknown[]
	status: 'draft' | 'published'
	submitLabel: string
	successMessage: string
}

export function parseTenantFormResponse(
	payload: unknown,
): TenantFormResponse | null {
	if (!payload || typeof payload !== 'object') return null
	const form = (payload as { form?: unknown }).form
	if (!form || typeof form !== 'object') return null
	const id = (form as { id?: unknown }).id
	if (typeof id !== 'string' || id.length === 0) return null
	return form as TenantFormResponse
}
