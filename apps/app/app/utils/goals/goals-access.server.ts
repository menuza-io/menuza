import { canReadOrderTotals } from '#app/utils/dashboards/today.server.ts'
import { type SalesGoalsAccess } from './goals.ts'

export async function loadSalesGoalsAccess(input: {
	userId: string
	organizationId: string
	orgSlug: string
	dataRegion: string
}): Promise<SalesGoalsAccess> {
	const orders = await canReadOrderTotals(input.userId, input.organizationId)
	if (!orders) return { available: false }
	const { resolveRegionalTenantApiUrls } =
		await import('#app/utils/tenant-api.server.ts')
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(input.dataRegion)
	return {
		available: true,
		tokenUrl: `/${input.orgSlug}/reports/token`,
		tenantApiUrl,
		goalsUrl: `/${input.orgSlug}/goals/progress`,
	}
}
