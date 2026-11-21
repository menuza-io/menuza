import {
	and,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lte,
	sql,
	type SQL,
} from 'drizzle-orm'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { RESTAURANT_SALES_ORDER_STATUSES } from '@repo/common/restaurant-orders'
import {
	type ReportDefinition,
	type ReportRecord,
	type ReportSubject,
	referencedFieldIds,
	resolveTimeframeRange,
} from '@repo/reports'
import {
	customers,
	customerSubscriptions,
	discountRedemptions,
	marketingCampaigns,
	marketingMessages,
	qrTabs,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { isValidTimeZone } from '@repo/reservations'
import { queryInChunks } from '../lib/chunked-in.ts'
import { isPayableOrder, payableOrderCondition } from './order-payable.ts'

/**
 * Most recent orders an order, item, or option report reads. Like the phone
 * call cap, it only bounds memory when a report spans a very long history.
 */
export const ORDER_REPORT_MAX_ROWS = 50_000

/** Orders placed this soon after an email or text are credited to it. */
export const ATTRIBUTION_WINDOW_MS = 7 * 86_400_000

const ATTRIBUTION_MAX_MESSAGES = 200_000

/** Statuses whose marketing message actually reached the customer. */
const DELIVERED_MESSAGE_STATUSES = ['Sent', 'Opened', 'Clicked']

export type LoadedRecords = { records: ReportRecord[]; truncated: boolean }

type OrderStatus = (typeof restaurantOrders.$inferSelect)['status']

// An order waiting for acceptance may still be rejected: not a sale yet.
const ACTIVE_STATUSES: readonly OrderStatus[] = RESTAURANT_SALES_ORDER_STATUSES

type OrderSalesState = {
	status: OrderStatus
	paymentMethod: 'handoff' | 'online'
	paymentStatus: string
}

/**
 * Open and completed orders count as sales once they are payable: handoff
 * orders right away, online orders after payment succeeds (or when none was
 * due: a 100% discount). Cancelled,
 * expired, and payment-review orders are left out.
 */
export function orderCountsTowardSales(order: OrderSalesState) {
	return ACTIVE_STATUSES.includes(order.status) && isPayableOrder(order)
}

/** The same rule as {@link orderCountsTowardSales}, as a WHERE clause. */
export function countedOrderCondition(): SQL {
	return and(
		inArray(restaurantOrders.status, [...RESTAURANT_SALES_ORDER_STATUSES]),
		payableOrderCondition(),
	)!
}

/**
 * Status as the orders page shows it. Online orders still waiting on payment
 * read as such, and holds that have lapsed read as expired even before the
 * next order write sweeps them (reports never write).
 */
export function reportOrderStatus(
	order: OrderSalesState & { holdExpiresAt: Date | null },
	now: Date,
): { status: string; paymentStatus: string } {
	if (
		order.status === 'accepted' &&
		order.paymentMethod === 'online' &&
		order.paymentStatus === 'pending'
	) {
		return order.holdExpiresAt && order.holdExpiresAt < now
			? { status: 'expired', paymentStatus: 'expired' }
			: { status: 'awaiting_payment', paymentStatus: 'pending' }
	}
	return { status: order.status, paymentStatus: order.paymentStatus }
}

/**
 * Matches the same person across signed-in and guest checkouts. The last nine
 * digits survive the formatting and country-code differences between a
 * checkout phone and an account phone.
 */
export function phoneKey(phone: string | null | undefined): string | null {
	const digits = (phone ?? '').replace(/\D/g, '')
	return digits.length >= 6 ? digits.slice(-9) : null
}

function localized(value: unknown): string {
	return typeof value === 'string' ? getLocalizedMenuValue(value) : ''
}

type ReportOptionLine = {
	groupName: string
	optionName: string
	quantity: number
	totalCents: number
}

type ReportOrderLine = {
	itemName: string
	quantity: number
	totalCents: number
	options: ReportOptionLine[]
}

function finiteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Reads the stored `lines` JSON defensively; malformed lines are skipped. */
export function parseOrderLines(raw: unknown): ReportOrderLine[] {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const lines: ReportOrderLine[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const line = entry as Record<string, unknown>
		const options = Array.isArray(line.options) ? line.options : []
		lines.push({
			itemName: localized(line.itemName),
			quantity: finiteNumber(line.quantity),
			totalCents: finiteNumber(line.totalCents),
			options: options
				.filter(
					(option): option is Record<string, unknown> =>
						Boolean(option) && typeof option === 'object',
				)
				.map((option) => ({
					groupName: localized(option.groupName),
					optionName: localized(option.optionName),
					quantity: finiteNumber(option.quantity),
					totalCents: finiteNumber(option.totalCents),
				})),
		})
	}
	return lines
}

const orderColumns = {
	id: restaurantOrders.id,
	customerId: restaurantOrders.customerId,
	number: restaurantOrders.number,
	status: restaurantOrders.status,
	paymentMethod: restaurantOrders.paymentMethod,
	paymentStatus: restaurantOrders.paymentStatus,
	fulfillment: restaurantOrders.fulfillment,
	locationName: restaurantOrders.locationName,
	dropId: restaurantOrders.dropId,
	dropSlug: restaurantOrders.dropSlug,
	scheduledFor: restaurantOrders.scheduledFor,
	contactName: restaurantOrders.contactName,
	contactPhone: restaurantOrders.contactPhone,
	contactEmail: restaurantOrders.contactEmail,
	currency: restaurantOrders.currency,
	subtotalCents: restaurantOrders.subtotalCents,
	taxCents: restaurantOrders.taxCents,
	deliveryFeeCents: restaurantOrders.deliveryFeeCents,
	tipCents: restaurantOrders.tipCents,
	tipPercent: restaurantOrders.tipPercent,
	serviceFeeCents: restaurantOrders.serviceFeeCents,
	packagingFeeCents: restaurantOrders.packagingFeeCents,
	totalCents: restaurantOrders.totalCents,
	discountCents: restaurantOrders.discountCents,
	deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
	loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
	tabId: restaurantOrders.tabId,
	holdExpiresAt: restaurantOrders.holdExpiresAt,
	locationTimezone: restaurantOrders.locationTimezone,
	pickupTimezone: restaurantOrders.pickupTimezone,
	createdAt: restaurantOrders.createdAt,
	completedAt: restaurantOrders.completedAt,
}

export type OrderReportRow = Pick<
	typeof restaurantOrders.$inferSelect,
	keyof typeof orderColumns
> & { lines?: unknown }

/**
 * Reads the most recent orders in the report window, newest first. Only the
 * timeframe narrows the query; filters run in the engine.
 */
async function loadOrderRows(
	db: TenantDatabase,
	orgId: string,
	definition: ReportDefinition,
	now: Date,
	options: { onlyCounted: boolean; withLines: boolean; maxRows: number },
): Promise<{ rows: OrderReportRow[]; truncated: boolean }> {
	// Counted by fulfilment time (#310), "Ordered at" reads the fulfilment time,
	// so the window has to be cut on it too: an order placed on Friday for
	// Sunday is in Sunday's report.
	const timeColumn =
		definition.timeframe.field === 'completedAt'
			? sql`${restaurantOrders.completedAt}`
			: definition.timeBasis === 'fulfillment'
				? ORDER_FULFILLED_AT
				: sql`${restaurantOrders.createdAt}`
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	// The columns hold epoch seconds.
	const conditions: SQL[] = [
		eq(restaurantOrders.orgId, orgId),
		sql`${timeColumn} <= ${Math.floor(range.end.getTime() / 1000)}`,
	]
	if (range.start) {
		conditions.push(
			sql`${timeColumn} >= ${Math.floor(range.start.getTime() / 1000)}`,
		)
	}
	if (options.onlyCounted) conditions.push(countedOrderCondition())
	const where = and(...conditions)
	const limit = options.maxRows + 1

	const loaded: OrderReportRow[] = options.withLines
		? await db
				.select({ ...orderColumns, lines: restaurantOrders.lines })
				.from(restaurantOrders)
				.where(where)
				.orderBy(desc(timeColumn))
				.limit(limit)
		: await db
				.select(orderColumns)
				.from(restaurantOrders)
				.where(where)
				.orderBy(desc(timeColumn))
				.limit(limit)
	const truncated = loaded.length > options.maxRows
	return {
		rows: truncated ? loaded.slice(0, options.maxRows) : loaded,
		truncated,
	}
}

/**
 * When an order was fulfilled (#310): the scheduled time of a scheduled
 * order, else when it was completed, else when it was placed. Cancelled and
 * expired orders follow the placed time on both bases.
 */
export function orderFulfilledAt(row: {
	status: string
	scheduledFor: Date | null
	completedAt: Date | null
	createdAt: Date | null
}): Date | null {
	if (row.status === 'cancelled' || row.status === 'expired') {
		return row.createdAt
	}
	return row.scheduledFor ?? row.completedAt ?? row.createdAt
}

/** The same rule as {@link orderFulfilledAt}, in SQL (epoch seconds). */
const ORDER_FULFILLED_AT = sql`case when ${restaurantOrders.status} in ('cancelled', 'expired') then ${restaurantOrders.createdAt} else coalesce(${restaurantOrders.scheduledFor}, ${restaurantOrders.completedAt}, ${restaurantOrders.createdAt}) end`

/** The location's own zone, when the order carries one the runtime knows. */
function orderTimeZone(row: {
	locationTimezone: string | null
	pickupTimezone: string | null
}): string {
	for (const zone of [row.locationTimezone, row.pickupTimezone]) {
		if (zone && isValidTimeZone(zone)) return zone
	}
	return ''
}

/** Fields shared by order, item, and option records. */
function orderContext(row: OrderReportRow) {
	return {
		createdAt: row.createdAt,
		fulfilledAt: orderFulfilledAt(row),
		// Days and hours are the location's own; without a zone, the report's.
		locationTimeZone: orderTimeZone(row),
		orderNumber: row.number,
		location: localized(row.locationName),
		fulfillment: row.fulfillment,
		source: row.dropId ? 'drop' : 'menu',
		drop: row.dropSlug ?? '',
		currency: row.currency.toUpperCase(),
	}
}

export async function customerIdsByPhone(db: TenantDatabase) {
	const rows = await db
		.select({ id: customers.id, phone: customers.phone })
		.from(customers)
	const byPhone = new Map<string, string>()
	for (const row of rows) {
		const key = phoneKey(row.phone)
		if (key) byPhone.set(key, row.id)
	}
	return byPhone
}

/**
 * Who placed an order: the signed-in customer, else the customer whose phone
 * matches the checkout phone, else the checkout phone itself.
 */
export function orderIdentity(
	order: { customerId: string | null; contactPhone: string | null },
	byPhone: Map<string, string>,
): string | null {
	if (order.customerId) return order.customerId
	const key = phoneKey(order.contactPhone)
	if (!key) return null
	return byPhone.get(key) ?? `phone:${key}`
}

export type CustomerOrderHistory = {
	orders: number
	spentCents: number
	firstAt: Date
	lastAt: Date
	firstSource: 'menu' | 'drop'
	currency: string
}

/**
 * Lifetime totals of orders that count toward sales, per customer identity
 * (see {@link orderIdentity}). Aggregated in SQL, so it stays small no matter
 * how many orders the organization has.
 */
export async function loadCustomerOrderHistory(
	db: TenantDatabase,
	orgId: string,
	byPhone: Map<string, string>,
): Promise<Map<string, CustomerOrderHistory>> {
	const rows = await db
		.select({
			customerId: restaurantOrders.customerId,
			contactPhone: restaurantOrders.contactPhone,
			orders: sql<number>`count(*)`,
			spentCents: sql<number>`coalesce(sum(${restaurantOrders.totalCents}), 0)`,
			firstAt: sql`min(${restaurantOrders.createdAt})`.mapWith(
				restaurantOrders.createdAt,
			),
			lastAt: sql`max(${restaurantOrders.createdAt})`.mapWith(
				restaurantOrders.createdAt,
			),
			firstMenuAt:
				sql`min(case when ${restaurantOrders.dropId} is null then ${restaurantOrders.createdAt} end)`.mapWith(
					restaurantOrders.createdAt,
				),
			currency: sql<string>`max(${restaurantOrders.currency})`,
		})
		.from(restaurantOrders)
		.where(and(eq(restaurantOrders.orgId, orgId), countedOrderCondition()))
		.groupBy(restaurantOrders.customerId, restaurantOrders.contactPhone)

	const history = new Map<string, CustomerOrderHistory>()
	for (const row of rows) {
		const identity = orderIdentity(row, byPhone)
		if (!identity || !row.firstAt || !row.lastAt) continue
		const firstSource =
			row.firstMenuAt && row.firstMenuAt.getTime() === row.firstAt.getTime()
				? 'menu'
				: 'drop'
		const existing = history.get(identity)
		if (!existing) {
			history.set(identity, {
				orders: Number(row.orders),
				spentCents: Number(row.spentCents),
				firstAt: row.firstAt,
				lastAt: row.lastAt,
				firstSource,
				currency: (row.currency ?? '').toUpperCase(),
			})
			continue
		}
		existing.orders += Number(row.orders)
		existing.spentCents += Number(row.spentCents)
		if (row.firstAt < existing.firstAt) {
			existing.firstAt = row.firstAt
			existing.firstSource = firstSource
		}
		if (row.lastAt > existing.lastAt) existing.lastAt = row.lastAt
	}
	return history
}

type AttributionMessage = { sentAt: number; channel: 'email' | 'sms' }

/**
 * Delivered emails and texts that could take credit for orders placed between
 * `from` and `to`, grouped by customer and sorted oldest first.
 */
async function loadAttributionMessages(
	db: TenantDatabase,
	from: Date,
	to: Date,
): Promise<Map<string, AttributionMessage[]>> {
	const rows = await db
		.select({
			customerId: marketingMessages.customerId,
			sentAt: marketingMessages.sentAt,
			channel: marketingMessages.channel,
			campaignChannel: marketingCampaigns.channel,
		})
		.from(marketingMessages)
		.leftJoin(
			marketingCampaigns,
			eq(marketingMessages.campaignId, marketingCampaigns.id),
		)
		.where(
			and(
				inArray(marketingMessages.status, DELIVERED_MESSAGE_STATUSES),
				gte(
					marketingMessages.sentAt,
					new Date(from.getTime() - ATTRIBUTION_WINDOW_MS),
				),
				lte(marketingMessages.sentAt, to),
			),
		)
		.orderBy(desc(marketingMessages.sentAt))
		.limit(ATTRIBUTION_MAX_MESSAGES)

	const byCustomer = new Map<string, AttributionMessage[]>()
	for (const row of rows) {
		if (!row.sentAt) continue
		const channel = row.campaignChannel ?? row.channel
		// Push is not attributed to orders (yet): reports name email and text.
		if (channel === 'push') continue
		const messages = byCustomer.get(row.customerId) ?? []
		// Broadcast rows keep the column default, so the campaign's channel wins.
		messages.push({ sentAt: row.sentAt.getTime(), channel })
		byCustomer.set(row.customerId, messages)
	}
	for (const messages of byCustomer.values()) {
		messages.sort((left, right) => left.sentAt - right.sentAt)
	}
	return byCustomer
}

/** Channel of the latest message in the window before `orderedAt`, if any. */
export function attributedChannel(
	messages: readonly AttributionMessage[] | undefined,
	orderedAt: Date,
): 'email' | 'sms' | 'none' {
	if (!messages) return 'none'
	const at = orderedAt.getTime()
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!
		if (message.sentAt > at) continue
		return message.sentAt >= at - ATTRIBUTION_WINDOW_MS
			? message.channel
			: 'none'
	}
	return 'none'
}

