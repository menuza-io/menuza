import crypto from 'node:crypto'
import { and, count, desc, eq, gte, inArray, lt, sum } from 'drizzle-orm'
import { ENV } from 'varlock/env'

import {
	buildPublicOrderingOptions,
	canonicalOrderRequest,
	priceRestaurantOrder,
	restaurantOrderContextSchema,
	type OrderCapacitySpec,
	type PricedOrderLine,
	type PricedRestaurantOrder,
	type PublicOrderingOptions,
	type RestaurantOrderContext,
	type RestaurantOrderError,
	type RestaurantOrderRequest,
} from '@repo/common/restaurant-orders'
import {
	getTenantDb,
	RESTAURANT_ORDER_ACTIVE_STATUSES,
	restaurantOrders,
	restaurantOrderReservations,
	type RestaurantOrder,
} from '@repo/tenant-db'

import type { PublishedOrganization } from '../lib/origin.ts'
import { getNodeRegion } from '../lib/region.ts'
import {
	getInternalCommandToken,
	hmacHash,
	syncEnvFromProcess,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'

/** Tenant database + transaction handle types. */
type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type OrderTx = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

// ---------------------------------------------------------------------------
// Failure shape shared by all order operations
// ---------------------------------------------------------------------------

export type OrderServiceFailure = {
	status: number
	code: string
	message: string
}

export type OrderServiceResult<T> =
	{ ok: true; data: T } | { ok: false; failure: OrderServiceFailure }

export function orderFailure(
	status: number,
	code: string,
	message: string,
): { ok: false; failure: OrderServiceFailure } {
	return { ok: false, failure: { status, code, message } }
}

function fromEngineError(error: RestaurantOrderError): OrderServiceFailure {
	return { status: error.status, code: error.code, message: error.message }
}

// ---------------------------------------------------------------------------
// Per-org serialization
// ---------------------------------------------------------------------------

const orgLocks = new Map<string, Promise<unknown>>()

/**
 * Serializes write operations for one org inside this process. Durable Object
 * orgs are single-threaded already; on the Node/OCI runtime this keeps order
 * placement and payment events from racing each other, and SQLite busy
 * handling covers any cross-process writer.
 */
export async function runExclusive<T>(
	orgId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = orgLocks.get(orgId) ?? Promise.resolve()
	const run = previous.then(operation, operation)
	const tail = run.catch(() => {})
	orgLocks.set(orgId, tail)
	void tail.then(() => {
		if (orgLocks.get(orgId) === tail) orgLocks.delete(orgId)
	})
	return run
}

// ---------------------------------------------------------------------------
// Secret capability tokens (receipt + payment), derived deterministically
// from AUTH_HMAC_SECRET so idempotent retries return the same capabilities.
// Only SHA-256 hashes are stored; verification re-derives the HMAC.
// ---------------------------------------------------------------------------

export function deriveReceiptToken(orgId: string, orderId: string): string {
	return hmacHash(`restaurant-receipt:${orgId}:${orderId}`)
}

export function derivePaymentToken(orgId: string, orderId: string): string {
	return hmacHash(`restaurant-payment:${orgId}:${orderId}`)
}

export function verifyReceiptToken(
	orgId: string,
	orderId: string,
	presented: string,
): boolean {
	if (!presented) return false
	return timingSafeEqualString(presented, deriveReceiptToken(orgId, orderId))
}

export function verifyPaymentToken(
	orgId: string,
	orderId: string,
	presented: string,
): boolean {
	if (!presented) return false
	return timingSafeEqualString(presented, derivePaymentToken(orgId, orderId))
}

function sha256Hex(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex')
}

// ---------------------------------------------------------------------------
// App catalog context fetch (fresh, fail closed, never browser-supplied URL)
// ---------------------------------------------------------------------------

function appOrderContextUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function fetchOrderContext(
	orgId: string,
	locationId: string,
	dropSlug: string | null,
): Promise<OrderServiceResult<RestaurantOrderContext>> {
	const appUrl = appOrderContextUrl()
	const internalToken = getInternalCommandToken()
	if (!appUrl || internalToken.length < 16) {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
	const params = new URLSearchParams({ orgId, locationId })
	if (dropSlug) params.set('drop', dropSlug)

	try {
		const response = await fetch(
			`${appUrl}/resources/order-context?${params.toString()}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${internalToken}`,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(5_000),
			},
		)
		if (!response.ok) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		const parsed = restaurantOrderContextSchema.safeParse(await response.json())
		if (!parsed.success) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		if (parsed.data.orgId !== orgId) {
			return orderFailure(
				503,
				'ordering_unavailable',
				'Ordering is temporarily unavailable. Please try again shortly.',
			)
		}
		return { ok: true, data: parsed.data }
	} catch {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}
}

// ---------------------------------------------------------------------------
// Expiry sweep: online holds stop consuming capacity the moment they lapse.
// Runs inside the same transaction as capacity counting.
// ---------------------------------------------------------------------------

async function expireHolds(db: OrderTx, now: Date): Promise<void> {
	await db
		.update(restaurantOrders)
		.set({
			status: 'expired',
			paymentStatus: 'expired',
			updatedAt: now,
		})
		.where(
			and(
				eq(restaurantOrders.paymentMethod, 'online'),
				eq(restaurantOrders.status, 'accepted'),
				eq(restaurantOrders.paymentStatus, 'pending'),
				lt(restaurantOrders.holdExpiresAt, now),
			),
		)
}

/**
 * Opportunistic sweep used by read paths: expires lapsed online holds for the
 * org so receipts, quotes, and availability reflect reality.
 */
export async function sweepExpiredHolds(orgId: string, now = new Date()) {
	const db = await getTenantDb(orgId)
	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() => db.transaction(async (tx) => expireHolds(tx, now))),
	)
}

