import { db, eq, and, Organization } from '@repo/database'
import { inventoryContextSchema } from '@repo/inventory'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine inventory context endpoint:
 * `GET /resources/inventory/context?orgId=<id>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`
 * (`requireInternalCommandAuth`). Returns the organization's folded
 * `inventory.*` flags and nothing else (`inventoryContextSchema`): stock,
 * counts and suppliers never leave the region. The regional tenant-api reads
 * this path.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
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

	const features = await getInventoryFeatureState(org.id)
	const payload = inventoryContextSchema.parse({ orgId: org.id, features })

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'private, no-store',
		},
	})
}
