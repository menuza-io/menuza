import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { drainMenuSyncOutbox } from '#app/utils/menu/menu-sync.server.ts'

/**
 * Drains queued POS and delivery menu/availability sync rows (#74).
 *
 * Woken on demand by `MenuSyncWorkflow` (`step.sleepUntil`), swept every 15
 * minutes, and run nightly with `?nightly=1` (03:00 UTC) for platforms that
 * accept whole-menu syncs nightly.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const url = new URL(request.url)
	const nightlyParam = url.searchParams.get('nightly')
	const nightly = nightlyParam === '1' || nightlyParam === 'true'

	const result = await drainMenuSyncOutbox({ nightly })
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
