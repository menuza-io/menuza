import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { drainStaffingOutbox } from '#app/utils/staffing/outbox.server.ts'
import { type Route } from './+types/jobs.staffing-outbox.ts'

/**
 * Daily (shares the `0 4 * * *` trigger; no cron slot of its own): delivers the
 * staffing outbox, the control-plane queue of link, unlink and erase events for
 * the regional staff data. Rows carry ids only; the response carries counts
 * only. Failed deliveries back off exponentially and are retried on every run
 * until they succeed or run out of attempts.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const result = await drainStaffingOutbox({ purge: true })
	return Response.json({ success: result.failed === 0, ...result })
}
