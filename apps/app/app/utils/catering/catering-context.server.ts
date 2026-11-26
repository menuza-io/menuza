import {
	CATERING_CONTRACT_VERSION,
	CATERING_FLAG_KEYS,
	parseCateringSettings,
	type CateringContext,
} from '@repo/common/catering'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, db, eq, OrganizationLocation } from '@repo/database'

/**
 * Catering flags (#124): `catering.enabled` is the master and `catering.quotes`
 * (a child) needs it. Only a literal `true` counts, so a missing or unreadable
 * flag reads as off. Default off for every organization.
 */
export type CateringFeatures = { enabled: boolean; quotes: boolean }

export async function getCateringFeatures(
	organizationId: string,
): Promise<CateringFeatures> {
	const [enabled, quotes] = await Promise.all([
		getFeatureFlag(CATERING_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(CATERING_FLAG_KEYS.quotes, { organizationId }),
	])
	return {
		enabled: enabled === true,
		quotes: enabled === true && quotes === true,
	}
}

export async function isCateringEnabled(organizationId: string) {
	return (await getCateringFeatures(organizationId)).enabled
}

/**
 * What the region reads (`catering` in the order context): the settings of
 * each location that turned catering on, while the org flag is on. Everything
 * is business configuration; the alert members are left out, the region has no
 * use for them. Returns `undefined` while the flag is off, so the region reads
 * catering as off.
 */
export async function buildCateringContext(
	organizationId: string,
	locationId?: string | null,
): Promise<CateringContext | undefined> {
	const features = await getCateringFeatures(organizationId)
	if (!features.enabled) return undefined
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			catering: OrganizationLocation.catering,
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
		const settings = parseCateringSettings(row.catering)
		if (!settings?.enabled) continue
		const { alertUserIds: ignoredAlerts, ...forTheRegion } = settings
		void ignoredAlerts
		locations[row.id] = forTheRegion
	}
	return {
		version: CATERING_CONTRACT_VERSION,
		quotes: features.quotes,
		locations,
	}
}
