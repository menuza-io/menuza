import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { loadCustomerAppSummary } from '#app/utils/customer-apps/summary.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({ orgId: z.string().regex(TENANT_ORG_ID_PATTERN) })

/**
 * What a regional node needs to know about an organization's branded app
 * (#196, #105): the live stores for the "Track this order in the app" block in
 * the receipt email, and whether push can be sent (flags, credentials set).
 * Internal token only. Public facts and booleans: never a credential.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	await requireInternalCommandAuth(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_organization' }, { status: 400 })
	}
	return Response.json(await loadCustomerAppSummary(parsed.data.orgId), {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
