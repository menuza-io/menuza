import { randomUUID } from 'node:crypto'
import { proportionalFeeRefund } from '@repo/reservations'
import {
	rsvOutbox,
	rsvPayments,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { forEachInChunks } from '../lib/chunked-in.ts'
import { type ReservationWriteTx } from '../lib/reservations-write.ts'

/**
 * Regional refund bookkeeping: refund rows, the outbox rows the App executes,
 * and the closing of provider sessions for bookings that lapsed or were
 * cancelled unpaid. Every function runs inside the caller's write transaction;
 * nothing here talks to a provider.
 */

type Tx = ReservationWriteTx | TenantDatabase
type PaymentRow = typeof rsvPayments.$inferSelect
type ReservationRow = typeof rsvReservations.$inferSelect

/** Deposits and prepayments: the rows a guest cancellation or an operator refund can return. */
export const REFUNDABLE_KINDS = ['deposit_charge', 'prepay_charge'] as const

/** Refund rows that already count toward what was refunded (issued or issuing). */
export const REFUND_COUNTED_STATUSES = [
	'charging',
	'refund_pending',
	'succeeded',
] as const

export const REFUND_LEASE_MS = 10 * 60_000

export async function enqueuePaymentOutbox(
	tx: Tx,
	input: {
		kind: 'refund_request' | 'checkout_expire'
		dedupeKey: string
		payload: Record<string, unknown>
		now: number
	},
): Promise<void> {
	await tx
		.insert(rsvOutbox)
		.values({
			kind: input.kind,
			dedupeKey: input.dedupeKey,
			payload: input.payload,
			status: 'pending',
			attempts: 0,
			nextAttemptAt: input.now,
			createdAt: input.now,
		})
		.onConflictDoNothing({ target: rsvOutbox.dedupeKey })
}

export function refundIdempotencyKey(
	reservationId: string,
	refundId: string,
): string {
	return `rsv:${reservationId}:refund:${refundId}`
}

/**
 * Creates a refund row (`requested`) against `parent` and the outbox row the
 * tick delivers to the App. The amount is reserved on the parent at once, so
 * two requests can never refund more than was paid; a failed refund releases
 * its reservation (see `releaseRefundReservation`).
 */
export async function queueRefundRequest(
	tx: Tx,
	input: {
		orgId: string
		parent: PaymentRow
		amountMinor: number
		requestedBy: string | null
		now: number
	},
): Promise<{ refundId: string }> {
	const refundId = `pay_${randomUUID()}`
	await tx.insert(rsvPayments).values({
		id: refundId,
		locationId: input.parent.locationId,
		reservationId: input.parent.reservationId,
		provider: input.parent.provider,
		kind: 'refund',
		purpose: 'refund',
		amountMinor: input.amountMinor,
		currency: input.parent.currency,
		status: 'requested',
		parentPaymentId: input.parent.id,
		platformFeeBp: input.parent.platformFeeBp,
		idempotencyKey: refundIdempotencyKey(input.parent.reservationId, refundId),
		createdBy: input.requestedBy,
		createdAt: input.now,
		updatedAt: input.now,
	})
	await tx
		.update(rsvPayments)
		.set({
			refundedMinor: sql`${rsvPayments.refundedMinor} + ${input.amountMinor}`,
			updatedAt: input.now,
			version: sql`${rsvPayments.version} + 1`,
		})
		.where(eq(rsvPayments.id, input.parent.id))
	await enqueuePaymentOutbox(tx, {
		kind: 'refund_request',
		dedupeKey: `refund_request:${refundId}`,
		payload: {
			kind: 'refund_request',
			orgId: input.orgId,
			refundRequestId: refundId,
		},
		now: input.now,
	})
	return { refundId }
}

/** Gives back the amount a failed refund had reserved on its payment. */
export async function releaseRefundReservation(
	tx: Tx,
	refund: Pick<PaymentRow, 'parentPaymentId' | 'amountMinor'>,
	now: number,
): Promise<void> {
	if (!refund.parentPaymentId) return
	await tx
		.update(rsvPayments)
		.set({
			refundedMinor: sql`max(0, ${rsvPayments.refundedMinor} - ${refund.amountMinor})`,
			updatedAt: now,
			version: sql`${rsvPayments.version} + 1`,
		})
		.where(eq(rsvPayments.id, refund.parentPaymentId))
}

/**
 * Amount a guest cancel refunds: free cancellation (before the deadline)
 * returns everything, a late cancel follows the snapshot's refund rule, and a
 * restaurant cancellation always returns everything.
 */
export function cancellationRefundMinor(input: {
	paidMinor: number
	cancelledBy: 'guest' | 'restaurant' | 'system'
	late: boolean
	snapshot: Record<string, unknown> | null
}): number {
	if (input.paidMinor <= 0) return 0
	if (input.cancelledBy !== 'guest' || !input.late) return input.paidMinor
	const rule = input.snapshot?.refundRule
	const bp = Number(input.snapshot?.partialRefundBp)
	if (rule === 'partial' && Number.isFinite(bp) && bp > 0) {
		return Math.floor((input.paidMinor * Math.min(10_000, bp)) / 10_000)
	}
	return 0
}

/** Succeeded deposit/prepay rows of a reservation, oldest first. */
export async function loadRefundablePayments(
	tx: Tx,
	reservationId: string,
): Promise<PaymentRow[]> {
	return tx
		.select()
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.reservationId, reservationId),
				inArray(rsvPayments.kind, [...REFUNDABLE_KINDS]),
				inArray(rsvPayments.status, [
					'succeeded',
					'partially_refunded',
					'refund_pending',
				]),
			),
		)
		.orderBy(rsvPayments.createdAt)
}