// ---------------------------------------------------------------------------
// Capacity assertions (run inside the placement transaction, after sweeping)
// ---------------------------------------------------------------------------

async function assertSlotCapacity(
	tx: OrderTx,
	capacity: OrderCapacitySpec,
): Promise<OrderServiceFailure | null> {
	if (capacity.maxOrdersPerSlot == null) return null
	const [row] = await tx
		.select({ value: count() })
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.pickupWindowId, capacity.windowId),
				eq(restaurantOrders.pickupTime, capacity.slotTime),
				inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
			),
		)
	const used = Number(row?.value ?? 0)
	if (used >= capacity.maxOrdersPerSlot) {
		return {
			status: 422,
			code: 'slot_full',
			message: 'That pickup time is fully booked. Please choose another time.',
		}
	}
	return null
}

async function reservedQuantity(
	tx: OrderTx,
	entity: { kind: 'item' | 'category'; entityId: string },
	scope: { dropId: string; windowId?: string; slotTime?: string },
): Promise<number> {
	const conditions = [
		eq(restaurantOrderReservations.kind, entity.kind),
		eq(restaurantOrderReservations.entityId, entity.entityId),
		// Inventory caps belong to a drop: never count other drops' usage.
		eq(restaurantOrders.dropId, scope.dropId),
		inArray(restaurantOrders.status, [...RESTAURANT_ORDER_ACTIVE_STATUSES]),
	]
	if (scope.windowId && scope.slotTime) {
		conditions.push(eq(restaurantOrderReservations.windowId, scope.windowId))
		conditions.push(eq(restaurantOrderReservations.slotTime, scope.slotTime))
	}
	const [row] = await tx
		.select({ value: sum(restaurantOrderReservations.quantity) })
		.from(restaurantOrderReservations)
		.innerJoin(
			restaurantOrders,
			eq(restaurantOrders.id, restaurantOrderReservations.orderId),
		)
		.where(and(...conditions))
	return Number(row?.value ?? 0)
}

