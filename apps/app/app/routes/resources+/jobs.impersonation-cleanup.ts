import { cleanupExpiredImpersonationSessions } from '@repo/auth'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { type Route } from './+types/jobs.impersonation-cleanup.ts'

/**
 * Hourly (jobs-cron): ends impersonation sessions past their expiry. Each one
 * gets its ADMIN_IMPERSONATION_END audit entry (dated at the expiry), so a
 * START is never left without an END when nobody stops or replaces the
 * session by hand.
 */
export async function action({ request }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	await requireInternalCommandAuth(request)

	const ended = await cleanupExpiredImpersonationSessions()

	return Response.json({
		success: true,
		ended,
		timestamp: new Date().toISOString(),
	})
}
