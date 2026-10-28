import { i18n } from '@lingui/core'
import {
	PRINT_AFTER_SHIPPING_HOLDS,
	PRINT_MAX_PIECES_PER_DESIGN,
	PRINT_SELF_CANCEL_STATUSES,
	PRINT_VENDOR_CHECK_HOLDS,
	type PrintOrderStatus,
	type PrintProductKey,
	type PrintShippingAddress,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { brand } from '@repo/config/brand'
import {
	and,
	asc,
	db,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	ne,
	Notification,
	or,
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
import { loadCatalog } from '#app/modules/lingui/lingui.ts'
import { getShopCommerce } from '#app/utils/shop.server.ts'
import { getPrintFileUrl } from '#app/utils/storage.server.ts'
import { type PrintShopAccess } from './access.server.ts'
import { exceedsDrift, retailCents } from './pricing.ts'
import { getPrintFile } from './print-files.server.ts'
import {
	PRINT_EMAIL_ACTION,
	PRINT_EMAIL_COPY,
	PRINT_EMAIL_EYEBROW,
} from './print-notifications.ts'
import { resolvePrintPieces, staleFacts } from './print-snapshot.server.ts'
import { canViewQrCodes } from './qr-access.server.ts'
import { getPrintVendor, isPrintMock } from './vendors/index.server.ts'
import {
	PRINT_VENDORS,
	VendorError,
	type PrintVendorName,
	type VendorAddress,
	type VendorItem,
	type VendorOrderState,
} from './vendors/types.ts'

/** The platform is the merchant: its own Stripe account, mocked under MOCKS. */
const platformStripe = () => getShopCommerce().getPlatformStripe()

/**
 * Shipped prints. The platform is the merchant: the operator pays retail (live
 * vendor wholesale times the markup, plus shipping at cost, plus Stripe Tax)
 * through a one-off Stripe Checkout on the organization's customer; the vendor
 * order is placed only after Stripe confirms payment, one order per vendor.
 * Operator B2B data only (control plane): no customer data is involved.
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

/** One vendor item per printed piece (a set of cards is one item per card). */
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

/**
 * A print with per-piece codes prints each code as of approval. A code
 * renewed (or a piece renamed or removed) since then would ship prints that
 * no longer work, so such a design has to be approved again before it is
 * sold.
 */
async function requireFreshCodes(
	request: Request,
	access: PrintShopAccess,
	designId: string,
	snapshot: PrintSnapshot,
) {
	if (!snapshot.qr || (snapshot.facts.pieces ?? []).length === 0) return
	if (!(await canViewQrCodes(access, snapshot.qr))) {
		throw new PrintOrderError(
			403,
			'qr_forbidden',
			'Ordering this print also needs permission to see its QR codes.',
		)
	}
	let live: Awaited<ReturnType<typeof resolvePrintPieces>>
	try {
		live = await resolvePrintPieces({
			request,
			access,
			designId,
			target: snapshot.qr,
		})
	} catch (error) {
		if (error instanceof Response && error.status === 403) {
			throw new PrintOrderError(
				403,
				'qr_forbidden',
				'Ordering this print also needs permission to see its QR codes.',
			)
		}
		throw new PrintOrderError(
			503,
			'qr_unavailable',
			'The QR codes could not be checked right now. Try again in a minute.',
		)
	}
	const changes = staleFacts(snapshot, {
		...snapshot,
		facts: { ...snapshot.facts, pieces: live.facts },
	})
	if (changes.length > 0) {
		throw new PrintOrderError(
			409,
			'design_stale',
			'QR codes or labels changed since this print was approved. Approve the proof again, then order.',
		)
	}
}

export async function createPrintQuote(
	request: Request,
	access: PrintShopAccess,
	input: {
		lines: Array<{ designId: string; quantity: number }>
		address: PrintShippingAddress
		scopeId: string | null
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
		snapshot: PrintSnapshot
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
		// Approval refuses larger sets; this holds for prints approved before.
		const snapshotPieces =
			(design.snapshot as PrintSnapshot).pieces?.length ?? 0
		if (snapshotPieces > PRINT_MAX_PIECES_PER_DESIGN) {
			throw new PrintOrderError(
				422,
				'too_many_pieces',
				'This print has too many pieces to order at once.',
			)
		}
		const product = design.product
		if (
			!printCatalog.products[product]?.shippable ||
			!printCatalog.getSize(product, design.sizeKey)
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
		await requireFreshCodes(
			request,
			access,
			design.id,
			design.snapshot as PrintSnapshot,
		)
		drafts.push({
			designId: design.id,
			snapshotHash: design.snapshotHash ?? '',
			product,
			sizeKey: design.sizeKey,
			vendor: mapping.vendor,
			vendorSku: mapping.vendorSku,
			quantity: line.quantity,
			pieces: (design.snapshot as PrintSnapshot).pieces.length,
			// Frozen now: what is priced is exactly what prints.
			snapshot: design.snapshot as PrintSnapshot,
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
			scopeId: input.scopeId,
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
				snapshot: draft.snapshot,
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
	const customer = await platformStripe().customers.create(
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
	request: Request,
	access: PrintShopAccess,
	orderId: string,
	returnBase: string,
): Promise<string> {
	const { order, items } = await getPrintOrderDetail(
		access.organization.id,
		orderId,
	)
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
	// A code renewed since the quote would ship dead prints: check again right
	// before money moves (the last step with a signed-in user).
	for (const { item } of items) {
		if (item.snapshot) {
			await requireFreshCodes(
				request,
				access,
				item.designId,
				item.snapshot as PrintSnapshot,
			)
		}
	}
	// One live payment per order: re-serve the open session, and never start a
	// second one for a session that is already paid (its webhook may be late).
	let previousSession: string | null = null
	if (order.stripeCheckoutSessionId) {
		// Unknown is not "gone": starting another session now could leave two
		// open payments for one order.
		const existing = await platformStripe()
			.checkout.sessions.retrieve(order.stripeCheckoutSessionId)
			.catch(() => {
				throw new PrintOrderError(
					503,
					'checkout_unavailable',
					'Payment is unavailable.',
				)
			})
		if (
			existing?.payment_status === 'paid' ||
			existing?.status === 'complete'
		) {
			throw new PrintOrderError(
				409,
				'payment_processing',
				'Your payment is being confirmed. This page updates in a moment.',
			)
		}
		if (existing?.status === 'open' && existing.url) return existing.url
		previousSession = existing.id
	}
	const customer = await ensureStripeCustomer(access.organization.id)
	// Stripe Tax uses the customer's shipping address: make it this order's.
	try {
		await platformStripe().customers.update(customer, {
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
	// Stripe needs at least 30 minutes. Derived from the quote, not the clock,
	// so a retry sends the same parameters under the same idempotency key.
	const expiresAt = Math.floor(order.quoteExpiresAt.getTime() / 1000) + 31 * 60
	const metadata = {
		type: PRINT_STRIPE_METADATA_TYPE,
		orderId: order.id,
		organizationId: access.organization.id,
	}
	const session = await platformStripe().checkout.sessions.create(
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
			// A new key after an expired session; the same one for a retry.
			idempotencyKey: `print-checkout-${order.id}-${order.quoteExpiresAt.getTime()}-${previousSession ?? 'first'}`,
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
	/**
	 * Runs the vendor submission after the webhook answers (Workers
	 * `waitUntil`). Without it the submission runs inline (tests, scripts).
	 */
	options: { later?: (task: () => Promise<unknown>) => void } = {},
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
	if (updated.length === 0) {
		// Paid after the order was cancelled (two tabs, or a session that could
		// not be expired): give the money back instead of keeping it silently.
		const [current] = await db
			.select()
			.from(PrintOrder)
			.where(eq(PrintOrder.id, order.id))
			.limit(1)
		if (current?.status === 'cancelled' && !current.stripePaymentIntentId) {
			const paymentIntent =
				typeof session.payment_intent === 'string'
					? session.payment_intent
					: (session.payment_intent?.id ?? null)
			if (paymentIntent && session.amount_total) {
				await platformStripe().refunds.create(
					{
						payment_intent: paymentIntent,
						amount: session.amount_total,
						metadata: { type: PRINT_STRIPE_METADATA_TYPE, orderId: order.id },
					},
					{ idempotencyKey: `print-late-refund-${order.id}` },
				)
				await db
					.update(PrintOrder)
					.set({
						status: 'refunded',
						stripePaymentIntentId: paymentIntent,
						totalCents: session.amount_total,
						refundCents: session.amount_total,
						refundedAt: new Date(),
						failureReason: 'late_payment',
					})
					.where(
						and(
							eq(PrintOrder.id, order.id),
							eq(PrintOrder.status, 'cancelled'),
						),
					)
			}
		}
		// Otherwise a repeated delivery of the same event changes nothing.
		return
	}
	await notifyPrintOrder(order.id, 'paid')
	if (options.later) options.later(() => submitPrintOrder(order.id))
	else await submitPrintOrder(order.id)
}

// ---------------------------------------------------------------------------
// Vendor submission
// ---------------------------------------------------------------------------

async function hold(orderId: string, reason: string) {
	await db
		.update(PrintOrder)
		.set({ status: 'held', holdReason: reason })
		.where(and(eq(PrintOrder.id, orderId), eq(PrintOrder.status, 'submitting')))
}

/**
 * Set on a `submitting` order just before a vendor is called, and cleared once
 * its answer is recorded: a claim left behind with it may have reached the
 * vendor (Admin checks), one without it never did (safe to submit again).
 */
const VENDOR_SENDING = 'vendor_sending'

/** Rendering ran out of time: give the claim back, files rendered so far stay cached. */
async function release(orderId: string) {
	await db
		.update(PrintOrder)
		.set({ status: 'paid', holdReason: null })
		.where(and(eq(PrintOrder.id, orderId), eq(PrintOrder.status, 'submitting')))
}

/** Rendering time one submission may spend before it hands over. */
const SUBMIT_RENDER_BUDGET_MS = 20_000

function webhookUrl(vendor: PrintVendorName) {
	const token = ENV.PRINT_WEBHOOK_TOKEN?.trim()
	const base = ENV.BASE_URL?.replace(/\/$/, '')
	if (!token || token.length < 32 || !base) return null
	return `${base}/resources/print/webhook/${vendor}?token=${encodeURIComponent(token)}`
}

/**
 * Renders (or reuses) one print-ready PDF per piece with the vendor's bleed.
 * Past the deadline it stops between pieces ('deferred'), but only once it
 * has rendered at least one new file: renders are cached by their inputs, so
 * every run moves the order forward and the next one picks up from there.
 */
async function pieceFileUrls(
	organizationId: string,
	item: ItemRow,
	bleedMm: number,
	deadline: number,
	/** New files rendered in this run, shared across the order's items. */
	progress: { rendered: number },
): Promise<string[] | null | 'deferred'> {
	// The snapshot frozen on the item at quote time, never the live design.
	const snapshot = item.snapshot as PrintSnapshot | null
	if (!snapshot || snapshot.pieces.length !== item.pieces) return null
	const urls: string[] = []
	for (const piece of snapshot.pieces) {
		if (progress.rendered > 0 && Date.now() > deadline) return 'deferred'
		const file = await getPrintFile(
			{
				organizationId,
				snapshot: { ...snapshot, pieces: [piece] },
				format: 'pro',
				bleedMm,
			},
			{ skipLimit: true },
		)
		if (file.kind !== 'pdf') {
			if (isPrintMock()) {
				// The local emulator's stand-in counts as a new file.
				progress.rendered += 1
				urls.push(`https://example.invalid/mock-print/${item.id}`)
				continue
			}
			return null
		}
		if (file.fresh) progress.rendered += 1
		urls.push(getPrintFileUrl(file.objectKey, 7 * 24 * 3600))
	}
	return urls
}

/**
 * Sends a paid order to its vendors. Each vendor is re-quoted first: a rise
 * above the drift limit holds the order for Admin instead of selling at a
 * loss. A vendor that refuses the order cancels the rest and refunds in full.
 *
 * Rendering a large set can take minutes, so a run renders for at most
 * `budgetMs` and then hands the order back ('deferred', status `paid`); the
 * print-sync sweep continues it from the cached files.
 */
export async function submitPrintOrder(
	orderId: string,
	options: { ignoreDrift?: boolean; budgetMs?: number } = {},
): Promise<'done' | 'deferred'> {
	// Claim the order first: only one submission runs, and a cancel or refund
	// cannot slip between the vendor call and the status write.
	const claimed = await db
		.update(PrintOrder)
		.set({ status: 'submitting' })
		.where(
			and(
				eq(PrintOrder.id, orderId),
				inArray(PrintOrder.status, ['paid', 'held']),
			),
		)
		.returning({ id: PrintOrder.id })
	if (claimed.length === 0) return 'done'
	try {
		return await submitClaimedOrder(orderId, {
			ignoreDrift: options.ignoreDrift,
			deadline: Date.now() + (options.budgetMs ?? SUBMIT_RENDER_BUDGET_MS),
		})
	} catch (error) {
		await hold(orderId, 'submission_error')
		throw error
	}
}

async function submitClaimedOrder(
	orderId: string,
	options: { ignoreDrift?: boolean; deadline: number },
): Promise<'done' | 'deferred'> {
	const { order, vendorOrders, items } = await getPrintOrderDetail(
		null,
		orderId,
	)
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
	// Phase 1: price and render everything before any vendor is called, so a
	// run that runs out of time hands back an order no vendor has yet.
	const progress = { rendered: 0 }
	const ready: Array<{
		vendorOrder: (typeof pending)[number]
		vendor: ReturnType<typeof getPrintVendor>
		files: VendorItem[]
	}> = []
	for (const vendorOrder of pending) {
		const vendor = getPrintVendor(vendorOrder.vendor as PrintVendorName)
		const mine = items
			.map((row) => row.item)
			.filter((item) => item.vendorOrderId === vendorOrder.id)
		const quoteItems = mine.flatMap((item) => vendorItemsFor(item))
		try {
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
				if (!options.ignoreDrift) {
					await hold(order.id, 'price_drift')
					return 'done'
				}
				// Admin accepted the new price: it becomes the one to compare
				// with, so a resumed submission does not hold the order again.
				await db
					.update(PrintVendorOrder)
					.set({
						wholesaleItemsCents: quote.itemsCents,
						wholesaleShippingCents: quote.shippingCents,
					})
					.where(eq(PrintVendorOrder.id, vendorOrder.id))
			}
			const files: VendorItem[] = []
			for (const item of mine) {
				// Each product and size has its own bleed at the vendor.
				const mapping = await vendorProductFor(item.product, item.sizeKey)
				const urls = await pieceFileUrls(
					order.organizationId,
					item,
					mapping?.bleedMm ?? 3,
					options.deadline,
					progress,
				)
				if (urls === 'deferred') {
					await release(order.id)
					return 'deferred'
				}
				if (!urls) {
					await hold(order.id, 'render_unavailable')
					return 'done'
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
			ready.push({ vendorOrder, vendor, files })
		} catch {
			// Nothing reached a vendor in this run: safe to retry.
			await hold(order.id, 'vendor_unavailable')
			return 'done'
		}
	}

	// Phase 2: send. From the first call on, the order carries the marker
	// until it is recorded as submitted, so a run cut short anywhere in here
	// is held for Admin instead of being resumed as if nothing went out.
	if (ready.length > 0) {
		await db
			.update(PrintOrder)
			.set({ holdReason: VENDOR_SENDING })
			.where(
				and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, 'submitting')),
			)
	}
	for (const { vendorOrder, vendor, files } of ready) {
		try {
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
				return 'done'
			}
			// A timeout or an error after the call may hide an order the vendor
			// did place, so Admin checks the vendor before any retry.
			await hold(order.id, 'vendor_unknown')
			return 'done'
		}
	}
	await db
		.update(PrintOrder)
		.set({ status: 'submitted', holdReason: null })
		.where(
			and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, 'submitting')),
		)
	return 'done'
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
	// Vendor orders cancelled after a partial cancel no longer count.
	const states = vendorOrders
		.map((vendorOrder) => vendorOrder.status as VendorOrderState)
		.filter(
			(state) =>
				state !== 'cancelled' && state !== 'failed' && state !== 'returned',
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
	if (
		['cancelled', 'failed', 'delivered', 'returned'].includes(
			vendorOrder.status,
		)
	) {
		return
	}
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
	const leftVendor =
		Boolean(vendorOrder.shippedAt) ||
		['shipped', 'delivered'].includes(vendorOrder.status)
	if (
		status.state === 'returned' ||
		(leftVendor && (status.state === 'failed' || status.state === 'cancelled'))
	) {
		// Printed and sent, so the vendor has been paid: a parcel that came back
		// (often a wrong address) is Admin's call (reship, part or full refund),
		// never an automatic full refund.
		await db
			.update(PrintOrder)
			.set({
				status: 'held',
				holdReason:
					status.state === 'returned'
						? 'vendor_returned'
						: 'vendor_after_shipping',
			})
			.where(
				and(
					eq(PrintOrder.id, vendorOrder.orderId),
					inArray(PrintOrder.status, [
						'submitted',
						'in_production',
						'shipped',
						'delivered',
					]),
				),
			)
		return
	}
	if (status.state === 'failed' || status.state === 'cancelled') {
		// The vendor dropped a paid order before it shipped: refund in full.
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
const STALE_PAID_MS = 5 * 60_000
const STALE_CLAIM_MS = 15 * 60_000
/** Rendering time the sweep spends per order, and in all. */
const SWEEP_ORDER_BUDGET_MS = 60_000
const SWEEP_TOTAL_BUDGET_MS = 10 * 60_000
/** Rendering time of an Admin retry (its command call times out at 30 s). */
const ADMIN_RETRY_BUDGET_MS = 15_000

/**
 * Picks up orders a request left behind (cut short, or out of rendering time):
 * - a submission claim that never called a vendor goes back to `paid` and is
 *   submitted again, continuing from the cached files;
 * - a claim cut short during a vendor call (or a stuck cancel) is held for
 *   Admin, since that call may or may not have gone through;
 * - paid orders are submitted, oldest touched first. Each run renders at
 *   least one new file or holds on a failed render, so a large set always
 *   finishes; nothing has to give up on it.
 */
async function sweepStalePrintOrders(limit: number) {
	const now = Date.now()
	const staleBefore = new Date(now - STALE_CLAIM_MS)
	const resumed = await db
		.update(PrintOrder)
		.set({ status: 'paid', holdReason: null })
		.where(
			and(
				eq(PrintOrder.status, 'submitting'),
				or(
					isNull(PrintOrder.holdReason),
					ne(PrintOrder.holdReason, VENDOR_SENDING),
				),
				lt(PrintOrder.updatedAt, staleBefore),
			),
		)
		.returning({ id: PrintOrder.id })
	const resumedIds = new Set(resumed.map((row) => row.id))
	await db
		.update(PrintOrder)
		.set({ status: 'held', holdReason: 'stale_claim' })
		.where(
			and(
				inArray(PrintOrder.status, ['submitting', 'cancelling']),
				lt(PrintOrder.updatedAt, staleBefore),
			),
		)
	const paid = await db
		.select({ id: PrintOrder.id, updatedAt: PrintOrder.updatedAt })
		.from(PrintOrder)
		.where(eq(PrintOrder.status, 'paid'))
		.orderBy(asc(PrintOrder.updatedAt))
		.limit(limit)
	const sweepEnd = now + SWEEP_TOTAL_BUDGET_MS
	for (const { id, updatedAt } of paid) {
		// A webhook may still be submitting a fresh one in the background.
		const fresh = updatedAt.getTime() > now - STALE_PAID_MS
		if (fresh && !resumedIds.has(id)) continue
		// Keep going on one large set while there is time left.
		for (;;) {
			const left = sweepEnd - Date.now()
			if (left <= 0) return
			const result = await submitPrintOrder(id, {
				budgetMs: Math.min(SWEEP_ORDER_BUDGET_MS, left),
			}).catch(() => 'done' as const)
			if (result !== 'deferred') break
		}
	}
}

const SHIPPED_FOLLOW_MS = 30 * 24 * 60 * 60_000

export async function syncOpenPrintOrders(limit = 50) {
	await sweepStalePrintOrders(limit).catch(() => null)
	// Not yet shipped first: that is where a vendor-side cancel (and so a
	// refund) can still happen. Shipped orders are followed for delivery for
	// 30 days, never forever, so they cannot crowd out new orders.
	const active = await db
		.select()
		.from(PrintVendorOrder)
		.where(inArray(PrintVendorOrder.status, ['submitted', 'in_production']))
		.orderBy(asc(PrintVendorOrder.lastEventAt))
		.limit(limit)
	const shipped =
		active.length < limit
			? await db
					.select()
					.from(PrintVendorOrder)
					.where(
						and(
							eq(PrintVendorOrder.status, 'shipped'),
							gt(
								PrintVendorOrder.shippedAt,
								new Date(Date.now() - SHIPPED_FOLLOW_MS),
							),
						),
					)
					.orderBy(asc(PrintVendorOrder.lastEventAt))
					.limit(limit - active.length)
			: []
	const open = [...active, ...shipped]
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
	await platformStripe().refunds.create(
		{
			payment_intent: order.stripePaymentIntentId,
			amount: order.totalCents - order.refundCents,
			metadata: { type: PRINT_STRIPE_METADATA_TYPE, orderId: order.id },
		},
		// Keyed on what was refunded before, so a part refunded earlier never
		// collides with this one.
		{ idempotencyKey: `print-refund-${order.id}-from-${order.refundCents}` },
	)
	await db
		.update(PrintOrder)
		.set({ refundCents: order.totalCents, refundedAt: new Date() })
		.where(eq(PrintOrder.id, order.id))
}

async function cancelAtVendors(vendorOrders: VendorOrderRow[]) {
	const live = vendorOrders.filter(
		(vendorOrder) =>
			vendorOrder.vendorOrderId &&
			!['cancelled', 'failed'].includes(vendorOrder.status),
	)
	// All or nothing: if any vendor already started, cancel none, so a cart
	// split across vendors is never half cancelled and fully charged.
	for (const vendorOrder of live) {
		const status = await getPrintVendor(
			vendorOrder.vendor as PrintVendorName,
		).status(vendorOrder.vendorOrderId!)
		if (status.state === 'cancelled' || status.state === 'failed') continue
		if (status.state !== 'submitted') return false
	}
	let cancelledAny = false
	for (const vendorOrder of vendorOrders) {
		if (
			!vendorOrder.vendorOrderId ||
			['cancelled', 'failed'].includes(vendorOrder.status)
		)
			continue
		let result: 'cancelled' | 'too_late'
		try {
			result = await getPrintVendor(
				vendorOrder.vendor as PrintVendorName,
			).cancel(vendorOrder.vendorOrderId)
		} catch (error) {
			// Nothing cancelled yet: the caller may restore and retry. Once one
			// vendor is cancelled, any failure leaves a half-cancelled order.
			if (!cancelledAny) throw error
			result = 'too_late'
		}
		if (result === 'too_late') {
			// Production began between the check and the cancel: some vendors
			// may be cancelled already, so this needs a person (and a partial
			// refund) rather than a retry.
			throw new PrintOrderError(
				409,
				'partial_cancel',
				'Part of this order was already in production. Our team will refund what was cancelled.',
			)
		}
		await db
			.update(PrintVendorOrder)
			.set({ status: 'cancelled' })
			.where(eq(PrintVendorOrder.id, vendorOrder.id))
		cancelledAny = true
	}
	return true
}

async function failAndRefund(orderId: string, reason: string) {
	const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
	if (order.status === 'refunded' || order.status === 'cancelled') return
	const cancelled = await cancelAtVendors(vendorOrders).catch(() => false)
	if (!cancelled) {
		// Some vendor is printing it: a person decides what to refund.
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'partial_cancel' })
			.where(eq(PrintOrder.id, order.id))
		return
	}
	try {
		await refundInFull(order)
	} catch (error) {
		// Vendors are cancelled but the money did not move: hold it for Admin
		// to refund (Admin's retry refuses refund_failed). The hold settles the
		// order, so there is nothing left for the caller to handle.
		console.error(
			`Print order ${order.id} refund failed after cancelling vendors:`,
			error instanceof Error ? error.message : error,
		)
		await db
			.update(PrintOrder)
			.set({
				status: 'held',
				holdReason: 'refund_failed',
				failureReason: reason,
			})
			.where(eq(PrintOrder.id, order.id))
		return
	}
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
	if (order.status === 'submitting' || order.status === 'cancelling') {
		throw busyError()
	}
	if (
		order.status === 'held' &&
		(PRINT_VENDOR_CHECK_HOLDS.includes(order.holdReason ?? '') ||
			PRINT_AFTER_SHIPPING_HOLDS.includes(order.holdReason ?? ''))
	) {
		// A vendor may have the order already, including prints made and shipped.
		// Admin must resolve these holds before anything is refunded.
		throw new PrintOrderError(
			409,
			'needs_support',
			'Our team is checking this order with the printer. It cannot be cancelled here right now.',
		)
	}
	if (!PRINT_SELF_CANCEL_STATUSES.includes(order.status as PrintOrderStatus)) {
		throw new PrintOrderError(
			409,
			'too_late',
			'Production has started, so this order can no longer be cancelled.',
		)
	}
	if (order.status === 'quote' || order.status === 'awaiting_payment') {
		if (order.stripeCheckoutSessionId && order.status === 'awaiting_payment') {
			// A completed session is paid even if the webhook has not landed yet:
			// let the paid path take it instead of cancelling paid money.
			const session = await platformStripe()
				.checkout.sessions.retrieve(order.stripeCheckoutSessionId)
				.catch(() => null)
			if (session?.status === 'complete') throw busyError()
			await platformStripe()
				.checkout.sessions.expire(order.stripeCheckoutSessionId)
				.catch(() => null)
		}
		const cancelled = await db
			.update(PrintOrder)
			.set({ status: 'cancelled', cancelledAt: new Date() })
			.where(
				and(
					eq(PrintOrder.id, order.id),
					inArray(PrintOrder.status, ['quote', 'awaiting_payment']),
				),
			)
			.returning({ id: PrintOrder.id })
		// Paid in the meantime: the paid path owns it now.
		if (cancelled.length === 0) throw busyError()
		return
	}
	// Claim it from the exact state we saw: a submission in flight holds the
	// order as `submitting`, so a cancel never races a vendor order.
	const claimed = await db
		.update(PrintOrder)
		.set({ status: 'cancelling' })
		.where(
			and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, order.status)),
		)
		.returning({ id: PrintOrder.id })
	if (claimed.length === 0) throw busyError()
	const restore = () =>
		db
			.update(PrintOrder)
			.set({ status: order.status })
			.where(
				and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, 'cancelling')),
			)
	let cancelledAtVendors = false
	try {
		cancelledAtVendors = await cancelAtVendors(vendorOrders)
	} catch (error) {
		if (error instanceof PrintOrderError && error.code === 'partial_cancel') {
			await db
				.update(PrintOrder)
				.set({ status: 'held', holdReason: 'partial_cancel' })
				.where(eq(PrintOrder.id, order.id))
		} else {
			await restore()
		}
		throw error
	}
	if (!cancelledAtVendors) {
		await restore()
		throw new PrintOrderError(
			409,
			'too_late',
			'Production has started, so this order can no longer be cancelled.',
		)
	}
	try {
		await refundInFull(order)
	} catch (error) {
		// Vendors are cancelled but the money did not move: Admin refunds it.
		await db
			.update(PrintOrder)
			.set({ status: 'held', holdReason: 'refund_failed' })
			.where(eq(PrintOrder.id, order.id))
		throw error
	}
	await db
		.update(PrintOrder)
		.set({
			status: 'refunded',
			cancelledAt: new Date(),
			failureReason: 'cancelled_by_operator',
		})
		.where(eq(PrintOrder.id, order.id))
}

function busyError() {
	return new PrintOrderError(
		409,
		'order_busy',
		'This order is changing right now. Refresh and try again.',
	)
}

const ADMIN_REFUND_REFUSED = [
	'quote',
	'awaiting_payment',
	'cancelled',
	'refunded',
]

/**
 * Admin refunds. In full: vendor orders still waiting are cancelled first;
 * if a vendor already started, Admin must say the vendor keeps printing
 * (`keepPrinting`, e.g. a defect claim or a lost parcel), so the platform never
 * refunds in full by accident while still paying the vendor. A part
 * (`amountCents`, e.g. what was cancelled after `partial_cancel`) leaves the
 * order printing and clears its hold.
 */
export async function adminRefundPrintOrder(
	orderId: string,
	options: {
		keepPrinting?: boolean
		amountCents?: number
		checkedVendor?: boolean
	} = {},
) {
	const { order, vendorOrders } = await getPrintOrderDetail(null, orderId)
	if (ADMIN_REFUND_REFUSED.includes(order.status)) {
		throw new PrintOrderError(
			409,
			'not_refundable',
			'Only a paid order can be refunded. An unpaid one is cancelled instead.',
		)
	}
	if (order.status === 'submitting' || order.status === 'cancelling') {
		throw busyError()
	}
	if (!order.stripePaymentIntentId) {
		throw new PrintOrderError(
			409,
			'not_refundable',
			'This order has no payment to refund.',
		)
	}
	if (
		PRINT_VENDOR_CHECK_HOLDS.includes(order.holdReason ?? '') &&
		!options.checkedVendor
	) {
		// A vendor may hold an order we never recorded: refunding without a
		// look would leave the platform paying for prints nobody pays for.
		throw new PrintOrderError(
			409,
			'check_vendor',
			'The vendor may already have this order. Search the vendor dashboard for its references first, and cancel it there if found.',
		)
	}
	if (options.amountCents !== undefined) {
		if (order.holdReason !== 'partial_cancel') {
			throw new PrintOrderError(
				409,
				'not_partial',
				'Only an order held after a partial cancel can be refunded in part.',
			)
		}
		await adminPartialRefund(order, vendorOrders, options.amountCents)
		return
	}
	// Claim from the state we saw, so a submission cannot start meanwhile.
	const claimed = await db
		.update(PrintOrder)
		.set({ status: 'cancelling' })
		.where(
			and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, order.status)),
		)
		.returning({ id: PrintOrder.id })
	if (claimed.length === 0) throw busyError()
	const restore = () =>
		db
			.update(PrintOrder)
			.set({ status: order.status })
			.where(
				and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, 'cancelling')),
			)
	let vendorsCancelled = false
	try {
		const cancelled = await cancelAtVendors(vendorOrders)
		if (!cancelled && !options.keepPrinting) {
			throw new PrintOrderError(
				409,
				'vendor_printing',
				`A vendor already started printing this order. Refund anyway only if the vendor should keep printing and shipping at ${brand.name}'s cost.`,
			)
		}
		vendorsCancelled = cancelled
		await refundInFull(order)
	} catch (error) {
		if (vendorsCancelled) {
			// Vendors are cancelled but the money did not move: never put the
			// order back as if it were still printing.
			await db
				.update(PrintOrder)
				.set({ status: 'held', holdReason: 'refund_failed' })
				.where(eq(PrintOrder.id, order.id))
		} else if (
			error instanceof PrintOrderError &&
			error.code === 'partial_cancel'
		) {
			await db
				.update(PrintOrder)
				.set({ status: 'held', holdReason: 'partial_cancel' })
				.where(eq(PrintOrder.id, order.id))
		} else {
			await restore()
		}
		throw error
	}
	await db
		.update(PrintOrder)
		.set({
			status: 'refunded',
			refundedAt: new Date(),
			failureReason: order.failureReason ?? 'refunded_by_admin',
		})
		.where(eq(PrintOrder.id, order.id))
	await notifyPrintOrder(order.id, 'failed')
}