async function assertEntityCapacity(
	tx: OrderTx,
	capacity: OrderCapacitySpec,
): Promise<OrderServiceFailure | null> {
	for (const entity of capacity.entities) {
		if (entity.inventory != null) {
			const used = await reservedQuantity(tx, entity, {
				dropId: capacity.dropId,
			})
			if (used + entity.quantity > entity.inventory) {
				return {
					status: 422,
					code: 'sold_out',
					message:
						'Some items in your order just sold out. Please review your order.',
				}
			}
		}
		if (entity.maxPerPickupSlot != null) {
			const usedInSlot = await reservedQuantity(tx, entity, {
				dropId: capacity.dropId,
				windowId: capacity.windowId,
				slotTime: capacity.slotTime,
			})
			if (usedInSlot + entity.quantity > entity.maxPerPickupSlot) {
				return {
					status: 422,
					code: 'sold_out',
					message:
						'Some items in your order are fully booked for that time. Please choose another time.',
				}
			}
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// Order numbers (per-org, per-UTC-day sequence)
// ---------------------------------------------------------------------------

function dayKeyOf(now: Date): string {
	const year = now.getUTCFullYear()
	const month = String(now.getUTCMonth() + 1).padStart(2, '0')
	const day = String(now.getUTCDate()).padStart(2, '0')
	return `${year}${month}${day}`
}

async function nextOrderNumber(
	tx: OrderTx,
	now: Date,
	usedKeys: Set<string>,
): Promise<string> {
	const dayStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	)
	const [row] = await tx
		.select({ value: count() })
		.from(restaurantOrders)
		.where(gte(restaurantOrders.createdAt, dayStart))
	const base = Number(row?.value ?? 0)
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const candidate = `${dayKeyOf(now)}-${String(base + 1 + attempt).padStart(4, '0')}`
		if (!usedKeys.has(candidate)) {
			usedKeys.add(candidate)
			return candidate
		}
	}
	const candidate = `${dayKeyOf(now)}-${crypto.randomUUID().slice(0, 8)}`
	usedKeys.add(candidate)
	return candidate
}

function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes('UNIQUE constraint failed')
	)
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export type PlaceOrderSuccess = {
	status: 200 | 201
	order: RestaurantOrder
	receiptToken: string
	paymentToken: string | null
}

export type PlaceOrderResult =
	| { ok: true; data: PlaceOrderSuccess }
	| { ok: false; failure: OrderServiceFailure }

