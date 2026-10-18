import { randomUUID } from 'node:crypto'
import {
	noShowFee,
	policyRequiresPayment,
	resolveFeeAmount,
	type PolicySnapshot,
	type ReservationFeeKind,
	type ReservationPaymentBindRequest,
	type ReservationPaymentQuote,
	type ReservationPaymentQuoteRequest,
	type ReservationPaymentStatusRequest,
	type ReservationPaymentStatusResponse,
	type ReservationPendingResponse,
	type ReservationRefundClaim,
	type ReservationRefundResultRequest,
	type ReservationDisputeRequest,
	type ReservationFeeClaim,
	type ReservationFeeResultRequest,
} from '@repo/reservations'
import {
	getTenantDb,
	rsvAuditLog,
	rsvExperiences,
	rsvPayments,
	rsvReservationEvents,
	rsvReservations,
	rsvTableOccupancies,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import {
	deriveFeePayToken,
	deriveGuestRef,
	verifyFeePayToken,
	verifyReservationPayToken,
} from '../lib/reservations-public-auth.ts'
import {
	withReservationWrite,
	type ReservationWriteHelpers,
	type ReservationWriteTx,
} from '../lib/reservations-write.ts'
import { alternativesWindow, insertOccupancyRows } from './rsv-hold-service.ts'
import {
	enqueuePaymentMessage,
	enqueueReservationMessage,
} from './rsv-message-queue.ts'
import { enqueueManagerAlert } from './rsv-outbox.ts'
import {
	computeFeeReversal,
	enqueuePaymentOutbox,
	queueRefundRequest,
	REFUND_LEASE_MS,
	releaseRefundReservation,
	REFUNDABLE_KINDS,
} from './rsv-payment-refunds.ts'
import { loadPublicEngineState, pickI18n } from './rsv-public-engine.ts'
import { planRequestTables } from './rsv-public-booking-service.ts'

/**
 * The regional payment broker (architecture 12.4 to 12.6). The App owns every
 * provider call; this module decides amounts, state and capacity from the
 * booking-time snapshot, inside the per-organization write gate, and never
 * makes a network call. Every method is idempotent: a duplicate delivery of
 * the same terminal event changes nothing.
 */

type Tx = ReservationWriteTx | TenantDatabase
type PaymentRow = typeof rsvPayments.$inferSelect
type ReservationRow = typeof rsvReservations.$inferSelect

const FEE_LINK_TTL_MS = 7 * 24 * 3_600_000
/** How long a lapsed provider session is still checked for a late payment. */
const LATE_PAYMENT_WATCH_MS = 3 * 24 * 3_600_000

const SESSION_KIND_BY_PURPOSE = {
	deposit: 'deposit_charge',
	prepay: 'prepay_charge',
	experience: 'prepay_charge',
	guarantee: 'card_setup',
} as const

const FEE_KINDS = ['no_show_fee_charge', 'cancel_fee_charge'] as const
const FEE_KIND_BY_API: Record<ReservationFeeKind, (typeof FEE_KINDS)[number]> =
	{
		no_show_fee: 'no_show_fee_charge',
		late_cancel_fee: 'cancel_fee_charge',
	}
const API_FEE_KIND: Record<(typeof FEE_KINDS)[number], ReservationFeeKind> = {
	no_show_fee_charge: 'no_show_fee',
	cancel_fee_charge: 'late_cancel_fee',
}

/** Reservation states in which an unpaid hold may still become a booking. */
const PAYABLE_RESERVATION_STATUSES = ['pending_payment'] as const

function notFound(code = 'not_found'): HttpError {
	return new HttpError(404, code)
}

function snapshotOf(reservation: ReservationRow): PolicySnapshot | null {
	const raw = reservation.policySnapshot
	if (!raw || typeof raw !== 'object') return null
	const snapshot = raw as Partial<PolicySnapshot>
	if (typeof snapshot.policyId !== 'string') return null
	return {
		...(snapshot as PolicySnapshot),
		partySize: snapshot.partySize ?? reservation.partySize,
	}
}

async function loadReservation(
	tx: Tx,
	reservationId: string,
): Promise<ReservationRow> {
	const row = await tx
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!row) throw notFound('reservation_not_found')
	return row
}

async function loadPayment(tx: Tx, id: string): Promise<PaymentRow | null> {
	return (
		(await tx.select().from(rsvPayments).where(eq(rsvPayments.id, id)).get()) ??
		null
	)
}

async function writeAudit(
	tx: Tx,
	input: {
		actorKind: 'operator' | 'system'
		actorId: string | null
		locationId: string
		action: string
		entityId: string
		changes?: Record<string, unknown>
		now: number
	},
) {
	await tx.insert(rsvAuditLog).values({
		id: `aud_${randomUUID()}`,
		at: input.now,
		actorKind: input.actorKind,
		actorId: input.actorId,
		locationId: input.locationId,
		action: input.action,
		entityType: 'reservation_payment',
		entityId: input.entityId,
		changes: input.changes ?? {},
	})
}

/** Runs `fn` in the write gate of the reservation's location and date. */
async function inReservationWrite<T>(
	orgId: string,
	reservationId: string,
	now: number,
	fn: (
		tx: ReservationWriteTx,
		helpers: ReservationWriteHelpers,
		reservation: ReservationRow,
	) => Promise<T>,
): Promise<T> {
	const db = await getTenantDb(orgId)
	const pre = await db
		.select({
			id: rsvReservations.id,
			locationId: rsvReservations.locationId,
			businessDate: rsvReservations.businessDate,
		})
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!pre) throw notFound('reservation_not_found')
	return withReservationWrite(
		{
			orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx, helpers) => {
			const reservation = await loadReservation(tx, reservationId)
			return fn(tx, helpers, reservation)
		},
	)
}

function queueContext(
	orgId: string,
	now: number,
	helpers: ReservationWriteHelpers,
) {
	return { orgId, now, afterCommit: helpers.afterCommit }
}

async function addEvent(
	tx: Tx,
	reservation: ReservationRow,
	input: {
		type: string
		toStatus?: ReservationRow['status']
		data?: Record<string, unknown>
		now: number
	},
) {
	await tx.insert(rsvReservationEvents).values({
		id: `rev_${randomUUID()}`,
		reservationId: reservation.id,
		at: input.now,
		actorKind: 'system',
		type: input.type,
		fromStatus: reservation.status,
		toStatus: input.toStatus ?? reservation.status,
		data: input.data ?? {},
	})
}

// ---------------------------------------------------------------------------
// quote
// ---------------------------------------------------------------------------

async function latestSessionPayment(
	tx: Tx,
	reservationId: string,
	purpose: keyof typeof SESSION_KIND_BY_PURPOSE,
): Promise<PaymentRow | null> {
	const rows = await tx
		.select()
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.reservationId, reservationId),
				eq(rsvPayments.kind, SESSION_KIND_BY_PURPOSE[purpose]),
			),
		)
		.orderBy(desc(rsvPayments.createdAt))
		.limit(1)
	return rows[0] ?? null
}