async function adminPartialRefund(
	order: OrderRow,
	vendorOrders: VendorOrderRow[],
	amountCents: number,
) {
	const remaining = order.totalCents - order.refundCents
	if (
		!Number.isInteger(amountCents) ||
		amountCents <= 0 ||
		amountCents > remaining
	) {
		throw new PrintOrderError(
			422,
			'invalid_amount',
			'Enter an amount above zero and no more than what is left to refund.',
		)
	}
	// Claim the refunded total we saw: a second click (or a second admin)
	// cannot refund the same part twice.
	const claimed = await db
		.update(PrintOrder)
		.set({
			refundCents: order.refundCents + amountCents,
			refundedAt: new Date(),
		})
		.where(
			and(
				eq(PrintOrder.id, order.id),
				eq(PrintOrder.refundCents, order.refundCents),
			),
		)
		.returning({ id: PrintOrder.id })
	if (claimed.length === 0) throw busyError()
	try {
		await platformStripe().refunds.create(
			{
				payment_intent: order.stripePaymentIntentId!,
				amount: amountCents,
				metadata: { type: PRINT_STRIPE_METADATA_TYPE, orderId: order.id },
			},
			{ idempotencyKey: `print-refund-${order.id}-from-${order.refundCents}` },
		)
	} catch (error) {
		await db
			.update(PrintOrder)
			.set({ refundCents: order.refundCents })
			.where(
				and(
					eq(PrintOrder.id, order.id),
					eq(PrintOrder.refundCents, order.refundCents + amountCents),
				),
			)
		throw error
	}
	// The rest keeps printing: track it again instead of holding it, but only
	// when nothing is still waiting to be sent (that stays held for Admin).
	if (
		order.status === 'held' &&
		!vendorOrders.some((vendorOrder) => vendorOrder.status === 'pending')
	) {
		await db
			.update(PrintOrder)
			.set({ status: 'submitted', holdReason: null })
			.where(and(eq(PrintOrder.id, order.id), eq(PrintOrder.status, 'held')))
		await rollUp(order.id)
	}
}

