import { CUSTOMER_APP_BUILD_STATUSES } from '@repo/common/customer-app'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	readCustomerAppBuildIdHeader,
	requireCustomerAppBuildCallbackAuth,
} from '#app/utils/customer-apps/pipeline-auth.server.ts'
import { applyBuildCallback } from '#app/utils/customer-apps/service.server.ts'

const BodySchema = z.object({
	buildId: z.string().min(1).max(64),
	status: z.enum(CUSTOMER_APP_BUILD_STATUSES),
	externalBuildId: z.string().max(200).nullish(),
	logUrl: z.string().max(500).nullish(),
	error: z.string().max(60).nullish(),
})

/**
 * Build status callbacks from the pipeline (#156). Authenticated per build with
 * CUSTOMER_APP_PIPELINE_TOKEN (not INTERNAL_COMMAND_TOKEN). A finished build
 * never moves back; the log link must be https on an allowed host.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireCustomerAppBuildCallbackAuth(request)
	const parsed = BodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json({ error: 'invalid' }, { status: 400 })
	}
	const headerBuildId = readCustomerAppBuildIdHeader(request)
	if (parsed.data.buildId !== headerBuildId) {
		return Response.json({ error: 'invalid' }, { status: 400 })
	}
	const result = await applyBuildCallback(parsed.data)
	if (!result.ok) {
		const status = result.code === 'not_found' ? 404 : 422
		return Response.json({ error: result.code }, { status })
	}
	return Response.json({ ok: true, status: result.status })
}