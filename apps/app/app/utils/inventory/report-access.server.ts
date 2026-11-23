import { isImpersonating } from '@repo/auth'
import { INVENTORY_PERMISSIONS } from '@repo/inventory'
import {
	INVENTORY_REPORT_SUBJECTS,
	type InventoryReportSubject,
} from '@repo/reports/token'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import {
	getInventoryFeatureState,
	getUserInventoryGrants,
} from './access.server.ts'

export type InventoryReportAccess = {
	subjects: InventoryReportSubject[]
	scopeIds: string[] | null
}

const NONE: InventoryReportAccess = { subjects: [], scopeIds: [] }

export async function resolveInventoryReportAccess(input: {
	request: Request
	userId: string
	organizationId: string
}): Promise<InventoryReportAccess> {
	if (await isImpersonating(input.request)) return NONE
	const features = await getInventoryFeatureState(input.organizationId)
	if (!features.enabled) return NONE
	const [grants, locationIds] = await Promise.all([
		getUserInventoryGrants(input.userId, input.organizationId),
		resolveDiscountLocationIds(input.userId, input.organizationId),
	])
	const held = new Set<string>(grants)
	if (
		!held.has(INVENTORY_PERMISSIONS.READ_INVENTORY) ||
		!held.has(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
	) {
		return NONE
	}
	if (locationIds !== null && locationIds.length === 0) return NONE
	return {
		subjects: [...INVENTORY_REPORT_SUBJECTS],
		scopeIds: locationIds,
	}
}