/**
 * Admin found the order on the vendor's dashboard after a `vendor_unknown`
 * (or stale) hold: record the vendor's order id instead of placing it again,
 * so tracking, cancel and refunds see it. The order goes back to tracking
 * once nothing is left to send.
 */
export async function adminRecordVendorOrder(
	orderId: string,
	vendorOrders: Array<{ id: string; vendorOrderId: string }>,
) {
	const detail = await getPrintOrderDetail(null, orderId)
	if (
		detail.order.status !== 'held' ||
		!PRINT_VENDOR_CHECK_HOLDS.includes(detail.order.holdReason ?? '')
	) {
		// A refund case (refund_failed, partial_cancel) must not lose its hold.
		throw new PrintOrderError(
			409,
			'not_held',
			'Only an order held while its vendor order is unknown can be updated this way.',
		)
	}
	for (const entry of vendorOrders) {
		const row = detail.vendorOrders.find(
			(vendorOrder) => vendorOrder.id === entry.id,
		)
		if (!row || row.status !== 'pending') {
			throw new PrintOrderError(
				409,
				'not_pending',
				'That vendor order is not waiting to be sent.',
			)
		}
		// The id must exist at that vendor: a typo would track nothing.
		const found = await getPrintVendor(row.vendor as PrintVendorName)
			.status(entry.vendorOrderId)
			.then(() => true)
			.catch(() => false)
		if (!found) {
			throw new PrintOrderError(
				422,
				'vendor_order_not_found',
				'The vendor does not know that order id. Check it and try again.',
			)
		}
	}
	for (const entry of vendorOrders) {
		await db
			.update(PrintVendorOrder)
			.set({
				vendorOrderId: entry.vendorOrderId,
				status: 'submitted',
				submittedAt: new Date(),
				error: null,
			})
			.where(
				and(
					eq(PrintVendorOrder.id, entry.id),
					eq(PrintVendorOrder.status, 'pending'),
				),
			)
	}
	const { vendorOrders: fresh } = await getPrintOrderDetail(null, orderId)
	if (!fresh.some((vendorOrder) => vendorOrder.status === 'pending')) {
		await db
			.update(PrintOrder)
			.set({ status: 'submitted', holdReason: null })
			.where(and(eq(PrintOrder.id, orderId), eq(PrintOrder.status, 'held')))
		await rollUp(orderId)
	}
}

