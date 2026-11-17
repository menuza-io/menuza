import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * Records a manual availability change in the regional database (ids only).
 * Failures are logged and do not block the control-plane write.
 */
export async function recordMenuAvailabilityEvent(input: {
	orgId: string
	dataRegion: string
	locationId: string | null
	entityType: 'item' | 'modifier_option'
	entityId: string
	available: boolean
	internalCommandToken: string
}) {
	if (!input.locationId) return
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(input.dataRegion)
	try {
		await fetch(`${tenantApiUrl}/api/menu/availability-events`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${input.internalCommandToken}`,
			},
			body: JSON.stringify({
				orgId: input.orgId,
				locationId: input.locationId,
				entityType: input.entityType,
				entityId: input.entityId,
				event: input.available ? 'available' : 'unavailable',
			}),
		})
	} catch (error) {
		console.error('menu availability event failed', {
			orgId: input.orgId,
			entityId: input.entityId,
			error: error instanceof Error ? error.message : 'unknown',
		})
	}
}
