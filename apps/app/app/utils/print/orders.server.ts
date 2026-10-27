import {
	getPrintSize,
	PRINT_PRODUCTS,
	PRINT_SELF_CANCEL_STATUSES,
	type PrintOrderStatus,
	type PrintProductKey,
	type PrintShippingAddress,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import {
	and,
	db,
	desc,
	eq,
	inArray,
	Notification,
	Organization,
	PrintDesign,
	PrintOrder,
	PrintOrderItem,
	PrintSettings,
	PrintVendorEvent,
	PrintVendorOrder,
	PrintVendorProduct,
	User,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { createElement } from 'react'
import type Stripe from 'stripe'
import { ENV } from 'varlock/env'
import { stripe } from '#app/utils/payments.server.ts'
import { getPrintFileUrl } from '#app/utils/storage.server.ts'
import { type PrintShopAccess } from './access.server.ts'
import { exceedsDrift, retailCents } from './pricing.ts'
import { getPrintFile } from './print-files.server.ts'
import { getPrintVendor, isPrintMock } from './vendors/index.server.ts'
import {
	PRINT_VENDORS,
	VendorError,
	type PrintVendorName,
	type VendorAddress,
	type VendorItem,
	type VendorOrderState,
} from './vendors/types.ts'

/**
 * Shipped prints. Menuza is the merchant: the operator pays retail (live
 * vendor wholesale times the markup, plus shipping at cost, plus Stripe Tax)
 * through a one-off Stripe Checkout on the organization's customer; the vendor
 * order is placed only after Stripe confirms payment, one order per vendor.
 * Operator B2B data only (control plane): no guest data is involved.
 */

export class PrintOrderError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'PrintOrderError'
	}
}

type OrderRow = typeof PrintOrder.$inferSelect
type VendorOrderRow = typeof PrintVendorOrder.$inferSelect
type ItemRow = typeof PrintOrderItem.$inferSelect

// ---------------------------------------------------------------------------
// Settings and catalog
// ---------------------------------------------------------------------------

export type PrintSettingsView = {
	markupBp: number
	driftHoldBp: number
	quoteTtlMinutes: number
}

export async function getPrintSettings(): Promise<PrintSettingsView> {
	const [row] = await db
		.select()
		.from(PrintSettings)
		.where(eq(PrintSettings.id, 'default'))
		.limit(1)
	return {
		markupBp: row?.markupBp ?? 3000,
		driftHoldBp: row?.driftHoldBp ?? 1000,
		quoteTtlMinutes: row?.quoteTtlMinutes ?? 30,
	}
}

export async function vendorProductFor(product: string, sizeKey: string) {
	const [row] = await db
		.select()
		.from(PrintVendorProduct)
		.where(
			and(
				eq(PrintVendorProduct.product, product),
				eq(PrintVendorProduct.sizeKey, sizeKey),
				eq(PrintVendorProduct.active, true),
			),
		)
		.limit(1)
	if (!row || !(PRINT_VENDORS as readonly string[]).includes(row.vendor))
		return null
	return { ...row, vendor: row.vendor as PrintVendorName }
}

/** Product/size pairs that can ship right now (a vendor SKU is mapped). */
export async function shippableSizes(): Promise<Set<string>> {
	const rows = await db
		.select({
			product: PrintVendorProduct.product,
			sizeKey: PrintVendorProduct.sizeKey,
		})
		.from(PrintVendorProduct)
		.where(eq(PrintVendorProduct.active, true))
	return new Set(rows.map((row) => `${row.product}:${row.sizeKey}`))
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

function vendorAddress(
	order: Pick<
		OrderRow,
		| 'recipientName'
		| 'recipientPhone'
		| 'addressLine1'
		| 'addressLine2'
		| 'city'
		| 'state'
		| 'postalCode'
		| 'country'
	>,
	email: string | null,
): VendorAddress {
	return {
		name: order.recipientName,
		phone: order.recipientPhone,
		email,
		line1: order.addressLine1,
		line2: order.addressLine2,
		city: order.city,
		state: order.state,
		postalCode: order.postalCode,
		country: order.country,
	}
}

/** One vendor item per printed piece (a table-card set is one card per table). */
function vendorItemsFor(
	item: Pick<ItemRow, 'id' | 'vendorSku' | 'quantity' | 'pieces'>,
): VendorItem[] {
	return Array.from({ length: item.pieces }, (_, index) => ({
		reference: `${item.id}_${index}`,
		sku: item.vendorSku,
		quantity: item.quantity,
	}))
}

/** Spreads a vendor total over items in proportion to their printed copies. */
function allocate(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0) || 1
	const shares = weights.map((weight) => Math.floor((total * weight) / sum))
	let rest = total - shares.reduce((a, b) => a + b, 0)
	for (
		let index = 0;
		rest > 0;
		index = (index + 1) % shares.length, rest -= 1
	) {
		shares[index]! += 1
	}
	return shares
}