/** Consumed tab discounts keyed by tab id (minor units, items plus delivery). */
export async function loadTabDiscountCentsByTabId(
	db: TenantDatabase,
	tabIds: readonly string[],
): Promise<Map<string, number>> {
	const totals = new Map<string, number>()
	if (tabIds.length === 0) return totals
	const rows = await queryInChunks([...tabIds], (chunk) =>
		db
			.select({
				sourceId: discountRedemptions.sourceId,
				amountMinor: discountRedemptions.amountMinor,
				deliveryAmountMinor: discountRedemptions.deliveryAmountMinor,
			})
			.from(discountRedemptions)
			.where(
				and(
					eq(discountRedemptions.sourceType, 'tab'),
					eq(discountRedemptions.state, 'consumed'),
					inArray(discountRedemptions.sourceId, chunk),
				),
			),
	)
	for (const row of rows) {
		totals.set(
			row.sourceId,
			(totals.get(row.sourceId) ?? 0) +
				row.amountMinor +
				row.deliveryAmountMinor,
		)
	}
	return totals
}

/**
 * The service fee (#123) of tabs paid from the phone, keyed by tab id (minor
 * units, before tax). A tab's rounds carry none: the fee is priced when the
 * guest pays the tab, so it is stored on the tab.
 */
export async function loadTabServiceFeeCentsByTabId(
	db: TenantDatabase,
	tabIds: readonly string[],
): Promise<Map<string, number>> {
	const fees = new Map<string, number>()
	if (tabIds.length === 0) return fees
	const rows = await queryInChunks([...tabIds], (chunk) =>
		db
			.select({ id: qrTabs.id, feeCents: qrTabs.serviceFeeCents })
			.from(qrTabs)
			.where(
				and(
					eq(qrTabs.status, 'closed'),
					gt(qrTabs.serviceFeeCents, 0),
					inArray(qrTabs.id, chunk),
				),
			),
	)
	for (const row of rows) fees.set(row.id, row.feeCents)
	return fees
}