async function experienceLabel(
	tx: Tx,
	reservation: ReservationRow,
): Promise<string | null> {
	if (!reservation.experienceId) return null
	const experience = await tx
		.select({ nameI18n: rsvExperiences.nameI18n })
		.from(rsvExperiences)
		.where(eq(rsvExperiences.id, reservation.experienceId))
		.get()
	return experience
		? pickI18n(experience.nameI18n, reservation.guestLocale, true)
		: null
}

function lateCancelMax(snapshot: PolicySnapshot): number {
	const gross = snapshot.feePerCover
		? snapshot.lateCancelFeeMinor * snapshot.partySize
		: snapshot.lateCancelFeeMinor
	return snapshot.feeCapMinor !== null && snapshot.feeCapMinor !== undefined
		? Math.min(gross, snapshot.feeCapMinor)
		: gross
}

export async function quoteReservationPayment(
	orgId: string,
	request: ReservationPaymentQuoteRequest,
	now = Date.now(),
): Promise<ReservationPaymentQuote> {
	const db = await getTenantDb(orgId)
	if ('feeId' in request) {
		const fee = await loadPayment(db, request.feeId)
		if (
			!fee ||
			!(FEE_KINDS as readonly string[]).includes(fee.kind) ||
			!verifyFeePayToken(orgId, fee.id, request.paymentToken)
		) {
			throw notFound('invalid_payment_token')
		}
		const reservation = await loadReservation(db, fee.reservationId)
		return {
			purpose: 'fee',
			mode: 'payment',
			reservationId: reservation.id,
			locationId: reservation.locationId,
			feeId: fee.id,
			feeKind: API_FEE_KIND[fee.kind as (typeof FEE_KINDS)[number]],
			amountMinor: fee.amountMinor,
			currency: fee.currency,
			quantity: 1,
			unitAmountMinor: null,
			expiresAt: new Date(fee.createdAt + FEE_LINK_TTL_MS).toISOString(),
			now: new Date(now).toISOString(),
			reservationStatus: reservation.status,
			paymentStatus: fee.status === 'succeeded' ? 'paid' : 'pending',
			locale: reservation.guestLocale,
			boundSession:
				fee.providerSessionId && fee.status === 'pending'
					? { sessionId: fee.providerSessionId, processor: fee.provider }
					: null,
			providerCustomerRef: null,
			guestRef: deriveGuestRef(orgId, reservation.guestId),
			productLabel: null,
			policy: policyBlock(snapshotOf(reservation), reservation),
			consent: null,
		}
	}

	const reservation = await loadReservation(db, request.reservationId).catch(
		() => {
			throw notFound('invalid_payment_token')
		},
	)
	if (
		!verifyReservationPayToken(
			orgId,
			reservation.id,
			reservation.manageTokenVersion,
			request.paymentToken,
		)
	) {
		throw notFound('invalid_payment_token')
	}
	const payment = await latestSessionPayment(
		db,
		reservation.id,
		request.purpose,
	)
	if (!payment) throw notFound('payment_not_found')
	const snapshot = snapshotOf(reservation)
	const isSetup = payment.kind === 'card_setup'
	const perCoverLine =
		!isSetup &&
		snapshot?.perCover === true &&
		snapshot.amountMinor * snapshot.partySize === payment.amountMinor
	const setupBase = await db
		.select({ customerRef: rsvPayments.customerRef })
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.reservationId, reservation.id),
				eq(rsvPayments.kind, 'card_setup'),
			),
		)
		.limit(1)
	const location = await db
		.select({ timeZone: rsvReservations.timeZone })
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservation.id))
		.get()
	const consentCap = snapshot
		? Math.max(noShowFee(snapshot), lateCancelMax(snapshot))
		: 0
	return {
		purpose: request.purpose,
		mode: isSetup ? 'setup' : 'payment',
		reservationId: reservation.id,
		locationId: reservation.locationId,
		feeId: null,
		feeKind: null,
		amountMinor: isSetup ? 0 : payment.amountMinor,
		currency: payment.currency,
		quantity: perCoverLine ? reservation.partySize : 1,
		unitAmountMinor: perCoverLine ? (snapshot?.amountMinor ?? null) : null,
		expiresAt: new Date(
			reservation.paymentExpiresAt ?? reservation.createdAt,
		).toISOString(),
		now: new Date(now).toISOString(),
		reservationStatus: reservation.status,
		paymentStatus:
			payment.status === 'succeeded' ? 'paid' : reservation.paymentStatus,
		locale: reservation.guestLocale,
		// An expired row keeps its session so a late payment can still be found.
		boundSession:
			payment.providerSessionId &&
			(payment.status === 'pending' || payment.status === 'expired')
				? { sessionId: payment.providerSessionId, processor: payment.provider }
				: null,
		providerCustomerRef:
			payment.customerRef ?? setupBase[0]?.customerRef ?? null,
		guestRef: deriveGuestRef(orgId, reservation.guestId),
		productLabel:
			request.purpose === 'experience'
				? await experienceLabel(db, reservation)
				: null,
		policy: policyBlock(snapshot, reservation),
		consent:
			isSetup && snapshot
				? {
						capMinor: consentCap,
						noShowFeeMinor: noShowFee(snapshot),
						lateCancelFeeMinor: lateCancelMax(snapshot),
						freeCancelUntilMin: snapshot.freeCancelUntilMin,
						timeZone: location?.timeZone ?? 'UTC',
						startAtIso: new Date(reservation.startAt).toISOString(),
					}
				: null,
	}
}

function policyBlock(
	snapshot: PolicySnapshot | null,
	reservation: ReservationRow,
): ReservationPaymentQuote['policy'] {
	return {
		kind: snapshot?.kind ?? 'none',
		unitMinor: snapshot?.amountMinor ?? 0,
		partySize: snapshot?.partySize ?? reservation.partySize,
		capMinor: snapshot?.feeCapMinor ?? null,
		freeCancelUntilMin: snapshot?.freeCancelUntilMin ?? 0,
		termsVersion: snapshot?.termsVersion ?? 1,
	}
}

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

