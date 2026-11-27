import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { runMonthlyResultsEmails } from '#app/utils/reports/monthly.server.ts'
import { runDueReportSchedules } from '#app/utils/reports/schedules.server.ts'

/**
 * Hourly report email job, triggered by the existing hourly jobs-cron slot (no
 * sixth cron trigger):
 * - sends the scheduled report emails that are due in each schedule's own
 *   reporting time zone (#121; the region runs the report and sends the email);
 * - on the 2nd of each month, from 08:00 in an organization's reporting time
 *   zone, sends the monthly results email to its owners and admins (#221; the
 *   region answers totals only).
 *
 * Idempotent: a schedule runs once per local date, a failed run is retried from
 * the same instant, a paused schedule or an organization with the
 * `reports.schedules` flag off is left alone, and a person gets at most one
 * monthly email per month. One part failing never stops the other.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const [schedules, monthly] = await Promise.allSettled([
		runDueReportSchedules(),
		runMonthlyResultsEmails(),
	])
	for (const part of [schedules, monthly]) {
		if (part.status === 'rejected') {
			console.error('Report email job failed:', part.reason)
		}
	}
	const failed = schedules.status === 'rejected' || monthly.status === 'rejected'
	return Response.json(
		{
			success: !failed,
			schedules: schedules.status === 'fulfilled' ? schedules.value : null,
			monthly: monthly.status === 'fulfilled' ? monthly.value : null,
			timestamp: new Date().toISOString(),
		},
		{ status: failed ? 500 : 200 },
	)
}
