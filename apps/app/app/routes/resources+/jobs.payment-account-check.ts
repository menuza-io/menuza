import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { runDailyPaymentAccountDeadlineChecks } from '#app/utils/payments/account-alerts.server.ts'
import { runDailyDisputeDeadlineReminders } from '#app/utils/payments/disputes.server.ts'

/**
 * Daily payment visibility check (#269, #187):
 * - Sends 7, 3, and 1-day deadline reminders for payment accounts with due requirements.
 * - Sends 3-day deadline reminders for open payment disputes.
 * Triggered on the existing `0 3 * * *` jobs-cron slot (no sixth cron trigger).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const [accountDeadlines, disputeReminders] = await Promise.all([
		runDailyPaymentAccountDeadlineChecks(),
		runDailyDisputeDeadlineReminders(),
	])
	return Response.json({
		success: true,
		accountDeadlines,
		disputeReminders,
		timestamp: new Date().toISOString(),
	})
}
