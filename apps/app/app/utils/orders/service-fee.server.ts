import { getFeatureFlag } from '@repo/common/feature-flags'
import { SERVICE_FEE_CONTRACT_VERSION } from '@repo/common/service-fee'
import { and, db, eq, OrganizationLocation } from '@repo/database'

/** Org flag, default off, only a literal `true` counts. */
export const SERVICE_FEE_FLAG_KEY = 'ordering.service_fee'

export async function isServiceFeeEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(SERVICE_FEE_FLAG_KEY, { organizationId })) === true
	)
}

/** What the order context carries for the fee: see `readServiceFeePolicy`. */
export type ServiceFeeContext = {
	version: number
	locations: Record<string, unknown>
}

/**
 * The `serviceFee` field of the order context (#123): only while
 * `ordering.service_fee` is on, only locations whose saved fee is turned on.
 * The stored JSON goes through as it is, never re-shaped here, so a value the
 * region cannot read makes the region refuse orders at that location instead of
 * placing them without the fee. Unreadable JSON goes as an empty enabled
 * entry, which the region reads the same way. Policy only: no amounts of any
 * order, no guest data.
 */
export async function buildServiceFeeContext(
	organizationId: string,
	locationId?: string | null,
): Promise<ServiceFeeContext> {
	const empty = { version: SERVICE_FEE_CONTRACT_VERSION, locations: {} }
	if (!(await isServiceFeeEnabled(organizationId))) return empty
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			serviceFee: OrganizationLocation.serviceFee,
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
		if (!row.serviceFee) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(row.serviceFee)
		} catch {
			locations[row.id] = { enabled: true }
			continue
		}
		const enabled =
			parsed !== null &&
			typeof parsed === 'object' &&
			(parsed as { enabled?: unknown }).enabled === true
		// A fee that is off is not listed: the region treats a missing location
		// as off. Anything else that is not a plain `enabled: false` is listed.
		const explicitlyOff =
			parsed !== null &&
			typeof parsed === 'object' &&
			(parsed as { enabled?: unknown }).enabled === false
		if (enabled || !explicitlyOff) locations[row.id] = parsed
	}
	return { version: SERVICE_FEE_CONTRACT_VERSION, locations }
}
