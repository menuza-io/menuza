import { applyDeliveryStatus } from '@repo/auth'
import { statusFromTwilioStatus } from '@repo/common/sign-in-delivery'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** A message id, the provider's status word and a carrier error code. No number, no text. */
const eventSchema = z
	.object({
		providerMessageId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
		status: z.string().regex(/^[a-z_]{3,20}$/),
		errorCode: z
			.string()
			.regex(/^\d{3,6}$/)
			.nullable(),
	})
	.strict()

/**
 * `POST /resources/support/sms-status`: the US tenant-api node tells the App
 * what the carrier did with a sign-in code text (#246). It updates the delivery
 * log row of that message id. Internal token only.
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
	const parsed = eventSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const status = statusFromTwilioStatus(parsed.data.status)
	if (!status) return Response.json({ matched: false }, { headers: NO_STORE })
	const matched = await applyDeliveryStatus({
		provider: 'twilio',
		providerMessageId: parsed.data.providerMessageId,
		status,
		failureReason: parsed.data.errorCode,
	})
	// A report for a text that is not on the log is not an error (it was not a code).
	return Response.json({ matched }, { headers: NO_STORE })
}