/**
 * Runs inside the cancellation transaction. A paid deposit or prepayment is
 * refunded per the booking's snapshot (always in full when the restaurant
 * cancels); an unpaid booking closes its provider session; a card guarantee is
 * released unless the cancellation was late (the late-cancel fee may still be
 * charged, so the card stays on file).
 */
export async function handleCancellationPayments(
	tx: Tx,
	input: {
		orgId: string
		reservation: ReservationRow
		cancelledBy: 'guest' | 'restaurant' | 'system'
		late: boolean
		now: number
	},
): Promise<void> {
	const { reservation } = input
	if (reservation.paymentStatus === 'none' && !reservation.policySnapshot) {
		return
	}
	if (reservation.status === 'pending_payment') {
		await releaseExpiredPaymentSessions(tx, {
			orgId: input.orgId,
			reservationIds: [reservation.id],
			now: input.now,
		})
		return
	}
	const payments = await loadRefundablePayments(tx, reservation.id)
	let queued = 0
	for (const parent of payments) {
		const remaining = parent.amountMinor - parent.refundedMinor
		if (remaining <= 0) continue
		const amount = Math.min(
			remaining,
			cancellationRefundMinor({
				paidMinor: remaining,
				cancelledBy: input.cancelledBy,
				late: input.late,
				snapshot: reservation.policySnapshot,
			}),
		)
		if (amount <= 0) continue
		await queueRefundRequest(tx, {
			orgId: input.orgId,
			parent,
			amountMinor: amount,
			requestedBy: null,
			now: input.now,
		})
		queued++
	}
	if (queued > 0) {
		await tx
			.update(rsvReservations)
			.set({ paymentStatus: 'refund_pending' })
			.where(eq(rsvReservations.id, reservation.id))
		return
	}
	if (reservation.paymentStatus === 'guaranteed' && !input.late) {
		await tx
			.update(rsvReservations)
			.set({ paymentStatus: 'none' })
			.where(eq(rsvReservations.id, reservation.id))
	}
}

/**
 * Closes the payment side of bookings that lapsed or were cancelled unpaid:
 * unfinished payment rows go `expired` and, for each bound provider session,
 * a `checkout_expire` outbox row asks the App to close it so a late payment
 * becomes unlikely. A payment that still arrives is handled as a late
 * payment (the row keeps its session id for matching).
 */
export async function releaseExpiredPaymentSessions(
	tx: Tx,
	input: { orgId: string; reservationIds: readonly string[]; now: number },
): Promise<void> {
	await forEachInChunks([...input.reservationIds], async (chunk) => {
		const rows = await tx
			.select()
			.from(rsvPayments)
			.where(
				and(
					inArray(rsvPayments.reservationId, chunk),
					inArray(rsvPayments.status, ['created', 'pending']),
					inArray(rsvPayments.kind, [...REFUNDABLE_KINDS, 'card_setup']),
				),
			)
		for (const row of rows) {
			await tx
				.update(rsvPayments)
				.set({
					status: 'expired',
					updatedAt: input.now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(eq(rsvPayments.id, row.id))
			if (row.providerSessionId) {
				await enqueuePaymentOutbox(tx, {
					kind: 'checkout_expire',
					dedupeKey: `checkout_expire:${row.providerSessionId}`,
					payload: {
						kind: 'checkout_expire',
						orgId: input.orgId,
						reservationId: row.reservationId,
						sessionId: row.providerSessionId,
						processor: row.provider,
					},
					now: input.now,
				})
			}
		}
		await tx
			.update(rsvReservations)
			.set({ paymentStatus: 'none' })
			.where(
				and(
					inArray(rsvReservations.id, chunk),
					eq(rsvReservations.paymentStatus, 'pending'),
				),
			)
	})
}

/**
 * Fee this refund reverses on the platform side, from the cumulative share
 * already refunded on the same payment, so reversals sum to the snapshot.
 */
export async function computeFeeReversal(
	tx: Tx,
	parent: PaymentRow,
	refund: Pick<PaymentRow, 'id' | 'amountMinor'>,
): Promise<{
	refundedBeforeMinor: number
	feeReversedBeforeMinor: number
	feeReversalMinor: number
}> {
	const earlier = await tx
		.select({
			amountMinor: rsvPayments.amountMinor,
			platformFeeMinor: rsvPayments.platformFeeMinor,
		})
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.parentPaymentId, parent.id),
				eq(rsvPayments.kind, 'refund'),
				inArray(rsvPayments.status, [...REFUND_COUNTED_STATUSES]),
				sql`${rsvPayments.id} <> ${refund.id}`,
			),
		)
		.orderBy(desc(rsvPayments.createdAt))
	const refundedBeforeMinor = earlier.reduce((sum, r) => sum + r.amountMinor, 0)
	const feeReversedBeforeMinor = earlier.reduce(
		(sum, r) => sum + r.platformFeeMinor,
		0,
	)
	return {
		refundedBeforeMinor,
		feeReversedBeforeMinor,
		feeReversalMinor: proportionalFeeRefund(
			parent.platformFeeMinor,
			refund.amountMinor,
			parent.amountMinor,
			refundedBeforeMinor,
			feeReversedBeforeMinor,
		),
	}
}
