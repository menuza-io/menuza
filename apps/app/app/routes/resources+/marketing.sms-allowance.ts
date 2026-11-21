import {
	smsAllowanceEventSchema,
	smsAllowanceResultSchema,
	type SmsAllowanceResult,
} from '@repo/common/marketing-allowance'
import { and, db, eq, Organization } from '@repo/database'
import {
	releaseSmsSend,
	startSmsSend,
} from '@repo/marketing/server/sms-allowance'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: SmsAllowanceResult) {
	return Response.json(smsAllowanceResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

/**
 * `POST /resources/marketing/sms-allowance`: where the regional broadcast
 * dispatcher confirms a text broadcast may start (it holds a send of the month,
 * or gets one now) and gives a send back when it will not go out (#247). Ids
 * only; the answer is yes, or "none left until this instant". Authenticated
 * with `INTERNAL_COMMAND_TOKEN` only. Counts are numbers in the control plane.
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
	const parsed = smsAllowanceEventSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const { orgId, campaignId, action: what } = parsed.data
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	if (what === 'release') {
		await releaseSmsSend({ organizationId: orgId, campaignId })
		return answer({ ok: true })
	}
	const started = await startSmsSend({ organizationId: orgId, campaignId })
	return answer(
		started.ok
			? { ok: true }
			: { ok: false, reason: 'exhausted', resetsAt: started.resetsAt },
	)
}