export async function bindPaymentSession(
	orgId: string,
	request: ReservationPaymentBindRequest,
	now = Date.now(),
): Promise<void> {
	await inReservationWrite(
		orgId,
		request.reservationId,
		now,
		async (tx, _helpers, reservation) => {
			let payment: PaymentRow | null
			if (request.purpose === 'fee') {
				payment = request.feeId ? await loadPayment(tx, request.feeId) : null
				if (
					!payment ||
					payment.reservationId !== reservation.id ||
					!(FEE_KINDS as readonly string[]).includes(payment.kind)
				) {
					throw notFound('payment_not_found')
				}
				// Only a fee the card could not cover is payable through a link;
				// one the App is charging right now must never get a second path.
				const linkable =
					payment.status === 'requires_action' ||
					payment.status === 'failed' ||
					(payment.status === 'pending' && payment.providerSessionId !== null)
				if (!linkable) throw new HttpError(409, 'payment_terminal')
			} else {
				payment = await latestSessionPayment(
					tx,
					reservation.id,
					request.purpose,
				)
				if (!payment) throw notFound('payment_not_found')
				if (
					['succeeded', 'refunded', 'partially_refunded'].includes(
						payment.status,
					)
				) {
					throw new HttpError(409, 'payment_terminal')
				}
				if (
					!(PAYABLE_RESERVATION_STATUSES as readonly string[]).includes(
						reservation.status,
					) ||
					(reservation.paymentExpiresAt !== null &&
						reservation.paymentExpiresAt <= now)
				) {
					throw new HttpError(409, 'hold_expired')
				}
			}
			if (payment.provider !== request.processor) {
				throw new HttpError(409, 'processor_mismatch')
			}
			if (payment.providerSessionId) {
				if (
					payment.providerSessionId === request.sessionId &&
					payment.status === 'pending'
				) {
					return
				}
				if (payment.status === 'pending') {
					throw new HttpError(409, 'already_bound')
				}
			}
			const claimed = await tx
				.update(rsvPayments)
				.set({
					providerSessionId: request.sessionId,
					status: 'pending',
					platformFeeBp: request.platformFeeBp,
					platformFeeMinor: request.platformFeeMinor,
					customerRef: request.providerCustomerRef ?? payment.customerRef,
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(
					and(
						eq(rsvPayments.id, payment.id),
						or(
							isNull(rsvPayments.providerSessionId),
							inArray(rsvPayments.status, [
								'created',
								'expired',
								'failed',
								'requires_action',
							]),
						),
					),
				)
				.returning({ id: rsvPayments.id })
			if (claimed.length === 0) throw new HttpError(409, 'already_bound')
		},
	)
}

// ---------------------------------------------------------------------------
// status (webhook, poll, reconcile)
// ---------------------------------------------------------------------------

const TERMINAL_PAYMENT_STATUSES = [
	'succeeded',
	'refunded',
	'partially_refunded',
	'refund_pending',
	'review',
	'disputed',
] as const

function mismatch(): HttpError {
	return new HttpError(409, 'status_mismatch')
}

export async function applyPaymentStatus(
	orgId: string,
	request: ReservationPaymentStatusRequest,
	now = Date.now(),
): Promise<ReservationPaymentStatusResponse> {
	return inReservationWrite(
		orgId,
		request.reservationId,
		now,
		async (tx, helpers, reservation) => {
			const payment = await tx
				.select()
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.reservationId, reservation.id),
						eq(rsvPayments.providerSessionId, request.sessionId),
					),
				)
				.get()
			if (!payment) throw mismatch()
			if (payment.provider !== request.processor) throw mismatch()
			if (request.feeId && payment.id !== request.feeId) throw mismatch()
			if (
				request.purpose === 'fee' &&
				!(FEE_KINDS as readonly string[]).includes(payment.kind)
			) {
				throw mismatch()
			}
			if (
				request.purpose !== 'fee' &&
				(payment.purpose ?? null) !== request.purpose
			) {
				throw mismatch()
			}
			if (payment.currency !== request.currency) throw mismatch()
			const isSetup = payment.kind === 'card_setup'
			if (
				request.status === 'paid' &&
				request.amountMinor !== payment.amountMinor
			) {
				throw mismatch()
			}
			if (request.status === 'setup_succeeded' && !isSetup) throw mismatch()
			if (request.status === 'paid' && isSetup) throw mismatch()
			const view = (outcome: ReservationPaymentStatusResponse['outcome']) => ({
				outcome,
				reservationStatus: reservation.status,
				paymentStatus: reservation.paymentStatus,
			})

			if (request.status === 'failed') {
				if (payment.status === 'pending' || payment.status === 'created') {
					await tx
						.update(rsvPayments)
						.set({
							failureCode: 'payment_failed',
							updatedAt: now,
							version: sql`${rsvPayments.version} + 1`,
						})
						.where(eq(rsvPayments.id, payment.id))
				}
				return view('recorded')
			}

			if (request.status === 'expired') {
				if (payment.status === 'pending') {
					const stillPayable =
						request.purpose === 'fee' ||
						((PAYABLE_RESERVATION_STATUSES as readonly string[]).includes(
							reservation.status,
						) &&
							(reservation.paymentExpiresAt ?? 0) > now)
					await tx
						.update(rsvPayments)
						.set({
							// A live hold frees the binding so a fresh session can be bound.
							providerSessionId: stillPayable
								? null
								: payment.providerSessionId,
							status: stillPayable
								? request.purpose === 'fee'
									? 'requires_action'
									: 'created'
								: 'expired',
							updatedAt: now,
							version: sql`${rsvPayments.version} + 1`,
						})
						.where(eq(rsvPayments.id, payment.id))
				}
				return view('recorded')
			}

			// paid | setup_succeeded
			if (
				(TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(
					payment.status,
				)
			) {
				return view('duplicate')
			}

			if (request.purpose === 'fee') {
				return recordFeePaidViaLink(
					tx,
					helpers,
					orgId,
					reservation,
					payment,
					request,
					now,
				)
			}
			return settleBookingPayment(
				tx,
				helpers,
				orgId,
				reservation,
				payment,
				request,
				now,
			)
		},
	)
}

async function markPaymentSucceeded(
	tx: Tx,
	payment: PaymentRow,
	request: ReservationPaymentStatusRequest,
	now: number,
) {
	await tx
		.update(rsvPayments)
		.set({
			status: 'succeeded',
			providerRef: request.paymentRef ?? payment.providerRef,
			paymentMethodRef: request.paymentMethodRef ?? payment.paymentMethodRef,
			customerRef: request.providerCustomerRef ?? payment.customerRef,
			previousPaymentRef:
				request.previousPaymentRef ?? payment.previousPaymentRef,
			cardBrand: request.card?.brand ?? payment.cardBrand,
			cardLast4: request.card?.last4 ?? payment.cardLast4,
			cardExpMonth: request.card?.expMonth ?? payment.cardExpMonth,
			cardExpYear: request.card?.expYear ?? payment.cardExpYear,
			failureCode: null,
			updatedAt: now,
			version: sql`${rsvPayments.version} + 1`,
		})
		.where(eq(rsvPayments.id, payment.id))
}

