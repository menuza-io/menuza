import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	nextOccasionRun,
	runOccasionAutoSchedule,
	wakeOccasionWorkflow,
} from '#app/utils/marketing/occasion-schedule.server.ts'

/**
 * The marketing calendar's Auto-schedule (#152). Called by
 * `OccasionScheduleWorkflow` once a day (it sleeps until 06:00 UTC) and by the
 * hourly sweep. Creates the Scheduled broadcasts of the occasions that are 14
 * days away for organizations that turned Auto-schedule on for them, once per
 * occasion and year, then starts the next day's wake-up. Never sends: the
 * region sends a broadcast at its time, under consent, frequency and
 * quiet-hours rules.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runOccasionAutoSchedule()
	const woken = await wakeOccasionWorkflow(nextOccasionRun(Date.now()))
	return Response.json({ success: result.failed === 0, ...result, woken })
}