type TabRoundRow = Pick<OrderReportRow, 'id' | 'tabId' | 'createdAt'>

/** One order row per tab gets the tab's close discount in order reports. */
export function tabDiscountCentsByOrderId(
	rows: readonly TabRoundRow[],
	tabDiscounts: ReadonlyMap<string, number>,
): Map<string, number> {
	const latestByTab = new Map<string, TabRoundRow>()
	for (const row of rows) {
		if (!row.tabId) continue
		const previous = latestByTab.get(row.tabId)
		if (
			!previous ||
			(row.createdAt &&
				previous.createdAt &&
				row.createdAt > previous.createdAt)
		) {
			latestByTab.set(row.tabId, row)
		}
	}
	const byOrder = new Map<string, number>()
	for (const [tabId, order] of latestByTab) {
		const cents = tabDiscounts.get(tabId)
		if (cents && cents > 0) byOrder.set(order.id, cents)
	}
	return byOrder
}

export async function loadOrderRecords(
	db: TenantDatabase,
	orgId: string,
	subject: ReportSubject,
	definition: ReportDefinition,
	now: Date,
	maxRows = ORDER_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const fields = referencedFieldIds(subject, definition)
	const needsCustomerType = fields.has('customerType')
	const needsAttribution = fields.has('attributedChannel')
	const { rows, truncated } = await loadOrderRows(db, orgId, definition, now, {
		onlyCounted: false,
		withLines: fields.has('itemCount'),
		maxRows,
	})

	const byPhone =
		needsCustomerType || needsAttribution
			? await customerIdsByPhone(db)
			: new Map<string, string>()
	const history = needsCustomerType
		? await loadCustomerOrderHistory(db, orgId, byPhone)
		: null
	let earliest: Date | null = null
	let latest: Date | null = null
	for (const row of rows) {
		if (!row.createdAt) continue
		if (!earliest || row.createdAt < earliest) earliest = row.createdAt
		if (!latest || row.createdAt > latest) latest = row.createdAt
	}
	const messages =
		needsAttribution && earliest && latest
			? await loadAttributionMessages(db, earliest, latest)
			: null

	const tabIdsOfRows = [
		...new Set(rows.map((row) => row.tabId).filter((id): id is string => !!id)),
	]
	// A tab's service fee rides on its latest round, like its close discount.
	const tabServiceFeeByOrderId = fields.has('serviceFee')
		? tabDiscountCentsByOrderId(
				rows,
				await loadTabServiceFeeCentsByTabId(db, tabIdsOfRows),
			)
		: new Map<string, number>()
	const needsTabDiscount = fields.has('discount')
	const tabDiscountByOrderId = needsTabDiscount
		? tabDiscountCentsByOrderId(
				rows,
				await loadTabDiscountCentsByTabId(db, [
					...new Set(
						rows.map((row) => row.tabId).filter((id): id is string => !!id),
					),
				]),
			)
		: new Map<string, number>()

	const records = rows.map((row): ReportRecord => {
		const state = reportOrderStatus(row, now)
		const identity = history || messages ? orderIdentity(row, byPhone) : null
		const record: ReportRecord = {
			...orderContext(row),
			completedAt: row.completedAt,
			status: state.status,
			paymentStatus: state.paymentStatus,
			countsTowardSales: orderCountsTowardSales(row),
			paymentMethod: row.paymentMethod,
			timing: row.scheduledFor ? 'scheduled' : 'asap',
			customerName: row.contactName,
			customerPhone: row.contactPhone,
			customerEmail: row.contactEmail ?? '',
			total: row.totalCents / 100,
			subtotal: row.subtotalCents / 100,
			tax: row.taxCents / 100,
			tip: row.tipCents / 100,
			tipPercent: row.tipPercent,
			// Online orders carry their own fee; a tab's rides on its latest round.
			serviceFee:
				(row.serviceFeeCents + (tabServiceFeeByOrderId.get(row.id) ?? 0)) / 100,
			// The packaging or bag fee (#408), its own line: a tab round has none.
			packagingFee: row.packagingFeeCents / 100,
			deliveryFee: row.deliveryFeeCents / 100,
			// Items, delivery and loyalty on the order, plus a tab's close discount
			// on its latest round (tab redemptions, not round rows).
			discount:
				(row.discountCents +
					row.deliveryDiscountCents +
					row.loyaltyDiscountCents +
					(tabDiscountByOrderId.get(row.id) ?? 0)) /
				100,
		}
		if ('lines' in row) {
			record.itemCount = parseOrderLines(row.lines).reduce(
				(sum, line) => sum + line.quantity,
				0,
			)
		}
		if (history) {
			const firstAt = identity ? history.get(identity)?.firstAt : undefined
			record.customerType =
				firstAt && row.createdAt && row.createdAt > firstAt
					? 'returning'
					: 'new'
		}
		if (messages) {
			const customerId =
				identity && !identity.startsWith('phone:') ? identity : null
			record.attributedChannel =
				customerId && row.createdAt
					? attributedChannel(messages.get(customerId), row.createdAt)
					: 'none'
		}
		return record
	})
	return { records, truncated }
}

