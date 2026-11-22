import {
	ordersNotifyEventSchema,
	ordersNotifyResultSchema,
} from '@repo/common/operator-alerts'
import { type ActionFunctionArgs } from 'react-router'
import {
	deliverOrderAlert,
	loadAlertLocation,
	loadAlertOrganization,
	requestsFromEvent,
} from '#app/utils/alerts/order-alerts.server.ts'
import { isOrderAlertsEnabled } from '#app/utils/alerts/switches.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: {
	inApp: number
	emailed: number
	pushed: number
	texted: number
	skipped?: string
}) {
	return Response.json(ordersNotifyResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

function skipped(reason: string) {
	return answer({ inApp: 0, emailed: 0, pushed: 0, texted: 0, skipped: reason })
}

/**
 * `POST /resources/orders/notify`: where the regional tenant-api tells the App
 * an order or a tablet needs attention (#131, #241, #300, #190): a new order, a
 * waiting order, a scheduled order due soon, a payment to review, a large
 * order about to start, a tablet offline or back.
 *
 * The event is ids, an order number, a count, a time and a total (the strict
 * `ordersNotifyEventSchema`): a field that could carry a guest is a 400 and a
 * rejected value is never echoed. Recipients come from permissions and
 * location scope plus the location's confirmed recipients; each member's
 * preferences, quiet hours, snooze and threshold apply (#366).
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. Idempotent per event and
 * recipient. A flag or kill switch that is off, an unknown location or nobody
 * to tell answers 200 with a `skipped` reason, so the node stops retrying what
 * cannot succeed, and nothing is queued for later.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = ordersNotifyEventSchema.safeParse(raw)
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

	const organization = await loadAlertOrganization(event.orgId)
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	if (!(await isOrderAlertsEnabled(organization.id))) {
		return skipped('feature_off')
	}
	const location = event.locationId
		? await loadAlertLocation(organization.id, event.locationId)
		: null
	if (event.locationId && !location) return skipped('unknown_location')

	const result = await deliverOrderAlert({
		organization,
		location,
		requests: requestsFromEvent(event),
	})
	return answer(result)
}
