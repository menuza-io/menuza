/**
 * Per-location Station register settings (#372 guest details & dish notes,
 * #171 custom items, #380 variance flag threshold). Policy only: guest names and
 * phone numbers stay in the regional database, never here.
 */
import { auditService, AuditAction } from '@repo/audit'
import {
	POS_CUSTOM_ITEMS_MODES,
	POS_GUEST_DETAILS_MODES,
	posLocationStationSettingsSchema,
} from '@repo/common/pos-orders'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const optionalThresholdSchema = z
	.union([z.string(), z.null(), z.undefined()])
	.transform((value, ctx) => {
		const trimmed = typeof value === 'string' ? value.trim() : ''
		if (!trimmed || trimmed === 'null') return null
		if (!/^\d+$/.test(trimmed)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'invalid_threshold',
			})
			return z.NEVER
		}
		const n = Number(trimmed)
		if (!Number.isSafeInteger(n) || n < 0 || n > 100_000_000) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'invalid_threshold',
			})
			return z.NEVER
		}
		return n
	})

const formSchema = z.object({
	locationId: z.string().min(1).max(64),
	guestDetails: z.enum(POS_GUEST_DETAILS_MODES),
	dishNotes: z.enum(['true', 'false']),
	customItems: z.enum(POS_CUSTOM_ITEMS_MODES),
	customItemMaxCents: z.coerce.number().int().min(1).max(100_000_000),
	cashVarianceFlagCents: optionalThresholdSchema,
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
	if (!parsed.success) {
		return data(
			{ ok: false, error: 'invalid_request', stationSettings: null },
			{ status: 400 },
		)
	}
	const stationSettings = posLocationStationSettingsSchema.parse({
		guestDetails: parsed.data.guestDetails,
		dishNotes: parsed.data.dishNotes === 'true',
		customItems: parsed.data.customItems,
		customItemMaxCents: parsed.data.customItemMaxCents,
		cashVarianceFlagCents: parsed.data.cashVarianceFlagCents,
	})
	const updated = await db
		.update(OrganizationLocation)
		.set({ stationSettings: JSON.stringify(stationSettings) })
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, parsed.data.locationId),
			),
		)
		.returning({ id: OrganizationLocation.id })
	if (updated.length === 0) {
		return data(
			{ ok: false, error: 'location_not_found', stationSettings: null },
			{ status: 404 },
		)
	}
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType: 'organization_location',
		resourceId: parsed.data.locationId,
		details: 'Updated Station register settings for a location',
		metadata: { stationSettings },
		request,
	})
	return data({ ok: true, error: null, stationSettings })
}
