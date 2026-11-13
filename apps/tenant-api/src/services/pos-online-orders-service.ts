import { createHash } from 'node:crypto'
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	or,
	sql,
} from 'drizzle-orm'
import { localDateAndTimeToUtc } from '@repo/common/location-availability'
import {
	handoffNeedsPayment,
	POS_ONLINE_ORDERS_FEED_LIMIT,
	POS_ONLINE_ORDERS_PHONE_LIMIT,
	type PosOnlineOrderCommand,
	type PosOnlineOrderContact,
	type PosOnlineOrderDetail,
	type PosOnlineOrderRefund,
	type PosOnlineOrdersFeed,
	type PosOnlineOrdersGrants,
	type PosOnlineOrderSummary,
	type PosPhonePickup,
} from '@repo/common/pos-online-orders'
import { posStaffDisplayName } from '@repo/common/pos-orders'
import { type PricedOrderLine } from '@repo/common/restaurant-orders'
import {
	posOnlineOrderEvents,
	posOrders,
	restaurantOrders,
	staffMembers,
	type PosOnlineOrderEvent,
	type RestaurantOrder,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'
import { maskPhone } from '../lib/reservations-station.ts'
import { listOrderRefunds, recordOrderRefund } from './order-refund-service.ts'
import {
	orderFailure,
	updateOperatorOrder,
	type OrderServiceFailure,
	type OrderServiceResult,
	type OrderTx,
	type OrderWriteHooks,
} from './order-service.ts'
import { payableOrderCondition } from './order-payable.ts'

/**
 * Station's Orders app on one terminal at one server-bound location. Every
 * order rule (transitions, payment at handoff, refund limits, loyalty) is the
 * operator's (`updateOperatorOrder`, `recordOrderRefund`); this adds the
 * location, the version the counter saw, the person's grants and an
 * append-only record of who did what.
 */

export type OnlineOrdersActor = {
	orgId: string
	locationId: string
	deviceId: string
	staffId: string
	grants: PosOnlineOrdersGrants
}

/** Finished orders stay in the inbox this long (recall, refunds at the counter). */
const FINISHED_MS = 4 * 3_600_000
/** How often one person may reveal a guest's contact: each is recorded, and this stops a sweep. */
export const CONTACT_REVEALS_PER_HOUR = 30

/** Text as the wire schema allows it: an over-long value is cut, never a reason the tablet cannot open the order. */
const clip = <T extends string | null | undefined>(value: T, max: number) =>
	(typeof value === 'string'
		? value.slice(0, max)
		: (value ?? null)) as T extends string ? string : string | null
const ACTIVE = ['accepted', 'preparing', 'ready'] as const
/** Dish, variant and option names may be JSON maps of every menu language. */
const MENU_TEXT_MAX = 4000

const ms = (value: Date | null | undefined) => (value ? value.getTime() : null)

/** What the counter acts on. Any change elsewhere (App, kitchen, a payment) moves it. */
export function onlineOrderVersion(order: RestaurantOrder): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				order.id,
				order.status,
				order.paymentStatus,
				order.refundedCents,
				ms(order.updatedAt),
				ms(order.completedAt),
				ms(order.cancelledAt),
				ms(order.paidAt),
			]),
		)
		.digest('hex')
}

function dueAt(order: RestaurantOrder): number | null {
	if (order.scheduledFor) return order.scheduledFor.getTime()
	if (order.pickupDate && order.pickupTime && order.pickupTimezone)
		return localDateAndTimeToUtc(
			order.pickupDate,
			order.pickupTime,
			order.pickupTimezone,
		).getTime()
	return null
}

