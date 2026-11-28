import { and, asc, eq } from 'drizzle-orm'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { zatcaQrPayload } from '@repo/common/pos-fiscal'
import { type ReceiptInput } from '@repo/common/print-ticket'
import {
	parseLineCatalog,
	lineCatalogHasAlcohol,
} from '@repo/common/item-placement'
import { type ReceiptTargets } from '@repo/common/receipt-extras'
import {
	posFiscalDocuments,
	posOrders,
	posPayments,
	posZatcaSubmissions,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { maskPhone } from '../lib/reservations-station.ts'
import { fetchOrderContext } from './order-service.ts'

/**
 * What the print path needs from the organization besides the order itself,
 * read from the same order context the App serves the region (so there is no
 * second copy of the location's ticket settings, VAT number or receipt-code
 * targets). Kept for a minute.
 */
export type PrintContext = {
	/** The raw `stationSettings.tickets` of the location; resolved by the caller. */
	tickets: unknown
	timeZone: string
	defaultLocale: string
	businessName: string
	locationName: string
	vatNumber: string | null
	targets: ReceiptTargets
	logoUrl: string | null
	currency: string
}

const cache = new Map<string, { at: number; value: PrintContext | null }>()
const FRESH_MS = 60_000

export function clearPrintContextCache() {
	cache.clear()
}

export async function loadPrintContext(
	orgId: string,
	locationId: string,
): Promise<PrintContext | null> {
	const key = `${orgId}:${locationId}`
	const hit = cache.get(key)
	if (hit && Date.now() - hit.at < FRESH_MS) return hit.value
	const result = await fetchOrderContext(orgId, locationId, null)
	let value: PrintContext | null = null
	if (result.ok) {
		const menu = result.data.menu
		const location = menu.locations.find((entry) => entry.id === locationId)
		if (location) {
			const organization = menu.organization as {
				name?: string
				logoUrl?: string | null
			}
			value = {
				tickets: (location.stationSettings as { tickets?: unknown } | undefined)
					?.tickets,
				timeZone: location.timezone || 'UTC',
				defaultLocale: menu.organization.defaultLocale ?? 'en',
				businessName: organization.name || location.name,
				locationName: location.name,
				vatNumber: location.vatNumber?.trim() || null,
				targets: {
					reviewUrl: location.receiptCodes?.reviewUrl ?? null,
					appUrl: location.receiptCodes?.appUrl ?? null,
				},
				logoUrl: organization.logoUrl ?? null,
				currency: location.currency,
			}
		}
	}
	// A failed read is not kept long: the next ticket asks again.
	cache.set(key, {
		at: result.ok ? Date.now() : Date.now() - FRESH_MS + 5_000,
		value,
	})
	if (cache.size > 200) cache.clear()
	return value
}

/** The QR of a signed ZATCA invoice, taken out of its XML, or null. */
export function signedQrFromXml(xmlBase64: string): string | null {
	try {
		const xml = atob(xmlBase64)
		const match =
			/<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>\s*([^<\s]+)\s*</.exec(
				xml,
			)
		return match?.[1] ?? null
	} catch {
		return null
	}
}

const orderTypeOf = (
	fulfillment: string,
	driveThrough = false,
): ReceiptInput['orderType'] =>
	driveThrough
		? 'drive_through'
		: fulfillment === 'dine_in'
			? 'dine_in'
			: fulfillment === 'delivery'
				? 'delivery'
				: fulfillment === 'pickup'
					? 'pickup'
					: 'takeaway'

type LineLike = {
	quantity?: number
	itemName?: string
	name?: string
	variantNames?: string[]
	variantLabel?: string | null
	totalCents?: number
	baseCents?: number
	instructions?: string | null
	options?: Array<{
		optionName?: string
		name?: string
		quantity?: number
		totalCents?: number
		unitCents?: number
	}>
}

const asLines = (value: unknown): LineLike[] =>
	Array.isArray(value) ? (value as LineLike[]) : []

/** A guest receipt for an order, as the printer will print it. Null when the order is not at the location. */
export async function loadReceiptForPrint(
	db: TenantDatabase,
	input: {
		orgId: string
		locationId: string
		source: 'online' | 'pos'
		orderId: string
		context: PrintContext | null
		reprint: boolean
	},
): Promise<{
	receipt: ReceiptInput
	extras: { config: unknown; targets: ReceiptTargets; logoUrl: string | null }
} | null> {
	const context = input.context
	const locale = context?.defaultLocale ?? 'en'
	const zone = safeZone(context?.timeZone ?? 'UTC')
	const clock = (at: number) =>
		new Intl.DateTimeFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
			dateStyle: 'short',
			timeStyle: 'short',
			timeZone: zone,
		}).format(at)
	const base = {
		businessName: context?.businessName ?? '',
		vatNumber: context?.vatNumber ?? null,
	}
	const extras = {
		config: (context?.tickets as { extras?: unknown } | undefined)?.extras,
		targets: context?.targets ?? { reviewUrl: null, appUrl: null },
		logoUrl: context?.logoUrl ?? null,
	}

	if (input.source === 'online') {
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(
				and(
					eq(restaurantOrders.id, input.orderId),
					eq(restaurantOrders.orgId, input.orgId),
					eq(restaurantOrders.locationId, input.locationId),
				),
			)
			.limit(1)
		if (!order) return null
		const fees = [
			order.deliveryFeeCents > 0
				? {
						label: 'Delivery',
						cents: order.deliveryFeeCents - order.deliveryDiscountCents,
					}
				: null,
			order.serviceFeeCents > 0
				? {
						label: order.serviceFeeLabel || 'Service fee',
						cents: order.serviceFeeCents,
					}
				: null,
			order.packagingFeeCents > 0
				? {
						label: order.packagingFeeLabel || 'Packaging fee',
						cents: order.packagingFeeCents,
					}
				: null,
		].filter((fee): fee is { label: string; cents: number } =>
			Boolean(fee && fee.cents > 0),
		)
		const adjustments = [
			order.discountCents > 0
				? { label: 'Discount', cents: order.discountCents }
				: null,
			order.loyaltyDiscountCents > 0
				? { label: 'Reward', cents: order.loyaltyDiscountCents }
				: null,
		].filter((a): a is { label: string; cents: number } => Boolean(a))
		const paid =
			order.paymentStatus === 'paid' || order.paymentStatus === 'not_required'
		return {
			extras,
			receipt: {
				...base,
				time: clock(order.createdAt?.getTime() ?? Date.now()),
				number: order.number,
				orderType: orderTypeOf(order.fulfillment),
				tableLabel: order.fulfillment === 'dine_in' ? order.tableLabel : null,
				guestName: firstWord(order.contactName),
				// The masked callback number, never the full one: the same rule as Station.
				phoneMasked: order.contactPhone ? maskPhone(order.contactPhone) : null,
				currency: order.currency,
				lines: asLines(order.lines).map((line) => ({
					quantity: line.quantity ?? 1,
					name: getLocalizedMenuValue(line.itemName ?? '', locale, locale),
					variant: line.variantNames?.length
						? line.variantNames
								.map((name) => getLocalizedMenuValue(name, locale, locale))
								.join(' · ')
						: null,
					totalCents: line.totalCents ?? 0,
					options: (line.options ?? []).map((option) => ({
						name: getLocalizedMenuValue(
							option.optionName ?? '',
							locale,
							locale,
						),
						quantity: option.quantity,
						totalCents: option.totalCents,
					})),
					note: line.instructions || null,
				})),
				subtotalCents: order.subtotalCents,
				adjustments,
				fees,
				taxCents: order.taxCents,
				tipCents: order.tipCents,
				totalCents: order.totalCents,
				payments: [
					{
						label: paid ? 'Paid' : 'Pay at handoff',
						cents: paid ? order.totalCents : 0,
					},
				].filter((p) => p.cents > 0 || !paid),
				checkId: order.hasAlcohol === true,
				testOrder: order.isTest === true,
				kind: order.status === 'cancelled' ? 'void' : 'sale',
				reprint: input.reprint,
			},
		}
	}

	const [order] = await db
		.select()
		.from(posOrders)
		.where(
			and(
				eq(posOrders.id, input.orderId),
				eq(posOrders.locationId, input.locationId),
			),
		)
		.limit(1)
	if (!order) return null
	const payments = await db
		.select()
		.from(posPayments)
		.where(eq(posPayments.orderId, order.id))
		.orderBy(asc(posPayments.receivedAt))
	const [invoice] = await db
		.select()
		.from(posFiscalDocuments)
		.where(
			and(
				eq(posFiscalDocuments.orderId, order.id),
				eq(posFiscalDocuments.kind, 'invoice'),
			),
		)
		.limit(1)
	// The Phase 2 code of an onboarded unit when there is one; otherwise the
	// Phase 1 code a VAT-registered location prints.
	let fiscalQr: string | null = null
	if (invoice) {
		const [submission] = await db
			.select({ xml: posZatcaSubmissions.xmlBase64 })
			.from(posZatcaSubmissions)
			.where(eq(posZatcaSubmissions.docId, invoice.docId))
			.limit(1)
		fiscalQr = submission ? signedQrFromXml(submission.xml) : null
		if (!fiscalQr && base.vatNumber) {
			fiscalQr = zatcaQrPayload({
				sellerName: base.businessName,
				vatNumber: base.vatNumber,
				at: new Date(invoice.issuedAt).toISOString(),
				totalCents: invoice.totalCents,
				taxCents: invoice.taxCents,
			})
		}
	}
	const paidCents = payments
		.filter((payment) => payment.kind === 'payment')
		.reduce((sum, payment) => sum + payment.amountCents, 0)
	const lineTotal = (line: LineLike) =>
		((line.baseCents ?? 0) +
			(line.options ?? []).reduce(
				(sum, option) => sum + (option.unitCents ?? 0) * (option.quantity ?? 1),
				0,
			)) *
		(line.quantity ?? 1)
	const adjustments = (
		Array.isArray(order.adjustments) ? order.adjustments : []
	) as Array<{
		label?: string
		amountCents?: number
	}>
	return {
		extras,
		receipt: {
			...base,
			time: clock(order.rungUpAt),
			number: order.number,
			orderType: orderTypeOf(
				order.orderType,
				order.orderType === 'drive_through',
			),
			tableLabel: order.tableLabel,
			servedBy: order.staffName,
			invoiceNumber: invoice ? String(invoice.counter) : null,
			currency: order.currency,
			lines: asLines(order.lines).map((line) => ({
				quantity: line.quantity ?? 1,
				name: line.name ?? '',
				variant: line.variantLabel ?? null,
				totalCents: lineTotal(line),
				options: (line.options ?? []).map((option) => ({
					name: option.optionName ?? option.name ?? '',
					quantity: option.quantity,
					totalCents:
						(option.unitCents ?? 0) *
						(option.quantity ?? 1) *
						(line.quantity ?? 1),
				})),
				note: line.instructions || null,
			})),
			subtotalCents: order.subtotalCents,
			adjustments: adjustments
				.filter((a) => (a.amountCents ?? 0) > 0)
				.map((a) => ({
					label: a.label ?? 'Discount',
					cents: a.amountCents ?? 0,
				})),
			taxCents: order.taxCents,
			taxInclusive: order.taxInclusive,
			taxRatePercent: order.taxRatePercent,
			tipCents: order.tipCents,
			totalCents: order.totalCents,
			payments: payments
				.filter((payment) => payment.kind === 'payment')
				.map((payment) => ({
					label: `Paid · ${payment.method}`,
					cents: payment.amountCents,
				})),
			refunds: payments
				.filter((payment) => payment.kind === 'refund')
				.map((payment) => ({
					label: `Refunded · ${payment.method}`,
					cents: payment.amountCents,
				})),
			balanceCents:
				order.status === 'open' ? Math.max(0, order.totalCents - paidCents) : 0,
			fiscalQr,
			checkId: lineCatalogHasAlcohol(parseLineCatalog(order.lineCatalog)),
			kind:
				order.status === 'void'
					? 'void'
					: order.status === 'refunded'
						? 'refund'
						: 'sale',
			reprint: input.reprint,
		},
	}
}

const firstWord = (name: string | null | undefined) =>
	(name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) || null

function safeZone(zone: string): string {
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone })
		return zone
	} catch {
		return 'UTC'
	}
}
