import { type ActionFunctionArgs } from 'react-router'
import { flushFormAlertDigests } from '#app/utils/forms/alerts.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * `POST /resources/jobs/form-alerts` (every 15 minutes, jobs-cron): sends the
 * batched email for form responses that arrived inside a member's 10-minute
 * window and were not followed by another response (#142). Counts only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await flushFormAlertDigests()
	return Response.json(result, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
