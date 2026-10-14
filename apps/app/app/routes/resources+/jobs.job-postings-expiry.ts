import { expireJobPostings } from '#app/utils/hiring/job-postings.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { type Route } from './+types/jobs.job-postings-expiry.ts'

/**
 * Daily (shares the `0 3 * * *` trigger; no cron slot of its own): marks every
 * published job posting whose closing date has passed as `expired`. Careers
 * pages already stop serving an ended posting the instant its date passes, so
 * this only keeps the stored status honest for the editor. Idempotent. The
 * response carries a count only.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)

	const result = await expireJobPostings()
	return Response.json({ success: true, ...result })
}