export async function createPrintQuote(
	access: PrintShopAccess,
	input: {
		lines: Array<{ designId: string; quantity: number }>
		address: PrintShippingAddress
		locationId: string | null
	},
): Promise<string> {
	const settings = await getPrintSettings()
	const designIds = [...new Set(input.lines.map((line) => line.designId))]
	const designs = await db
		.select()
		.from(PrintDesign)
		.where(
			and(
				eq(PrintDesign.organizationId, access.organization.id),
				inArray(PrintDesign.id, designIds),
			),
		)
	const byId = new Map(designs.map((design) => [design.id, design]))

	type Draft = {
		designId: string
		snapshotHash: string
		product: PrintProductKey
		sizeKey: string
		vendor: PrintVendorName
		vendorSku: string
		quantity: number
		pieces: number
	}
	const drafts: Draft[] = []
	for (const line of input.lines) {
		const design = byId.get(line.designId)
		if (
			!design ||
			design.archivedAt ||
			design.status !== 'approved' ||
			!design.snapshot
		) {
			throw new PrintOrderError(
				422,
				'design_not_approved',
				'Approve each print before ordering it.',
			)
		}
		const product = design.product as PrintProductKey
		if (
			!PRINT_PRODUCTS[product]?.shippable ||
			!getPrintSize(product, design.sizeKey)
		) {
			throw new PrintOrderError(
				422,
				'not_shippable',
				'This print can only be downloaded.',
			)
		}
		const mapping = await vendorProductFor(product, design.sizeKey)
		if (!mapping) {
			throw new PrintOrderError(
				422,
				'not_shippable',
				'This size cannot be shipped right now.',
			)
		}
		drafts.push({
			designId: design.id,
			snapshotHash: design.snapshotHash ?? '',
			product,
			sizeKey: design.sizeKey,
			vendor: mapping.vendor,
			vendorSku: mapping.vendorSku,
			quantity: line.quantity,
			pieces: (design.snapshot as PrintSnapshot).pieces.length,
		})
	}

	const address = vendorAddress(
		{
			recipientName: input.address.recipientName,
			recipientPhone: input.address.recipientPhone,
			addressLine1: input.address.line1,
			addressLine2: input.address.line2 ?? null,
			city: input.address.city,
			state: input.address.state,
			postalCode: input.address.postalCode,
			country: 'US',
		},
		null,
	)

	// One quote per vendor; quotes run before anything is written.
	const vendors = [...new Set(drafts.map((draft) => draft.vendor))]
	const quotes = new Map<
		PrintVendorName,
		Awaited<ReturnType<ReturnType<typeof getPrintVendor>['quote']>>
	>()
	for (const vendor of vendors) {
		const items = drafts
			.filter((draft) => draft.vendor === vendor)
			.flatMap((draft, index) =>
				vendorItemsFor({
					id: `q${index}`,
					vendorSku: draft.vendorSku,
					quantity: draft.quantity,
					pieces: draft.pieces,
				}),
			)
		try {
			quotes.set(vendor, await getPrintVendor(vendor).quote(items, address))
		} catch (error) {
			throw new PrintOrderError(
				503,
				'quote_unavailable',
				error instanceof VendorError && error.code === 'rejected'
					? 'The printer cannot ship this order to that address.'
					: 'We could not get a price right now. Try again in a minute.',
			)
		}
	}

	let wholesale = 0
	let itemsRetail = 0
	let shipping = 0
	for (const quote of quotes.values()) {
		wholesale += quote.itemsCents + quote.shippingCents
		itemsRetail += retailCents(quote.itemsCents, settings.markupBp)
		shipping += quote.shippingCents
	}

	const now = new Date()
	const [order] = await db
		.insert(PrintOrder)
		.values({
			organizationId: access.organization.id,
			placedById: access.userId,
			status: 'quote',
			currency: 'USD',
			itemsCents: itemsRetail,
			shippingCents: shipping,
			taxCents: 0,
			totalCents: itemsRetail + shipping,
			wholesaleCents: wholesale,
			markupBp: settings.markupBp,
			quoteExpiresAt: new Date(
				now.getTime() + settings.quoteTtlMinutes * 60_000,
			),
			locationId: input.locationId,
			recipientName: input.address.recipientName,
			recipientPhone: input.address.recipientPhone,
			addressLine1: input.address.line1,
			addressLine2: input.address.line2 || null,
			city: input.address.city,
			state: input.address.state,
			postalCode: input.address.postalCode,
			country: 'US',
		})
		.returning()
	if (!order)
		throw new PrintOrderError(
			500,
			'quote_failed',
			'We could not save this quote.',
		)

	for (const vendor of vendors) {
		const quote = quotes.get(vendor)!
		const [vendorOrder] = await db
			.insert(PrintVendorOrder)
			.values({
				orderId: order.id,
				vendor,
				status: 'pending',
				shippingMethod: quote.shippingMethod,
				wholesaleItemsCents: quote.itemsCents,
				wholesaleShippingCents: quote.shippingCents,
			})
			.returning()
		const mine = drafts.filter((draft) => draft.vendor === vendor)
		const wholesaleShares = allocate(
			quote.itemsCents,
			mine.map((draft) => draft.quantity * draft.pieces),
		)
		const retailShares = allocate(
			retailCents(quote.itemsCents, settings.markupBp),
			mine.map((draft) => draft.quantity * draft.pieces),
		)
		await db.insert(PrintOrderItem).values(
			mine.map((draft, index) => ({
				orderId: order.id,
				vendorOrderId: vendorOrder!.id,
				designId: draft.designId,
				snapshotHash: draft.snapshotHash,
				product: draft.product,
				sizeKey: draft.sizeKey,
				vendor,
				vendorSku: draft.vendorSku,
				quantity: draft.quantity,
				pieces: draft.pieces,
				wholesaleCents: wholesaleShares[index]!,
				retailCents: retailShares[index]!,
			})),
		)
	}
	return order.id
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPrintOrders(organizationId: string) {
	return db
		.select()
		.from(PrintOrder)
		.where(eq(PrintOrder.organizationId, organizationId))
		.orderBy(desc(PrintOrder.createdAt))
		.limit(100)
}

export async function getPrintOrderDetail(
	organizationId: string | null,
	orderId: string,
) {
	const [order] = await db
		.select()
		.from(PrintOrder)
		.where(
			organizationId
				? and(
						eq(PrintOrder.id, orderId),
						eq(PrintOrder.organizationId, organizationId),
					)
				: eq(PrintOrder.id, orderId),
		)
		.limit(1)
	if (!order) throw new Response('Not Found', { status: 404 })
	const [vendorOrders, items] = await Promise.all([
		db
			.select()
			.from(PrintVendorOrder)
			.where(eq(PrintVendorOrder.orderId, order.id)),
		db
			.select({
				item: PrintOrderItem,
				designName: PrintDesign.name,
			})
			.from(PrintOrderItem)
			.innerJoin(PrintDesign, eq(PrintDesign.id, PrintOrderItem.designId))
			.where(eq(PrintOrderItem.orderId, order.id)),
	])
	return { order, vendorOrders, items }
}

// ---------------------------------------------------------------------------
// Checkout (Stripe, platform account, one-off payment)
// ---------------------------------------------------------------------------

export const PRINT_STRIPE_METADATA_TYPE = 'print_order'

export function isPrintStripeMetadata(
	metadata: Stripe.Metadata | null | undefined,
): metadata is Stripe.Metadata & { orderId: string; organizationId: string } {
	return (
		metadata?.type === PRINT_STRIPE_METADATA_TYPE &&
		typeof metadata.orderId === 'string' &&
		typeof metadata.organizationId === 'string'
	)
}

/** Stripe Tax codes: general tangible goods, and shipping. */
const TAX_CODE_PRINTS = 'txcd_99999999'
const TAX_CODE_SHIPPING = 'txcd_92010001'

async function ensureStripeCustomer(organizationId: string): Promise<string> {
	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			stripeCustomerId: Organization.stripeCustomerId,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org)
		throw new PrintOrderError(
			404,
			'organization_not_found',
			'Organization not found.',
		)
	if (org.stripeCustomerId) return org.stripeCustomerId
	// The subscription flow reuses this customer if the org upgrades later.
	const customer = await stripe.customers.create(
		{ name: org.name, metadata: { organizationId: org.id } },
		{ idempotencyKey: `print-customer-${org.id}` },
	)
	await db
		.update(Organization)
		.set({ stripeCustomerId: customer.id })
		.where(eq(Organization.id, org.id))
	return customer.id
}

