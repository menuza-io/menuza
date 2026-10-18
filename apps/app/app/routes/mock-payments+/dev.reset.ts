import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'
import { clearMockOnboardingColumns } from '#app/utils/payments-mock/onboard.server.ts'

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/**
 * Dev only: `POST /mock-payments/dev/reset` wipes the emulator state and the
 * organizations' onboarding columns that point into it (mocked providers only).
 */
export async function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	await getPaymentsEmulator().reset()
	await clearMockOnboardingColumns()
	return Response.json({ ok: true }, { headers: noStore })
}
