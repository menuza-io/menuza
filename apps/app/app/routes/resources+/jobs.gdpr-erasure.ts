import { z } from 'zod'
import { processDueErasureRequests } from '#app/utils/gdpr.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { type Route } from './+types/jobs.gdpr-erasure.ts'

/** Admin's expedite names one request; the cron sends no body. */
const bodySchema = z
	.object({ requestId: z.string().min(1).max(64).optional() })
	.strict()

export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)

	const text = await request.text()
	let body: unknown = {}
	if (text.trim()) {
		try {
			body = JSON.parse(text)
		} catch {
			return Response.json({ error: 'Invalid JSON' }, { status: 400 })
		}
	}
	const parsed = bodySchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid payload' }, { status: 400 })
	}

	const now = new Date()
	const results = await processDueErasureRequests({
		now,
		requestId: parsed.data.requestId,
	})

	return Response.json({
		success: results.failed === 0,
		...results,
		timestamp: now.toISOString(),
	})
}
