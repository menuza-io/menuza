import { type ActionFunctionArgs } from 'react-router'
import { runHourlyGbpSweep } from '#app/utils/gbp/sweep.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Hourly Google Business Profile sweep (INTERNAL_COMMAND_TOKEN): retries
 * pending pushes, pulls listing diffs, checks verification daily, re-checks
 * order links weekly, and publishes coalesced menus/photos.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runHourlyGbpSweep()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
