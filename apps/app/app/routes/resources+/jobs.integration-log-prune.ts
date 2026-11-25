import { pruneOldIntegrationLogs } from '@repo/integrations'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Deletes `IntegrationLog` rows older than 90 days (#94).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)
	const { deleted } = await pruneOldIntegrationLogs(90)

	return Response.json({
		success: true,
		deleted,
		timestamp: new Date().toISOString(),
	})
}
