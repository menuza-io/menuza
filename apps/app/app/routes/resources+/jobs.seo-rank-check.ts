import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { runRankChecks } from '#app/utils/seo/rank-tracking.server.ts'
import { type Route } from './+types/jobs.seo-rank-check.ts'

/**
 * Daily (shares the `0 3 * * *` trigger): runs the weekly local rank check
 * of every keyword that is due (never checked, or a week since its last
 * check), within each organization's monthly budget, for organizations with
 * `seo.rank_tracking` on (#182). New keywords get their baseline the next
 * day. A check over the budget is recorded as skipped and counted here.
 * Also drops keywords removed more than 90 days ago. Counts only.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runRankChecks()
	return Response.json({ success: true, ...result })
}
