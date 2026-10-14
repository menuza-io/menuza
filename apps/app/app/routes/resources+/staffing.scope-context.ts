import { and, db, eq, Organization } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getStaffingFeatureState } from '#app/utils/staffing/access.server.ts'
import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'

/**
 * Internal scope facts for the regional time clock.
 *
 * tenant-api cannot read the control plane, but a punch needs the scope's
 * time zone to fix the business date, and a kiosk shows the scope name. It
 * pulls both here, authenticated with `INTERNAL_COMMAND_TOKEN`, and caches them
 * for a few minutes. Only scope facts leave: ids, names and time zones.
 * No staff, pay or schedule data is read or returned, and the request names
 * only an organization.
 *
 * It also reports the organization's effective staffing flags and data region.
 * The regional tick has no operator token to carry the flags (tokens are minted
 * by the App only when a flag is on), so it asks here before it sends anything:
 * a flag that is off, or an answer that never arrives, means the tick does
 * nothing for that organization.
 */

const querySchema = z.object({ orgId: z.string().regex(TENANT_ORG_ID_PATTERN) })

export type StaffingScopeContextResponse = {
	orgId: string
	/** Effective flags (the master switch already folded into each). */
	features: {
		enabled: boolean
		timeclock: boolean
		scheduling: boolean
		hiring: boolean
	}
	dataRegion: string
	scopes: Array<{
		id: string
		name: string
		timeZone: string
		isActive: boolean
	}>
}

export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: a plain 403 instead of the browser redirect.
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
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, dataRegion: true },
	})
	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const scope = await loadOrganizationScope(org.id)

	const features = await getStaffingFeatureState(org.id)
	const response: StaffingScopeContextResponse = {
		orgId: org.id,
		features: {
			enabled: features.enabled,
			timeclock: features.timeclock,
			scheduling: features.scheduling,
			hiring: features.hiring,
		},
		dataRegion: org.dataRegion,
		scopes: [{ ...scope, isActive: true }],
	}
	return Response.json(response, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
