import { alertKeywordEventSchema } from '@repo/common/operator-alerts'
import { type ActionFunctionArgs } from 'react-router'
import { applyAlertKeyword } from '#app/utils/alerts/recipients.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/orders/alert-keyword`: STOP and START replies to an order
 * alert text (#241). The US tenant-api receives every reply to the shared
 * texting number, hashes the sender (an HMAC, never the number) and forwards the
 * keyword here; a recipient with that hash is stopped or brought back. A reply
 * that matches nobody changes nothing. Internal token only.
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
	const parsed = alertKeywordEventSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const changed = await applyAlertKeyword(parsed.data)
	return Response.json({ changed }, { headers: NO_STORE })
}
