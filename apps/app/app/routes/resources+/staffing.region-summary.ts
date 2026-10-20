import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs, data } from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { requiresStaffConfirmation } from '#app/utils/staffing/region-confirmation.ts'
import { fetchStaffSummary } from '#app/utils/staffing/region-guard.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const querySchema = z.object({ orgSlug: z.string().min(1).max(100) })

/**
 * `GET /resources/staffing/region-summary?orgSlug=...`: how much staff data the
 * organization's current region holds, so the region-switch dialog can show what
 * would be deleted. Counts only; the same permission as the region action
 * (`update:settings:any`). The slug is resolved to an organization the caller is
 * an active member of, never trusted as an id.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserId(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) throw data({ error: 'Invalid request' }, { status: 400 })

	const organization = await requireUserOrganization(
		request,
		parsed.data.orgSlug,
		{ id: true, dataRegion: true, hasProvisionedDb: true },
	)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	if (!organization.hasProvisionedDb) {
		return Response.json(
			{ summary: null, known: true, requiresConfirmation: false },
			{ headers: NO_STORE },
		)
	}
	const summary = await fetchStaffSummary({
		organizationId: organization.id,
		dataRegion: organization.dataRegion,
	})
	return Response.json(
		{
			summary,
			known: summary !== null,
			requiresConfirmation: requiresStaffConfirmation(summary),
		},
		{ headers: NO_STORE },
	)
}
