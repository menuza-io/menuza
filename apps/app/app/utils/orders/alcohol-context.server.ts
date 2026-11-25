import { type AlcoholContext } from '@repo/common/alcohol-rules'
import { and, db, eq, OrganizationLocation } from '@repo/database'

/**
 * Where alcohol may be ordered online, per location id (#167), and whether the
 * organization is in KSA (alcohol is refused online there, whatever is stored).
 * A location never reviewed has a null setting and is left out: the region
 * reads a missing one as pickup and delivery, what happened before the setting.
 */
export async function buildAlcoholContext(
	organizationId: string,
	dataRegion: string | null | undefined,
	locationId?: string | null,
): Promise<AlcoholContext> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			alcoholOnline: OrganizationLocation.alcoholOnline,
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
		if (row.alcoholOnline) locations[row.id] = row.alcoholOnline
	}
	return { ksa: dataRegion === 'ksa', locations }
}
