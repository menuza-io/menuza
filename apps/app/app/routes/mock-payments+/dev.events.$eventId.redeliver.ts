import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { toEventSummary } from '#app/utils/payments-mock/events.server.ts'

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/** Dev only: `POST /mock-payments/dev/events/:eventId/redeliver` signs and sends it again. */
export async function action({ request, params }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const emulator = getPaymentsEmulator()
	const id = params.eventId ?? ''
	const event =
		(await emulator.events.redeliver('stripe', id)) ??
		(await emulator.events.redeliver('checkout', id))
	if (!event)
		return Response.json({ error: 'event_not_found' }, { status: 404 })
	return Response.json(toEventSummary(event, false), { headers: noStore })
}
