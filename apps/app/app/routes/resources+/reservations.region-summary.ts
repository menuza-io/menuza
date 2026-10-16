import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs, data } from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { requiresReservationsConfirmation } from '#app/utils/reservations/region-confirmation.ts'
import { fetchReservationsSummary } from '#app/utils/reservations/region-guard.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const querySchema = z
	.object({
		orgSlug: z.string().min(1).max(100).optional(),
		orgId: z.string().min(1).max(100).optional(),
	})
	.refine((val) => Boolean(val.orgSlug || val.orgId), {
		message: 'orgSlug or orgId is required',
	})

/**
 * `GET /resources/reservations/region-summary?orgSlug=...`: how much reservations
 * data the organization's current region holds, so the region-switch dialog can
 * show what would be deleted. Counts only; requires `update:settings:any`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	await requireUserId(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) throw data({ error: 'Invalid request' }, { status: 400 })

	const organization = await requireUserOrganization(
		request,
		parsed.data.orgSlug ?? parsed.data.orgId,
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
	const summary = await fetchReservationsSummary({
		organizationId: organization.id,
		dataRegion: organization.dataRegion,
	})
	return Response.json(
		{
			summary,
			known: summary !== null,
			requiresConfirmation: requiresReservationsConfirmation(summary),
		},
		{ headers: NO_STORE },
	)
}
