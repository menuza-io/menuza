import {
	and,
	db,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({
	code: z
		.string()
		.min(8)
		.max(24)
		.regex(/^[a-z0-9]+$/),
})

/**
 * Internal machine-to-machine lookup for supplier invoice mail (#503):
 * `GET /resources/inventory/invoice-address?code=<code>`.
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`. A regional
 * tenant-api node that received mail for `invoices+<code>@...` asks which
 * organization, location and data region the code names, and answers 404 for an
 * unknown code. Only the code travels here: the mail, its attachments and its
 * sender are never sent to the control plane.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid code' }, { status: 400 })
	}
	const [row] = await db
		.select({
			orgId: Organization.id,
			dataRegion: Organization.dataRegion,
			locationId: OrganizationLocation.id,
		})
		.from(OrganizationLocation)
		.innerJoin(
			Organization,
			eq(Organization.id, OrganizationLocation.organizationId),
		)
		.where(
			and(
				eq(OrganizationLocation.invoiceInboxCode, parsed.data.code),
				eq(Organization.active, true),
			),
		)
		.limit(1)
	if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
	return Response.json(
		{
			orgId: row.orgId,
			locationId: row.locationId,
			dataRegion: row.dataRegion === 'ksa' ? 'ksa' : 'us',
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