/** One record per order line, from orders that count toward sales. */
export async function loadOrderItemRecords(
	db: TenantDatabase,
	orgId: string,
	definition: ReportDefinition,
	now: Date,
	maxRows = ORDER_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const { rows, truncated } = await loadOrderRows(db, orgId, definition, now, {
		onlyCounted: true,
		withLines: true,
		maxRows,
	})
	const records: ReportRecord[] = []
	for (const row of rows) {
		const context = orderContext(row)
		for (const line of parseOrderLines(row.lines)) {
			records.push({
				...context,
				itemName: line.itemName,
				quantity: line.quantity,
				sales: line.totalCents / 100,
			})
		}
	}
	return { records, truncated }
}

/** One record per chosen option, from orders that count toward sales. */
export async function loadOrderOptionRecords(
	db: TenantDatabase,
	orgId: string,
	definition: ReportDefinition,
	now: Date,
	maxRows = ORDER_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const { rows, truncated } = await loadOrderRows(db, orgId, definition, now, {
		onlyCounted: true,
		withLines: true,
		maxRows,
	})
	const records: ReportRecord[] = []
	for (const row of rows) {
		const context = orderContext(row)
		for (const line of parseOrderLines(row.lines)) {
			// Option prices and quantities are per unit of the item they're on.
			for (const option of line.options) {
				records.push({
					...context,
					itemName: line.itemName,
					groupName: option.groupName,
					optionName: option.optionName,
					quantity: option.quantity * line.quantity,
					sales: (option.totalCents * line.quantity) / 100,
				})
			}
		}
	}
	return { records, truncated }
}