function summary(
	order: RestaurantOrder,
	openedAt: number | null,
): PosOnlineOrderSummary {
	const lines = (order.lines ?? []) as PricedOrderLine[]
	return {
		id: order.id,
		number: clip(order.number, 40),
		version: onlineOrderVersion(order),
		status: order.status as PosOnlineOrderSummary['status'],
		fulfillment: order.fulfillment,
		channel: order.source ? 'qr' : 'web',
		tableLabel:
			order.fulfillment === 'dine_in' ? clip(order.tableLabel, 60) : null,
		guestName: clip(order.contactName, 200),
		createdAt: ms(order.createdAt) ?? 0,
		dueAt: dueAt(order),
		paymentMethod: order.paymentMethod,
		paymentStatus: order.paymentStatus,
		onTab: Boolean(order.tabId),
		currency: order.currency,
		totalCents: order.totalCents,
		refundedCents: order.refundedCents,
		itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
		openedAt,
		completedAt: ms(order.completedAt),
		cancelledAt: ms(order.cancelledAt),
	}
}

async function firstOpened(
	db: TenantDatabase,
	orderIds: string[],
): Promise<Map<string, number>> {
	const opened = new Map<string, number>()
	if (!orderIds.length) return opened
	const rows = await queryInChunks(orderIds, (chunk) =>
		db
			.select({
				orderId: posOnlineOrderEvents.orderId,
				at: sql<number>`min(${posOnlineOrderEvents.at})`,
			})
			.from(posOnlineOrderEvents)
			.where(
				and(
					inArray(posOnlineOrderEvents.orderId, chunk),
					eq(posOnlineOrderEvents.action, 'opened'),
				),
			)
			.groupBy(posOnlineOrderEvents.orderId),
	)
	for (const row of rows) opened.set(row.orderId, Number(row.at))
	return opened
}

/** Online orders the counter sees: payable, at this location, and not a payment held for review. */
function atLocation(orgId: string, locationId: string) {
	return and(
		eq(restaurantOrders.orgId, orgId),
		eq(restaurantOrders.locationId, locationId),
		inArray(restaurantOrders.status, [...ACTIVE, 'completed', 'cancelled']),
		payableOrderCondition(),
	)
}

export async function onlineOrdersFeed(
	db: TenantDatabase,
	actor: Pick<OnlineOrdersActor, 'orgId' | 'locationId' | 'grants'>,
	now = Date.now(),
): Promise<PosOnlineOrdersFeed> {
	const [rows, phones] = await Promise.all([
		db
			.select()
			.from(restaurantOrders)
			.where(and(atLocation(actor.orgId, actor.locationId), inInbox(now)))
			.orderBy(
				sql`case when ${restaurantOrders.status} in ('accepted', 'preparing', 'ready') then 0 else 1 end`,
				asc(restaurantOrders.createdAt),
			)
			.limit(POS_ONLINE_ORDERS_FEED_LIMIT + 1),
		db
			.select({
				id: posOrders.id,
				number: posOrders.number,
				guestName: posOrders.guestName,
				pickupAt: posOrders.pickupAt,
				status: posOrders.status,
				currency: posOrders.currency,
				totalCents: posOrders.totalCents,
			})
			.from(posOrders)
			.where(
				and(
					eq(posOrders.locationId, actor.locationId),
					eq(posOrders.orderSource, 'phone'),
					eq(posOrders.status, 'open'),
					isNotNull(posOrders.pickupAt),
					gte(posOrders.pickupAt, now - 24 * 3_600_000),
				),
			)
			.orderBy(asc(posOrders.pickupAt))
			.limit(POS_ONLINE_ORDERS_PHONE_LIMIT),
	])
	const kept = rows.slice(0, POS_ONLINE_ORDERS_FEED_LIMIT)
	const opened = await firstOpened(
		db,
		kept.map((order) => order.id),
	)
	return {
		orders: kept.map((order) => summary(order, opened.get(order.id) ?? null)),
		phonePickups: phones.map((row): PosPhonePickup => ({
			id: row.id,
			number: row.number,
			guestName: row.guestName ? row.guestName.slice(0, 200) : null,
			pickupAt: row.pickupAt,
			status: row.status === 'paid' ? 'paid' : 'open',
			currency: row.currency,
			totalCents: row.totalCents,
		})),
		grants: actor.grants,
		serverNow: now,
		truncated: rows.length > POS_ONLINE_ORDERS_FEED_LIMIT,
	}
}

