import { parseUtensilsSettings } from '@repo/common/checkout-utensils'
import { parseOnlineOrderingSettings } from '@repo/common/location-settings'
import { and, db, eq, OrganizationLocation } from '@repo/database'

export type UtensilsContext = Record<
	string,
	{ enabled: boolean; defaultRequested: boolean }
>

export async function buildUtensilsContext(
	organizationId: string,
	locationId?: string | null,
): Promise<UtensilsContext> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			onlineOrderingSettings: OrganizationLocation.onlineOrderingSettings,
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
	const out: UtensilsContext = {}
	for (const row of rows) {
		const settings = parseOnlineOrderingSettings(row.onlineOrderingSettings)
		const utensils = parseUtensilsSettings(settings?.utensils)
		if (utensils.enabled) {
			out[row.id] = {
				enabled: true,
				defaultRequested: utensils.defaultRequested,
			}
		}
	}
	return out
}

export async function buildPickupInstructionsContext(
	organizationId: string,
	locationId?: string | null,
): Promise<Record<string, string>> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			pickupInstructions: OrganizationLocation.pickupInstructions,
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
	const out: Record<string, string> = {}
	for (const row of rows) {
		const raw = row.pickupInstructions?.trim()
		if (raw) out[row.id] = raw
	}
	return out
}