export async function startPrintCheckout(
	access: PrintShopAccess,
	orderId: string,
	returnBase: string,
): Promise<string> {
	const { order } = await getPrintOrderDetail(access.organization.id, orderId)
	if (order.status !== 'quote' && order.status !== 'awaiting_payment') {
		throw new PrintOrderError(
			409,
			'not_payable',
			'This order is already paid or closed.',
		)
	}
	if (order.quoteExpiresAt.getTime() <= Date.now()) {
		throw new PrintOrderError(
			409,
			'quote_expired',
			'This price has expired. Get a new price.',
		)
	}
	const customer = await ensureStripeCustomer(access.organization.id)
	// Stripe Tax uses the customer's shipping address: make it this order's.
	try {
		await stripe.customers.update(customer, {
			shipping: {
				name: order.recipientName,
				phone: order.recipientPhone,
				address: {
					line1: order.addressLine1,
					line2: order.addressLine2 ?? undefined,
					city: order.city,
					state: order.state,
					postal_code: order.postalCode,
					country: order.country,
				},
			},
		})
	} catch (error) {
		if (!isPrintMock()) throw error
	}
	// Stripe needs at least 30 minutes; the quote lock is the shorter of both.
	const expiresAt = Math.max(
		Math.floor(order.quoteExpiresAt.getTime() / 1000),
		Math.floor(Date.now() / 1000) + 31 * 60,
	)
	const metadata = {
		type: PRINT_STRIPE_METADATA_TYPE,
		orderId: order.id,
		organizationId: access.organization.id,
	}
	const session = await stripe.checkout.sessions.create(
		{
			mode: 'payment',
			customer,
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: 'usd',
						unit_amount: order.itemsCents,
						product_data: { name: 'Prints', tax_code: TAX_CODE_PRINTS },
						tax_behavior: 'exclusive',
					},
				},
				{
					quantity: 1,
					price_data: {
						currency: 'usd',
						unit_amount: order.shippingCents,
						product_data: { name: 'Shipping', tax_code: TAX_CODE_SHIPPING },
						tax_behavior: 'exclusive',
					},
				},
			],
			// Sales tax follows the ship-to address (Stripe Tax).
			...(isPrintMock() ? {} : { automatic_tax: { enabled: true } }),
			metadata,
			payment_intent_data: { metadata },
			expires_at: expiresAt,
			success_url: `${returnBase}?paid=1`,
			cancel_url: `${returnBase}?cancelled=1`,
		},
		{
			idempotencyKey: `print-checkout-${order.id}-${order.quoteExpiresAt.getTime()}`,
		},
	)
	await db
		.update(PrintOrder)
		.set({ status: 'awaiting_payment', stripeCheckoutSessionId: session.id })
		.where(eq(PrintOrder.id, order.id))
	if (!session.url)
		throw new PrintOrderError(
			503,
			'checkout_unavailable',
			'Payment is unavailable.',
		)
	return session.url
}

