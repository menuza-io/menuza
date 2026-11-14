import {
	getTenantDb,
	restaurantOrders,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'

import { runInBackground } from '../lib/background.ts'
import { verifyOrderLinkToken } from '../lib/order-link.ts'
import {
	receiptOrder,
	sweepExpiredHolds,
	verifyReceiptToken,
} from './order-service.ts'

/**
 * Guest access to one order by either of its capabilities: the receipt token
 * (`Authorization: Bearer`, returned at placement) or the "View your order"
 * link token (`X-Order-Link`, from the URL fragment of the email link; see
 * `lib/order-link.ts`). Either one grants read-only access to that order's
 * receipt and the receipt re-send; neither signs anyone in, and the link token
 * opens nothing else (payment, tabs, quotes and every write keep their own
 * capabilities). A link-token read gets `linkReceiptOrder`: no contact
 * details, no delivery address, no free-text line instructions.
 */

export const ORDER_LINK_HEADER = 'X-Order-Link'

/**
 * A link token is exactly what `deriveOrderLinkToken` (`lib/order-link.ts`)
 * emits: a lowercase hex HMAC-SHA256. Any other value is refused before any
 * database work, so an anonymous caller cannot make the node open the tenant
 * database, sweep holds or read an order with a junk header.
 */
const ORDER_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/

export type GuestOrderCredentials = {
	/** The Bearer value, or '' when none was sent. */
	receiptToken: string
	/** The `X-Order-Link` value, or null when the header was not sent. */
	linkToken: string | null
}

/**
 * `via` says which credential was verified: `receipt` (the Bearer receipt
 * token the placing device holds) wins when both are valid; `link` means only
 * the forwardable link token was, and the caller must answer with
 * `linkReceiptOrder`, never the full receipt.
 */
export type GuestOrderAccess =
	{ ok: true; order: RestaurantOrder; via: 'receipt' | 'link' } | { ok: false }

/** The `X-Order-Link` header, or null when absent or blank. */
export function readOrderLinkHeader(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

async function readOrder(orgId: string, orderId: string) {
	const db = await getTenantDb(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	return order ?? null
}

/**
 * Whether the credentials open `orderId` in `orgId`, with the order row when
 * they do. Every refusal is the same `{ ok: false }`: a forged, tampered,
 * expired (90 days after the order was placed), erased, other-order or
 * other-organization token reads exactly like an unknown order.
 *
 * Nothing touches the database unless the receipt token verifies (an HMAC
 * check) or the link header is well formed. A well-formed link token costs one
 * order read; the hold sweep (a write) runs only after it verified, and the
 * order is read again so the status shown is current, exactly as the receipt
 * read does.
 */
export async function authorizeGuestOrder(
	orgId: string,
	orderId: string,
	credentials: GuestOrderCredentials,
	now: number = Date.now(),
): Promise<GuestOrderAccess> {
	const { receiptToken, linkToken } = credentials
	const receiptValid =
		receiptToken !== '' && verifyReceiptToken(orgId, orderId, receiptToken)
	if (receiptValid) {
		// The same sweep the receipt read runs, so the status shown is current.
		await sweepExpiredHolds(orgId)
		const order = await readOrder(orgId, orderId)
		return order ? { ok: true, order, via: 'receipt' } : { ok: false }
	}
	if (linkToken === null || !ORDER_LINK_TOKEN_PATTERN.test(linkToken)) {
		return { ok: false }
	}
	const candidate = await readOrder(orgId, orderId)
	if (
		!candidate ||
		!verifyOrderLinkToken({
			orgId,
			orderId,
			presented: linkToken,
			createdAt: candidate.createdAt,
			receiptTokenHash: candidate.receiptTokenHash,
			now,
		})
	) {
		return { ok: false }
	}
	await sweepExpiredHolds(orgId)
	const order = await readOrder(orgId, orderId)
	return order ? { ok: true, order, via: 'link' } : { ok: false }
}

/**
 * The receipt as a link-token read sees it. The link is emailed and texted,
 * so it gets forwarded and kept: this body carries nothing that names,
 * reaches or locates the guest. Built as an allow-list, so a key added to
 * `receiptOrder` later stays out until someone decides it is safe here.
 *
 * Against `receiptOrder`: no `contact` key; `delivery` keeps only `feeCents`
 * and `zoneId` (no address, city, unit, postal code or notes) and is null when
 * the order is not a delivery; every line's free-text `instructions` is null
 * (guests write allergies, names and phone numbers there). Everything else is
 * the same.
 */
export function linkReceiptOrder(order: RestaurantOrder) {
	const full = receiptOrder(order)
	return {
		id: full.id,
		number: full.number,
		status: full.status,
		paymentStatus: full.paymentStatus,
		currency: full.currency,
		subtotalCents: full.subtotalCents,
		taxCents: full.taxCents,
		deliveryFeeCents: full.deliveryFeeCents,
		tipCents: full.tipCents,
		loyaltyDiscountCents: full.loyaltyDiscountCents,
		discountCents: full.discountCents,
		deliveryDiscountCents: full.deliveryDiscountCents,
		discounts: full.discounts,
		totalCents: full.totalCents,
		holdExpiresAt: full.holdExpiresAt,
		promisedAt: full.promisedAt,
		promisedUntil: full.promisedUntil,
		tipPercent: full.tipPercent,
		refundedCents: full.refundedCents,
		fulfillment: full.fulfillment,
		locale: full.locale,
		createdAt: full.createdAt,
		scheduledFor: full.scheduledFor,
		location: full.location,
		pickup: full.pickup,
		drop: full.drop,
		table: full.table,
		tabId: full.tabId,
		source: full.source,
		lines: full.lines.map((line) => ({ ...line, instructions: null })),
		delivery: full.delivery
			? { feeCents: full.delivery.feeCents, zoneId: full.delivery.zoneId }
			: null,
	}
}

const inFlight = new Set<Promise<void>>()

/** Tests: waits for receipt re-sends started by `resendReceiptInBackground`. */
export async function orderLinkResendsIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}

/**
 * Re-sends the receipt email after the response, so neither the answer nor
 * its timing says whether the order has an email address. The outcome is not
 * reported to the guest; `sendOrderReceiptNow` logs failures by id only.
 */
export function resendReceiptInBackground(
	orgId: string,
	orderId: string,
): void {
	const work = (async () => {
		try {
			const { sendOrderReceiptNow } = await import('./order-message-send.ts')
			await sendOrderReceiptNow(orgId, orderId)
		} catch (error) {
			console.warn(
				'Order receipt resend not started',
				orgId,
				orderId,
				error instanceof Error ? error.name : 'unknown',
			)
		}
	})().finally(() => {
		inFlight.delete(work)
	})
	inFlight.add(work)
	runInBackground(work)
}