async function settleBookingPayment(
	tx: ReservationWriteTx,
	helpers: ReservationWriteHelpers,
	orgId: string,
	reservation: ReservationRow,
	payment: PaymentRow,
	request: ReservationPaymentStatusRequest,
	now: number,
): Promise<ReservationPaymentStatusResponse> {
	const isSetup = payment.kind === 'card_setup'
	const paidStatus = isSetup ? 'guaranteed' : 'paid'
	const ctx = queueContext(orgId, now, helpers)

	const confirm = async (toStatus: ReservationRow['status'], event: string) => {
		await markPaymentSucceeded(tx, payment, request, now)
		await tx
			.update(rsvReservations)
			.set({
				status: toStatus,
				paymentStatus: paidStatus,
				paymentExpiresAt: null,
				version: reservation.version + 1,
				updatedAt: now,
			})
			.where(eq(rsvReservations.id, reservation.id))
		await addEvent(tx, reservation, {
			type: event,
			toStatus,
			data: { purpose: request.purpose, amountMinor: payment.amountMinor },
			now,
		})
		if (isSetup) {
			await enqueueReservationMessage(tx, ctx, {
				reservationId: reservation.id,
				kind: 'confirmation',
			})
		} else {
			await enqueuePaymentMessage(tx, ctx, {
				reservationId: reservation.id,
				kind: 'payment_received',
				paymentId: payment.id,
			})
		}
	}

	if (reservation.status === 'pending_payment') {
		await confirm('booked', 'payment_received')
		return {
			outcome: 'recorded',
			reservationStatus: 'booked',
			paymentStatus: paidStatus,
		}
	}

	if (
		['booked', 'confirmed', 'arrived', 'partially_seated', 'seated'].includes(
			reservation.status,
		)
	) {
		// Paid after an operator confirmed the booking by hand: keep its state.
		await markPaymentSucceeded(tx, payment, request, now)
		await tx
			.update(rsvReservations)
			.set({
				paymentStatus: paidStatus,
				paymentExpiresAt: null,
				version: reservation.version + 1,
				updatedAt: now,
			})
			.where(eq(rsvReservations.id, reservation.id))
		if (!isSetup) {
			await enqueuePaymentMessage(tx, ctx, {
				reservationId: reservation.id,
				kind: 'payment_received',
				paymentId: payment.id,
			})
		}
		return {
			outcome: 'recorded',
			reservationStatus: reservation.status,
			paymentStatus: paidStatus,
		}
	}

	if (reservation.status === 'expired') {
		const restored = await tryRestoreExpiredBooking(
			tx,
			helpers,
			reservation,
			now,
		)
		if (restored) {
			await confirm('booked', 'payment_received_late')
			return {
				outcome: 'confirmed',
				reservationStatus: 'booked',
				paymentStatus: paidStatus,
			}
		}
	}

	// Cancelled, finished, no-show, or an expired booking whose slot is gone.
	if (isSetup) {
		// Nothing was charged: the card on file is harmless.
		await markPaymentSucceeded(tx, payment, request, now)
		return {
			outcome: 'recorded',
			reservationStatus: reservation.status,
			paymentStatus: reservation.paymentStatus,
		}
	}
	const refund = await queueLateRefund(
		tx,
		orgId,
		reservation,
		payment,
		request,
		now,
	)
	return {
		outcome: 'refund_required',
		reservationStatus: reservation.status,
		paymentStatus: 'refund_pending',
		refund,
	}
}

/**
 * A payment arrived after the hold lapsed: bring the booking back only when
 * its slot still fits (the engine re-runs the plan for the host channel).
 * Table-less (pool) bookings are never restored here: their cover caps are
 * checked only at booking time, so the safe answer is a refund.
 */
async function tryRestoreExpiredBooking(
	tx: ReservationWriteTx,
	helpers: ReservationWriteHelpers,
	reservation: ReservationRow,
	now: number,
): Promise<boolean> {
	if (reservation.startAt <= now) return false
	// Experience seatings carry their own cover caps and area rules.
	if (reservation.experienceId) return false
	const hadTables = await tx
		.select({ id: rsvTableOccupancies.id })
		.from(rsvTableOccupancies)
		.where(eq(rsvTableOccupancies.reservationId, reservation.id))
		.limit(1)
	if (hadTables.length === 0) return false
	const window = alternativesWindow(reservation.businessDate)
	const state = await loadPublicEngineState(tx, {
		locationId: reservation.locationId,
		...window,
		now,
	})
	if (!state) return false
	const tableIds = planRequestTables(state, {
		businessDate: reservation.businessDate,
		localMin: reservation.localStartMin,
		partySize: reservation.partySize,
		serviceId: reservation.serviceId,
		now,
		startAt: reservation.startAt,
		endAt: reservation.endAt,
	})
	if (tableIds.length === 0) return false
	await insertOccupancyRows(tx, {
		locationId: reservation.locationId,
		kind: 'reservation',
		ownerId: reservation.id,
		tableIds,
		startAt: reservation.startAt,
		endAt: reservation.endAt,
		resetBufferMin: (id) => state.tableById.get(id)?.resetBufferMin ?? 0,
		now,
	})
	helpers.markAffectedDate(reservation.locationId, reservation.businessDate)
	return true
}

async function queueLateRefund(
	tx: ReservationWriteTx,
	orgId: string,
	reservation: ReservationRow,
	payment: PaymentRow,
	request: ReservationPaymentStatusRequest,
	now: number,
) {
	const refundId = `pay_${randomUUID()}`
	const paid: PaymentRow = {
		...payment,
		providerRef: request.paymentRef ?? payment.providerRef,
	}
	await tx.insert(rsvPayments).values({
		id: refundId,
		locationId: payment.locationId,
		reservationId: payment.reservationId,
		provider: payment.provider,
		kind: 'refund',
		purpose: 'late_refund',
		amountMinor: payment.amountMinor,
		currency: payment.currency,
		status: 'charging',
		parentPaymentId: payment.id,
		platformFeeBp: payment.platformFeeBp,
		platformFeeMinor: payment.platformFeeMinor,
		idempotencyKey: `rsv:${reservation.id}:refund:${refundId}`,
		createdAt: now,
		updatedAt: now,
	})
	await markPaymentSucceeded(tx, payment, request, now)
	await tx
		.update(rsvPayments)
		.set({ refundedMinor: payment.amountMinor })
		.where(eq(rsvPayments.id, payment.id))
	await tx
		.update(rsvReservations)
		.set({
			paymentStatus: 'refund_pending',
			version: reservation.version + 1,
			updatedAt: now,
		})
		.where(eq(rsvReservations.id, reservation.id))
	await addEvent(tx, reservation, {
		type: 'late_payment_refund',
		data: { amountMinor: payment.amountMinor },
		now,
	})
	void orgId
	return {
		reservationId: reservation.id,
		paymentRef: paid.providerRef ?? request.paymentRef ?? '',
		processor: payment.provider,
		amountMinor: payment.amountMinor,
		currency: payment.currency,
		paymentAmountMinor: payment.amountMinor,
		platformFeeMinor: payment.platformFeeMinor,
		refundedBeforeMinor: 0,
		feeReversedBeforeMinor: 0,
		feeReversalMinor: payment.platformFeeMinor,
	}
}

