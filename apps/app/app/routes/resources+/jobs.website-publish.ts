import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { publishDueSchedules } from '#app/utils/website/scheduled-publish.server.ts'

/**
 * Publishes every website schedule whose time has come (#180). The jobs-cron
 * `WebsitePublishWorkflow` calls it at the scheduled time, and the hourly
 * sweep calls it again as the backup. A schedule is claimed by one caller, so
 * any number of callers at once publish each page once.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await publishDueSchedules()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
