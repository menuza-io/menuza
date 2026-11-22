import { type ActionFunctionArgs } from 'react-router'
import { runOperatorAlertsSweep } from '#app/utils/alerts/sweep.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Runs the operator alerts' timed work (#106, #131, #366): pause and busy-mode
 * alerts, alerts held by quiet hours that are due, the push receipts sweep
 * (dead tokens removed) and the alert log's pruning.
 *
 * `OperatorAlertsWorkflow` in `jobs-cron` sleeps until quiet hours end and calls
 * this right then (no new cron slot), and the hourly sweep calls it too. Every
 * step is idempotent per member and occurrence, so a repeat is a no-op.
 * Internal token only; the answer is counts.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runOperatorAlertsSweep()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
