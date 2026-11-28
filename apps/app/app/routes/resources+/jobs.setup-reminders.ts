import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { runSetupReminders } from '#app/utils/launch/setup-reminders.server.ts'

/**
 * Daily setup reminder job (#271), triggered by the existing 03:00 jobs-cron
 * slot (no sixth cron trigger). For each organization that is not live it emails
 * the owners about the single next unfinished launch step, 1, 3 and 7 days
 * after the last progress, then stops; progress resets the sequence. Behind the
 * organization flag `launch.reminders` (default off). Idempotent: a day of the
 * sequence is claimed once, whatever the number of runs.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	try {
		const result = await runSetupReminders()
		return Response.json({
			success: true,
			...result,
			timestamp: new Date().toISOString(),
		})
	} catch (error) {
		console.error('Setup reminder job failed:', error)
		return Response.json({ success: false }, { status: 500 })
	}
}
