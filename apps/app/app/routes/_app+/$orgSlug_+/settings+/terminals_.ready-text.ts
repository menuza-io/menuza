/**
 * "Text guests when their order is ready", per location (Settings,
 * Terminals). Action only: the Terminals loader reads the switches. Needs menu
 * write access, like the other Station settings on that page. Policy only:
 * the guest's number lives in the regional database, never here.
 */
import { auditService, AuditAction } from '@repo/audit'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const schema = z.object({
	locationId: z.string().min(1).max(64),
	enabled: z.enum(['true', 'false']),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true, slug: true, dataRegion: true },
	)
	const userId = await requireMenuWrite(request, organization.id)
	const parsed = schema.safeParse(
		Object.fromEntries((await request.formData()).entries()),
	)
	if (!parsed.success)
		return data({ ok: false, error: 'invalid_request' }, { status: 400 })
	// No SMS route outside the US region yet: the switch cannot be turned on.
	const enabled = parsed.data.enabled === 'true'
	if (enabled && organization.dataRegion !== 'us')
		return data({ ok: false, error: 'sms_unavailable' }, { status: 409 })
	const updated = await db
		.update(OrganizationLocation)
		.set({ readyTextEnabled: enabled })
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, parsed.data.locationId),
			),
		)
		.returning({ id: OrganizationLocation.id })
	if (updated.length === 0)
		return data({ ok: false, error: 'location_not_found' }, { status: 404 })
	// Station and the region read it from the published menu and order context.
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'organization_location',
		resourceId: parsed.data.locationId,
		details: enabled
			? 'Ready texts turned on for a location'
			: 'Ready texts turned off for a location',
		metadata: { readyTextEnabled: enabled },
		request,
	})
	return data({ ok: true, error: null })
}
