import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { toEventSummary } from '#app/utils/payments-mock/events.server.ts'

/**
 * Dev only: `GET /mock-payments/dev/events?provider=&type=&limit=`, newest
 * first. Delivery state only; add `payload=1` for the signed body.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	const params = new URL(request.url).searchParams
	const provider = params.get('provider')
	if (provider !== null && provider !== 'stripe' && provider !== 'checkout') {
		return Response.json({ error: 'invalid_provider' }, { status: 400 })
	}
	const limit = Number(params.get('limit') ?? '')
	const events = await getPaymentsEmulator().events.list({
		provider: provider ?? undefined,
		type: params.get('type') ?? undefined,
		limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
	})
	return Response.json(
		events.map((event) => toEventSummary(event, params.get('payload') === '1')),
		{ headers: noStore },
	)
}

export function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}
