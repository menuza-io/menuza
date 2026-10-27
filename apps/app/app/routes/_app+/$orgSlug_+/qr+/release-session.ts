import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'
import { expireReleasedTabSession } from '#app/utils/restaurant-orders/checkout.server.ts'

const ReleasedSessionSchema = z.strictObject({
	tabId: z.string().min(1).max(64),
	sessionId: z.string().min(1).max(255),
	processor: z.string().min(1).max(32),
})

/**
 * After "Stop online payment" (browser to region), the browser hands the
 * released session here so the App, the only caller of the processors, can
 * close the guest's payment page. Ids only: no guest data crosses.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug, {
		write: true,
	})
	const parsed = ReleasedSessionSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return data({ error: 'invalid_request' }, { status: 400 })
	}
	const result = await expireReleasedTabSession({
		organizationId: access.organization.id,
		...parsed.data,
	})
	return data({ result }, { headers: { 'Cache-Control': 'private, no-store' } })
}
