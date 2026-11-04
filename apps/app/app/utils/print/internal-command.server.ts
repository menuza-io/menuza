import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Internal print commands (jobs-cron, Admin) authenticate with
 * INTERNAL_COMMAND_TOKEN. A caller without it gets that route's 401.
 */
export async function requirePrintInternalCommand(request: Request) {
	await requireInternalCommandAuth(request)
}
