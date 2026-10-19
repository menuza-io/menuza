/**
 * Hourly reconcile of reservation payments (jobs-cron -> App).
 *
 * For every active, reservations-enabled organization with a provisioned
 * regional database, ask the region for bound sessions still pending and
 * refunds still pending (ids only), retrieve each from the provider and push
 * terminal states through the same paths as the browser poll and the webhooks.
 *
 * A transient provider failure skips the item (retried on the next run, never
 * reported as terminal); one failing organization or item never stops the rest.
 */

import { and, db, eq, Organization } from '@repo/database'
import {
	checkoutRefundActionStatus,
	mapCheckoutPaymentToReservationPayment,
	mapStripeRefundToReservation,
	mapStripeSessionToReservationPayment,
	reservationCheckoutReference,
	type ReservationPaymentEvent,
	type ReservationRefundEvent,
} from '@repo/payments'
import { type ReservationPendingResponse } from '@repo/reservations'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'
import {
	issueReservationRefund,
	loadReservationPaymentsOrg,
	logReservationPaymentFailure,
	pushReservationPaymentEvent,
} from '#app/utils/reservations/payments.server.ts'
import {
	claimReservationRefunds,
	fetchPendingReservationPayments,
	RegionalPaymentsApiError,
	reportReservationRefundResult,
} from '#app/utils/reservations/regional-payments-api.server.ts'
import { getShopCommerce } from '#app/utils/shop.server.ts'

export type ReservationReconcileSummary = {
	organizations: number
	sessionsChecked: number
	sessionsPushed: number
	refundsChecked: number
	refundsReported: number
	skipped: number
	failedOrganizations: number
}

type PendingSession = ReservationPendingResponse['sessions'][number]
type PendingRefund = ReservationPendingResponse['refunds'][number]
type OrgScope = { id: string; dataRegion: string | null }

/**
 * Does this provider refund belong to the pending regional refund row?
 *
 * Primary key: the opaque `refundRequestId` in the refund metadata. A refund
 * whose metadata has none (a late-payment refund issued before the region named
 * its row) is recognised by the documented fallback key: same organization,
 * metadata kind `late_payment`, same payment reference and same amount. Both
 * come from the provider object, never from the feed row alone.
 */
export function refundBelongsToRequest(
	event: Pick<
		ReservationRefundEvent,
		'orgId' | 'refundRequestId' | 'late' | 'paymentRef' | 'amountMinor'
	>,
	orgId: string,
	refund: Pick<PendingRefund, 'refundRequestId' | 'paymentRef' | 'amountMinor'>,
): boolean {
	if (event.orgId !== orgId) return false
	if (event.refundRequestId) {
		return event.refundRequestId === refund.refundRequestId
	}
	return (
		event.late &&
		event.paymentRef !== null &&
		event.paymentRef === refund.paymentRef &&
		event.amountMinor === refund.amountMinor
	)
}

/** Look up one pending session at its provider; null when nothing is decided. */
async function lookupSessionEvent(
	org: OrgScope,
	session: PendingSession,
): Promise<ReservationPaymentEvent | null> {
	const commerce = getShopCommerce()
	if (session.processor === 'stripe') {
		const found = await commerce.retrieveReservationStripeSession(
			session.sessionId,
			{ setup: session.purpose === 'guarantee' },
		)
		const event = mapStripeSessionToReservationPayment(found)
		if (!event || event.sessionId !== session.sessionId) return null
		return event
	}
	const reference = reservationCheckoutReference({
		orgId: org.id,
		reservationId: session.reservationId,
		feeId: session.feeId,
		purpose: session.purpose,
	})
	if (session.sessionId !== reference) return null
	const payments = await commerce.findReservationCheckoutPayments(reference)
	const events = payments
		.map((payment) => mapCheckoutPaymentToReservationPayment(payment))
		.filter((event): event is ReservationPaymentEvent => event !== null)
	return (
		events.find(
			(event) => event.status === 'paid' || event.status === 'setup_succeeded',
		) ??
		events.find((event) => event.status === 'failed') ??
		null
	)
}