/**
 * Stripe Checkout events for print orders. Only the session bound to the
 * order moves it, and only forward; a paid order is then submitted to the
 * vendors. Throwing makes Stripe retry.
 */
export async function handlePrintStripeSession(
	session: Stripe.Checkout.Session,
	eventType: string,
) {
	if (!isPrintStripeMetadata(session.metadata)) return
	const [order] = await db
		.select()
		.from(PrintOrder)
		.where(
			and(
				eq(PrintOrder.id, session.metadata.orderId),
				eq(PrintOrder.organizationId, session.metadata.organizationId),
			),
		)
		.limit(1)
	if (!order || order.stripeCheckoutSessionId !== session.id) return

	if (eventType === 'checkout.session.expired') {
		await db
			.update(PrintOrder)
			.set({ status: 'cancelled', cancelledAt: new Date() })
			.where(
				and(
					eq(PrintOrder.id, order.id),
					eq(PrintOrder.status, 'awaiting_payment'),
				),
			)
		return
	}
	if (eventType === 'checkout.session.async_payment_failed') {
		await db
			.update(PrintOrder)
			.set({
				status: 'cancelled',
				cancelledAt: new Date(),
				failureReason: 'payment_failed',
			})
			.where(
				and(
					eq(PrintOrder.id, order.id),
					eq(PrintOrder.status, 'awaiting_payment'),
				),
			)
		return
	}
	if (session.payment_status !== 'paid') return
	if (session.currency !== 'usd') return
	const updated = await db
		.update(PrintOrder)
		.set({
			status: 'paid',
			paidAt: new Date(),
			taxCents: session.total_details?.amount_tax ?? 0,
			totalCents: session.amount_total ?? order.totalCents,
			stripePaymentIntentId:
				typeof session.payment_intent === 'string'
					? session.payment_intent
					: (session.payment_intent?.id ?? null),
		})
		.where(
			and(
				eq(PrintOrder.id, order.id),
				eq(PrintOrder.status, 'awaiting_payment'),
			),
		)
		.returning({ id: PrintOrder.id })
	// A repeated delivery of the same event changes nothing.
	if (updated.length === 0) return
	await notifyPrintOrder(order.id, 'paid')
	await submitPrintOrder(order.id)
}

