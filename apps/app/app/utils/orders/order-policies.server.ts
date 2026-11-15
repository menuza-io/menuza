import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	type GuestCancelContext,
	type OrderAcceptanceContext,
} from '@repo/common/restaurant-orders'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import {
	foldGuestCancel,
	foldOrderAcceptance,
	GUEST_CANCEL_FLAG_KEY,
	MANUAL_ACCEPTANCE_FLAG_KEY,
} from './order-policies.ts'

export async function isGuestCancelEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(GUEST_CANCEL_FLAG_KEY, { organizationId })) === true
	)
}

export async function isManualAcceptanceEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(MANUAL_ACCEPTANCE_FLAG_KEY, { organizationId })) ===
		true
	)
}

/**
 * The `guestCancel` and `acceptance` fields of the order context, for one
 * location when `locationId` is given, else every location. Locations are read
 * only while a flag is on.
 */
export async function buildOrderPolicyContext(
	organizationId: string,
	locationId?: string | null,
): Promise<{
	guestCancel: GuestCancelContext
	acceptance: OrderAcceptanceContext
}> {
	const [guestCancelFlag, acceptanceFlag] = await Promise.all([
		isGuestCancelEnabled(organizationId),
		isManualAcceptanceEnabled(organizationId),
	])
	if (!guestCancelFlag && !acceptanceFlag) {
		return { guestCancel: {}, acceptance: {} }
	}
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			guestCancelMinutes: OrganizationLocation.guestCancelMinutes,
			guestCancelScheduledLeadMinutes:
				OrganizationLocation.guestCancelScheduledLeadMinutes,
			orderAcceptanceMode: OrganizationLocation.orderAcceptanceMode,
			orderAcceptanceTimeoutMinutes:
				OrganizationLocation.orderAcceptanceTimeoutMinutes,
			orderAcceptanceMinTotalCents:
				OrganizationLocation.orderAcceptanceMinTotalCents,
			orderAcceptanceScheduledOnly:
				OrganizationLocation.orderAcceptanceScheduledOnly,
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
	return {
		guestCancel: foldGuestCancel(guestCancelFlag, rows),
		acceptance: foldOrderAcceptance(acceptanceFlag, rows),
	}
}
