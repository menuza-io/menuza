/**
 * Per-location ticket settings (#363): which fields print on each ticket type,
 * which are bold or larger, when tickets print, and how adjusted and cancelled
 * orders print. Stored in the location's Station settings next to the register
 * settings, which this route never changes (and which never change these).
 * Policy only: no guest data.
 */
import { auditService, AuditAction } from '@repo/audit'
import {
	parsePosLocationStationSettings,
	posLocationStationSettingsSchema,
} from '@repo/common/pos-orders'
import { compactTickets, ticketsConfigSchema } from '@repo/common/ticket-config'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/** A ticket configuration is a few kilobytes at most. */
const MAX_JSON_LENGTH = 20_000

const formSchema = z.object({
	locationId: z.string().min(1).max(64),
	tickets: z.string().max(MAX_JSON_LENGTH),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug ?? '',
		{ id: true, slug: true },
	)
	const userId = await requireMenuWrite(request, organization.id)
	const form = Object.fromEntries((await request.formData()).entries())
	const parsed = formSchema.safeParse(form)
	const invalid = () =>
		data(
			{ ok: false, error: 'invalid_request', tickets: null },
			{ status: 400 },
		)
	if (!parsed.success) return invalid()
	let raw: unknown
	try {
		raw = JSON.parse(parsed.data.tickets)
	} catch {
		return invalid()
	}
	// A hand-made post with a wrong shape is refused, not quietly reset.
	const strict = ticketsConfigSchema.strict().safeParse(raw)
	if (!strict.success) return invalid()
	const tickets = compactTickets(strict.data)

	const [saved] = await db
		.select({ stationSettings: OrganizationLocation.stationSettings })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, parsed.data.locationId),
			),
		)
		.limit(1)
	if (!saved) {
		return data(
			{ ok: false, error: 'location_not_found', tickets: null },
			{ status: 404 },
		)
	}
	const stationSettings = posLocationStationSettingsSchema.parse({
		...parsePosLocationStationSettings(saved.stationSettings),
		tickets,
	})
	await db
		.update(OrganizationLocation)
		.set({ stationSettings: JSON.stringify(stationSettings) })
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, parsed.data.locationId),
			),
		)
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'organization_location',
		resourceId: parsed.data.locationId,
		details: 'Updated ticket settings for a location',
		metadata: { tickets },
		request,
	})
	return data({ ok: true, error: null, tickets: stationSettings.tickets })
}
