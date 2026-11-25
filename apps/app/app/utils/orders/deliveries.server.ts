import { DELIVERY_IN_HOUSE_FLAG_KEY } from '@repo/common/delivery-runs'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'

/**
 * Own-driver deliveries (#287) are behind the organization flag
 * `delivery.in_house` (default off, only a literal `true`).
 */
export async function isInHouseDeliveryEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(DELIVERY_IN_HOUSE_FLAG_KEY, { organizationId })) ===
		true
	)
}

export type DeliveryLocation = { id: string; name: string }

/** Active locations the Deliveries board can show; empty while the flag is off. */
export async function loadDeliveryLocations(
	organizationId: string,
): Promise<DeliveryLocation[]> {
	if (!(await isInHouseDeliveryEnabled(organizationId))) return []
	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
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
	return rows.map((row) => ({ id: row.id, name: row.name }))
}
