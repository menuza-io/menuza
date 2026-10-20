import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
	readDevBody,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { mockOnboardOrganization } from '#app/utils/payments-mock/onboard.server.ts'

const schema = z.object({
	orgSlug: z.string().trim().min(1).max(100),
	provider: z.enum(['stripe', 'checkout']),
})

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/**
 * Dev only: `POST /mock-payments/dev/onboard { orgSlug, provider }` enables a
 * provider for an organization in one call (see docs/payments-mock.md).
 */
export async function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const body = await readDevBody(request, schema)
	const result = await mockOnboardOrganization(body)
	if (!result.ok) {
		return Response.json(
			{ error: result.error },
			{ status: result.status, headers: noStore },
		)
	}
	return Response.json(result, { headers: noStore })
}