export async function placeOrder(input: {
	organization: PublishedOrganization
	request: RestaurantOrderRequest
	customerId: string | null
	now?: Date
}): Promise<PlaceOrderResult> {
	const { organization, request, customerId } = input
	const now = input.now ?? new Date()
	const orgId = organization.id

	const contextResult = await fetchOrderContext(
		orgId,
		request.locationId,
		request.dropSlug ?? null,
	)
	if (!contextResult.ok) return contextResult
	const context = contextResult.data

	if (getNodeRegion() !== context.dataRegion) {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}

	if (
		request.paymentMethod === 'online' &&
		(!context.onlinePayment.enabled || !context.onlinePayment.processor)
	) {
		return orderFailure(
			400,
			'online_payment_disabled',
			'Online payment is not available for this menu. Choose pay at handoff.',
		)
	}

	const priced = priceRestaurantOrder(context, request, { now })
	if (!priced.ok) {
		return { ok: false, failure: fromEngineError(priced.error) }
	}
	const result: PricedRestaurantOrder = priced.result

	const requestHash = sha256Hex(canonicalOrderRequest(request))
	const orderId = crypto.randomUUID()
	const receiptToken = deriveReceiptToken(orgId, orderId)
	const paymentToken =
		request.paymentMethod === 'online'
			? derivePaymentToken(orgId, orderId)
			: null

	const db = await getTenantDb(orgId)

	const replayOrConflict = (existing: RestaurantOrder): PlaceOrderResult => {
		if (existing.requestHash !== requestHash) {
			return orderFailure(
				409,
				'idempotency_conflict',
				'This checkout was already completed with different details.',
			)
		}
		return {
			ok: true,
			data: {
				status: 200,
				order: existing,
				receiptToken: deriveReceiptToken(orgId, existing.id),
				paymentToken:
					existing.paymentMethod === 'online'
						? derivePaymentToken(orgId, existing.id)
						: null,
			},
		}
	}

	const [existing] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.idempotencyKey, request.idempotencyKey))
		.limit(1)
	if (existing) return replayOrConflict(existing)

	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db.transaction(async (tx) => {
				const [existingInTx] = await tx
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.idempotencyKey, request.idempotencyKey))
					.limit(1)
				if (existingInTx) return replayOrConflict(existingInTx)

				await expireHolds(tx, now)

				if (result.capacity) {
					const slotFailure = await assertSlotCapacity(tx, result.capacity)
					if (slotFailure) return { ok: false, failure: slotFailure }
					const entityFailure = await assertEntityCapacity(tx, result.capacity)
					if (entityFailure) return { ok: false, failure: entityFailure }
				}

				const usedNumbers = new Set<string>()
				let inserted: RestaurantOrder | null = null
				for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
					const number = await nextOrderNumber(tx, now, usedNumbers)
					const holdExpiresAt =
						request.paymentMethod === 'online'
							? new Date(now.getTime() + result.holdMinutes * 60 * 1000)
							: null
					try {
						const [row] = await tx
							.insert(restaurantOrders)
							.values({
								id: orderId,
								orgId,
								customerId,
								number,
								locale: request.locale,
								status: 'accepted',
								paymentMethod: request.paymentMethod,
								paymentStatus:
									request.paymentMethod === 'online' ? 'pending' : 'unpaid',
								paymentProcessor:
									request.paymentMethod === 'online'
										? (context.onlinePayment.processor ?? null)
										: null,
								fulfillment: request.fulfillment,
								locationId: request.locationId,
								locationName: result.location.name,
								dropId: result.drop?.id ?? null,
								dropSlug: result.drop?.slug ?? null,
								pickupWindowId: result.pickup?.windowId ?? null,
								pickupDate: result.pickup?.date ?? null,
								pickupTime: result.pickup?.time ?? null,
								pickupTimezone: result.pickup?.timezone ?? null,
								contactName: request.contact.name,
								contactPhone: request.contact.phone,
								contactEmail: request.contact.email ?? null,
								deliveryAddress: result.delivery?.address ?? null,
								deliveryCity: result.delivery?.city ?? null,
								deliveryUnit: result.delivery?.unit ?? null,
								deliveryNotes: result.delivery?.notes ?? null,
								deliveryZoneId: result.delivery?.zoneId ?? null,
								currency: result.currency,
								subtotalCents: result.subtotalCents,
								taxCents: result.taxCents,
								deliveryFeeCents: result.deliveryFeeCents,
								tipCents: result.tipCents,
								tipPercent: result.tipPercent,
								totalCents: result.totalCents,
								lines: result.lines,
								idempotencyKey: request.idempotencyKey,
								requestHash,
								receiptTokenHash: sha256Hex(receiptToken),
								paymentTokenHash: paymentToken ? sha256Hex(paymentToken) : null,
								holdExpiresAt,
							})
							.returning()
						inserted = row ?? null
					} catch (error) {
						if (isUniqueConstraintError(error) && attempt < 4) continue
						throw error
					}
				}
				if (!inserted) {
					return orderFailure(
						500,
						'order_number_conflict',
						'We could not place this order. Please try again.',
					)
				}

				if (result.capacity && result.capacity.entities.length > 0) {
					await tx.insert(restaurantOrderReservations).values(
						result.capacity.entities.map((entity) => ({
							orderId: inserted!.id,
							kind: entity.kind,
							entityId: entity.entityId,
							windowId: result.capacity!.windowId,
							slotTime: result.capacity!.slotTime,
							quantity: entity.quantity,
						})),
					)
				}

				return {
					ok: true,
					data: {
						status: 201,
						order: inserted,
						receiptToken,
						paymentToken,
					},
				}
			}),
		),
	)
}

// ---------------------------------------------------------------------------
// Receipt retrieval (secret capability, never orderId or customer JWT alone)
// ---------------------------------------------------------------------------

export type ReceiptOrder = {
	order: RestaurantOrder
	lines: PricedOrderLine[]
}

export async function getOrderReceipt(
	orgId: string,
	orderId: string,
	presentedToken: string,
): Promise<OrderServiceResult<ReceiptOrder>> {
	if (!verifyReceiptToken(orgId, orderId, presentedToken)) {
		return orderFailure(
			403,
			'invalid_receipt_token',
			'This receipt link is not valid.',
		)
	}
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	return {
		ok: true,
		data: { order, lines: order.lines as PricedOrderLine[] },
	}
}

// ---------------------------------------------------------------------------
// Internal quote (App → regional). No PII: amounts and lifecycle state only.
// ---------------------------------------------------------------------------

export type OrderQuote = {
	orgId: string
	orderId: string
	totalCents: number
	currency: string
	holdExpiresAt: string | null
	status: string
}

