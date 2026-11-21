import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { applyDueMenuSchedules } from '#app/utils/menu/menu-schedules.server.ts'

/**
 * Applies every menu changeover schedule whose `goLiveAt` has arrived (#149).
 *
 * `MenuScheduleWorkflow` in `jobs-cron` sleeps until `goLiveAt` and calls this
 * endpoint right when the changeover is due (satisfying the within-5-minutes
 * criterion without adding a new cron slot), and the hourly `0 * * * *` sweep
 * calls it again as a backup. Each schedule is claimed atomically so concurrent
 * callers are no-ops.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await applyDueMenuSchedules()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
