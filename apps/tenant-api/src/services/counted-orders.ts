import { sql } from 'drizzle-orm'

/**
 * Counted online orders: ids, the guest, when (seconds), and the amount that
 * stays after refunds. One row per order.
 */
export function countedOrders(): ReturnType<typeof sql> {
	return sql`(
		SELECT ro.id AS id,
			ro.customer_id AS customer_id,
			ro.created_at AS ts,
			MAX(ro.total_cents - MAX(ro.refunded_cents - ro.refund_reversed_cents, 0), 0) AS net,
			json_extract(ro.attribution, '$.campaignId') AS campaign_id,
			json_extract(ro.attribution, '$.stepId') AS step_id,
			json_extract(ro.attribution, '$.shortLinkId') AS short_link_id
		FROM restaurant_orders ro
		WHERE ro.is_test = 0
			AND ro.status IN ('accepted', 'preparing', 'ready', 'completed')
			AND (ro.payment_status = 'paid' OR ro.status = 'completed')
	)`
}