async function reconcileSession(
	org: OrgScope,
	session: PendingSession,
	summary: ReservationReconcileSummary,
) {
	summary.sessionsChecked += 1
	const event = await lookupSessionEvent(org, session)
	if (
		!event ||
		event.orgId !== org.id ||
		event.reservationId !== session.reservationId ||
		event.purpose !== session.purpose ||
		(event.status !== 'paid' &&
			event.status !== 'failed' &&
			event.status !== 'expired' &&
			event.status !== 'setup_succeeded')
	) {
		return
	}
	await pushReservationPaymentEvent(org, event)
	summary.sessionsPushed += 1
}

async function reconcileRefund(
	org: OrgScope,
	refund: PendingRefund,
	summary: ReservationReconcileSummary,
) {
	summary.refundsChecked += 1
	const commerce = getShopCommerce()
	const scope = {
		dataRegion: org.dataRegion,
		orgId: org.id,
		refundRequestId: refund.refundRequestId,
		amountMinor: refund.amountMinor,
	}

	if (refund.refundRef === null) {
		// Requested or claimed but never issued. The feed row is a hint only:
		// its fee reversal is not computed until the region claims the refund,
		// so a stale `requested` row would reverse no platform commission. Take
		// the authoritative claim (it computes the reversal and keeps a lapsed
		// claim's amounts stable) and execute only what the claim returns. A
		// refusal (409) means another worker holds it: never executed twice.
		let claims
		try {
			claims = await claimReservationRefunds({
				dataRegion: org.dataRegion,
				orgId: org.id,
				refundRequestId: refund.refundRequestId,
			})
		} catch (error) {
			if (error instanceof RegionalPaymentsApiError && !error.retryable) {
				return
			}
			throw error
		}
		const orgRow = await loadReservationPaymentsOrg(org.id)
		if (!orgRow) return
		for (const claim of claims) {
			if (claim.refundRequestId !== refund.refundRequestId) continue
			const execution = await issueReservationRefund({
				org: orgRow,
				directive: claim,
				refundRequestId: claim.refundRequestId,
			})
			await reportReservationRefundResult({
				...scope,
				amountMinor: execution.amountMinor,
				refundRef: execution.refundRef ?? undefined,
				status: execution.status,
			})
			summary.refundsReported += 1
		}
		return
	}

	let status: 'succeeded' | 'pending' | 'failed'
	if (refund.processor === 'stripe') {
		const stored = await commerce.retrieveReservationStripeRefund(
			refund.refundRef,
		)
		const event = mapStripeRefundToReservation(stored)
		if (!event || !refundBelongsToRequest(event, org.id, refund)) return
		status = event.status
	} else {
		const actions = await commerce.listReservationCheckoutPaymentActions(
			refund.paymentRef,
		)
		const action = actions.find((entry) => entry.id === refund.refundRef)
		if (!action) return
		status = checkoutRefundActionStatus(action)
	}
	if (status === 'pending') return
	await reportReservationRefundResult({
		...scope,
		refundRef: refund.refundRef,
		status,
	})
	summary.refundsReported += 1
}

/** Run one organization's reconcile; item failures are counted, not thrown. */
async function reconcileOrganization(
	org: OrgScope,
	summary: ReservationReconcileSummary,
) {
	const pending = await fetchPendingReservationPayments({
		dataRegion: org.dataRegion,
		orgId: org.id,
	})
	for (const session of pending.sessions) {
		try {
			await reconcileSession(org, session, summary)
		} catch (error) {
			summary.skipped += 1
			logReservationPaymentFailure('reconcile session', error)
		}
	}
	for (const refund of pending.refunds) {
		try {
			await reconcileRefund(org, refund, summary)
		} catch (error) {
			summary.skipped += 1
			logReservationPaymentFailure('reconcile refund', error)
		}
	}
}

export async function reconcileReservationPayments(): Promise<ReservationReconcileSummary> {
	const summary: ReservationReconcileSummary = {
		organizations: 0,
		sessionsChecked: 0,
		sessionsPushed: 0,
		refundsChecked: 0,
		refundsReported: 0,
		skipped: 0,
		failedOrganizations: 0,
	}
	const organizations = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(
			and(
				eq(Organization.active, true),
				eq(Organization.hasProvisionedDb, true),
			),
		)
	for (const org of organizations) {
		try {
			if (!(await isReservationsFeatureEnabled(org.id))) continue
			summary.organizations += 1
			await reconcileOrganization(org, summary)
		} catch (error) {
			summary.failedOrganizations += 1
			logReservationPaymentFailure('reconcile organization', error)
		}
	}
	return summary
}