export async function loadTextSubscriberRecords(
	db: TenantDatabase,
): Promise<ReportRecord[]> {
	const rows = await db
		.select({
			subscribedAt: customerSubscriptions.subscribedAt,
			unsubscribedAt: customerSubscriptions.unsubscribedAt,
			source: customerSubscriptions.source,
			topic: customerSubscriptions.topic,
			customerName: customers.name,
			customerPhone: customers.phone,
		})
		.from(customerSubscriptions)
		.innerJoin(customers, eq(customerSubscriptions.customerId, customers.id))
		.where(eq(customerSubscriptions.channel, 'sms'))
	return rows.map((row) => ({
		subscribedAt: row.subscribedAt,
		unsubscribedAt: row.unsubscribedAt,
		status: row.unsubscribedAt ? 'unsubscribed' : 'subscribed',
		source: row.source,
		topic: row.topic,
		customerName: row.customerName,
		customerPhone: row.customerPhone ?? '',
	}))
}

/** Customer fields computed from orders; reading them needs order access. */
export function customerOrderFieldIds(subject: ReportSubject) {
	return new Set(
		subject.fields
			.filter((field) => field.requiresSubject === 'orders')
			.map((field) => field.id),
	)
}

export async function loadCustomerRecords(
	db: TenantDatabase,
	orgId: string,
	subject: ReportSubject,
	definition: ReportDefinition,
): Promise<ReportRecord[]> {
	const fields = referencedFieldIds(subject, definition)
	const orderFields = customerOrderFieldIds(subject)
	const needsOrders = [...fields].some((id) => orderFields.has(id))

	const rows = await db
		.select({
			id: customers.id,
			createdAt: customers.createdAt,
			phoneVerified: customers.phoneVerified,
			email: customers.email,
			name: customers.name,
			phone: customers.phone,
		})
		.from(customers)

	const textSubscribers = fields.has('textSubscriber')
		? new Set(
				(
					await db
						.select({ customerId: customerSubscriptions.customerId })
						.from(customerSubscriptions)
						.where(
							and(
								eq(customerSubscriptions.channel, 'sms'),
								isNull(customerSubscriptions.unsubscribedAt),
							),
						)
				).map((row) => row.customerId),
			)
		: null

	let history: Map<string, CustomerOrderHistory> | null = null
	let orgCurrency = ''
	if (needsOrders) {
		const byPhone = new Map<string, string>()
		for (const row of rows) {
			const key = phoneKey(row.phone)
			if (key) byPhone.set(key, row.id)
		}
		history = await loadCustomerOrderHistory(db, orgId, byPhone)
		const currencies = new Map<string, number>()
		for (const entry of history.values()) {
			if (!entry.currency) continue
			currencies.set(entry.currency, (currencies.get(entry.currency) ?? 0) + 1)
		}
		orgCurrency =
			[...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
	}

	return rows.map((row): ReportRecord => {
		const record: ReportRecord = {
			createdAt: row.createdAt,
			phoneVerified: Boolean(row.phoneVerified),
			hasEmail: Boolean(row.email && row.email.length > 0),
			email: row.email ?? '',
			name: row.name ?? '',
			phone: row.phone ?? '',
		}
		if (textSubscribers) record.textSubscriber = textSubscribers.has(row.id)
		if (history) {
			const orders = history.get(row.id)
			record.hasOrdered = Boolean(orders)
			record.orderCount = orders?.orders ?? 0
			record.totalSpent = (orders?.spentCents ?? 0) / 100
			record.firstOrderAt = orders?.firstAt ?? null
			record.lastOrderAt = orders?.lastAt ?? null
			record.firstOrderSource = orders?.firstSource ?? 'none'
			record.currency = orders?.currency || orgCurrency
		}
		return record
	})
}
