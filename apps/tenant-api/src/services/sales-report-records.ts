import { getLocalizedMenuValue } from '@repo/common/menu-types'
import {
	orderCancelGroup,
	posOrderCountsAsSale,
	posSaleMoney,
	posSalesChannel,
	posTender,
	refundShares,
	restaurantSaleMoney,
	restaurantSalesChannel,
	splitMinor,
	type SaleMoney,
	type SalesTender,
} from '@repo/common/sales-report-facts'
import {
	type ReportDefinition,
	type ReportRecord,
	type ReportSubject,
	referencedFieldIds,
	resolveTimeframeRange,
} from '@repo/reports'
import { isValidTimeZone } from '@repo/reservations'
import {
	orderProblemReplies,
	orderProblems,
	posOrders,
	posPayments,
	qrTabRefunds,
	qrTabs,
	restaurantOrderRefunds,
	restaurantOrders,
	rsvLocationSettings,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import {
	countedOrderCondition,
	customerIdsByPhone,
	loadCustomerOrderHistory,
	loadTabDiscountCentsByTabId,
	loadTabServiceFeeCentsByTabId,
	orderIdentity,
	tabDiscountCentsByOrderId,
	type LoadedRecords,
} from './report-records.ts'

/**
 * The sales, refunds and cancelled-orders report subjects (#84, #228).
 *
 * One row per closed sale from any channel: web and QR orders
 * (`restaurant_orders`) and Station sales (`pos_orders`). What counts, and
 * what the money figures mean, is decided in
 * `@repo/common/sales-report-facts`, the same rules the items-sold reader
 * (`item-sales.ts`) uses:
 *
 * - a web or QR order counts once it is open or completed and payable
 *   (`countedOrderCondition`); a Station sale counts when paid or refunded;
 * - the rounds of a QR tab closed at the counter and rung up on a Station
 *   till are left out, because that till sale is the same food;
 * - a sale voided at the till is its own row with nothing but the voided
 *   count and amount, so it is in no sales total;
 * - a refund is its own row, dated when the money went back, that takes its
 *   share off net sales, tax and tips;
 * - a sale paid with more than one tender is one row per tender, with the
 *   money split in proportion and the sale counted once (on the largest
 *   tender), so sums by tender are what each tender took;
 * - amounts are per currency and never added across currencies (the engine
 *   splits a grouped report by currency).
 *
 * Only the timeframe and the token's locations narrow the queries; filters
 * run in the engine. No guest contact data is read except the name on a
 * cancelled order, and only when the report asks for it (the route has
 * already checked the customers grant).
 */

/** Most recent rows of each kind (web orders, till sales, refunds) one run reads. */
export const SALES_REPORT_MAX_ROWS = 50_000

export type SalesReportContext = {
	db: TenantDatabase
	orgId: string
	/** Locations the token is limited to; `null` is every location. */
	locationIds: readonly string[] | null
	now: Date
}

type Window = { startMs: number | null; endMs: number }

function windowOf(definition: ReportDefinition, now: Date): Window {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	return {
		startMs: range.start ? range.start.getTime() : null,
		endMs: range.end.getTime(),
	}
}

/** `expression` (epoch, in `unitMs` milliseconds per unit) inside the window. */
function inWindow(expression: SQL, window: Window, unitMs: number): SQL[] {
	const conditions: SQL[] = [
		sql`${expression} <= ${Math.floor(window.endMs / unitMs)}`,
	]
	if (window.startMs !== null) {
		conditions.push(
			sql`${expression} >= ${Math.floor(window.startMs / unitMs)}`,
		)
	}
	return conditions
}

/** A location limit as a WHERE clause; no clause when every location is allowed. */
function locationCondition(
	column:
		| typeof restaurantOrders.locationId
		| typeof posOrders.locationId
		| typeof qrTabs.locationId
		| typeof orderProblems.locationId,
	locationIds: readonly string[] | null,
): SQL[] {
	if (locationIds === null) return []
	return [
		// bounded: analytics token locationIds mirror control-plane locations (well under 100).
		inArray(column, [...locationIds]),
	]
}

/** A token limited to no location reads nothing. */
function noLocations(ctx: SalesReportContext) {
	return ctx.locationIds !== null && ctx.locationIds.length === 0
}

// Rounds of a tab rung up on a Station till are read as that till sale.
const notRungUpOnStation = () =>
	or(isNull(qrTabs.id), eq(qrTabs.rungUpOnStation, false))!

function localized(value: unknown): string {
	return typeof value === 'string' ? getLocalizedMenuValue(value) : ''
}

const major = (minor: number) => minor / 100

function keep<T>(rows: T[], maxRows: number) {
	const truncated = rows.length > maxRows
	return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated }
}

/**
 * Each location's time zone: its Reservations setting when it has one (the
 * only per-location zone the region keeps), else whatever zone its orders
 * carry. Sales at a location with neither are cut in the report's own zone.
 */
async function loadLocationZones(
	db: TenantDatabase,
	locationIds: readonly string[],
): Promise<Map<string, string>> {
	const zones = new Map<string, string>()
	if (locationIds.length === 0) return zones
	const rows = await queryInChunks([...locationIds], (chunk) =>
		db
			.select({
				locationId: rsvLocationSettings.locationId,
				timeZone: rsvLocationSettings.timeZone,
			})
			.from(rsvLocationSettings)
			.where(inArray(rsvLocationSettings.locationId, chunk)),
	)
	for (const row of rows) {
		if (isValidTimeZone(row.timeZone)) zones.set(row.locationId, row.timeZone)
	}
	return zones
}

class ZoneBook {
	private readonly seen = new Map<string, string>()
	constructor(private readonly stored: Map<string, string>) {}

	/** Remembers a zone an order of this location carried. */
	note(locationId: string, ...zones: Array<string | null | undefined>) {
		if (this.seen.has(locationId)) return
		for (const zone of zones) {
			if (zone && isValidTimeZone(zone)) {
				this.seen.set(locationId, zone)
				return
			}
		}
	}

