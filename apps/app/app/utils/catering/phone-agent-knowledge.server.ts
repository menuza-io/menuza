import { parseCateringSettings } from '@repo/common/catering'
import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { type FaqEntry } from '@repo/phone-agent'
import { getCateringFeatures } from './catering-context.server.ts'
import { cateringKnowledge } from './phone-agent-knowledge.ts'

type Zone = { name?: unknown; enabled?: unknown; deliveryFee?: unknown }

/**
 * Catering answers for one call (#325): the approved knowledge of the location
 * the call is for (the default one when the number is not tied to a location),
 * read live from its catering settings so a change reaches the next call. Empty
 * while the organization's `catering.enabled` flag is off or the location has
 * catering off.
 */
export async function cateringFaqForCall(input: {
	organizationId: string
	scopeId: string | null
	currency: string
	language: string
	defaultLocale: string
	now?: Date
}): Promise<FaqEntry[]> {
	if (!(await getCateringFeatures(input.organizationId)).enabled) return []
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
			catering: OrganizationLocation.catering,
			deliveryZones: OrganizationLocation.deliveryZones,
			isDefault: OrganizationLocation.isDefault,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, input.organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
	const row = input.scopeId
		? rows.find((candidate) => candidate.id === input.scopeId)
		: (rows.find(
				(candidate) => parseCateringSettings(candidate.catering)?.enabled,
			) ?? rows[0])
	if (!row) return []
	const settings = parseCateringSettings(row.catering)
	if (!settings?.enabled) return []
	let zones: Zone[] = []
	try {
		const parsed: unknown = row.deliveryZones
			? JSON.parse(row.deliveryZones)
			: []
		zones = Array.isArray(parsed) ? (parsed as Zone[]) : []
	} catch {
		zones = []
	}
	const enabled = zones.filter((zone) => zone.enabled !== false)
	const fees = enabled
		.map((zone) => Number(zone.deliveryFee))
		.filter((fee) => Number.isFinite(fee) && fee > 0)
	return cateringKnowledge({
		settings,
		facts: {
			currency: input.currency,
			deliveryZoneNames: enabled
				.map((zone) => (typeof zone.name === 'string' ? zone.name : ''))
				.filter(Boolean),
			deliveryFeeMinor:
				fees.length > 0 ? Math.round(Math.min(...fees) * 100) : null,
		},
		locationId: row.id,
		timeZone: row.timezone || 'UTC',
		locale: input.language,
		defaultLocale: input.defaultLocale,
		now: input.now ?? new Date(),
	})
}
