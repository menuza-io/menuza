import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	previewSetupReminder,
	sendManualSetupReminder,
} from '#app/utils/launch/setup-reminders.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const bodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('preview'),
		organizationId: z.string().min(1).max(64),
	}),
	z.object({
		intent: z.literal('send'),
		organizationId: z.string().min(1).max(64),
		adminUserId: z.string().min(1).max(64),
	}),
])

/**
 * `POST /resources/setup-reminder`, for Admin's Launch card (#271; internal
 * command token). `preview` says what the reminder would say and to how many
 * people; `send` sends one (once a day per organization, audit logged). The
 * answer carries words and counts only: never an address.
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
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const body = parsed.data
	const result =
		body.intent === 'preview'
			? await previewSetupReminder(body.organizationId)
			: await sendManualSetupReminder({
					organizationId: body.organizationId,
					adminUserId: body.adminUserId,
				})
	return Response.json(result, { headers: NO_STORE })
}
