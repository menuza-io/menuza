import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Internal print commands (jobs-cron, Admin) authenticate with
 * INTERNAL_COMMAND_TOKEN. A caller without it gets a plain 403, never the
 * login redirect an operator page would send.
 */
export async function requirePrintInternalCommand(request: Request) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			throw new Response('Forbidden', { status: 403 })
		}
		throw error
	}
}
