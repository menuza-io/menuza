import { auditService, AuditAction } from '@repo/audit'
import {
	type DailyDishStatusRowData,
	dailyDishStatusRowSchema,
} from '@repo/common/daily-dish-limits'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { type DailyLimitTopUp } from './daily-limit-top-up.ts'

/**
 * A manager adds to, or sets the amount left of, one dish's daily limit
 * through the organization's region (#409). The region keeps the counts; the
 * App only checks the location is the organization's, signs the call, and
 * writes the audit entry (ids and numbers, never a guest).
 */
export async function topUpDailyLimitThroughRegion(
	input: DailyLimitTopUp & {
		request: Request
		orgSlug: string
		organizationId: string
		userId: string
	},
): Promise<
	| { ok: true; row: DailyDishStatusRowData | null }
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
	const response = await fetch(
		`${tenantApiUrl}/operator/orders/daily-limits/top-up`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${jwt}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify({
				locationId: input.locationId,
				key: input.key,
				...input.change,
			}),
		},
	)
	const raw: unknown = await response.json().catch(() => ({}))
	const payload =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? (raw as { error?: string; row?: unknown })
			: {}
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			error: payload.error ?? 'top_up_failed',
		}
	}
	const row = dailyDishStatusRowSchema.safeParse(payload.row)

	await auditService.log({
		action: AuditAction.DAILY_DISH_LIMIT_TOPPED_UP,
		userId: input.userId,
		organizationId: input.organizationId,
		details: `Changed today's daily limit of a dish at ${location.name}`,
		metadata: {
			locationId: location.id,
			key: input.key,
			...input.change,
			...(row.success ? { remaining: row.data.remaining } : {}),
		},
		request: input.request,
		resourceType: 'organization_location',
		resourceId: location.id,
	})

	return { ok: true, row: row.success ? row.data : null }
}
