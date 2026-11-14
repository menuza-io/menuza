import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { reconcileRestaurantOrderRefunds } from '#app/utils/restaurant-orders/refunds-reconcile.server.ts'
import { type Route } from './+types/jobs.restaurant-order-refunds-reconcile.ts'

/**
 * Hourly (rides the `0 * * * *` trigger): re-drives restaurant order provider
 * refunds the regions still list as pending. A refund never sent to the
 * provider is executed (same idempotency key as every other path); one sent
 * more than 15 minutes ago is read back from the provider and its final state
 * reported. Idempotent; a transient failure skips the refund until the next
 * run. The response carries counts only.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const summary = await reconcileRestaurantOrderRefunds()
	return Response.json(
		{ success: summary.failedOrganizations === 0, ...summary },
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