// ---------------------------------------------------------------------------
// Vendor submission
// ---------------------------------------------------------------------------

async function hold(orderId: string, reason: string) {
	await db
		.update(PrintOrder)
		.set({ status: 'held', holdReason: reason })
		.where(eq(PrintOrder.id, orderId))
}

function webhookUrl(vendor: PrintVendorName) {
	const token = ENV.PRINT_WEBHOOK_TOKEN?.trim()
	const base = ENV.BASE_URL?.replace(/\/$/, '')
	if (!token || token.length < 32 || !base) return null
	return `${base}/resources/print/webhook/${vendor}?token=${encodeURIComponent(token)}`
}

/** Renders (or reuses) one print-ready PDF per piece with the vendor's bleed. */
async function pieceFileUrls(
	organizationId: string,
	item: ItemRow,
	bleedMm: number,
): Promise<string[] | null> {
	const [design] = await db
		.select({ snapshot: PrintDesign.snapshot })
		.from(PrintDesign)
		.where(eq(PrintDesign.id, item.designId))
		.limit(1)
	const snapshot = design?.snapshot as PrintSnapshot | null
	if (!snapshot) return null
	const urls: string[] = []
	for (const piece of snapshot.pieces) {
		const file = await getPrintFile({
			organizationId,
			snapshot: { ...snapshot, pieces: [piece] },
			format: 'pro',
			bleedMm,
		})
		if (file.kind !== 'pdf') {
			if (isPrintMock()) {
				urls.push(`https://example.invalid/mock-print/${item.id}`)
				continue
			}
			return null
		}
		urls.push(getPrintFileUrl(file.objectKey, 7 * 24 * 3600))
	}
	return urls
}

/**
 * Sends a paid order to its vendors. Each vendor is re-quoted first: a rise
 * above the drift limit holds the order for Admin instead of selling at a
 * loss. A vendor that refuses the order cancels the rest and refunds in full.
 */