async function recordFeePaidViaLink(
	tx: ReservationWriteTx,
	helpers: ReservationWriteHelpers,
	orgId: string,
	reservation: ReservationRow,
	fee: PaymentRow,
	request: ReservationPaymentStatusRequest,
	now: number,
): Promise<ReservationPaymentStatusResponse> {
	await markPaymentSucceeded(tx, fee, request, now)
	await tx
		.update(rsvReservations)
		.set({
			paymentStatus: 'fee_charged',
			version: reservation.version + 1,
			updatedAt: now,
		})
		.where(eq(rsvReservations.id, reservation.id))
	await enqueuePaymentMessage(tx, queueContext(orgId, now, helpers), {
		reservationId: reservation.id,
		kind: 'fee_charged',
		paymentId: fee.id,
	})
	return {
		outcome: 'recorded',
		reservationStatus: reservation.status,
		paymentStatus: 'fee_charged',
	}
}

// ---------------------------------------------------------------------------
// fees (staff only)
// ---------------------------------------------------------------------------

export async function requestOperatorFee(params: {
	orgId: string
	reservationId: string
	actorId: string
	kind: ReservationFeeKind
	amountMinor?: number | null
	expectedVersion: number
	now?: number
}): Promise<{
	feeId: string
	amountMinor: number
	currency: string
	kind: ReservationFeeKind
	attempt: number
}> {
	const now = params.now ?? Date.now()
	return inReservationWrite(
		params.orgId,
		params.reservationId,
		now,
		async (tx, _helpers, reservation) => {
			if (reservation.version !== params.expectedVersion) {
				throw new HttpError(409, 'stale_version', undefined, {
					currentVersion: reservation.version,
				})
			}
			const eligible =
				params.kind === 'no_show_fee'
					? reservation.status === 'no_show'
					: reservation.status === 'cancelled' && reservation.lateCancel
			if (!eligible) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'status_not_eligible',
				})
			}
			const snapshot = snapshotOf(reservation)
			if (!snapshot || !policyRequiresPayment(snapshot.kind)) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'no_policy',
				})
			}
			const setup = await tx
				.select()
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.reservationId, reservation.id),
						eq(rsvPayments.kind, 'card_setup'),
						eq(rsvPayments.status, 'succeeded'),
					),
				)
				.orderBy(desc(rsvPayments.createdAt))
				.limit(1)
			const guarantee = setup[0]
			if (!guarantee?.paymentMethodRef) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'no_guarantee',
				})
			}
			const feeRows = await tx
				.select()
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.reservationId, reservation.id),
						inArray(rsvPayments.kind, [...FEE_KINDS]),
					),
				)
				.orderBy(asc(rsvPayments.createdAt))
			if (feeRows.some((row) => row.status === 'succeeded')) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'already_charged',
				})
			}
			if (
				feeRows.some((row) =>
					['pending', 'charging', 'requires_action'].includes(row.status),
				)
			) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'in_flight',
				})
			}
			const dbKind = FEE_KIND_BY_API[params.kind]
			const attempt = feeRows.filter((row) => row.kind === dbKind).length + 1
			if (attempt > 2) {
				throw new HttpError(409, 'fee_not_allowed', undefined, {
					reason: 'retry_limit',
				})
			}
			const amount = resolveFeeAmount({
				snapshot,
				kind: params.kind,
				requestedMinor: params.amountMinor ?? null,
			})
			if (!amount.ok) {
				throw new HttpError(
					amount.code === 'invalid' ? 400 : 409,
					amount.code,
					undefined,
					{ reason: amount.reason },
				)
			}
			const feeId = `pay_${randomUUID()}`
			await tx.insert(rsvPayments).values({
				id: feeId,
				locationId: reservation.locationId,
				reservationId: reservation.id,
				provider: guarantee.provider,
				kind: dbKind,
				purpose: 'fee',
				amountMinor: amount.amountMinor,
				currency: snapshot.currency,
				status: 'pending',
				attempt,
				parentPaymentId: guarantee.id,
				idempotencyKey: `rsv:${reservation.id}:${params.kind}:${attempt}`,
				createdBy: params.actorId,
				createdAt: now,
				updatedAt: now,
			})
			await tx
				.update(rsvReservations)
				.set({
					paymentStatus: 'fee_pending',
					version: reservation.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, reservation.id))
			await writeAudit(tx, {
				actorKind: 'operator',
				actorId: params.actorId,
				locationId: reservation.locationId,
				action: 'payment.fee_requested',
				entityId: feeId,
				changes: {
					reservationId: reservation.id,
					kind: params.kind,
					amountMinor: amount.amountMinor,
					attempt,
				},
				now,
			})
			return {
				feeId,
				amountMinor: amount.amountMinor,
				currency: snapshot.currency,
				kind: params.kind,
				attempt,
			}
		},
	)
}

