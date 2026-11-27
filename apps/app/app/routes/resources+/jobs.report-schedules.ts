import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { runDueReportSchedules } from '#app/utils/reports/schedules.server.ts'

/**
 * Hourly report email job (#121), triggered by the existing hourly jobs-cron
 * slot (no sixth cron trigger):
 * - sends the scheduled report emails that are due in each schedule's own
 *   reporting time zone (the region runs the report and sends the email).
 *
 * Idempotent: a schedule runs once per local date, a failed run is retried from
 * the same instant, and a paused schedule or an organization with the
 * `reports.schedules` flag off is left alone.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const schedules = await runDueReportSchedules()
	return Response.json({
		success: true,
		schedules,
		timestamp: new Date().toISOString(),
	})
}