export async function getOrderQuote(
	orgId: string,
	orderId: string,
	paymentToken: string,
): Promise<OrderServiceResult<OrderQuote>> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	if (order.paymentMethod !== 'online') {
		return orderFailure(
			409,
			'not_online_order',
			'Quotes are only available for online orders.',
		)
	}
	if (!verifyPaymentToken(orgId, order.id, paymentToken)) {
		return orderFailure(
			403,
			'invalid_payment_token',
			'This payment link is not valid.',
		)
	}
	return {
		ok: true,
		data: {
			orgId,
			orderId: order.id,
			totalCents: order.totalCents,
			currency: order.currency,
			holdExpiresAt: order.holdExpiresAt
				? order.holdExpiresAt.toISOString()
				: null,
			status: order.status,
		},
	}
}

// ---------------------------------------------------------------------------
// Payment session binding (exactly once) + payment events (monotonic)
// ---------------------------------------------------------------------------

export type PaymentSessionResult = {
	orgId: string
	orderId: string
	sessionId: string
	status: string
	paymentStatus: string
}

export async function bindPaymentSession(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}): Promise<OrderServiceResult<PaymentSessionResult>> {
	const { orgId, orderId, sessionId, processor } = input
	const db = await getTenantDb(orgId)

	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db.transaction(async (tx) => {
				await expireHolds(tx, new Date())
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, orderId),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (!order) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				if (order.paymentMethod !== 'online') {
					return orderFailure(
						409,
						'not_online_order',
						'Payment sessions are only valid for online orders.',
					)
				}
				if (order.status === 'expired') {
					return orderFailure(
						409,
						'hold_expired',
						'The checkout hold for this order has expired.',
					)
				}
				if (
					order.paymentStatus === 'paid' ||
					order.paymentStatus === 'failed' ||
					order.paymentStatus === 'expired' ||
					order.paymentStatus === 'review'
				) {
					return orderFailure(
						409,
						'payment_terminal',
						'This order already has a terminal payment state.',
					)
				}
				if (order.paymentProcessor && order.paymentProcessor !== processor) {
					return orderFailure(
						409,
						'processor_mismatch',
						'This order is bound to a different payment processor.',
					)
				}
				if (order.paymentSessionId && order.paymentSessionId !== sessionId) {
					return orderFailure(
						409,
						'session_conflict',
						'This order already has a bound payment session.',
					)
				}
				if (order.paymentSessionId === sessionId) {
					return {
						ok: true,
						data: {
							orgId,
							orderId: order.id,
							sessionId,
							status: order.status,
							paymentStatus: order.paymentStatus,
						},
					}
				}
				await tx
					.update(restaurantOrders)
					.set({
						paymentSessionId: sessionId,
						paymentProcessor: processor,
						paymentEventAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(restaurantOrders.id, order.id))
				return {
					ok: true,
					data: {
						orgId,
						orderId: order.id,
						sessionId,
						status: order.status,
						paymentStatus: order.paymentStatus,
					},
				}
			}),
		),
	)
}

export type PaymentEventResult = {
	orgId: string
	orderId: string
	sessionId: string
	status: string
	paymentStatus: string
}

