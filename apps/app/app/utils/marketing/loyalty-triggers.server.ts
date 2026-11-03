import { getUserId } from '@repo/auth'
import {
	LOYALTY_PERMISSIONS,
	type LoyaltyPermission,
	type LoyaltyFeatures,
} from '@repo/loyalty'
import { isLoyaltyJourneyTrigger } from '@repo/tenant-db/types/journey'
import {
	getLoyaltyFeatureState,
	getUserLoyaltyGrants,
} from '#app/utils/loyalty/access.server.ts'

/** Pure rule: the module is on and the member can read loyalty data. */
export function computeLoyaltyTriggersEnabled(
	features: Pick<LoyaltyFeatures, 'enabled'>,
	grants: readonly LoyaltyPermission[],
) {
	if (!features.enabled) return false
	return (
		grants.includes(LOYALTY_PERMISSIONS.READ_LOYALTY) ||
		grants.includes(LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT)
	)
}

/** Whether the editor offers the `loyalty_*` triggers to this member. */
export async function loyaltyTriggersEnabled(
	request: Request,
	organizationId: string,
) {
	const features = await getLoyaltyFeatureState(organizationId)
	if (!features.enabled) return false
	const userId = await getUserId(request)
	if (!userId) return false
	const grants = await getUserLoyaltyGrants(userId, organizationId)
	return computeLoyaltyTriggersEnabled(features, grants)
}

/**
 * A loyalty trigger can only be saved while the module is on and the member
 * may read it. Journeys that already use one keep their trigger on save, so
 * `currentTriggerType` is allowed through.
 */
export function loyaltyTriggerBlocked(params: {
	triggerType: unknown
	enabled: boolean
	currentTriggerType?: string | null
}) {
	if (!isLoyaltyJourneyTrigger(params.triggerType)) return false
	if (params.enabled) return false
	return params.triggerType !== params.currentTriggerType
}
