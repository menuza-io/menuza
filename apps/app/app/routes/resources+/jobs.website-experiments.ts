import { type ActionFunctionArgs } from 'react-router'
import { sweepExperiments } from '#app/utils/experiments/experiments.server.ts'
import { readArmCounts } from '#app/utils/experiments/region.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * `POST /resources/jobs/website-experiments` (daily, jobs-cron) (#338): ends
 * every A/B test past its 60 days or at its visitor cap and purges those
 * sites' cache so the original shows again at once. Counts only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const { ended, organizationIds } = await sweepExperiments(readArmCounts)
	for (const organizationId of organizationIds) {
		await purgeOrganizationSiteCache(organizationId)
	}
	return Response.json(
		{ success: true, ended },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
