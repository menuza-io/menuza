import { type ActionFunctionArgs } from 'react-router'
import { runDomainSweep } from '#app/utils/domains/sweep.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Every 15 minutes (jobs-cron) (#139, #283, #183, #276, #103): pending custom
 * domains are checked and go live (the operator is told), a pending host is
 * reminded after 7 days and released after 30, nameserver moves are seen,
 * domain registrations progress, renewals and their reminders run, email
 * forwarding and sending domains are checked. Safe to call more often.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runDomainSweep()
	return Response.json({
		success: result.errors === 0,
		...result,
		timestamp: new Date().toISOString(),
	})
}