export async function claimFee(
	orgId: string,
	request: { reservationId: string; feeId: string },
	now = Date.now(),
): Promise<ReservationFeeClaim> {
	return inReservationWrite(
		orgId,
		request.reservationId,
		now,
		async (tx, _helpers, reservation) => {
			const fee = await loadPayment(tx, request.feeId)
			if (
				!fee ||
				fee.reservationId !== reservation.id ||
				!(FEE_KINDS as readonly string[]).includes(fee.kind)
			) {
				throw notFound('fee_not_found')
			}
			const claimed = await tx
				.update(rsvPayments)
				.set({
					status: 'charging',
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(
					and(
						eq(rsvPayments.id, fee.id),
						or(
							eq(rsvPayments.status, 'pending'),
							// A claim whose result never came back may be taken again;
							// the provider idempotency key makes the retry safe.
							and(
								eq(rsvPayments.status, 'charging'),
								lt(rsvPayments.updatedAt, now - REFUND_LEASE_MS),
							),
						),
					),
				)
				.returning({ id: rsvPayments.id })
			if (claimed.length === 0) {
				throw new HttpError(409, 'fee_not_claimable', undefined, {
					status: fee.status,
				})
			}
			const setup = fee.parentPaymentId
				? await loadPayment(tx, fee.parentPaymentId)
				: null
			return {
				feeId: fee.id,
				reservationId: reservation.id,
				locationId: reservation.locationId,
				kind: API_FEE_KIND[fee.kind as (typeof FEE_KINDS)[number]],
				attempt: Math.min(2, Math.max(1, fee.attempt)),
				amountMinor: fee.amountMinor,
				currency: fee.currency,
				processor: fee.provider,
				providerCustomerRef: setup?.customerRef ?? null,
				paymentMethodRef: setup?.paymentMethodRef ?? null,
				previousPaymentRef: setup?.previousPaymentRef ?? null,
			}
		},
	)
}

export async function recordFeeResult(
	orgId: string,
	request: ReservationFeeResultRequest,
	now = Date.now(),
): Promise<void> {
	await inReservationWrite(
		orgId,
		request.reservationId,
		now,
		async (tx, helpers, reservation) => {
			const fee = await loadPayment(tx, request.feeId)
			if (
				!fee ||
				fee.reservationId !== reservation.id ||
				!(FEE_KINDS as readonly string[]).includes(fee.kind)
			) {
				throw notFound('fee_not_found')
			}
			if (fee.attempt !== request.attempt) throw mismatch()
			if (fee.status === 'succeeded' || fee.status === 'failed') return
			if (fee.status !== 'charging' && fee.status !== 'pending') return
			const ctx = queueContext(orgId, now, helpers)
			if (request.status === 'succeeded') {
				await tx
					.update(rsvPayments)
					.set({
						status: 'succeeded',
						providerRef: request.paymentRef ?? null,
						platformFeeBp: request.platformFeeBp,
						platformFeeMinor: request.platformFeeMinor,
						updatedAt: now,
						version: sql`${rsvPayments.version} + 1`,
					})
					.where(eq(rsvPayments.id, fee.id))
				await tx
					.update(rsvReservations)
					.set({
						paymentStatus: 'fee_charged',
						version: reservation.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, reservation.id))
				await enqueuePaymentMessage(tx, ctx, {
					reservationId: reservation.id,
					kind: 'fee_charged',
					paymentId: fee.id,
				})
				return
			}
			if (request.status === 'requires_action') {
				await tx
					.update(rsvPayments)
					.set({
						status: 'requires_action',
						failureCode: 'authentication_required',
						platformFeeBp: request.platformFeeBp,
						platformFeeMinor: request.platformFeeMinor,
						updatedAt: now,
						version: sql`${rsvPayments.version} + 1`,
					})
					.where(eq(rsvPayments.id, fee.id))
				await tx
					.update(rsvReservations)
					.set({
						paymentStatus: 'fee_pending',
						version: reservation.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, reservation.id))
				await enqueuePaymentMessage(tx, ctx, {
					reservationId: reservation.id,
					kind: 'fee_action_required',
					paymentId: fee.id,
				})
				return
			}
			await tx
				.update(rsvPayments)
				.set({
					status: 'failed',
					failureCode: 'card_declined',
					declineCode: request.declineCode ?? null,
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(eq(rsvPayments.id, fee.id))
			await tx
				.update(rsvReservations)
				.set({
					paymentStatus: 'fee_failed',
					version: reservation.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, reservation.id))
			await enqueueManagerAlert(tx, {
				orgId,
				kind: 'payment_failed',
				locationId: reservation.locationId,
				dedupeKey: `alert:payment_failed:${fee.id}`,
				now,
			})
		},
	)
}

/** Pay link for a fee the card could not cover (used by the message renderer). */
export function feePayLink(
	orgId: string,
	feeId: string,
	siteBase: string | null,
): string | null {
	if (!siteBase) return null
	return `${siteBase}/reserve/pay#f=${feeId}&t=${deriveFeePayToken(orgId, feeId)}`
}

// ---------------------------------------------------------------------------
// refunds
// ---------------------------------------------------------------------------

export async function requestOperatorRefund(params: {
	orgId: string
	reservationId: string
	actorId: string
	amountMinor?: number | null
	reason: string
	now?: number
}): Promise<{ refundId: string; amountMinor: number }> {
	const now = params.now ?? Date.now()
	return inReservationWrite(
		params.orgId,
		params.reservationId,
		now,
		async (tx, _helpers, reservation) => {
			const parents = await tx
				.select()
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.reservationId, reservation.id),
						inArray(rsvPayments.kind, [...REFUNDABLE_KINDS]),
						inArray(rsvPayments.status, ['succeeded', 'partially_refunded']),
					),
				)
				.orderBy(asc(rsvPayments.createdAt))
			const parent = parents.find((p) => p.amountMinor - p.refundedMinor > 0)
			if (!parent) {
				throw new HttpError(409, 'refund_exceeds_paid', undefined, {
					remainingMinor: 0,
				})
			}
			const remaining = parent.amountMinor - parent.refundedMinor
			const amount = params.amountMinor ?? remaining
			if (!Number.isInteger(amount) || amount <= 0) {
				throw new HttpError(400, 'invalid', undefined, {
					issues: [{ path: 'amountMinor', code: 'invalid' }],
				})
			}
			if (amount > remaining) {
				throw new HttpError(409, 'refund_exceeds_paid', undefined, {
					remainingMinor: remaining,
				})
			}
			const { refundId } = await queueRefundRequest(tx, {
				orgId: params.orgId,
				parent,
				amountMinor: amount,
				requestedBy: params.actorId,
				now,
			})
			await tx
				.update(rsvReservations)
				.set({
					paymentStatus: 'refund_pending',
					version: reservation.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, reservation.id))
			await writeAudit(tx, {
				actorKind: 'operator',
				actorId: params.actorId,
				locationId: reservation.locationId,
				action: 'payment.refund_requested',
				entityId: refundId,
				changes: {
					reservationId: reservation.id,
					amountMinor: amount,
					reasonLength: params.reason.length,
				},
				now,
			})
			return { refundId, amountMinor: amount }
		},
	)
}

async function directiveFor(
	tx: Tx,
	refund: PaymentRow,
	parent: PaymentRow,
): Promise<ReservationRefundClaim | null> {
	if (!parent.providerRef) return null
	const reversal = await computeFeeReversal(tx, parent, refund)
	await tx
		.update(rsvPayments)
		.set({ platformFeeMinor: reversal.feeReversalMinor })
		.where(eq(rsvPayments.id, refund.id))
	return {
		refundRequestId: refund.id,
		reservationId: refund.reservationId,
		paymentRef: parent.providerRef,
		processor: refund.provider,
		amountMinor: refund.amountMinor,
		currency: refund.currency,
		paymentAmountMinor: parent.amountMinor,
		platformFeeMinor: parent.platformFeeMinor,
		refundedBeforeMinor: reversal.refundedBeforeMinor,
		feeReversedBeforeMinor: reversal.feeReversedBeforeMinor,
		feeReversalMinor: reversal.feeReversalMinor,
	}
}

export async function claimRefunds(
	orgId: string,
	request: { refundRequestId?: string },
	now = Date.now(),
): Promise<{ refunds: ReservationRefundClaim[] }> {
	const db = await getTenantDb(orgId)
	const candidates = await db
		.select({
			id: rsvPayments.id,
			reservationId: rsvPayments.reservationId,
		})
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.kind, 'refund'),
				request.refundRequestId
					? eq(rsvPayments.id, request.refundRequestId)
					: inArray(rsvPayments.status, ['requested', 'charging']),
			),
		)
		.orderBy(asc(rsvPayments.createdAt))
		.limit(request.refundRequestId ? 1 : 20)
	const refunds: ReservationRefundClaim[] = []
	for (const candidate of candidates) {
		const claim = await inReservationWrite(
			orgId,
			candidate.reservationId,
			now,
			async (tx) => {
				const refund = await loadPayment(tx, candidate.id)
				if (!refund || refund.kind !== 'refund' || !refund.parentPaymentId) {
					return null
				}
				const parent = await loadPayment(tx, refund.parentPaymentId)
				if (!parent) return null
				const claimed = await tx
					.update(rsvPayments)
					.set({
						status: 'charging',
						updatedAt: now,
						version: sql`${rsvPayments.version} + 1`,
					})
					.where(
						and(
							eq(rsvPayments.id, refund.id),
							or(
								eq(rsvPayments.status, 'requested'),
								and(
									eq(rsvPayments.status, 'charging'),
									lt(rsvPayments.updatedAt, now - REFUND_LEASE_MS),
								),
							),
						),
					)
					.returning({ id: rsvPayments.id })
				if (claimed.length === 0) return null
				return directiveFor(tx, refund, parent)
			},
		)
		if (claim) refunds.push(claim)
	}
	if (request.refundRequestId && refunds.length === 0) {
		throw new HttpError(409, 'refund_not_claimable')
	}
	return { refunds }
}

