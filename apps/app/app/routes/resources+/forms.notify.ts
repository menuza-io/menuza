import { formResponseEventSchema } from '@repo/common/form-alerts'
import { and, db, eq, Organization } from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { deliverFormResponseAlert } from '#app/utils/forms/alerts.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/forms/notify`: where a region tells the App that a website
 * form got a response (#142). The event is the strict contract in
 * `@repo/common/form-alerts`: an organization id, a form id and name, a count
 * and who is notified, never an answer. The App resolves members and their
 * notification choices, writes an in-app notification per response and sends
 * emails batched to one per form per member every 10 minutes. Authenticated
 * with `INTERNAL_COMMAND_TOKEN` only; counts in the response.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = formResponseEventSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const event = parsed.data
	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, event.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	return Response.json(await deliverFormResponseAlert(event, organization), {
		headers: NO_STORE,
	})
}
