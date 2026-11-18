import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	getLocationHealth,
	summarizeLocations,
	type HealthSummary,
	type LocationHealth,
} from '@repo/common/location-health'
import {
	and,
	db,
	eq,
	inArray,
	Integration,
	PhoneAgent,
	PhoneAgentNumber,
} from '@repo/database'
import {
	hasActiveMenu,
	loadAttentionLocations,
	loadAttentionOrganization,
	loadMenuAvailability,
	PAY_AT_PICKUP_ONLY_FLAG,
} from '#app/utils/dashboards/attention.server.ts'
import { resolveRestaurantOnlinePayment } from '#app/utils/restaurant-orders/payment-config.server.ts'

export type LocationStatusData = {
	summary: HealthSummary
	locations: LocationHealth[]
}

function phoneAgentEnabled(settings: string | null): boolean {
	if (!settings) return false
	try {
		const parsed = JSON.parse(settings) as { enabled?: unknown }
		return parsed.enabled === true
	} catch {
		return false
	}
}

/**
 * Whether each active location the person may see can take orders right now,
 * from data the App already holds (no background job, no regional call). A
 * member limited to some locations sees only those: the same scope as the rest
 * of the dashboard (`loadAttentionLocations`). The checks themselves are the
 * pure `getLocationHealth` of `@repo/common`.
 */
export async function loadLocationStatus(input: {
	userId: string
	organizationId: string
	now?: Date
}): Promise<LocationStatusData | null> {
	const now = input.now ?? new Date()
	const [organization, { locations }] = await Promise.all([
		loadAttentionOrganization(input.organizationId),
		loadAttentionLocations(input.userId, input.organizationId),
	])
	if (!organization) return null

	const [menu, payAtPickupOnly, integrations, agentRows, numberRows] =
		await Promise.all([
			loadMenuAvailability(organization.id),
			getFeatureFlag(PAY_AT_PICKUP_ONLY_FLAG, {
				organizationId: organization.id,
			}),
			db
				.select({
					providerName: Integration.providerName,
					organizationLocationId: Integration.organizationLocationId,
					isActive: Integration.isActive,
					lastSyncAt: Integration.lastSyncAt,
				})
				.from(Integration)
				.where(
					and(
						eq(Integration.organizationId, organization.id),
						inArray(Integration.providerType, ['pos', 'delivery']),
					),
				),
			db
				.select({ settings: PhoneAgent.settings })
				.from(PhoneAgent)
				.where(eq(PhoneAgent.organizationId, organization.id))
				.limit(1),
			db
				.select({
					scopeId: PhoneAgentNumber.scopeId,
					isActive: PhoneAgentNumber.isActive,
				})
				.from(PhoneAgentNumber)
				.where(eq(PhoneAgentNumber.organizationId, organization.id)),
		])
	const payment = resolveRestaurantOnlinePayment(organization)
	const agent = agentRows[0]
		? { enabled: phoneAgentEnabled(agentRows[0].settings) }
		: null

	const health = locations.map((location) =>
		getLocationHealth({
			now,
			location: {
				id: location.id,
				name: location.name,
				timezone: location.timezone,
				storeHours: location.storeHours,
				onlineHours: location.onlineHours,
				specialHours: location.specialHours,
				orderingPausedAt: location.orderingPausedAt,
				orderingPausedUntil: location.orderingPausedUntil,
			},
			organization: {
				onlinePaymentsEnabled: payment.enabled,
				payAtPickupOnly: payAtPickupOnly === true,
				sitePublished: organization.sitePublished,
				customDomain: organization.customDomain,
				customDomainStatus: organization.customDomainStatus,
			},
			hasActiveMenu: hasActiveMenu(
				menu.menus,
				menu.overrides,
				location.id,
				now,
			),
			// A connection tied to this location, or one for the whole business.
			connections: integrations
				.filter(
					(row) =>
						row.organizationLocationId === null ||
						row.organizationLocationId === location.id,
				)
				.map((row) => ({
					providerName: row.providerName,
					isActive: row.isActive,
					lastSyncAt: row.lastSyncAt,
				})),
			phoneAgent: agent
				? {
						enabled: agent.enabled,
						// A line for this location, or one for the whole business.
						hasActiveLine: numberRows.some(
							(row) =>
								row.isActive &&
								(row.scopeId === null || row.scopeId === location.id),
						),
					}
				: null,
		}),
	)
	return { summary: summarizeLocations(health), locations: health }
}