export async function adminRetryPrintOrder(
	orderId: string,
	acceptPrice: boolean,
	options: { checkedVendor?: boolean } = {},
): Promise<'done' | 'deferred'> {
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
	if (
		order.holdReason === 'refund_failed' ||
		order.holdReason === 'partial_cancel'
	) {
		throw new PrintOrderError(
			409,
			'refund_needed',
			'Vendors were cancelled for this order: refund it instead of retrying.',
		)
	}
	if (PRINT_AFTER_SHIPPING_HOLDS.includes(order.holdReason ?? '')) {
		throw new PrintOrderError(
			409,
			'shipped_already',
			'The prints were made and shipped: reship through the vendor or refund it.',
		)
	}
	if (
		PRINT_VENDOR_CHECK_HOLDS.includes(order.holdReason ?? '') &&
		!options.checkedVendor
	) {
		throw new PrintOrderError(
			409,
			'check_vendor',
			'The vendor may already have this order. Search the vendor dashboard for its references first, then retry.',
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
	// One short run fits Admin's command call; a large set that is handed
	// back continues after the answer (`continueAfter`) and in the sweep.
	return submitPrintOrder(order.id, {
		ignoreDrift: acceptPrice,
		budgetMs: ADMIN_RETRY_BUDGET_MS,
	})
}

// ---------------------------------------------------------------------------
// Notifications (email + in-app to the person who placed the order)
// ---------------------------------------------------------------------------

export type PrintNotificationKind = 'paid' | 'shipped' | 'failed'

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
			// Webhooks and jobs run without a request language: use the source.
			if (!i18n.locale) await loadCatalog('en')
			const copy = PRINT_EMAIL_COPY[kind]
			const headline = i18n._(copy.headline)
			await sendEmail({
				to: row.email,
				subject: headline,
				react: createElement(StaffingAlertEmail, {
					eyebrow: i18n._(PRINT_EMAIL_EYEBROW),
					headline,
					detail: i18n._(copy.detail),
					actionLabel: i18n._(PRINT_EMAIL_ACTION),
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

/**
 * Keeps submitting an order handed back for lack of time, for about as long
 * as a Worker may run after its answer; the print-sync sweep does the rest.
 */
export async function continuePrintSubmission(orderId: string) {
	const end = Date.now() + 25_000
	for (;;) {
		const left = end - Date.now()
		if (left <= 0) return
		const result = await submitPrintOrder(orderId, { budgetMs: left })
		if (result !== 'deferred') return
	}
}
