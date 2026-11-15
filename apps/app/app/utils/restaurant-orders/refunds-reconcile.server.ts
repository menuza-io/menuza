/**
 * Hourly reconcile of restaurant order provider refunds (jobs-cron -> App).
 *
 * For every active organization with a provisioned regional database and an
 * online payment account, ask the region for provider refunds still pending
 * (ids and amounts only), then:
 * - a refund never sent to the provider (no provider id) is executed, with
 *   the same key every other path uses, so it can never be refunded twice;
 * - a refund sent more than 15 minutes ago is read back from the provider and
 *   its final state reported (a missed webhook).
 *
 * A transient failure skips the item until the next run; one failing
 * organization or refund never stops the rest. The summary is counts only.
 */

import { type OrderProviderRefund } from '@repo/common/restaurant-orders'
import { and, db, eq, isNotNull, or, Organization } from '@repo/database'
import {
	executeBookedRestaurantRefund,
	logRestaurantRefundFailure,
	type RestaurantRefundOrg,
} from './refunds.server.ts'
import {
	fetchPendingRestaurantOrderRefunds,
	RegionalOrderApiError,
} from './regional-order-api.server.ts'

/** An executed refund is read back once it has been quiet this long. */
export const RESTAURANT_REFUND_RECHECK_AFTER_MS = 15 * 60_000
/**
 * A refund not yet sent is left alone this long, so the run does not race the
 * operator's own request or the region's kick (both would be harmless, but
 * there is no need).
 */
export const RESTAURANT_REFUND_EXECUTE_AFTER_MS = 60_000
/** Refunds read per organization and run. */
const PER_ORGANIZATION_LIMIT = 200

export type RestaurantRefundReconcileSummary = {
	organizations: number
	refundsChecked: number
	refundsExecuted: number
	refundsReported: number
	skipped: number
	failedOrganizations: number
}

function quietForMs(refund: OrderProviderRefund, now: number): number {
	const at = Date.parse(refund.updatedAt || refund.createdAt)
	return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY
}

async function reconcileOrganization(
	org: RestaurantRefundOrg,
	summary: RestaurantRefundReconcileSummary,
	now: number,
) {
	let pending: OrderProviderRefund[]
	try {
		pending = await fetchPendingRestaurantOrderRefunds({
			dataRegion: org.dataRegion,
			orgId: org.id,
			limit: PER_ORGANIZATION_LIMIT,
		})
	} catch (error) {
		// A region that predates provider refunds (or has no database for the
		// organization) answers 404: nothing to reconcile there.
		if (error instanceof RegionalOrderApiError && error.httpStatus === 404) {
			return
		}
		throw error
	}
	summary.organizations += 1
	for (const refund of pending) {
		if (refund.status !== 'pending') continue
		const quiet = quietForMs(refund, now)
		const due = refund.providerRefundId
			? quiet >= RESTAURANT_REFUND_RECHECK_AFTER_MS
			: quiet >= RESTAURANT_REFUND_EXECUTE_AFTER_MS
		if (!due) continue
		summary.refundsChecked += 1
		try {
			const result = await executeBookedRestaurantRefund(org, refund)
			if (!refund.providerRefundId) summary.refundsExecuted += 1
			if (result.status !== 'pending') summary.refundsReported += 1
		} catch (error) {
			summary.skipped += 1
			logRestaurantRefundFailure('reconcile refund', error)
		}
	}
}

export async function reconcileRestaurantOrderRefunds(
	now = Date.now(),
): Promise<RestaurantRefundReconcileSummary> {
	const summary: RestaurantRefundReconcileSummary = {
		organizations: 0,
		refundsChecked: 0,
		refundsExecuted: 0,
		refundsReported: 0,
		skipped: 0,
		failedOrganizations: 0,
	}
	// Only organizations that can take online payments can have a provider
	// refund: the others are never asked.
	const organizations = await db
		.select({
			id: Organization.id,
			dataRegion: Organization.dataRegion,
			hasProvisionedDb: Organization.hasProvisionedDb,
			checkoutSubEntityId: Organization.checkoutSubEntityId,
		})
		.from(Organization)
		.where(
			and(
				eq(Organization.active, true),
				eq(Organization.hasProvisionedDb, true),
				or(
					isNotNull(Organization.stripeConnectAccountId),
					isNotNull(Organization.checkoutSubEntityId),
				),
			),
		)
	for (const org of organizations) {
		try {
			await reconcileOrganization(org, summary, now)
		} catch (error) {
			summary.failedOrganizations += 1
			logRestaurantRefundFailure('reconcile organization', error)
		}
	}
	return summary
}
