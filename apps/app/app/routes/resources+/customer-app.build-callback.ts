import { CUSTOMER_APP_BUILD_STATUSES } from '@repo/common/customer-app'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { applyBuildCallback } from '#app/utils/customer-apps/service.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const BodySchema = z.object({
	buildId: z.string().min(1).max(64),
	status: z.enum(CUSTOMER_APP_BUILD_STATUSES),
	externalBuildId: z.string().max(200).nullish(),
	logUrl: z.string().max(500).nullish(),
	error: z.string().max(60).nullish(),
})

/**
 * Build status callbacks from the pipeline (#156). Internal token only. A
 * finished build never moves back; the log link must be https.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const parsed = BodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json({ error: 'invalid' }, { status: 400 })
	}
	const result = await applyBuildCallback(parsed.data)
	if (!result.ok) {
		return Response.json({ error: result.code }, { status: 404 })
	}
	return Response.json({ ok: true, status: result.status })
}
