import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { reconcileReservationPayments } from '#app/utils/reservations/payments-reconcile.server.ts'
import { type Route } from './+types/jobs.reservation-payments-reconcile.ts'

/**
 * Hourly (rides the `0 * * * *` trigger): re-checks every reservation payment
 * session and refund the regions still list as pending, and pushes terminal
 * provider states through the same paths as the browser poll and the webhooks.
 * Idempotent; a transient provider failure skips the item until the next run.
 * The response carries counts only.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const summary = await reconcileReservationPayments()
	return Response.json({
		success: summary.failedOrganizations === 0,
		...summary,
	})
}
