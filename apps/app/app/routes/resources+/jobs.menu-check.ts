import { type ActionFunctionArgs } from 'react-router'
import { runDailyDeliveryMenuChecks } from '#app/utils/integrations/menu-check.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Daily sweep checking that connected delivery platform menus match Menuza
 * (#144). Triggered once per day from `apps/jobs-cron` (`0 3 * * *`).
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const result = await runDailyDeliveryMenuChecks()
	return Response.json({
		success: true,
		...result,
		timestamp: new Date().toISOString(),
	})
}
