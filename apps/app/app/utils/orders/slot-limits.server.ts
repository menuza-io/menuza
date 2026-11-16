import { ORDERING_SLOT_LIMITS_FLAG } from '@repo/common/ordering-flags'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'

export type SlotLimitsContext = { enabled: boolean }

export type SlotLimitLocation = {
	id: string
	name: string
	timezone: string
}

export async function buildSlotLimitsContext(
	organizationId: string,
): Promise<SlotLimitsContext> {
	const enabled = Boolean(
		await getFeatureFlag(ORDERING_SLOT_LIMITS_FLAG, { organizationId }),
	)
	return { enabled }
}

export async function isSlotLimitsEnabled(
	organizationId: string,
): Promise<boolean> {
	return (await buildSlotLimitsContext(organizationId)).enabled
}

/** Active locations for the Orders slot-limits panel. */
export async function loadSlotLimitLocations(
	organizationId: string,
): Promise<SlotLimitLocation[]> {
	const enabled = await buildSlotLimitsContext(organizationId)
	if (!enabled.enabled) return []
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		timezone: row.timezone || 'UTC',
	}))
}
