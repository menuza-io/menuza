import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { reconcileSeatQuantities } from '#app/utils/payments.server.ts'
import { type Route } from './+types/jobs.seat-reconcile.ts'

/** Daily: puts each subscription's Stripe seat count back to its members. */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)

	const result = await reconcileSeatQuantities()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
