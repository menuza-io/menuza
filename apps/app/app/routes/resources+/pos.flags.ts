import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { isDeviceHealthOn } from '#app/utils/pos/device-health.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine endpoint: `GET /resources/pos/flags?orgId=`.
 * The organization's Station flags (flags only, no data), for the regional
 * tenant-api, which has no control-plane database. Authenticated with
 * `INTERNAL_COMMAND_TOKEN`.
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
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, parsed.data.orgId),
			eq(Organization.active, true),
		),
		columns: { id: true },
	})
	if (!org) return new Response('Not Found', { status: 404 })
	return Response.json(
		{ deviceHealth: await isDeviceHealthOn(org.id) },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