	of(locationId: string, ...own: Array<string | null | undefined>): string {
		for (const zone of own) {
			if (zone && isValidTimeZone(zone)) return zone
		}
		return this.stored.get(locationId) ?? this.seen.get(locationId) ?? ''
	}
}

const webSaleColumns = {
	id: restaurantOrders.id,
	number: restaurantOrders.number,
	customerId: restaurantOrders.customerId,
	contactPhone: restaurantOrders.contactPhone,
	paymentMethod: restaurantOrders.paymentMethod,
	fulfillment: restaurantOrders.fulfillment,
	locationId: restaurantOrders.locationId,
	locationName: restaurantOrders.locationName,
	locationTimezone: restaurantOrders.locationTimezone,
	pickupTimezone: restaurantOrders.pickupTimezone,
	dropId: restaurantOrders.dropId,
	source: restaurantOrders.source,
	tabId: restaurantOrders.tabId,
	scheduledFor: restaurantOrders.scheduledFor,
	completedAt: restaurantOrders.completedAt,
	createdAt: restaurantOrders.createdAt,
	currency: restaurantOrders.currency,
	subtotalCents: restaurantOrders.subtotalCents,
	taxCents: restaurantOrders.taxCents,
	deliveryFeeCents: restaurantOrders.deliveryFeeCents,
	tipCents: restaurantOrders.tipCents,
	serviceFeeCents: restaurantOrders.serviceFeeCents,
	serviceFeeTaxCents: restaurantOrders.serviceFeeTaxCents,
	packagingFeeCents: restaurantOrders.packagingFeeCents,
	packagingFeeTaxCents: restaurantOrders.packagingFeeTaxCents,
	totalCents: restaurantOrders.totalCents,
	discountCents: restaurantOrders.discountCents,
	deliveryDiscountCents: restaurantOrders.deliveryDiscountCents,
	loyaltyDiscountCents: restaurantOrders.loyaltyDiscountCents,
	giftCardCents: restaurantOrders.giftCardCents,
	refundedCents: restaurantOrders.refundedCents,
	refundReversedCents: restaurantOrders.refundReversedCents,
	taxExemptRef: restaurantOrders.taxExemptRef,
}

type WebSaleRow = Pick<
	typeof restaurantOrders.$inferSelect,
	keyof typeof webSaleColumns
>

const posSaleColumns = {
	id: posOrders.id,
	number: posOrders.number,
	status: posOrders.status,
	orderType: posOrders.orderType,
	orderSource: posOrders.orderSource,
	pickupAt: posOrders.pickupAt,
	pickupTimeZone: posOrders.pickupTimeZone,
	staffId: posOrders.staffId,
	staffName: posOrders.staffName,
	locationId: posOrders.locationId,
	locationName: posOrders.locationName,
	currency: posOrders.currency,
	taxInclusive: posOrders.taxInclusive,
	subtotalCents: posOrders.subtotalCents,
	adjustmentCents: posOrders.adjustmentCents,
	taxCents: posOrders.taxCents,
	tipCents: posOrders.tipCents,
	totalCents: posOrders.totalCents,
	adjustments: posOrders.adjustments,
	serviceChargeCents: posOrders.serviceChargeCents,
	taxExemptRef: posOrders.taxExemptRef,
	rungUpAt: posOrders.rungUpAt,
}

type PosSaleRow = Pick<
	typeof posOrders.$inferSelect,
	keyof typeof posSaleColumns
>

/** When a web or QR order was fulfilled: scheduled, else completed, else placed. */
function webFulfilledAt(row: {
	scheduledFor: Date | null
	completedAt: Date | null
	createdAt: Date | null
}) {
	return row.scheduledFor ?? row.completedAt ?? row.createdAt
}

/** The same rule as {@link webFulfilledAt}, in SQL (epoch seconds). */
const WEB_FULFILLED_AT = sql`coalesce(${restaurantOrders.scheduledFor}, ${restaurantOrders.completedAt}, ${restaurantOrders.createdAt})`

/** When a Station sale was fulfilled: its pickup time (a phone order), else when it was rung up. */
const POS_FULFILLED_AT = sql`coalesce(${posOrders.pickupAt}, ${posOrders.rungUpAt})`

const ZERO_MONEY = {
	grossSales: 0,
	discounts: 0,
	loyaltyRewards: 0,
	cashDiscounts: 0,
	tax: 0,
	tips: 0,
	serviceCharges: 0,
	taxExemptSales: 0,
	refunds: 0,
	netSales: 0,
	collected: 0,
	saleCount: 0,
	voidCount: 0,
	voidAmount: 0,
}

/**
 * The rows of one sale: one per tender it was paid with. The money is split
 * in proportion to what each tender took (shares add up exactly) and the sale
 * is counted on the largest.
 */
function saleRows(
	base: ReportRecord,
	money: SaleMoney,
	tenders: ReadonlyArray<{ tender: SalesTender; amountMinor: number }>,
	serviceChargeMinor = 0,
): ReportRecord[] {
	const parts = tenders.filter((part) => part.amountMinor > 0)
	if (parts.length === 0) parts.push({ tender: 'none', amountMinor: 0 })
	const weights = parts.map((part) => part.amountMinor)
	const share = (minor: number) => splitMinor(minor, weights)
	const gross = share(money.grossMinor)
	const discount = share(money.discountMinor)
	const loyalty = share(money.loyaltyMinor)
	const cashDiscount = share(money.cashDiscountMinor)
	const tax = share(money.taxMinor)
	const tip = share(money.tipMinor)
	const serviceCharges = share(serviceChargeMinor)
	const net = share(money.netMinor)
	const total = share(money.totalMinor)
	const largest = weights.indexOf(Math.max(...weights))
	return parts.map((part, index) => ({
		...base,
		...ZERO_MONEY,
		entry: 'sale',
		tender: part.tender,
		grossSales: major(gross[index] ?? 0),
		discounts: major(discount[index] ?? 0),
		loyaltyRewards: major(loyalty[index] ?? 0),
		cashDiscounts: major(cashDiscount[index] ?? 0),
		tax: major(tax[index] ?? 0),
		tips: major(tip[index] ?? 0),
		serviceCharges: major(serviceCharges[index] ?? 0),
		taxExemptSales: base.taxExempt ? major(net[index] ?? 0) : 0,
		netSales: major(net[index] ?? 0),
		collected: major(total[index] ?? 0),
		saleCount: index === largest ? 1 : 0,
	}))
}

