import {
	publicFormKvKey,
	publicFormProjectionSchema,
	type PublicFormProjection,
} from '@repo/common/public-form'

import { getSitesDataKV } from './worker-env'

export async function getCachedPublicForm(
	organizationId: string,
	formId: string,
) {
	const kv = getSitesDataKV()
	if (!kv) return null
	try {
		const form = await kv.get<PublicFormProjection>(
			publicFormKvKey(organizationId, formId),
			'json',
		)
		const parsed = publicFormProjectionSchema.safeParse(form)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export async function setCachedPublicForm(
	organizationId: string,
	form: PublicFormProjection,
) {
	const kv = getSitesDataKV()
	if (!kv) return
	try {
		const key = publicFormKvKey(organizationId, form.id)
		const current = await kv.get<PublicFormProjection>(key, 'json')
		if (current && current.revision > form.revision) return
		await kv.put(key, JSON.stringify(form))
	} catch {
		// A cache write must never prevent the public form from rendering.
	}
}