export async function applyPaymentEvent(input: {
	orgId: string
	orderId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
}): Promise<OrderServiceResult<PaymentEventResult>> {
	const {
		orgId,
		orderId,
		sessionId,
		processor,
		status,
		amountCents,
		currency,
	} = input
	const db = await getTenantDb(orgId)

	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db.transaction(async (tx) => {
				await expireHolds(tx, new Date())
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, orderId),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (!order) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}
				if (order.paymentMethod !== 'online') {
					return orderFailure(
						409,
						'not_online_order',
						'Payment events are only valid for online orders.',
					)
				}
				if (!order.paymentSessionId || order.paymentSessionId !== sessionId) {
					return orderFailure(
						403,
						'session_mismatch',
						'This payment event does not match the bound payment session.',
					)
				}
				if (order.paymentProcessor !== processor) {
					return orderFailure(
						409,
						'processor_mismatch',
						'This payment event does not match the bound payment processor.',
					)
				}
				if (order.totalCents !== amountCents) {
					return orderFailure(
						422,
						'amount_mismatch',
						'The payment amount does not match this order.',
					)
				}
				if (order.currency !== currency) {
					return orderFailure(
						422,
						'currency_mismatch',
						'The payment currency does not match this order.',
					)
				}

				const now = new Date()
				const idempotent: PaymentEventResult = {
					orgId,
					orderId: order.id,
					sessionId,
					status: order.status,
					paymentStatus: order.paymentStatus,
				}

				if (status === 'paid') {
					if (order.paymentStatus === 'paid')
						return { ok: true, data: idempotent }
					const lateArrival =
						order.status === 'expired' || order.status === 'cancelled'
					if (
						order.status === 'accepted' &&
						order.paymentStatus === 'pending'
					) {
						await tx
							.update(restaurantOrders)
							.set({
								paymentStatus: 'paid',
								paidAt: now,
								paymentEventAt: now,
								updatedAt: now,
							})
							.where(eq(restaurantOrders.id, order.id))
						return {
							ok: true,
							data: {
								...idempotent,
								status: order.status,
								paymentStatus: 'paid',
							},
						}
					}
					if (
						lateArrival &&
						(order.paymentStatus === 'pending' ||
							order.paymentStatus === 'expired' ||
							order.paymentStatus === 'failed')
					) {
						// Money arrived after the hold lapsed: never resurrect the
						// reservation. Surface payment_review for the operator.
						await tx
							.update(restaurantOrders)
							.set({
								status: 'payment_review',
								paymentStatus: 'paid',
								paidAt: now,
								paymentEventAt: now,
								updatedAt: now,
							})
							.where(eq(restaurantOrders.id, order.id))
						return {
							ok: true,
							data: {
								...idempotent,
								status: 'payment_review',
								paymentStatus: 'paid',
							},
						}
					}
					return orderFailure(
						409,
						'payment_state_conflict',
						'This order cannot transition to paid.',
					)
				}

				if (status === 'failed') {
					if (order.paymentStatus === 'failed')
						return { ok: true, data: idempotent }
					if (
						order.status === 'accepted' &&
						order.paymentStatus === 'pending'
					) {
						await tx
							.update(restaurantOrders)
							.set({
								status: 'cancelled',
								paymentStatus: 'failed',
								cancelledAt: now,
								paymentEventAt: now,
								updatedAt: now,
							})
							.where(eq(restaurantOrders.id, order.id))
						return {
							ok: true,
							data: {
								...idempotent,
								status: 'cancelled',
								paymentStatus: 'failed',
							},
						}
					}
					return orderFailure(
						409,
						'payment_state_conflict',
						'This order cannot transition to failed.',
					)
				}

				// provider session expired without payment
				if (order.paymentStatus === 'expired')
					return { ok: true, data: idempotent }
				if (order.status === 'accepted' && order.paymentStatus === 'pending') {
					await tx
						.update(restaurantOrders)
						.set({
							status: 'expired',
							paymentStatus: 'expired',
							paymentEventAt: now,
							updatedAt: now,
						})
						.where(eq(restaurantOrders.id, order.id))
					return {
						ok: true,
						data: {
							...idempotent,
							status: 'expired',
							paymentStatus: 'expired',
						},
					}
				}
				return orderFailure(
					409,
					'payment_state_conflict',
					'This order cannot transition to expired.',
				)
			}),
		),
	)
}

// ---------------------------------------------------------------------------
// Operator lifecycle transitions
// ---------------------------------------------------------------------------

const OPERATOR_STATUS_TRANSITIONS: Record<RestaurantOrder['status'], string[]> =
	{
		accepted: ['preparing', 'ready', 'completed', 'cancelled'],
		preparing: ['ready', 'completed', 'cancelled'],
		ready: ['completed', 'cancelled'],
		completed: [],
		cancelled: [],
		expired: [],
		payment_review: ['preparing', 'ready', 'completed', 'cancelled'],
	}

export type OperatorPatchInput = {
	status: RestaurantOrder['status']
	markPaid?: boolean
}