/** A refund's row: dated when the money went back, against the sale's own money. */
function refundRow(
	base: ReportRecord,
	refundedAt: Date,
	amountMinor: number,
	tender: SalesTender,
	sale: SaleMoney,
): ReportRecord {
	const shares = refundShares(amountMinor, sale)
	return {
		...base,
		...ZERO_MONEY,
		entry: 'refund',
		occurredAt: refundedAt,
		fulfilledAt: refundedAt,
		tender,
		refunds: major(amountMinor),
		netSales: -major(shares.netMinor),
		tax: -major(shares.taxMinor),
		tips: -major(shares.tipMinor),
		collected: -major(amountMinor),
	}
}

function webBase(
	row: WebSaleRow,
	zones: ZoneBook,
	customerType: string | undefined,
): ReportRecord {
	const refunded = row.refundedCents - row.refundReversedCents
	return {
		occurredAt: row.createdAt,
		fulfilledAt: webFulfilledAt(row),
		location: localized(row.locationName),
		locationId: row.locationId,
		locationTimeZone: zones.of(
			row.locationId,
			row.locationTimezone,
			row.pickupTimezone,
		),
		channel: restaurantSalesChannel(row),
		fulfillment: row.fulfillment,
		staffName: 'Online',
		status:
			row.totalCents > 0 && refunded >= row.totalCents ? 'refunded' : 'paid',
		orderNumber: row.number,
		taxExempt: Boolean(row.taxExemptRef),
		// Orders store lower-case codes; everything else is upper case.
		currency: row.currency.toUpperCase(),
		...(customerType ? { customerType } : {}),
	}
}

function posBase(row: PosSaleRow, zones: ZoneBook): ReportRecord {
	return {
		occurredAt: new Date(row.rungUpAt),
		fulfilledAt: new Date(row.pickupAt ?? row.rungUpAt),
		location: row.locationName ?? '',
		locationId: row.locationId,
		locationTimeZone: zones.of(row.locationId, row.pickupTimeZone),
		channel: posSalesChannel(row.orderSource),
		fulfillment: row.orderType,
		staffName: row.staffName || 'Not signed in',
		status:
			row.status === 'void'
				? 'voided'
				: row.status === 'refunded'
					? 'refunded'
					: 'paid',
		orderNumber: row.number,
		taxExempt: Boolean(row.taxExemptRef),
		currency: row.currency.toUpperCase(),
		customerType: 'station',
	}
}

/**
 * Tab totals that ride on a tab's latest round, like its close discount in
 * the order reports: the tip and service fee of a tab paid from the phone.
 */
async function loadTabTipCentsByTabId(
	db: TenantDatabase,
	tabIds: readonly string[],
): Promise<Map<string, number>> {
	const tips = new Map<string, number>()
	if (tabIds.length === 0) return tips
	const rows = await queryInChunks([...tabIds], (chunk) =>
		db
			.select({ id: qrTabs.id, tipCents: qrTabs.tipCents })
			.from(qrTabs)
			.where(and(eq(qrTabs.status, 'closed'), inArray(qrTabs.id, chunk))),
	)
	for (const row of rows) if (row.tipCents > 0) tips.set(row.id, row.tipCents)
	return tips
}

/** Web and QR order money with its tab's close discount, service fee and tip added. */
function webMoney(
	row: WebSaleRow,
	extra: { discount: number; serviceFee: number; tip: number },
): SaleMoney {
	const money = restaurantSaleMoney(row)
	if (!extra.discount && !extra.serviceFee && !extra.tip) return money
	// A tab's discount comes off what its rounds came to; never below nothing.
	const discount = Math.min(extra.discount, money.netMinor)
	return {
		...money,
		grossMinor: money.grossMinor + extra.serviceFee,
		discountMinor: money.discountMinor + discount,
		netMinor: money.netMinor - discount + extra.serviceFee,
		tipMinor: money.tipMinor + extra.tip,
		totalMinor: money.totalMinor - discount + extra.serviceFee + extra.tip,
	}
}

function webTenders(row: WebSaleRow, money: SaleMoney) {
	const giftCard = Math.min(Math.max(0, row.giftCardCents), money.totalMinor)
	return [
		{ tender: 'gift_card' as const, amountMinor: giftCard },
		{
			tender:
				row.paymentMethod === 'handoff'
					? ('handoff' as const)
					: ('card_online' as const),
			amountMinor: money.totalMinor - giftCard,
		},
	]
}

