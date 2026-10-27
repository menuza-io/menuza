import { type ActionFunctionArgs } from 'react-router'
import { requirePrintInternalCommand } from '#app/utils/print/internal-command.server.ts'
import { syncOpenPrintOrders } from '#app/utils/print/orders.server.ts'

/**
 * Cron safety net for shipped prints: fetches the status of open vendor
 * orders whose webhook may have been missed (jobs-cron, INTERNAL_COMMAND_TOKEN).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requirePrintInternalCommand(request)
	const synced = await syncOpenPrintOrders()
	return Response.json({
		success: true,
		synced,
		timestamp: new Date().toISOString(),
	})
}