export async function recordRefundResult(
	orgId: string,
	request: ReservationRefundResultRequest,
	now = Date.now(),
): Promise<void> {
	const db = await getTenantDb(orgId)
	let refundRow: PaymentRow | null = null
	if (request.refundRequestId) {
		refundRow = await loadPayment(db, request.refundRequestId)
	} else if (request.reservationId && request.paymentRef) {
		const parent = await db
			.select()
			.from(rsvPayments)
			.where(
				and(
					eq(rsvPayments.reservationId, request.reservationId),
					eq(rsvPayments.providerRef, request.paymentRef),
				),
			)
			.get()
		if (parent) {
			refundRow =
				(await db
					.select()
					.from(rsvPayments)
					.where(
						and(
							eq(rsvPayments.parentPaymentId, parent.id),
							eq(rsvPayments.kind, 'refund'),
							eq(rsvPayments.purpose, 'late_refund'),
						),
					)
					.get()) ?? null
		}
	}
	if (!refundRow || refundRow.kind !== 'refund')
		throw notFound('refund_not_found')
	const target = refundRow
	await inReservationWrite(
		orgId,
		target.reservationId,
		now,
		async (tx, helpers, reservation) => {
			const refund = await loadPayment(tx, target.id)
			if (!refund || !refund.parentPaymentId) throw notFound('refund_not_found')
			if (refund.status === 'succeeded' || refund.status === 'failed') return
			const parent = await loadPayment(tx, refund.parentPaymentId)
			if (!parent) throw notFound('refund_not_found')
			const late = refund.purpose === 'late_refund'
			const ctx = queueContext(orgId, now, helpers)

			if (request.status === 'pending') {
				await tx
					.update(rsvPayments)
					.set({
						status: 'refund_pending',
						providerRef: request.refundRef ?? refund.providerRef,
						updatedAt: now,
						version: sql`${rsvPayments.version} + 1`,
					})
					.where(eq(rsvPayments.id, refund.id))
				await tx
					.update(rsvReservations)
					.set({ paymentStatus: 'refund_pending' })
					.where(eq(rsvReservations.id, reservation.id))
				return
			}

			if (request.status === 'failed') {
				await tx
					.update(rsvPayments)
					.set({
						status: 'failed',
						failureCode: 'refund_failed',
						updatedAt: now,
						version: sql`${rsvPayments.version} + 1`,
					})
					.where(eq(rsvPayments.id, refund.id))
				await releaseRefundReservation(tx, refund, now)
				await tx
					.update(rsvPayments)
					.set({ status: 'review', updatedAt: now })
					.where(eq(rsvPayments.id, parent.id))
				await tx
					.update(rsvReservations)
					.set({
						paymentStatus: 'review',
						version: reservation.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, reservation.id))
				await enqueueManagerAlert(tx, {
					orgId,
					kind: 'payment_review',
					locationId: reservation.locationId,
					dedupeKey: `alert:payment_review:${refund.id}`,
					now,
				})
				return
			}

			await tx
				.update(rsvPayments)
				.set({
					status: 'succeeded',
					providerRef: request.refundRef ?? refund.providerRef,
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(eq(rsvPayments.id, refund.id))
			const settled = await tx
				.select({
					total: sql<number>`coalesce(sum(${rsvPayments.amountMinor}), 0)`,
				})
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.parentPaymentId, parent.id),
						eq(rsvPayments.kind, 'refund'),
						eq(rsvPayments.status, 'succeeded'),
					),
				)
				.get()
			const refundedTotal = Number(settled?.total ?? 0)
			const full = refundedTotal >= parent.amountMinor
			await tx
				.update(rsvPayments)
				.set({
					status: full ? 'refunded' : 'partially_refunded',
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(eq(rsvPayments.id, parent.id))
			const inFlight = await tx
				.select({ id: rsvPayments.id })
				.from(rsvPayments)
				.where(
					and(
						eq(rsvPayments.reservationId, reservation.id),
						eq(rsvPayments.kind, 'refund'),
						inArray(rsvPayments.status, [
							'requested',
							'charging',
							'refund_pending',
						]),
					),
				)
				.limit(1)
			await tx
				.update(rsvReservations)
				.set({
					paymentStatus:
						inFlight.length > 0
							? 'refund_pending'
							: full
								? 'refunded'
								: 'partially_refunded',
					version: reservation.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, reservation.id))
			await enqueuePaymentMessage(tx, ctx, {
				reservationId: reservation.id,
				kind: late ? 'late_payment_refunded' : 'refund_issued',
				paymentId: refund.id,
			})
		},
	)
}

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------

export async function recordDispute(
	orgId: string,
	request: ReservationDisputeRequest,
	now = Date.now(),
): Promise<void> {
	const db = await getTenantDb(orgId)
	const payment = await db
		.select()
		.from(rsvPayments)
		.where(eq(rsvPayments.providerRef, request.paymentRef))
		.get()
	if (!payment) throw notFound('payment_not_found')
	if (
		request.reservationId &&
		request.reservationId !== payment.reservationId
	) {
		throw mismatch()
	}
	await inReservationWrite(
		orgId,
		payment.reservationId,
		now,
		async (tx, _helpers, reservation) => {
			const row = await loadPayment(tx, payment.id)
			if (!row) return
			if (
				row.disputeRef === request.disputeRef &&
				row.disputeStatus === request.status
			) {
				return
			}
			await tx
				.update(rsvPayments)
				.set({
					disputeStatus: request.status,
					disputeRef: request.disputeRef,
					updatedAt: now,
					version: sql`${rsvPayments.version} + 1`,
				})
				.where(eq(rsvPayments.id, row.id))
			if (request.status === 'opened' || request.status === 'lost') {
				await tx
					.update(rsvReservations)
					.set({
						paymentStatus: 'disputed',
						version: reservation.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, reservation.id))
				if (request.status === 'opened') {
					await enqueueManagerAlert(tx, {
						orgId,
						kind: 'dispute_opened',
						locationId: reservation.locationId,
						dedupeKey: `alert:dispute_opened:${request.disputeRef}`,
						now,
					})
				}
			} else if (reservation.paymentStatus === 'disputed') {
				const feeKind = (FEE_KINDS as readonly string[]).includes(row.kind)
				await tx
					.update(rsvReservations)
					.set({
						paymentStatus: feeKind ? 'fee_charged' : 'paid',
						version: reservation.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, reservation.id))
			}
		},
	)
}

// ---------------------------------------------------------------------------
// reconcile feed, operator view, guest poll
// ---------------------------------------------------------------------------

export async function listPendingPayments(
	orgId: string,
	now = Date.now(),
): Promise<ReservationPendingResponse> {
	const db = await getTenantDb(orgId)
	const sessions = await db
		.select()
		.from(rsvPayments)
		.where(
			and(
				or(
					eq(rsvPayments.status, 'pending'),
					// Lapsed sessions stay watched for a while: a payment can land late.
					and(
						eq(rsvPayments.status, 'expired'),
						gt(rsvPayments.updatedAt, now - LATE_PAYMENT_WATCH_MS),
					),
				),
				sql`${rsvPayments.providerSessionId} IS NOT NULL`,
				inArray(rsvPayments.kind, [
					'deposit_charge',
					'prepay_charge',
					'card_setup',
					'no_show_fee_charge',
					'cancel_fee_charge',
				]),
			),
		)
		.orderBy(asc(rsvPayments.updatedAt))
		.limit(200)
	const refunds = await db
		.select()
		.from(rsvPayments)
		.where(
			and(
				eq(rsvPayments.kind, 'refund'),
				or(
					eq(rsvPayments.status, 'refund_pending'),
					and(
						inArray(rsvPayments.status, ['requested', 'charging']),
						lt(rsvPayments.updatedAt, now - REFUND_LEASE_MS),
					),
				),
			),
		)
		.orderBy(asc(rsvPayments.updatedAt))
		.limit(200)
	const parents = new Map<string, PaymentRow>()
	for (const refund of refunds) {
		if (refund.parentPaymentId && !parents.has(refund.parentPaymentId)) {
			const parent = await loadPayment(db, refund.parentPaymentId)
			if (parent) parents.set(parent.id, parent)
		}
	}
	return {
		sessions: sessions.map((row) => ({
			reservationId: row.reservationId,
			feeId: (FEE_KINDS as readonly string[]).includes(row.kind)
				? row.id
				: null,
			purpose: (FEE_KINDS as readonly string[]).includes(row.kind)
				? ('fee' as const)
				: ((row.purpose as 'deposit' | 'prepay' | 'experience' | 'guarantee') ??
					'deposit'),
			sessionId: row.providerSessionId!,
			processor: row.provider,
			amountMinor: row.amountMinor,
			currency: row.currency,
		})),
		refunds: refunds.flatMap((row) => {
			const parent = row.parentPaymentId
				? parents.get(row.parentPaymentId)
				: undefined
			if (!parent?.providerRef) return []
			return [
				{
					refundRequestId: row.id,
					reservationId: row.reservationId,
					paymentRef: parent.providerRef,
					processor: row.provider,
					refundRef: row.status === 'refund_pending' ? row.providerRef : null,
					amountMinor: row.amountMinor,
					currency: row.currency,
					paymentAmountMinor: parent.amountMinor,
					platformFeeMinor: parent.platformFeeMinor,
					feeReversalMinor: row.platformFeeMinor,
				},
			]
		}),
	}
}

export function serializePaymentRow(row: PaymentRow) {
	return {
		id: row.id,
		reservationId: row.reservationId,
		kind: row.kind,
		purpose: row.purpose,
		status: row.status,
		amountMinor: row.amountMinor,
		refundedMinor: row.refundedMinor,
		currency: row.currency,
		platformFeeBp: row.platformFeeBp,
		platformFeeMinor: row.platformFeeMinor,
		attempt: row.attempt,
		cardBrand: row.cardBrand,
		cardLast4: row.cardLast4,
		cardExpMonth: row.cardExpMonth,
		cardExpYear: row.cardExpYear,
		declineCode: row.declineCode,
		failureCode: row.failureCode,
		disputeStatus: row.disputeStatus,
		parentPaymentId: row.parentPaymentId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export async function listReservationPayments(
	orgId: string,
	reservationId: string,
	allowedLocation: (locationId: string) => boolean,
) {
	const db = await getTenantDb(orgId)
	const reservation = await db
		.select({
			id: rsvReservations.id,
			locationId: rsvReservations.locationId,
			version: rsvReservations.version,
			status: rsvReservations.status,
			paymentStatus: rsvReservations.paymentStatus,
			lateCancel: rsvReservations.lateCancel,
			partySize: rsvReservations.partySize,
			policySnapshot: rsvReservations.policySnapshot,
		})
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!reservation || !allowedLocation(reservation.locationId)) {
		throw notFound('reservation_not_found')
	}
	const rows = await db
		.select()
		.from(rsvPayments)
		.where(eq(rsvPayments.reservationId, reservationId))
		.orderBy(asc(rsvPayments.createdAt))
	const snapshot = snapshotOf(reservation as unknown as ReservationRow)
	return {
		reservation: {
			id: reservation.id,
			version: reservation.version,
			status: reservation.status,
			paymentStatus: reservation.paymentStatus,
			lateCancel: reservation.lateCancel,
		},
		policy: snapshot
			? {
					kind: snapshot.kind,
					noShowFeeMinor: noShowFee(snapshot),
					lateCancelFeeMinor: lateCancelMax(snapshot),
					currency: snapshot.currency,
				}
			: null,
		payments: rows.map(serializePaymentRow),
	}
}

export async function getGuestPaymentStatus(
	orgId: string,
	reservationId: string,
	now = Date.now(),
) {
	const db = await getTenantDb(orgId)
	const reservation = await loadReservation(db, reservationId)
	return {
		paymentStatus: reservation.paymentStatus,
		reservationStatus:
			reservation.status === 'pending_approval'
				? 'requested'
				: reservation.status,
		now: new Date(now).toISOString(),
	}
}

export { enqueuePaymentOutbox }