export async function submitPrintOrder(
	orderId: string,
	options: { ignoreDrift?: boolean } = {},
) {
	const { order, vendorOrders, items } = await getPrintOrderDetail(
		null,
		orderId,
	)
	if (order.status !== 'paid' && order.status !== 'held') return
	const settings = await getPrintSettings()
	const [placer] = order.placedById
		? await db
				.select({ email: User.email })
				.from(User)
				.where(eq(User.id, order.placedById))
				.limit(1)
		: []
	const address = vendorAddress(order, placer?.email ?? null)

	const pending = vendorOrders.filter(
		(vendorOrder) => vendorOrder.status === 'pending',
	)
	for (const vendorOrder of pending) {
		const vendor = getPrintVendor(vendorOrder.vendor as PrintVendorName)
		const mine = items
			.map((row) => row.item)
			.filter((item) => item.vendorOrderId === vendorOrder.id)
		const quoteItems = mine.flatMap((item) => vendorItemsFor(item))
		try {
			if (!options.ignoreDrift) {
				const quote = await vendor.quote(quoteItems, address)
				const locked =
					vendorOrder.wholesaleItemsCents + vendorOrder.wholesaleShippingCents
				if (
					exceedsDrift(
						locked,
						quote.itemsCents + quote.shippingCents,
						settings.driftHoldBp,
					)
				) {
					await hold(order.id, 'price_drift')
					return
				}
			}
			const mapping = await vendorProductFor(mine[0]!.product, mine[0]!.sizeKey)
			const bleedMm = mapping?.bleedMm ?? 3
			const files: VendorItem[] = []
			for (const item of mine) {
				const urls = await pieceFileUrls(order.organizationId, item, bleedMm)
				if (!urls) {
					await hold(order.id, 'render_unavailable')
					return
				}
				urls.forEach((url, index) =>
					files.push({
						reference: `${item.id}_${index}`,
						sku: item.vendorSku,
						quantity: item.quantity,
						fileUrl: url,
					}),
				)
			}
			const { vendorOrderId } = await vendor.createOrder({
				reference: vendorOrder.id,
				items: files,
				address,
				shippingMethod: vendorOrder.shippingMethod ?? 'Standard',
				callbackUrl: webhookUrl(vendorOrder.vendor as PrintVendorName),
			})
			await db
				.update(PrintVendorOrder)
				.set({
					vendorOrderId,
					status: 'submitted',
					submittedAt: new Date(),
					error: null,
				})
				.where(eq(PrintVendorOrder.id, vendorOrder.id))
		} catch (error) {
			if (error instanceof VendorError && error.code === 'rejected') {
				await db
					.update(PrintVendorOrder)
					.set({ status: 'failed', error: error.message })
					.where(eq(PrintVendorOrder.id, vendorOrder.id))
				await failAndRefund(order.id, 'vendor_rejected')
				return
			}
			// Unavailable: keep it for Admin to retry; nothing is lost.
			await hold(order.id, 'vendor_unavailable')
			return
		}
	}
	await db
		.update(PrintOrder)
		.set({ status: 'submitted', holdReason: null })
		.where(eq(PrintOrder.id, order.id))
}

// ---------------------------------------------------------------------------
// Status from vendors
// ---------------------------------------------------------------------------

const ROLLUP_ORDER: VendorOrderState[] = [
	'submitted',
	'in_production',
	'shipped',
	'delivered',
]

async function rollUp(orderId: string) {
	const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
	if (!['submitted', 'in_production', 'shipped'].includes(order.status)) return
	const states = vendorOrders.map(
		(vendorOrder) => vendorOrder.status as VendorOrderState,
	)
	if (states.length === 0) return
	const least = states.reduce((min, state) =>
		ROLLUP_ORDER.indexOf(state) < ROLLUP_ORDER.indexOf(min) ? state : min,
	)
	const next = (
		ROLLUP_ORDER.includes(least) ? least : 'submitted'
	) as PrintOrderStatus
	if (next !== order.status) {
		await db
			.update(PrintOrder)
			.set({ status: next })
			.where(eq(PrintOrder.id, order.id))
		if (next === 'shipped') await notifyPrintOrder(order.id, 'shipped')
	}
}

export async function syncPrintVendorOrder(vendorOrder: VendorOrderRow) {
	if (!vendorOrder.vendorOrderId) return
	if (['cancelled', 'failed', 'delivered'].includes(vendorOrder.status)) return
	const status = await getPrintVendor(
		vendorOrder.vendor as PrintVendorName,
	).status(vendorOrder.vendorOrderId)
	const now = new Date()
	await db
		.update(PrintVendorOrder)
		.set({
			status: status.state,
			carrier: status.carrier ?? vendorOrder.carrier,
			trackingNumber: status.trackingNumber ?? vendorOrder.trackingNumber,
			trackingUrl: status.trackingUrl ?? vendorOrder.trackingUrl,
			lastEventAt: now,
			...(status.state === 'shipped' && !vendorOrder.shippedAt
				? { shippedAt: now }
				: {}),
			...(status.state === 'delivered' ? { deliveredAt: now } : {}),
		})
		.where(eq(PrintVendorOrder.id, vendorOrder.id))
	if (status.state === 'failed' || status.state === 'cancelled') {
		// The vendor dropped a paid order: refund it in full.
		await failAndRefund(vendorOrder.orderId, `vendor_${status.state}`)
		return
	}
	await rollUp(vendorOrder.orderId)
}

/**
 * Vendor webhook: fetch the truth from the vendor, then remember the event so
 * a redelivery is a no-op. A failed sync is not remembered, so the vendor's
 * retry gets another chance.
 */
