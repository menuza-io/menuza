/**
 * Till discount rules for a paired terminal. Authenticated with
 * `INTERNAL_COMMAND_TOKEN`. tenant-api calls this after checking the device
 * secret, so these rules never ride on the public menu.
 */

import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { buildPublicMenuDiscounts } from '#app/utils/discounts/order-context.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
})

export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid parameters' }, { status: 400 })
	}

	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, parsed.data.orgId),
			eq(Organization.active, true),
		),
		columns: { id: true },
	})
	if (!org) return new Response('Not Found', { status: 404 })

	const { discountRules } = await buildPublicMenuDiscounts(org.id)
	return Response.json(
		{ discountRules },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