/** The inbox's reach: open orders, and those finished in the last four hours. */
function inInbox(now: number) {
	const since = new Date(now - FINISHED_MS)
	return or(
		inArray(restaurantOrders.status, [...ACTIVE]),
		gte(restaurantOrders.completedAt, since),
		gte(restaurantOrders.cancelledAt, since),
	)
}

/**
 * One order the counter may open: this location's, and in the inbox. Older
 * orders (and their guests' details) are the App's, however their id is known.
 */
async function loadAtLocation(
	db: TenantDatabase,
	actor: Pick<OnlineOrdersActor, 'orgId' | 'locationId'>,
	orderId: string,
	now = Date.now(),
): Promise<RestaurantOrder | null> {
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.id, orderId),
				atLocation(actor.orgId, actor.locationId),
				inInbox(now),
			),
		)
		.limit(1)
	return order ?? null
}

const NOT_FOUND = () => orderFailure(404, 'order_not_found', 'Order not found.')
const STALE = () =>
	orderFailure(
		409,
		'stale_version',
		'This order changed on another screen. Check it and try again.',
	).failure

export async function onlineOrderDetail(
	db: TenantDatabase,
	actor: Pick<OnlineOrdersActor, 'orgId' | 'locationId'>,
	orderId: string,
): Promise<PosOnlineOrderDetail | null> {
	const order = await loadAtLocation(db, actor, orderId)
	if (!order) return null
	const [opened, refunds, history] = await Promise.all([
		firstOpened(db, [order.id]),
		listOrderRefunds(actor.orgId, order.id),
		db
			.select({
				event: posOnlineOrderEvents,
				firstName: staffMembers.firstName,
				lastName: staffMembers.lastName,
			})
			.from(posOnlineOrderEvents)
			.leftJoin(staffMembers, eq(staffMembers.id, posOnlineOrderEvents.staffId))
			.where(eq(posOnlineOrderEvents.orderId, order.id))
			.orderBy(desc(posOnlineOrderEvents.at))
			.limit(50),
	])
	const lines = (order.lines ?? []) as PricedOrderLine[]
	const refundable =
		order.paymentMethod === 'online' &&
		order.paymentStatus === 'paid' &&
		!order.tabId
			? Math.max(0, order.totalCents - order.refundedCents)
			: 0
	return {
		...summary(order, opened.get(order.id) ?? null),
		lines: lines.map((line) => ({
			name: clip(line.itemName, MENU_TEXT_MAX),
			variantNames: (line.variantNames ?? []).map((name) =>
				clip(name, MENU_TEXT_MAX),
			),
			quantity: line.quantity,
			totalCents: line.totalCents,
			instructions: clip(line.instructions, 400),
			options: (line.options ?? []).map((option) => ({
				name: clip(option.optionName, MENU_TEXT_MAX),
				quantity: option.quantity,
				half: option.half,
			})),
		})),
		phoneMasked: maskPhone(order.contactPhone),
		hasEmail: Boolean(order.contactEmail),
		delivery:
			order.fulfillment === 'delivery' && order.deliveryAddress
				? {
						address: clip(order.deliveryAddress, 400),
						city: clip(order.deliveryCity, 200),
						unit: clip(order.deliveryUnit, 100),
						postalCode: clip(order.deliveryPostalCode, 40),
						notes: clip(order.deliveryNotes, 600),
					}
				: null,
		subtotalCents: order.subtotalCents,
		taxCents: order.taxCents,
		deliveryFeeCents: order.deliveryFeeCents,
		tipCents: order.tipCents,
		discountCents: order.discountCents + order.deliveryDiscountCents,
		loyaltyDiscountCents: order.loyaltyDiscountCents,
		paidAt: ms(order.paidAt),
		refundableCents: refundable,
		refunds: refunds.map((refund) => ({
			amountCents: refund.amountCents,
			note: clip(refund.note ?? '', 400),
			at: refund.createdAt,
		})),
		history: history.map(({ event, firstName, lastName }) => ({
			action: event.action,
			staffName:
				firstName !== null
					? posStaffDisplayName(firstName, lastName ?? '')
					: null,
			reason: event.reason,
			amountCents: event.amountCents,
			at: event.at,
		})),
	}
}

