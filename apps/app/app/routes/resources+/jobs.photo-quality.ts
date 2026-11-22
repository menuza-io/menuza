import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	processPhotoQualityForOrganization,
	sweepPhotoQuality,
} from '#app/utils/media/photo-quality.server.ts'

/**
 * Scores library photos in the background (#145).
 * - `{ organizationId }`: the Workflow's job (`PhotoQualityWorkflow`): analyze
 *   one batch of that organization's waiting images and say how many remain
 *   (`remaining`) and whether the daily limit stopped it (`limited`).
 * - An empty body (the hourly `0 * * * *` sweep): wakes the workflow for every
 *   organization with the flag on and images waiting; this is also how a
 *   backfill of old images is paced and resumed the next day.
 * The payload is an id: no photo, no organization data.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const text = await request.text().catch(() => '')
	let organizationId = ''
	if (text.trim()) {
		try {
			const body = JSON.parse(text) as { organizationId?: unknown }
			organizationId =
				typeof body.organizationId === 'string'
					? body.organizationId.trim()
					: ''
		} catch {
			return Response.json({ success: false }, { status: 400 })
		}
	}
	if (!organizationId) {
		return Response.json({ success: true, ...(await sweepPhotoQuality()) })
	}
	if (!/^[A-Za-z0-9_-]{8,64}$/u.test(organizationId)) {
		return Response.json({ success: false }, { status: 400 })
	}
	const batch = await processPhotoQualityForOrganization(organizationId)
	return Response.json({ success: true, organizationId, ...batch })
}
