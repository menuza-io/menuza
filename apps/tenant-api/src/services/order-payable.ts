import { eq, inArray, or, type SQL } from 'drizzle-orm'
import { restaurantOrders } from '@repo/tenant-db'

/**
 * Payment statuses that let a website order go ahead: paid online, or
 * `not_required` (a free order, nothing to pay after discounts).
 */
export const PAYABLE_PAYMENT_STATUSES = ['paid', 'not_required'] as const

/**
 * Whether a website order is payable: handoff orders right away, online
 * orders after payment succeeds or when no payment was due. The one rule the
 * kitchen display, reports, customer history and staffing demand share.
 */
export function isPayableOrder(order: {
	paymentMethod: string
	paymentStatus: string
}) {
	return (
		order.paymentMethod === 'handoff' ||
		(PAYABLE_PAYMENT_STATUSES as readonly string[]).includes(
			order.paymentStatus,
		)
	)
}

/** The same rule as {@link isPayableOrder}, as a WHERE clause. */
export function payableOrderCondition(): SQL {
	return or(
		eq(restaurantOrders.paymentMethod, 'handoff'),
		inArray(restaurantOrders.paymentStatus, [...PAYABLE_PAYMENT_STATUSES]),
	)!
}