async function record(
	tx: OrderTx | TenantDatabase,
	actor: OnlineOrdersActor,
	orderId: string,
	action: PosOnlineOrderEvent['action'],
	extra: { reason?: string | null; amountCents?: number | null } = {},
	at = Date.now(),
) {
	await tx.insert(posOnlineOrderEvents).values({
		orderId,
		locationId: actor.locationId,
		deviceId: actor.deviceId,
		staffId: actor.staffId,
		action,
		reason: extra.reason ?? null,
		amountCents: extra.amountCents ?? null,
		at,
	})
}

const forbidden = (code: string, message: string): OrderServiceFailure =>
	orderFailure(403, code, message).failure

/** The order is this location's and the counter saw its current state. */
function versionGuard(
	actor: OnlineOrdersActor,
	expectedVersion: string,
): OrderWriteHooks['guard'] {
	return (order) => {
		if (order.locationId !== actor.locationId) return NOT_FOUND().failure
		if (onlineOrderVersion(order) !== expectedVersion) return STALE()
		return null
	}
}

/**
 * Opening silences the alert on every tablet at the location; marking ready,
 * handing over and cancelling go through the operator's own transitions.
 */
export async function onlineOrderCommand(
	db: TenantDatabase,
	actor: OnlineOrdersActor,
	orderId: string,
	command: PosOnlineOrderCommand,
): Promise<OrderServiceResult<null>> {
	const order = await loadAtLocation(db, actor, orderId)
	if (!order) return NOT_FOUND()

	if (command.action === 'open') {
		// Once per order and person is enough to know who saw it first.
		const [seen] = await db
			.select({ id: posOnlineOrderEvents.id })
			.from(posOnlineOrderEvents)
			.where(
				and(
					eq(posOnlineOrderEvents.orderId, order.id),
					eq(posOnlineOrderEvents.action, 'opened'),
					eq(posOnlineOrderEvents.staffId, actor.staffId),
				),
			)
			.limit(1)
		if (!seen) await record(db, actor, order.id, 'opened')
		return { ok: true, data: null }
	}
	if (command.action === 'reprint') {
		await record(db, actor, order.id, 'reprinted', { reason: command.ticket })
		return { ok: true, data: null }
	}

	let failure: OrderServiceFailure | null = null
	let patch: { status: 'ready' | 'completed' | 'cancelled'; markPaid?: boolean }
	let actions: Array<{
		action: PosOnlineOrderEvent['action']
		reason?: string
	}>
	if (command.action === 'ready') {
		if (!actor.grants.manage)
			failure = forbidden('permission_required', 'You cannot manage orders.')
		patch = { status: 'ready' }
		actions = [{ action: 'ready' }]
	} else if (command.action === 'handed_over') {
		if (!actor.grants.manage)
			failure = forbidden('permission_required', 'You cannot manage orders.')
		patch = { status: 'completed', markPaid: command.markPaid || undefined }
		actions = [{ action: 'handed_over' }]
	} else {
		if (!actor.grants.cancel)
			failure = forbidden(
				'permission_required',
				'Ask a manager to cancel this order.',
			)
		patch = { status: 'cancelled' }
		actions = [{ action: 'cancelled', reason: command.reason }]
	}
	if (failure) return { ok: false, failure }

	const guard = versionGuard(actor, command.expectedVersion)
	const result = await updateOperatorOrder(actor.orgId, order.id, patch, {
		guard: (current) => {
			const refused = guard?.(current)
			if (refused) return refused
			// Handed over is the only way Station completes an order, and one paid at
			// handoff is never handed over before the payment is recorded.
			if (
				patch.status === 'completed' &&
				!patch.markPaid &&
				handoffNeedsPayment({
					paymentMethod: current.paymentMethod,
					paymentStatus: current.paymentStatus,
					onTab: Boolean(current.tabId),
				})
			)
				return orderFailure(
					409,
					'payment_required',
					'Record the payment taken at handoff first.',
				).failure
			if (patch.status === current.status) return STALE()
			return null
		},
		afterWrite: async (tx, before, after) => {
			const at = Date.now()
			if (before.paymentStatus !== 'paid' && after.paymentStatus === 'paid')
				await record(tx, actor, order.id, 'paid', {}, at)
			for (const entry of actions)
				await record(
					tx,
					actor,
					order.id,
					entry.action,
					{ reason: entry.reason ?? null },
					at,
				)
		},
	})
	if (!result.ok) return result
	return { ok: true, data: null }
}

