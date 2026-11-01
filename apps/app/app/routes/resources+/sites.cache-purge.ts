/**
 * Purges an organization's public site KV cache. Authenticated with
 * `INTERNAL_COMMAND_TOKEN` (Admin calls this after org-level discount flags
 * change; App has the SITES_DATA_KV binding).
 */

import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const bodySchema = z.object({
	organizationId: z.string().regex(TENANT_ORG_ID_PATTERN),
})

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 302) {
			return new Response('Forbidden', { status: 403 })
		}
		throw error
	}

	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json({ error: 'Invalid body' }, { status: 400 })
	}

	const org = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, parsed.data.organizationId),
			eq(Organization.active, true),
		),
		columns: { id: true, slug: true, customDomain: true },
	})
	if (!org) return new Response('Not Found', { status: 404 })

	await purgeOrganizationSiteCache(org.id, org.slug, org.customDomain)
	return Response.json({ ok: true })
}
