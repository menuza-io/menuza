import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { buildEmailIdentity } from '#app/utils/email-sender/sender.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
})

export async function loader({ request }: LoaderFunctionArgs) {
	await requireInternalCommandAuth(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid organization ID' }, { status: 400 })
	}

	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			customDomain: Organization.customDomain,
			dataRegion: Organization.dataRegion,
			hasProvisionedDb: Organization.hasProvisionedDb,
		})
		.from(Organization)
		.where(
			and(
				eq(Organization.id, parsed.data.orgId),
				eq(Organization.active, true),
			),
		)
		.limit(1)

	if (!organization) {
		return Response.json(
			{ error: 'Organization not found' },
			{ status: 404, headers: { 'Cache-Control': 'private, no-store' } },
		)
	}
	// Business identity only (#103): the sender name, a verified reply-to and a
	// verified sending address, so the region sends as the organization.
	return Response.json(
		{ ...organization, emailSender: await buildEmailIdentity(organization.id) },
		{ status: 200, headers: { 'Cache-Control': 'private, no-store' } },
	)
}