export async function updateOperatorOrder(
	orgId: string,
	orderId: string,
	input: OperatorPatchInput,
): Promise<OrderServiceResult<RestaurantOrder>> {
	const db = await getTenantDb(orgId)

	return runExclusive(orgId, () =>
		retryOnSqliteBusy(() =>
			db.transaction(async (tx) => {
				await expireHolds(tx, new Date())
				const [order] = await tx
					.select()
					.from(restaurantOrders)
					.where(
						and(
							eq(restaurantOrders.id, orderId),
							eq(restaurantOrders.orgId, orgId),
						),
					)
					.limit(1)
				if (!order) {
					return orderFailure(404, 'order_not_found', 'Order not found.')
				}

				const now = new Date()
				const patch: Partial<RestaurantOrder> = {}

				if (input.status !== order.status) {
					const allowed = OPERATOR_STATUS_TRANSITIONS[order.status] ?? []
					if (!allowed.includes(input.status)) {
						return orderFailure(
							422,
							'invalid_transition',
							`An order that is ${order.status} cannot move to ${input.status}.`,
						)
					}
					patch.status = input.status
					if (input.status === 'completed') patch.completedAt = now
					if (input.status === 'cancelled') patch.cancelledAt = now
				}

				if (input.markPaid) {
					if (order.paymentMethod !== 'online') {
						if (
							order.paymentStatus !== 'unpaid' &&
							order.paymentStatus !== 'paid'
						) {
							return orderFailure(
								409,
								'payment_state_conflict',
								'This order cannot be marked paid.',
							)
						}
						patch.paymentStatus = 'paid'
						patch.paidAt = now
					} else {
						return orderFailure(
							409,
							'payment_not_markable',
							'Online order payment status is controlled by payment events.',
						)
					}
				}

				if (Object.keys(patch).length === 0) {
					return { ok: true, data: order }
				}

				const [updated] = await tx
					.update(restaurantOrders)
					.set({ ...patch, updatedAt: now })
					.where(eq(restaurantOrders.id, order.id))
					.returning()
				return { ok: true, data: updated ?? order }
			}),
		),
	)
}

export async function listOperatorOrders(
	orgId: string,
	options: { limit: number; status?: string },
): Promise<RestaurantOrder[]> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const conditions = [eq(restaurantOrders.orgId, orgId)]
	if (options.status) {
		conditions.push(
			eq(restaurantOrders.status, options.status as RestaurantOrder['status']),
		)
	}
	return db
		.select()
		.from(restaurantOrders)
		.where(and(...conditions))
		.orderBy(desc(restaurantOrders.createdAt))
		.limit(options.limit)
}

export async function getOperatorOrder(
	orgId: string,
	orderId: string,
): Promise<OrderServiceResult<RestaurantOrder>> {
	const db = await getTenantDb(orgId)
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) {
		return orderFailure(404, 'order_not_found', 'Order not found.')
	}
	return { ok: true, data: order }
}

// ---------------------------------------------------------------------------
// Public ordering options (GET /orders/options): aggregates only, no PII
// ---------------------------------------------------------------------------

