import { and, db, eq, OrganizationLocation } from '@repo/database'

export async function buildOrderCapsContext(
	organizationId: string,
	locationId?: string | null,
): Promise<{ locations: Record<string, unknown> }> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			orderCaps: OrganizationLocation.orderCaps,
		})
		.from(OrganizationLocation)
		.where(
			locationId
				? and(
						eq(OrganizationLocation.organizationId, organizationId),
						eq(OrganizationLocation.id, locationId),
					)
				: eq(OrganizationLocation.organizationId, organizationId),
		)
	const locations: Record<string, unknown> = {}
	for (const row of rows) {
		if (!row.orderCaps) continue
		try {
			locations[row.id] = JSON.parse(row.orderCaps)
		} catch {
			continue
		}
	}
	return { locations }
}
