import { db, eq, and, Organization } from '@repo/database'
import { loyaltyContextSchema } from '@repo/loyalty'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getLoyaltyFeatureState } from '#app/utils/loyalty/access.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine loyalty context endpoint:
 * `GET /resources/loyalty/context?orgId=<id>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`
 * (`requireInternalCommandAuth`). Returns the organization's folded
 * `loyalty.*` flags and nothing else: loyalty member data never leaves the
 * region.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return Response.json({ error: 'Forbidden' }, { status: 403 })
		}
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const { orgId } = parsed.data

	const [org] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const features = await getLoyaltyFeatureState(org.id)
	const payload = loyaltyContextSchema.parse({ orgId: org.id, features })

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'private, no-store',
		},
	})
}
