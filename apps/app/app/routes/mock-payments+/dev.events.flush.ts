import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/** Dev only: `POST /mock-payments/dev/events/flush` delivers every queued or failed event. */
export async function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const provider = new URL(request.url).searchParams.get('provider')
	const result = await getPaymentsEmulator().events.flush({
		provider:
			provider === 'stripe' || provider === 'checkout' ? provider : undefined,
	})
	return Response.json(result, { headers: noStore })
}
