import { reportLinkCheckRequestSchema } from '@repo/reports/send-contract'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { resolveCsvLinkGrants } from '#app/utils/reports/schedules.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/report-link-check`: where a regional node asks, before it
 * serves the CSV link of a scheduled report email, whether the link's
 * recipient may still have it (#121). Internal token only; the request is
 * three ids (strict) and the answer is `active` plus the recipient's grants as
 * they are now, never a figure or a name. See `resolveCsvLinkGrants`.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const parsed = reportLinkCheckRequestSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const answer = await resolveCsvLinkGrants({
		organizationId: parsed.data.orgId,
		scheduleId: parsed.data.scheduleId,
		userId: parsed.data.userId,
	})
	return Response.json(answer, { headers: NO_STORE })
}
