import { type LoaderFunctionArgs } from 'react-router'
import { gateDevApi, noStore } from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'

/**
 * Dev only: `GET /mock-payments/dev/objects/:provider/:id`, the raw provider
 * object for assertions (`stripe` or `checkout`; a Checkout.com `sid_` id
 * resolves to its payment).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	gateDevApi(request)
	if (params.provider !== 'stripe' && params.provider !== 'checkout') {
		return Response.json({ error: 'invalid_provider' }, { status: 400 })
	}
	const object = await getPaymentsEmulator().object(
		params.provider,
		params.id ?? '',
	)
	if (!object)
		return Response.json({ error: 'object_not_found' }, { status: 404 })
	return Response.json(object, { headers: noStore })
}
