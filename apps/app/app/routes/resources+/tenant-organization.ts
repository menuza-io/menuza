import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
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

	return Response.json(organization ?? { error: 'Organization not found' }, {
		status: organization ? 200 : 404,
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
