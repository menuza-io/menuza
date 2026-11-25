import {
	parseCateringSettings,
	type CateringAnswerFacts,
	type CateringSettings,
} from '@repo/common/catering'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { getCateringFeatures } from './catering-context.server.ts'

/**
 * What a guest page may know about a location's catering (#124, #325): the
 * business settings the catering page shows and the facts the setting-backed
 * answers read. Never the members told about requests, never a guest.
 */
export type PublicCateringLocation = {
	settings: Omit<CateringSettings, 'alertUserIds'>
	facts: CateringAnswerFacts
}

export type PublicCatering = {
	quotes: boolean
	locations: Record<string, PublicCateringLocation>
}

function lowestFeeMinor(
	zones: ReadonlyArray<{ enabled?: boolean; deliveryFee?: number }>,
): number | null {
	const fees = zones
		.filter((zone) => zone.enabled !== false)
		.map((zone) => zone.deliveryFee)
		.filter((fee): fee is number => typeof fee === 'number' && fee > 0)
	return fees.length > 0 ? Math.round(Math.min(...fees) * 100) : null
}

/**
 * The public catering block of the site menu payload: only while the
 * organization's `catering.enabled` flag is on, only locations that turned it
 * on. Absent otherwise, so the catering page does not exist.
 */
export async function buildPublicCatering(
	organizationId: string,
	locations: ReadonlyArray<{
		id: string
		currency: string
		deliveryZones: ReadonlyArray<{
			name: string
			enabled?: boolean
			deliveryFee?: number
		}>
	}>,
): Promise<PublicCatering | undefined> {
	const features = await getCateringFeatures(organizationId)
	if (!features.enabled) return undefined
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			catering: OrganizationLocation.catering,
		})
		.from(OrganizationLocation)
		.where(and(eq(OrganizationLocation.organizationId, organizationId)))
	const result: Record<string, PublicCateringLocation> = {}
	for (const row of rows) {
		const settings = parseCateringSettings(row.catering)
		if (!settings?.enabled) continue
		const location = locations.find((candidate) => candidate.id === row.id)
		if (!location) continue
		const { alertUserIds: ignoredAlerts, ...publicSettings } = settings
		void ignoredAlerts
		result[row.id] = {
			settings: {
				...publicSettings,
				quoteMode: features.quotes ? publicSettings.quoteMode : 'off',
			},
			facts: {
				currency: location.currency,
				deliveryZoneNames: location.deliveryZones
					.filter((zone) => zone.enabled !== false)
					.map((zone) => zone.name)
					.filter(Boolean),
				deliveryFeeMinor: lowestFeeMinor(location.deliveryZones),
			},
		}
	}
	return { quotes: features.quotes, locations: result }
}
