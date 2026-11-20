import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { pruneFinishedSchedules } from '#app/utils/website/scheduled-publish.server.ts'
import { purgeWebsiteVersions } from '#app/utils/website/versions.server.ts'

/**
 * Daily (#85): purges the versions of pages deleted more than 30 days ago,
 * keeps every history at 50 versions, and drops finished schedule rows.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const [versions, schedules] = await Promise.all([
		purgeWebsiteVersions(),
		pruneFinishedSchedules(),
	])
	return Response.json({
		success: true,
		...versions,
		schedulesRemoved: schedules,
		timestamp: new Date().toISOString(),
	})
}