export async function handlePrintVendorWebhook(
	vendor: PrintVendorName,
	input: { eventId: string | null; vendorOrderId: string | null },
) {
	const eventKey = input.eventId ? `${vendor}:${input.eventId}` : null
	if (eventKey) {
		const [seen] = await db
			.select({ id: PrintVendorEvent.id })
			.from(PrintVendorEvent)
			.where(eq(PrintVendorEvent.id, eventKey))
			.limit(1)
		if (seen) return
	}
	if (input.vendorOrderId) {
		const [vendorOrder] = await db
			.select()
			.from(PrintVendorOrder)
			.where(
				and(
					eq(PrintVendorOrder.vendor, vendor),
					eq(PrintVendorOrder.vendorOrderId, input.vendorOrderId),
				),
			)
			.limit(1)
		if (vendorOrder) await syncPrintVendorOrder(vendorOrder)
	}
	if (eventKey) {
		await db
			.insert(PrintVendorEvent)
			.values({ id: eventKey, vendor })
			.onConflictDoNothing()
	}
}

/** Cron safety net for missed webhooks: open vendor orders, oldest first. */
export async function syncOpenPrintOrders(limit = 50) {
	const open = await db
		.select()
		.from(PrintVendorOrder)
		.where(
			inArray(PrintVendorOrder.status, [
				'submitted',
				'in_production',
				'shipped',
			]),
		)
		.orderBy(PrintVendorOrder.updatedAt)
		.limit(limit)
	let synced = 0
	for (const vendorOrder of open) {
		try {
			await syncPrintVendorOrder(vendorOrder)
			synced += 1
		} catch {
			// One vendor being down never stops the others.
		}
	}
	return synced
}

// ---------------------------------------------------------------------------
// Cancellation and refunds
// ---------------------------------------------------------------------------

async function refundInFull(order: OrderRow) {
	if (!order.stripePaymentIntentId || order.refundCents >= order.totalCents)
		return
	await stripe.refunds.create(
		{
			payment_intent: order.stripePaymentIntentId,
			amount: order.totalCents - order.refundCents,
			metadata: { type: PRINT_STRIPE_METADATA_TYPE, orderId: order.id },
		},
		{ idempotencyKey: `print-refund-${order.id}` },
	)
	await db
		.update(PrintOrder)
		.set({ refundCents: order.totalCents, refundedAt: new Date() })
		.where(eq(PrintOrder.id, order.id))
}

async function cancelAtVendors(vendorOrders: VendorOrderRow[]) {
	for (const vendorOrder of vendorOrders) {
		if (
			!vendorOrder.vendorOrderId ||
			['cancelled', 'failed'].includes(vendorOrder.status)
		)
			continue
		const result = await getPrintVendor(
			vendorOrder.vendor as PrintVendorName,
		).cancel(vendorOrder.vendorOrderId)
		if (result === 'too_late') return false
		await db
			.update(PrintVendorOrder)
			.set({ status: 'cancelled' })
			.where(eq(PrintVendorOrder.id, vendorOrder.id))
	}
	return true
}

async function failAndRefund(orderId: string, reason: string) {
	const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
	if (order.status === 'refunded' || order.status === 'cancelled') return
	await cancelAtVendors(vendorOrders).catch(() => false)
	await refundInFull(order)
	await db
		.update(PrintOrder)
		.set({ status: 'refunded', failureReason: reason })
		.where(eq(PrintOrder.id, order.id))
	await notifyPrintOrder(order.id, 'failed')
}

/** Operator self-cancel: possible until a vendor starts production. */
export async function cancelPrintOrder(
	access: PrintShopAccess,
	orderId: string,
) {
	const { order, vendorOrders } = await getPrintOrderDetail(
		access.organization.id,
		orderId,
	)
	if (!PRINT_SELF_CANCEL_STATUSES.includes(order.status as PrintOrderStatus)) {
		throw new PrintOrderError(
			409,
			'too_late',
			'Production has started, so this order can no longer be cancelled.',
		)
	}
	if (order.status === 'quote' || order.status === 'awaiting_payment') {
		if (order.stripeCheckoutSessionId && order.status === 'awaiting_payment') {
			await stripe.checkout.sessions
				.expire(order.stripeCheckoutSessionId)
				.catch(() => null)
		}
		await db
			.update(PrintOrder)
			.set({ status: 'cancelled', cancelledAt: new Date() })
			.where(eq(PrintOrder.id, order.id))
		return
	}
	if (!(await cancelAtVendors(vendorOrders))) {
		throw new PrintOrderError(
			409,
			'too_late',
			'Production has started, so this order can no longer be cancelled.',
		)
	}
	await refundInFull(order)
	await db
		.update(PrintOrder)
		.set({
			status: 'refunded',
			cancelledAt: new Date(),
			failureReason: 'cancelled_by_operator',
		})
		.where(eq(PrintOrder.id, order.id))
}