/** Records a refund with the operator's rules; loyalty never moves from a till. */
export async function onlineOrderRefund(
	db: TenantDatabase,
	actor: OnlineOrdersActor,
	orderId: string,
	request: PosOnlineOrderRefund,
	idempotencyKey: string,
): Promise<OrderServiceResult<{ replayed: boolean }>> {
	if (!actor.grants.refund)
		return {
			ok: false,
			failure: forbidden(
				'permission_required',
				'Ask a manager to record a refund.',
			),
		}
	const order = await loadAtLocation(db, actor, orderId)
	if (!order) return NOT_FOUND()
	const result = await recordOrderRefund(actor.orgId, order.id, {
		request:
			'full' in request
				? { full: true, note: request.note }
				: { amountCents: request.amountCents, note: request.note },
		// A Station person, never an App user id: `staff:<id>` like the host stand.
		actorId: `staff:${actor.staffId}`,
		idempotencyKey: `station:${idempotencyKey}`,
		// Taking points back needs `update:loyalty_redemption:any`, an App grant
		// no till session carries: such refunds are recorded in the App.
		loyaltyAccess: { refundLoyalty: false, impersonated: false },
		hooks: {
			guard: versionGuard(actor, request.expectedVersion),
			afterWrite: async (tx, before, after) => {
				await record(tx, actor, order.id, 'refunded', {
					reason: after.refundedCents >= after.totalCents ? 'full' : 'partial',
					amountCents: after.refundedCents - before.refundedCents,
				})
			},
		},
	})
	if (!result.ok) return result
	return { ok: true, data: { replayed: result.data.replayed } }
}

/** The guest's phone and email for one order, for a person allowed to see them; recorded. */
export async function onlineOrderContact(
	db: TenantDatabase,
	actor: OnlineOrdersActor,
	orderId: string,
): Promise<OrderServiceResult<PosOnlineOrderContact>> {
	if (!actor.grants.contact)
		return {
			ok: false,
			failure: forbidden(
				'permission_required',
				"You cannot see guests' contact details.",
			),
		}
	const order = await loadAtLocation(db, actor, orderId)
	if (!order) return NOT_FOUND()
	const [recent] = await db
		.select({ count: sql<number>`count(*)` })
		.from(posOnlineOrderEvents)
		.where(
			and(
				eq(posOnlineOrderEvents.staffId, actor.staffId),
				eq(posOnlineOrderEvents.action, 'contact_viewed'),
				gte(posOnlineOrderEvents.at, Date.now() - 3_600_000),
			),
		)
	if (Number(recent?.count ?? 0) >= CONTACT_REVEALS_PER_HOUR)
		return orderFailure(
			429,
			'contact_limit',
			'Too many contacts shown this hour. Try again later.',
		)
	await record(db, actor, order.id, 'contact_viewed')
	return {
		ok: true,
		data: {
			phone: clip(order.contactPhone, 40),
			email: clip(order.contactEmail, 320),
		},
	}
}
