import { sql, type SQL } from 'drizzle-orm'

/**
 * The orders that count for marketing (#98, #99): the one source audiences and
 * order journeys share, so "an order" means the same everywhere.
 *
 * - A website order counts like it does for loyalty and inventory: it is
 *   accepted, preparing, ready or completed AND payable (paid online, a free
 *   order, or pay at pickup). Cancelled, expired and payment-review orders never
 *   count, and an order refunded in full (net of reversed provider refunds)
 *   stops counting.
 * - A Station sale counts when it is paid, not fully refunded, and its
 *   `customer_phone` is the verified phone of a customer (the only way a till
 *   sale is linked to a guest). A first Station sale counts as a first order.
 *
 * Columns: `customer_id`, `ts` (ms), `net` (minor units, refunds taken off),
 * `location_id`, `order_ref` (`web:<id>` or `pos:<id>`), `completed` (1 when the
 * order is finished: a completed website order, a paid Station sale).
 *
 * Money never leaves this subquery as a name or contact: it carries ids, times
 * and amounts only.
 */
export function countedOrdersSql(): SQL {
	return sql`(
		SELECT ro.customer_id AS customer_id,
			ro.created_at * 1000 AS ts,
			MAX(ro.total_cents - MAX(ro.refunded_cents - ro.refund_reversed_cents, 0), 0) AS net,
			ro.location_id AS location_id,
			'web:' || ro.id AS order_ref,
			CASE WHEN ro.status = 'completed' THEN 1 ELSE 0 END AS completed
		FROM restaurant_orders ro
		WHERE ro.customer_id IS NOT NULL
			AND ro.is_test = 0
			AND ro.status IN ('accepted', 'preparing', 'ready', 'completed')
			AND (ro.payment_method = 'handoff' OR ro.payment_status IN ('paid', 'not_required'))
			AND (ro.refunded_cents - ro.refund_reversed_cents) < MAX(ro.total_cents, 1)
		UNION ALL
		SELECT c.id AS customer_id,
			po.rung_up_at AS ts,
			MAX(po.total_cents - po.refunded_cents, 0) AS net,
			po.location_id AS location_id,
			'pos:' || po.id AS order_ref,
			1 AS completed
		FROM pos_orders po
		JOIN customers c ON c.phone = po.customer_phone AND c.phone IS NOT NULL
		WHERE po.status = 'paid'
			AND po.refunded_cents < MAX(po.total_cents, 1)
	)`
}

export const DAY_MS = 24 * 60 * 60_000
