import { auditService, AuditAction } from '@repo/audit'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function resetSlotLimitsThroughRegion(input: {
	request: Request
	orgSlug: string
	organizationId: string
	userId: string
	locationId: string
}): Promise<
	| { ok: true; slotsCleared: string[] }
	| { ok: false; status: number; error: string }
> {
	const [location] = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, input.organizationId),
				eq(OrganizationLocation.id, input.locationId),
			),
		)
		.limit(1)
	if (!location) {
		return { ok: false, status: 404, error: 'location_not_found' }
	}

	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		input.request,
		input.orgSlug,
		{ scope: 'orders:write' },
	)
	const response = await fetch(`${tenantApiUrl}/operator/orders/limits/reset`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${jwt}`,
			'content-type': 'application/json',
			accept: 'application/json',
		},
		body: JSON.stringify({ locationId: input.locationId }),
	})
	const raw: unknown = await response.json().catch(() => ({}))
	const payload =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? (raw as { error?: string; slotsCleared?: string[] })
			: {}
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			error: payload.error ?? 'reset_failed',
		}
	}

	const slotsCleared = Array.isArray(payload.slotsCleared)
		? payload.slotsCleared
		: []

	await auditService.log({
		action: AuditAction.LOCATION_SLOT_LIMITS_RESET,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Reset order slot counters at ${location.name}`,
		metadata: { locationId: location.id, slotsCleared },
		request: input.request,
		resourceType: 'organization_location',
		resourceId: location.id,
	})

	return { ok: true, slotsCleared }
}
