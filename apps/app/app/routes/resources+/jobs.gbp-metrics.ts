import { type ActionFunctionArgs } from 'react-router'
import { runDailyGbpMetricsSweep } from '#app/utils/gbp/sweep.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Daily Google Business Profile performance metrics job
 * (INTERNAL_COMMAND_TOKEN): backfills 18 months for newly linked locations
 * and refreshes the last 7 days + monthly search terms without duplicates.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runDailyGbpMetricsSweep()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
