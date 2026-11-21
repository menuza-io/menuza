import { type ActionFunctionArgs } from 'react-router'
import { notifyDueExpiryAlerts } from '#app/utils/customer-apps/expiry-alerts.server.ts'
import { refreshDueStoreHealth } from '#app/utils/customer-apps/service.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Daily: reads each app's stores (at most once a day per app, with the last
 * known state kept when a store is unreachable) and then raises the developer
 * account expiry alerts 30 and 7 days before and on expiry (#156). jobs-cron,
 * INTERNAL_COMMAND_TOKEN. The answer is counts only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const health = await refreshDueStoreHealth()
	const alerts = await notifyDueExpiryAlerts()
	return Response.json({
		success: true,
		health,
		alerts,
		timestamp: new Date().toISOString(),
	})
}