export async function buildOrderingOptions(
	organization: PublishedOrganization,
	input: { slug: string | null; locationId: string; dropSlug: string | null },
): Promise<OrderServiceResult<PublicOrderingOptions>> {
	const contextResult = await fetchOrderContext(
		organization.id,
		input.locationId,
		input.dropSlug,
	)
	if (!contextResult.ok) return contextResult
	const context = contextResult.data
	if (getNodeRegion() !== context.dataRegion) {
		return orderFailure(
			503,
			'ordering_unavailable',
			'Ordering is temporarily unavailable. Please try again shortly.',
		)
	}

	const now = new Date()
	const db = await getTenantDb(organization.id)
	await sweepExpiredHolds(organization.id)

	const slotOrders = new Map<string, number>()
	const entityUsed = new Map<string, number>()

	if (input.dropSlug && context.drop) {
		const windowIds = context.drop.pickupWindows.map((window) => window.id)
		if (windowIds.length > 0) {
			const slotRows = await db
				.select({
					windowId: restaurantOrders.pickupWindowId,
					time: restaurantOrders.pickupTime,
					value: count(),
				})
				.from(restaurantOrders)
				.where(
					and(
						inArray(restaurantOrders.pickupWindowId, windowIds),
						inArray(restaurantOrders.status, [
							...RESTAURANT_ORDER_ACTIVE_STATUSES,
						]),
					),
				)
				.groupBy(restaurantOrders.pickupWindowId, restaurantOrders.pickupTime)
			for (const row of slotRows) {
				if (row.windowId && row.time) {
					slotOrders.set(`${row.windowId}|${row.time}`, Number(row.value))
				}
			}
		}

		const entityIds = context.drop.inventoryOverrides.map(
			(override) => override.entityId,
		)
		if (entityIds.length > 0) {
			const entityRows = await db
				.select({
					kind: restaurantOrderReservations.kind,
					entityId: restaurantOrderReservations.entityId,
					used: sum(restaurantOrderReservations.quantity),
				})
				.from(restaurantOrderReservations)
				.innerJoin(
					restaurantOrders,
					eq(restaurantOrders.id, restaurantOrderReservations.orderId),
				)
				.where(
					and(
						inArray(restaurantOrderReservations.entityId, entityIds),
						eq(restaurantOrders.dropId, context.drop.drop.id),
						inArray(restaurantOrders.status, [
							...RESTAURANT_ORDER_ACTIVE_STATUSES,
						]),
					),
				)
				.groupBy(
					restaurantOrderReservations.kind,
					restaurantOrderReservations.entityId,
				)
			for (const row of entityRows) {
				entityUsed.set(`${row.kind}|${row.entityId}`, Number(row.used ?? 0))
			}
		}
	}

	const built = buildPublicOrderingOptions(context, {
		slug: input.slug,
		locationId: input.locationId,
		dropSlug: input.dropSlug,
		counts: { slotOrders, entityUsed },
		now,
	})
	if (!built.ok) return { ok: false, failure: fromEngineError(built.error) }
	return { ok: true, data: built.options }
}

// ---------------------------------------------------------------------------
// Serialization (public summary + receipt + operator views)
// ---------------------------------------------------------------------------

export function publicOrderSummary(order: RestaurantOrder) {
	return {
		id: order.id,
		number: order.number,
		status: order.status,
		paymentStatus: order.paymentStatus,
		currency: order.currency,
		subtotalCents: order.subtotalCents,
		taxCents: order.taxCents,
		deliveryFeeCents: order.deliveryFeeCents,
		tipCents: order.tipCents,
		totalCents: order.totalCents,
		holdExpiresAt: order.holdExpiresAt
			? order.holdExpiresAt.toISOString()
			: null,
	}
}

export function receiptOrder(order: RestaurantOrder) {
	return {
		...publicOrderSummary(order),
		tipPercent: order.tipPercent,
		fulfillment: order.fulfillment,
		locale: order.locale,
		createdAt: order.createdAt ? order.createdAt.toISOString() : null,
		location: { id: order.locationId, name: order.locationName },
		pickup:
			order.pickupWindowId && order.pickupDate && order.pickupTime
				? {
						windowId: order.pickupWindowId,
						date: order.pickupDate,
						time: order.pickupTime,
						timezone: order.pickupTimezone ?? 'UTC',
					}
				: null,
		drop: order.dropSlug ? { slug: order.dropSlug } : null,
		lines: order.lines as PricedOrderLine[],
		contact: {
			name: order.contactName,
			phone: order.contactPhone,
			email: order.contactEmail ?? null,
		},
		delivery: order.deliveryAddress
			? {
					address: order.deliveryAddress,
					city: order.deliveryCity,
					unit: order.deliveryUnit,
					notes: order.deliveryNotes,
					feeCents: order.deliveryFeeCents,
					zoneId: order.deliveryZoneId,
				}
			: null,
	}
}

export function operatorOrder(order: RestaurantOrder) {
	return {
		...receiptOrder(order),
		id: order.id,
		orgId: order.orgId,
		customerId: order.customerId,
		paymentMethod: order.paymentMethod,
		paymentProcessor: order.paymentProcessor,
		paymentSessionId: order.paymentSessionId,
		dropId: order.dropId,
		deliveryZoneId: order.deliveryZoneId,
		paidAt: order.paidAt ? order.paidAt.toISOString() : null,
		completedAt: order.completedAt ? order.completedAt.toISOString() : null,
		cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
		updatedAt: order.updatedAt ? order.updatedAt.toISOString() : null,
	}
}
