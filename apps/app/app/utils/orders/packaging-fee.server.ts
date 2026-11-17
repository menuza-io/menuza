import { getFeatureFlag } from '@repo/common/feature-flags'
import { PACKAGING_FEE_CONTRACT_VERSION } from '@repo/common/packaging-fee'
import { and, db, eq, OrganizationLocation } from '@repo/database'

export const PACKAGING_FEE_FLAG_KEY = 'ordering.packaging_fee'

export async function isPackagingFeeEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(PACKAGING_FEE_FLAG_KEY, { organizationId })) === true
	)
}

export type PackagingFeeContext = {
	version: number
	locations: Record<string, unknown>
}

export async function buildPackagingFeeContext(
	organizationId: string,
	locationId?: string | null,
): Promise<PackagingFeeContext> {
	const empty = { version: PACKAGING_FEE_CONTRACT_VERSION, locations: {} }
	if (!(await isPackagingFeeEnabled(organizationId))) return empty
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			packagingFee: OrganizationLocation.packagingFee,
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
		if (!row.packagingFee) continue
		try {
			locations[row.id] = JSON.parse(row.packagingFee)
		} catch {
			locations[row.id] = { enabled: true }
		}
	}
	return { version: PACKAGING_FEE_CONTRACT_VERSION, locations }
}
