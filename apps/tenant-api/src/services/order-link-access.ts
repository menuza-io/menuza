import {
	getTenantDb,
	restaurantOrders,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'

import { runInBackground } from '../lib/background.ts'
import { verifyOrderLinkToken } from '../lib/order-link.ts'
import { sweepExpiredHolds, verifyReceiptToken } from './order-service.ts'

/**
 * Guest access to one order by either of its capabilities: the receipt token
 * (`Authorization: Bearer`, returned at placement) or the "View your order"
 * link token (`X-Order-Link`, from the URL fragment of the email link; see
 * `lib/order-link.ts`). Either one grants read-only access to that order's
 * receipt and the receipt re-send; neither signs anyone in, and the link token
 * opens nothing else (payment, tabs, quotes and every write keep their own
 * capabilities).
 */

export const ORDER_LINK_HEADER = 'X-Order-Link'

/**
 * A link token is 64 hex characters. Anything much longer is refused before
 * any hashing or database work.
 */
export const MAX_ORDER_LINK_HEADER_LENGTH = 128

export type GuestOrderCredentials = {
	/** The Bearer value, or '' when none was sent. */
	receiptToken: string
	/** The `X-Order-Link` value, or null when the header was not sent. */
	linkToken: string | null
}

export type GuestOrderAccess =
	{ ok: true; order: RestaurantOrder; via: 'receipt' | 'link' } | { ok: false }

/** The `X-Order-Link` header, or null when absent or blank. */
export function readOrderLinkHeader(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim()
	return trimmed ? trimmed : null
}

/**
 * Whether the credentials open `orderId` in `orgId`, with the order row when
 * they do. Every refusal is the same `{ ok: false }`: a forged, tampered,
 * expired (90 days after the order was placed), erased, other-order or
 * other-organization token reads exactly like an unknown order. Apart from an
 * over-long link header (refused without work), a presented link token always
 * costs the same hold sweep and order read, valid or not.
 */
export async function authorizeGuestOrder(
	orgId: string,
	orderId: string,
	credentials: GuestOrderCredentials,
	now: number = Date.now(),
): Promise<GuestOrderAccess> {
	const { receiptToken, linkToken } = credentials
	if (linkToken !== null && linkToken.length > MAX_ORDER_LINK_HEADER_LENGTH) {
		return { ok: false }
	}
	if (!receiptToken && linkToken === null) return { ok: false }
	const receiptValid =
		receiptToken !== '' && verifyReceiptToken(orgId, orderId, receiptToken)
	const db = await getTenantDb(orgId)
	// The same sweep the receipt read runs, so the status shown is current.
	await sweepExpiredHolds(orgId)
	const [order] = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(eq(restaurantOrders.id, orderId), eq(restaurantOrders.orgId, orgId)),
		)
		.limit(1)
	if (!order) return { ok: false }
	if (receiptValid) return { ok: true, order, via: 'receipt' }
	if (
		linkToken !== null &&
		verifyOrderLinkToken({
			orgId,
			orderId,
			presented: linkToken,
			createdAt: order.createdAt,
			receiptTokenHash: order.receiptTokenHash,
			now,
		})
	) {
		return { ok: true, order, via: 'link' }
	}
	return { ok: false }
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