export async function loadSalesRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (noLocations(ctx)) return { records: [], truncated: false }
	const { db, orgId, locationIds } = ctx
	const window = windowOf(definition, ctx.now)
	const byFulfilment = definition.timeBasis === 'fulfillment'
	const fields = referencedFieldIds(subject, definition)

	// 1. Web and QR orders that count toward sales.
	const webTime = byFulfilment
		? WEB_FULFILLED_AT
		: sql`${restaurantOrders.createdAt}`
	const web = keep(
		await db
			.select(webSaleColumns)
			.from(restaurantOrders)
			.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					countedOrderCondition(),
					notRungUpOnStation(),
					...inWindow(webTime, window, 1000),
					...locationCondition(restaurantOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(webTime))
			.limit(maxRows + 1),
		maxRows,
	)

	// 2. Station sales: closed ones, and the ones voided at the till.
	const posTime = byFulfilment ? POS_FULFILLED_AT : sql`${posOrders.rungUpAt}`
	const pos = keep(
		await db
			.select(posSaleColumns)
			.from(posOrders)
			.where(
				and(
					inArray(posOrders.status, ['paid', 'refunded', 'void']),
					...inWindow(posTime, window, 1),
					...locationCondition(posOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(posTime))
			.limit(maxRows + 1),
		maxRows,
	)

	// 3. Refunds, by the day the money went back, whenever the sale was.
	const refundTime = sql`coalesce(${restaurantOrderRefunds.settledAt}, ${restaurantOrderRefunds.createdAt})`
	const webRefunds = keep(
		await db
			.select({
				amountCents: restaurantOrderRefunds.amountCents,
				kind: restaurantOrderRefunds.kind,
				settledAt: restaurantOrderRefunds.settledAt,
				refundCreatedAt: restaurantOrderRefunds.createdAt,
				...webSaleColumns,
			})
			.from(restaurantOrderRefunds)
			.innerJoin(
				restaurantOrders,
				eq(restaurantOrders.id, restaurantOrderRefunds.orderId),
			)
			.leftJoin(qrTabs, eq(qrTabs.id, restaurantOrders.tabId))
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					eq(restaurantOrderRefunds.status, 'succeeded'),
					// A refund the provider took back later never left the till.
					isNull(restaurantOrderRefunds.reversedAt),
					// A cancelled order was never a sale, so its refund lowers none.
					countedOrderCondition(),
					notRungUpOnStation(),
					...inWindow(refundTime, window, 1),
					...locationCondition(restaurantOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(refundTime))
			.limit(maxRows + 1),
		maxRows,
	)
	const posRefunds = keep(
		await db
			.select({
				amountCents: posPayments.amountCents,
				method: posPayments.method,
				paidAt: posPayments.paidAt,
				refundStaffName: posPayments.staffName,
				...posSaleColumns,
			})
			.from(posPayments)
			.innerJoin(posOrders, eq(posOrders.id, posPayments.orderId))
			.where(
				and(
					eq(posPayments.kind, 'refund'),
					...inWindow(sql`${posPayments.paidAt}`, window, 1),
					...locationCondition(posOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(posPayments.paidAt))
			.limit(maxRows + 1),
		maxRows,
	)

	// Refunds of a tab paid from the phone (its rounds are the sales above).
	const tabRefundTime = sql`coalesce(${qrTabRefunds.settledAt}, ${qrTabRefunds.createdAt})`
	const tabRefunds = keep(
		await db
			.select({
				amountCents: qrTabRefunds.amountCents,
				settledAt: qrTabRefunds.settledAt,
				refundCreatedAt: qrTabRefunds.createdAt,
				tabNumber: qrTabs.tabNumber,
				locationId: qrTabs.locationId,
				currency: qrTabs.currency,
				taxCents: qrTabs.taxCents,
				tipCents: qrTabs.tipCents,
				totalCents: qrTabs.totalCents,
			})
			.from(qrTabRefunds)
			.innerJoin(qrTabs, eq(qrTabs.id, qrTabRefunds.tabId))
			.where(
				and(
					eq(qrTabRefunds.status, 'succeeded'),
					isNull(qrTabRefunds.reversedAt),
					eq(qrTabs.rungUpOnStation, false),
					...inWindow(tabRefundTime, window, 1),
					...locationCondition(qrTabs.locationId, locationIds),
				),
			)
			.orderBy(desc(tabRefundTime))
			.limit(maxRows + 1),
		maxRows,
	)

	// What each closed till sale was paid with.
	const closedIds = pos.rows
		.filter((row) => posOrderCountsAsSale(row.status))
		.map((row) => row.id)
	const payments = await queryInChunks(closedIds, (chunk) =>
		db
			.select({
				orderId: posPayments.orderId,
				method: posPayments.method,
				amountCents: posPayments.amountCents,
			})
			.from(posPayments)
			.where(
				and(
					eq(posPayments.kind, 'payment'),
					inArray(posPayments.orderId, chunk),
				),
			),
	)
	const paidBy = new Map<string, Map<SalesTender, number>>()
	for (const payment of payments) {
		const tenders =
			paidBy.get(payment.orderId) ?? new Map<SalesTender, number>()
		const tender = posTender(payment.method)
		tenders.set(tender, (tenders.get(tender) ?? 0) + payment.amountCents)
		paidBy.set(payment.orderId, tenders)
	}

	const webRows = [...web.rows, ...webRefunds.rows]
	const zones = new ZoneBook(
		await loadLocationZones(db, [
			...new Set(
				[...webRows, ...pos.rows, ...posRefunds.rows, ...tabRefunds.rows].map(
					(row) => row.locationId,
				),
			),
		]),
	)
	const locationNames = new Map<string, string>()
	for (const row of webRows) {
		zones.note(row.locationId, row.locationTimezone, row.pickupTimezone)
		locationNames.set(row.locationId, localized(row.locationName))
	}

	// A tab's close discount, service fee and tip ride on its latest round.
	const tabIds = [
		...new Set(
			web.rows.map((row) => row.tabId).filter((id): id is string => !!id),
		),
	]
	const tabDiscounts = tabDiscountCentsByOrderId(
		web.rows,
		await loadTabDiscountCentsByTabId(db, tabIds),
	)
	const tabServiceFees = tabDiscountCentsByOrderId(
		web.rows,
		await loadTabServiceFeeCentsByTabId(db, tabIds),
	)
	const tabTips = tabDiscountCentsByOrderId(
		web.rows,
		await loadTabTipCentsByTabId(db, tabIds),
	)
	const moneyOf = (row: WebSaleRow) =>
		webMoney(row, {
			discount: tabDiscounts.get(row.id) ?? 0,
			serviceFee: tabServiceFees.get(row.id) ?? 0,
			tip: tabTips.get(row.id) ?? 0,
		})

	// First-time or returning, only when the report reads it.
	const needsCustomerType = fields.has('customerType')
	const byPhone = needsCustomerType
		? await customerIdsByPhone(db)
		: new Map<string, string>()
	const history = needsCustomerType
		? await loadCustomerOrderHistory(db, orgId, byPhone)
		: null
	const customerTypeOf = (row: WebSaleRow) => {
		if (!history) return undefined
		const identity = orderIdentity(row, byPhone)
		const firstAt = identity ? history.get(identity)?.firstAt : undefined
		return firstAt && row.createdAt && row.createdAt > firstAt
			? 'returning'
			: 'new'
	}

	const records: ReportRecord[] = []
	for (const row of web.rows) {
		const money = moneyOf(row)
		const serviceChargeMinor =
			(row.serviceFeeCents ?? 0) + (tabServiceFees.get(row.id) ?? 0)
		records.push(
			...saleRows(
				webBase(row, zones, customerTypeOf(row)),
				money,
				webTenders(row, money),
				serviceChargeMinor,
			),
		)
	}
	for (const row of pos.rows) {
		const base = posBase(row, zones)
		if (row.status === 'void') {
			records.push({
				...base,
				...ZERO_MONEY,
				entry: 'void',
				tender: 'none',
				voidCount: 1,
				voidAmount: major(row.totalCents),
			})
			continue
		}
		const money = posSaleMoney(row)
		const tenders = [...(paidBy.get(row.id) ?? new Map<SalesTender, number>())]
		records.push(
			...saleRows(
				base,
				money,
				tenders.map(([tender, amountMinor]) => ({ tender, amountMinor })),
				row.serviceChargeCents ?? 0,
			),
		)
	}
	for (const row of webRefunds.rows) {
		records.push(
			refundRow(
				webBase(row, zones, customerTypeOf(row)),
				new Date(row.settledAt ?? row.refundCreatedAt),
				row.amountCents,
				// A provider refund went back to the card; a recorded one was
				// handed back the way the order was paid.
				row.kind === 'provider' || row.paymentMethod !== 'handoff'
					? 'card_online'
					: 'handoff',
				// The order's own money: a tab's extras are refunded on the tab.
				restaurantSaleMoney(row),
			),
		)
	}
	for (const row of tabRefunds.rows) {
		const refundedAt = new Date(row.settledAt ?? row.refundCreatedAt)
		records.push(
			refundRow(
				{
					location: locationNames.get(row.locationId) ?? '',
					locationId: row.locationId,
					locationTimeZone: zones.of(row.locationId),
					channel: 'qr_table',
					fulfillment: 'dine_in',
					staffName: 'Online',
					status: 'paid',
					orderNumber: row.tabNumber,
					currency: row.currency.toUpperCase(),
					...(history ? { customerType: 'new' } : {}),
				},
				refundedAt,
				row.amountCents,
				'card_online',
				{
					netMinor: Math.max(0, row.totalCents - row.taxCents - row.tipCents),
					taxMinor: row.taxCents,
					tipMinor: row.tipCents,
					grossMinor: 0,
					discountMinor: 0,
					loyaltyMinor: 0,
					cashDiscountMinor: 0,
					totalMinor: row.totalCents,
				},
			),
		)
	}
	for (const row of posRefunds.rows) {
		records.push(
			refundRow(
				{
					...posBase(row, zones),
					staffName: row.refundStaffName || row.staffName || 'Not signed in',
				},
				new Date(row.paidAt),
				row.amountCents,
				posTender(row.method),
				posSaleMoney(row),
			),
		)
	}

	return {
		records,
		truncated:
			web.truncated ||
			pos.truncated ||
			webRefunds.truncated ||
			tabRefunds.truncated ||
			posRefunds.truncated,
	}
}

/** A machine reason as words ("guest_request" reads "Guest request"). */
function words(value: string | null | undefined): string {
	if (!value) return ''
	const text = value.replaceAll('_', ' ').trim()
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Who gave a refund, without a name the region does not hold. An operator's
 * refund carries the member's user id as `member:<id>`; the Reports screens
 * replace it with the member's name from the control plane, so the name never
 * enters the region.
 */
function refundedBy(origin: string, actorId: string): string {
	if (origin === 'guest') return 'Guest'
	if (origin === 'system') return 'System'
	if (origin === 'station') return 'Station staff'
	return actorId && /^[\w-]{1,64}$/.test(actorId)
		? `member:${actorId}`
		: 'Team member'
}

/**
 * One record per refund that went through: web and QR order refunds
 * (`restaurant_order_refunds`), QR tab refunds (`qr_tab_refunds`) and till
 * refunds (`pos_payments` of kind `refund`). A partial refund is its own
 * record with its own amount. Pending and failed refunds, and ones the
 * provider took back, moved no money and are left out.
 */
export async function loadOrderRefundRecords(
	ctx: SalesReportContext,
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (noLocations(ctx)) return { records: [], truncated: false }
	const { db, orgId, locationIds } = ctx
	const window = windowOf(definition, ctx.now)

	const refundTime = sql`coalesce(${restaurantOrderRefunds.settledAt}, ${restaurantOrderRefunds.createdAt})`
	const web = keep(
		await db
			.select({
				amountCents: restaurantOrderRefunds.amountCents,
				kind: restaurantOrderRefunds.kind,
				full: restaurantOrderRefunds.full,
				note: restaurantOrderRefunds.note,
				origin: restaurantOrderRefunds.origin,
				actorId: restaurantOrderRefunds.actorId,
				settledAt: restaurantOrderRefunds.settledAt,
				refundCreatedAt: restaurantOrderRefunds.createdAt,
				number: restaurantOrders.number,
				paymentMethod: restaurantOrders.paymentMethod,
				locationId: restaurantOrders.locationId,
				locationName: restaurantOrders.locationName,
				locationTimezone: restaurantOrders.locationTimezone,
				pickupTimezone: restaurantOrders.pickupTimezone,
				dropId: restaurantOrders.dropId,
				source: restaurantOrders.source,
				currency: restaurantOrders.currency,
				totalCents: restaurantOrders.totalCents,
			})
			.from(restaurantOrderRefunds)
			.innerJoin(
				restaurantOrders,
				eq(restaurantOrders.id, restaurantOrderRefunds.orderId),
			)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					eq(restaurantOrderRefunds.status, 'succeeded'),
					isNull(restaurantOrderRefunds.reversedAt),
					...inWindow(refundTime, window, 1),
					...locationCondition(restaurantOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(refundTime))
			.limit(maxRows + 1),
		maxRows,
	)

	const tabRefundTime = sql`coalesce(${qrTabRefunds.settledAt}, ${qrTabRefunds.createdAt})`
	const tabs = keep(
		await db
			.select({
				amountCents: qrTabRefunds.amountCents,
				full: qrTabRefunds.full,
				note: qrTabRefunds.note,
				origin: qrTabRefunds.origin,
				actorId: qrTabRefunds.actorId,
				settledAt: qrTabRefunds.settledAt,
				refundCreatedAt: qrTabRefunds.createdAt,
				tabNumber: qrTabs.tabNumber,
				locationId: qrTabs.locationId,
				currency: qrTabs.currency,
				totalCents: qrTabs.totalCents,
			})
			.from(qrTabRefunds)
			.innerJoin(qrTabs, eq(qrTabs.id, qrTabRefunds.tabId))
			.where(
				and(
					eq(qrTabRefunds.status, 'succeeded'),
					isNull(qrTabRefunds.reversedAt),
					...inWindow(tabRefundTime, window, 1),
					...locationCondition(qrTabs.locationId, locationIds),
				),
			)
			.orderBy(desc(tabRefundTime))
			.limit(maxRows + 1),
		maxRows,
	)

	const pos = keep(
		await db
			.select({
				amountCents: posPayments.amountCents,
				method: posPayments.method,
				reason: posPayments.reason,
				paidAt: posPayments.paidAt,
				refundStaffName: posPayments.staffName,
				number: posOrders.number,
				orderSource: posOrders.orderSource,
				locationId: posOrders.locationId,
				locationName: posOrders.locationName,
				pickupTimeZone: posOrders.pickupTimeZone,
				currency: posOrders.currency,
				totalCents: posOrders.totalCents,
				refundedCents: posOrders.refundedCents,
			})
			.from(posPayments)
			.innerJoin(posOrders, eq(posOrders.id, posPayments.orderId))
			.where(
				and(
					eq(posPayments.kind, 'refund'),
					...inWindow(sql`${posPayments.paidAt}`, window, 1),
					...locationCondition(posOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(posPayments.paidAt))
			.limit(maxRows + 1),
		maxRows,
	)

	const zones = new ZoneBook(
		await loadLocationZones(db, [
			...new Set(
				[...web.rows, ...tabs.rows, ...pos.rows].map((row) => row.locationId),
			),
		]),
	)
	const names = new Map<string, string>()
	for (const row of web.rows) {
		zones.note(row.locationId, row.locationTimezone, row.pickupTimezone)
		names.set(row.locationId, localized(row.locationName))
	}
	for (const row of pos.rows) {
		if (row.locationName && !names.has(row.locationId)) {
			names.set(row.locationId, row.locationName)
		}
	}

	const records: ReportRecord[] = []
	for (const row of web.rows) {
		records.push({
			refundedAt: new Date(row.settledAt ?? row.refundCreatedAt),
			location: localized(row.locationName),
			locationId: row.locationId,
			locationTimeZone: zones.of(
				row.locationId,
				row.locationTimezone,
				row.pickupTimezone,
			),
			orderNumber: row.number,
			channel: restaurantSalesChannel(row),
			paymentMethod:
				row.kind === 'provider' || row.paymentMethod !== 'handoff'
					? 'card_online'
					: 'handoff',
			amount: major(row.amountCents),
			originalTotal: major(row.totalCents),
			extent: row.full ? 'full' : 'partial',
			refundedBy: refundedBy(row.origin, row.actorId),
			reason: row.note?.trim() || 'No reason given',
			currency: row.currency.toUpperCase(),
		})
	}
	for (const row of tabs.rows) {
		records.push({
			refundedAt: new Date(row.settledAt ?? row.refundCreatedAt),
			location: names.get(row.locationId) ?? '',
			locationId: row.locationId,
			locationTimeZone: zones.of(row.locationId),
			orderNumber: row.tabNumber,
			channel: 'qr_table',
			paymentMethod: 'card_online',
			amount: major(row.amountCents),
			originalTotal: major(row.totalCents),
			extent: row.full ? 'full' : 'partial',
			refundedBy: refundedBy(row.origin, row.actorId),
			reason: row.note?.trim() || 'No reason given',
			currency: row.currency.toUpperCase(),
		})
	}
	for (const row of pos.rows) {
		records.push({
			refundedAt: new Date(row.paidAt),
			location: row.locationName ?? names.get(row.locationId) ?? '',
			locationId: row.locationId,
			locationTimeZone: zones.of(row.locationId, row.pickupTimeZone),
			orderNumber: row.number,
			channel: posSalesChannel(row.orderSource),
			paymentMethod: posTender(row.method),
			amount: major(row.amountCents),
			originalTotal: major(row.totalCents),
			extent:
				row.totalCents > 0 && row.refundedCents >= row.totalCents
					? 'full'
					: 'partial',
			// The staff member's name as the till recorded it (staff, not a guest).
			refundedBy: row.refundStaffName || 'Station staff',
			reason: words(row.reason) || 'No reason given',
			currency: row.currency.toUpperCase(),
		})
	}
	return {
		records,
		truncated: web.truncated || tabs.truncated || pos.truncated,
	}
}

type PosLineVoid = {
	name: string
	quantity: number
	unitCents: number
	at: Date | null
	staffName: string
	reason: string
}

/** The stored `lineVoids` JSON, read defensively; malformed entries are skipped. */
export function parsePosLineVoids(raw: unknown): PosLineVoid[] {
	let value = raw
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const voids: PosLineVoid[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue
		const item = entry as Record<string, unknown>
		const quantity =
			typeof item.quantity === 'number' && item.quantity > 0
				? Math.floor(item.quantity)
				: 0
		if (quantity === 0 || typeof item.name !== 'string') continue
		const at = typeof item.at === 'string' ? new Date(item.at) : null
		const by =
			item.by && typeof item.by === 'object'
				? (item.by as { name?: unknown }).name
				: null
		voids.push({
			name: item.name,
			quantity,
			unitCents:
				typeof item.unitCents === 'number' && Number.isFinite(item.unitCents)
					? Math.max(0, Math.trunc(item.unitCents))
					: 0,
			at: at && !Number.isNaN(at.getTime()) ? at : null,
			staffName: typeof by === 'string' ? by : '',
			reason: typeof item.reason === 'string' ? item.reason : '',
		})
	}
	return voids
}

const POS_VOID_REASONS = new Set([
	'mistake',
	'guest_request',
	'out_of_stock',
	'quality',
	'wrong_charge',
	'other',
])

/** A till reason as the report's reason value; free text reads as "other". */
function posReason(value: string | null | undefined) {
	if (!value) return 'none'
	return POS_VOID_REASONS.has(value) ? value : 'other'
}

/**
 * Orders that never counted toward sales, with the reason group, and the
 * items taken off Station orders:
 *
 * - web and QR orders that were cancelled or expired, or whose payment hold
 *   lapsed (read as expired, as the orders page shows them);
 * - Station sales voided at the till;
 * - one record per item taken off a saved Station order (`lineVoids`), with
 *   the dish and the till's reason. The order itself may well have been sold;
 *   only the item is in this report.
 *
 * Dated by when the order was placed or rung up, on either time basis. The
 * guest's name is read only when the report asks for it.
 */
export async function loadCancelledOrderRecords(
	ctx: SalesReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (noLocations(ctx)) return { records: [], truncated: false }
	const { db, orgId, locationIds } = ctx
	const window = windowOf(definition, ctx.now)
	const withGuest = referencedFieldIds(subject, definition).has('guestName')
	const nowSeconds = Math.floor(ctx.now.getTime() / 1000)

	const web = keep(
		await db
			.select({
				number: restaurantOrders.number,
				status: restaurantOrders.status,
				cancelReason: restaurantOrders.cancelReason,
				cancelledBy: restaurantOrders.cancelledBy,
				rejectedReason: restaurantOrders.rejectedReason,
				cancelledAt: restaurantOrders.cancelledAt,
				createdAt: restaurantOrders.createdAt,
				locationId: restaurantOrders.locationId,
				locationName: restaurantOrders.locationName,
				locationTimezone: restaurantOrders.locationTimezone,
				pickupTimezone: restaurantOrders.pickupTimezone,
				dropId: restaurantOrders.dropId,
				source: restaurantOrders.source,
				currency: restaurantOrders.currency,
				totalCents: restaurantOrders.totalCents,
				contactName: restaurantOrders.contactName,
			})
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					or(
						inArray(restaurantOrders.status, ['cancelled', 'expired']),
						// An unpaid online order whose hold ran out, before the next
						// order write sweeps it (reports never write).
						and(
							eq(restaurantOrders.status, 'accepted'),
							eq(restaurantOrders.paymentMethod, 'online'),
							eq(restaurantOrders.paymentStatus, 'pending'),
							sql`${restaurantOrders.holdExpiresAt} < ${nowSeconds}`,
						),
					),
					...inWindow(sql`${restaurantOrders.createdAt}`, window, 1000),
					...locationCondition(restaurantOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(restaurantOrders.createdAt))
			.limit(maxRows + 1),
		maxRows,
	)

	// Voided sales, and any sale that had an item taken off.
	const pos = keep(
		await db
			.select({
				number: posOrders.number,
				status: posOrders.status,
				orderSource: posOrders.orderSource,
				voidReason: posOrders.voidReason,
				voidedByStaffName: posOrders.voidedByStaffName,
				guestName: posOrders.guestName,
				lineVoids: posOrders.lineVoids,
				locationId: posOrders.locationId,
				locationName: posOrders.locationName,
				pickupTimeZone: posOrders.pickupTimeZone,
				currency: posOrders.currency,
				totalCents: posOrders.totalCents,
				rungUpAt: posOrders.rungUpAt,
				updatedAt: posOrders.updatedAt,
			})
			.from(posOrders)
			.where(
				and(
					or(eq(posOrders.status, 'void'), sql`${posOrders.lineVoids} <> '[]'`),
					...inWindow(sql`${posOrders.rungUpAt}`, window, 1),
					...locationCondition(posOrders.locationId, locationIds),
				),
			)
			.orderBy(desc(posOrders.rungUpAt))
			.limit(maxRows + 1),
		maxRows,
	)

	const zones = new ZoneBook(
		await loadLocationZones(db, [
			...new Set([...web.rows, ...pos.rows].map((row) => row.locationId)),
		]),
	)
	for (const row of web.rows) {
		zones.note(row.locationId, row.locationTimezone, row.pickupTimezone)
	}

	const records: ReportRecord[] = []
	for (const row of web.rows) {
		const cancel = orderCancelGroup({
			...row,
			// The lapsed hold selected above is still stored as `accepted`.
			status: row.status === 'accepted' ? 'expired' : row.status,
		})
		if (!cancel) continue
		records.push({
			placedAt: row.createdAt,
			cancelledAt: row.cancelledAt,
			location: localized(row.locationName),
			locationId: row.locationId,
			locationTimeZone: zones.of(
				row.locationId,
				row.locationTimezone,
				row.pickupTimezone,
			),
			orderNumber: row.number,
			channel: restaurantSalesChannel(row),
			entry: 'order',
			reasonGroup: cancel.group,
			reason: cancel.reason,
			amount: major(row.totalCents),
			dishName: '',
			quantity: 0,
			staffName: '',
			...(withGuest ? { guestName: row.contactName } : {}),
			currency: row.currency.toUpperCase(),
		})
	}
	for (const row of pos.rows) {
		const base = {
			placedAt: new Date(row.rungUpAt),
			location: row.locationName ?? '',
			locationId: row.locationId,
			locationTimeZone: zones.of(row.locationId, row.pickupTimeZone),
			orderNumber: row.number,
			channel: posSalesChannel(row.orderSource),
			reasonGroup: 'voided_at_till',
			...(withGuest ? { guestName: row.guestName ?? '' } : {}),
			currency: row.currency.toUpperCase(),
		}
		if (row.status === 'void') {
			records.push({
				...base,
				cancelledAt: new Date(row.updatedAt),
				entry: 'order',
				reason: posReason(row.voidReason),
				amount: major(row.totalCents),
				dishName: '',
				quantity: 0,
				staffName: row.voidedByStaffName ?? '',
			})
		}
		for (const item of parsePosLineVoids(row.lineVoids)) {
			records.push({
				...base,
				cancelledAt: item.at,
				entry: 'item',
				reason: posReason(item.reason),
				amount: major(item.quantity * item.unitCents),
				dishName: item.name,
				quantity: item.quantity,
				staffName: item.staffName,
			})
		}
	}
	return { records, truncated: web.truncated || pos.truncated }
}

/**
 * Guest order problem reports (#191), one record per report
 * (`order_problems`) or per dish a report named (`order_problem_dishes`).
 * Counted by when the guest reported, never by the order's date. A record holds
 * the type, the status, the amounts and the minutes to answer: the guest's note,
 * photo and the words of the thread are never read, and an erased person's
 * report keeps its figures because those columns are all that remains of it.
 */
export async function loadOrderProblemRecords(
	ctx: SalesReportContext,
	subject: 'order_problems' | 'order_problem_dishes',
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (noLocations(ctx)) return { records: [], truncated: false }
	const { db, orgId, locationIds } = ctx
	const window = windowOf(definition, ctx.now)
	const loaded = keep(
		await db
			.select({
				id: orderProblems.id,
				kind: orderProblems.kind,
				status: orderProblems.status,
				resolution: orderProblems.resolution,
				itemRefs: orderProblems.itemRefs,
				refundCents: orderProblems.refundCents,
				creditCents: orderProblems.creditCents,
				createdAt: orderProblems.createdAt,
				resolvedAt: orderProblems.resolvedAt,
				locationId: orderProblems.locationId,
				number: restaurantOrders.number,
				locationName: restaurantOrders.locationName,
				locationTimezone: restaurantOrders.locationTimezone,
				pickupTimezone: restaurantOrders.pickupTimezone,
				currency: restaurantOrders.currency,
			})
			.from(orderProblems)
			.innerJoin(
				restaurantOrders,
				eq(restaurantOrders.id, orderProblems.orderId),
			)
			.where(
				and(
					eq(restaurantOrders.orgId, orgId),
					...inWindow(sql`${orderProblems.createdAt}`, window, 1),
					...locationCondition(orderProblems.locationId, locationIds),
				),
			)
			.orderBy(desc(orderProblems.createdAt))
			.limit(maxRows + 1),
		maxRows,
	)
	const zones = new ZoneBook(
		await loadLocationZones(db, [
			...new Set(loaded.rows.map((row) => row.locationId)),
		]),
	)
	for (const row of loaded.rows) {
		zones.note(row.locationId, row.locationTimezone, row.pickupTimezone)
	}
	// The operator's first answer, for "minutes to answer": only its time.
	const answeredAt = new Map<string, number>()
	if (subject === 'order_problems') {
		const ids = loaded.rows
			.filter((row) => row.resolvedAt != null)
			.map((row) => row.id)
		const answers = await queryInChunks(ids, (chunk) =>
			db
				.select({
					problemId: orderProblemReplies.problemId,
					at: orderProblemReplies.createdAt,
				})
				.from(orderProblemReplies)
				.where(
					and(
						inArray(orderProblemReplies.problemId, chunk),
						eq(orderProblemReplies.authorKind, 'operator'),
					),
				),
		)
		for (const answer of answers) {
			const was = answeredAt.get(answer.problemId)
			if (was === undefined || answer.at < was) {
				answeredAt.set(answer.problemId, answer.at)
			}
		}
	}

	const records: ReportRecord[] = []
	for (const row of loaded.rows) {
		const common = {
			reportedAt: new Date(row.createdAt),
			location: localized(row.locationName),
			locationId: row.locationId,
			locationTimeZone: zones.of(
				row.locationId,
				row.locationTimezone,
				row.pickupTimezone,
			),
			orderNumber: row.number,
			kind: row.kind,
			currency: row.currency.toUpperCase(),
		}
		if (subject === 'order_problems') {
			const first = answeredAt.get(row.id) ?? row.resolvedAt
			records.push({
				...common,
				status: row.status,
				resolution: row.resolution ?? 'none',
				problems: 1,
				affected: major(
					row.itemRefs.reduce((sum, item) => sum + item.amountCents, 0),
				),
				refunded: major(row.refundCents ?? 0),
				credited: major(row.creditCents ?? 0),
				minutesToAnswer:
					first != null
						? Math.max(
								0,
								Math.round(((first - row.createdAt) / 60_000) * 10) / 10,
							)
						: null,
			})
			continue
		}
		if (row.itemRefs.length === 0) {
			records.push({ ...common, dish: 'No dish named', units: 0, amount: 0 })
			continue
		}
		for (const item of row.itemRefs) {
			records.push({
				...common,
				dish: item.name,
				units: item.quantity,
				amount: major(item.amountCents),
			})
		}
	}
	return { records, truncated: loaded.truncated }
}