/** Admin: refund in full whatever the state (after a vendor defect claim, etc.). */
export async function adminRefundPrintOrder(orderId: string) {
	const { order } = await getPrintOrderDetail(null, orderId)
	await refundInFull(order)
	await db
		.update(PrintOrder)
		.set({
			status: 'refunded',
			failureReason: order.failureReason ?? 'refunded_by_admin',
		})
		.where(eq(PrintOrder.id, order.id))
	await notifyPrintOrder(order.id, 'failed')
}

/**
 * Admin: retry a held order. Items are re-mapped to the catalog's current
 * vendor SKU (that is how an order is rerouted), then submitted; `acceptPrice`
 * skips the drift check after Admin accepted the new wholesale price.
 */
export async function adminRetryPrintOrder(
	orderId: string,
	acceptPrice: boolean,
) {
	const { order, vendorOrders, items } = await getPrintOrderDetail(
		null,
		orderId,
	)
	if (order.status !== 'held') {
		throw new PrintOrderError(
			409,
			'not_held',
			'Only a held order can be retried.',
		)
	}
	for (const { item } of items) {
		const mapping = await vendorProductFor(item.product, item.sizeKey)
		if (!mapping) continue
		const vendorOrder = vendorOrders.find(
			(entry) => entry.id === item.vendorOrderId,
		)
		if (!vendorOrder || vendorOrder.status !== 'pending') continue
		if (
			mapping.vendor !== item.vendor ||
			mapping.vendorSku !== item.vendorSku
		) {
			await db
				.update(PrintOrderItem)
				.set({ vendor: mapping.vendor, vendorSku: mapping.vendorSku })
				.where(eq(PrintOrderItem.id, item.id))
			await db
				.update(PrintVendorOrder)
				.set({ vendor: mapping.vendor })
				.where(eq(PrintVendorOrder.id, vendorOrder.id))
		}
	}
	await submitPrintOrder(order.id, { ignoreDrift: acceptPrice })
}

// ---------------------------------------------------------------------------
// Notifications (email + in-app to the person who placed the order)
// ---------------------------------------------------------------------------

export type PrintNotificationKind = 'paid' | 'shipped' | 'failed'

const COPY: Record<
	PrintNotificationKind,
	{ headline: string; detail: string }
> = {
	paid: {
		headline: 'Your print order is paid',
		detail:
			'We sent it to the printer. You can cancel it until production starts.',
	},
	shipped: {
		headline: 'Your prints are on the way',
		detail: 'The parcel has shipped. Tracking is on the order page.',
	},
	failed: {
		headline: 'Your print order was refunded',
		detail: 'The order could not be completed, so we refunded it in full.',
	},
}

export async function notifyPrintOrder(
	orderId: string,
	kind: PrintNotificationKind,
) {
	try {
		const [row] = await db
			.select({
				placedById: PrintOrder.placedById,
				organizationId: PrintOrder.organizationId,
				orgSlug: Organization.slug,
				email: User.email,
			})
			.from(PrintOrder)
			.innerJoin(Organization, eq(Organization.id, PrintOrder.organizationId))
			.leftJoin(User, eq(User.id, PrintOrder.placedById))
			.where(eq(PrintOrder.id, orderId))
			.limit(1)
		if (!row?.placedById) return
		const url = `${(ENV.BASE_URL ?? '').replace(/\/$/, '')}/${row.orgSlug}/marketing/print/orders/${orderId}`
		await db
			.insert(Notification)
			.values({
				userId: row.placedById,
				organizationId: row.organizationId,
				type: `print_order_${kind}`,
				entityId: orderId,
				payload: JSON.stringify({ orgSlug: row.orgSlug, orderId }),
			})
			.onConflictDoNothing()
		if (row.email) {
			const copy = COPY[kind]
			await sendEmail({
				to: row.email,
				subject: copy.headline,
				react: createElement(StaffingAlertEmail, {
					eyebrow: 'Print shop',
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: 'Open the order',
					actionUrl: url,
				}),
			})
		}
	} catch (error) {
		console.error(
			'Print order notification failed:',
			error instanceof Error ? error.message : error,
		)
	}
}
