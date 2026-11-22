import { inArray, sql } from 'drizzle-orm'
import {
	buildOrderAttribution,
	REACHED_WINDOW_MS,
	type BuiltAttribution,
	type OrderAttributionInput,
} from '@repo/common/order-attribution'
import {
	getTenantDb,
	marketingCampaigns,
	marketingJourneys,
	type TenantDatabase,
} from '@repo/tenant-db'
import { queryInChunks } from '../lib/chunked-in.ts'
import { countedOrders } from './counted-orders.ts'
import { shortLinkExists } from './short-links.ts'

/**
 * Attribution of online orders to Menuza campaigns (#115), counted in the
 * region from what an order stored (`attribution`, `attribution_source`) and
 * the messages that were sent (`marketing_messages`). Counts and amounts only
 * leave here: never a guest, a message or a contact.
 *
 * Two views of the same orders, never the same number twice:
 * - **Clicked**: the order carries a campaign (`mzc`) or a short link of a
 *   message: the guest followed a link from it.
 * - **Reached**: Clicked, plus orders of guests who were sent a message in the
 *   14 days before ordering. Each such order is credited to the guest's most
 *   recent message, once. Reached is the union, so it is never below Clicked.
 *
 * Revenue counts an online order when it is paid or completed, and takes off
 * what was refunded (net of provider refunds that were reversed). A cancelled,
 * expired or rejected order does not count at all. Station sales are not
 * attributed.
 */

const DAY_S = 24 * 60 * 60
const REACHED_S = Math.round(REACHED_WINDOW_MS / 1000)

/** What a new order stores, with the short link checked against this region. */
export async function attributionForNewOrder(
	orgId: string,
	input: {
		orderSource: 'qr_table' | 'qr_poster' | null
		attribution: OrderAttributionInput | null | undefined
		couponCode?: string | null
		now: number
	},
): Promise<BuiltAttribution> {
	let shortLinkKnown = false
	let campaignKnown = false
	let stepKnown = false
	const touch = input.attribution
	if (touch?.shortLinkId || touch?.campaignId) {
		const db = await getTenantDb(orgId)
		if (touch.shortLinkId) {
			shortLinkKnown = await shortLinkExists(db, touch.shortLinkId)
		}
		if (touch.campaignId) {
			campaignKnown = (await campaignNamesById(db, [touch.campaignId])).has(
				touch.campaignId,
			)
			if (campaignKnown && touch.stepId) {
				const rows = await db.all<Row>(sql`
					SELECT 1 AS ok FROM journey_step_executions
					WHERE journey_id = ${touch.campaignId} AND node_id = ${touch.stepId}
					LIMIT 1
				`)
				stepKnown = rows.length > 0
			}
		}
	}
	return buildOrderAttribution({
		...input,
		shortLinkKnown,
		campaignKnown,
		stepKnown,
	})
}

/** The currency most of this region's online orders were placed in (ISO, lower case). */
export async function orderCurrency(db: TenantDatabase): Promise<string> {
	const rows = await db.all<Row>(sql`
		SELECT currency FROM restaurant_orders
		GROUP BY currency ORDER BY COUNT(*) DESC LIMIT 1
	`)
	const value = rows[0]?.currency
	return typeof value === 'string' && value ? value.toLowerCase() : 'usd'
}

export type AttributionTotals = { orders: number; revenueMinor: number }
export type OverviewAttribution = {
	days: number
	/** What the revenue is in (ISO code). */
	currency: string
	/** Marketing messages sent in the period (email, text and push). */
	messagesSent: number
	/** Different guests those messages went to. */
	guestsReached: number
	clicked: AttributionTotals
	reached: AttributionTotals
}

type Row = Record<string, unknown>
const num = (value: unknown) => Number(value ?? 0)

/**
 * The overview for the last `days` days: messages sent, unique guests reached,
 * and orders and revenue both ways.
 */
export async function overviewAttribution(
	db: TenantDatabase,
	input: { days: number; now?: number },
): Promise<OverviewAttribution> {
	const nowS = Math.floor((input.now ?? Date.now()) / 1000)
	const from = nowS - input.days * DAY_S

	const sent = await db.all<Row>(sql`
		SELECT COUNT(*) AS messages, COUNT(DISTINCT customer_id) AS guests
		FROM marketing_messages
		WHERE status NOT IN ('Failed', 'Processing', 'Unknown')
			AND sent_at >= ${from} AND sent_at <= ${nowS}
	`)

	// Orders in the period, each with the id of the message it is credited to
	// when the guest was reached (their most recent message in the 14 days
	// before) and whether it carries a click.
	const totals = await db.all<Row>(sql`
		WITH counted AS (
			SELECT * FROM ${countedOrders()} WHERE ts >= ${from} AND ts <= ${nowS}
		),
		credited AS (
			SELECT c.id AS order_id,
				ROW_NUMBER() OVER (
					PARTITION BY c.id ORDER BY mm.sent_at DESC, mm.id DESC
				) AS rn
			FROM counted c
			JOIN marketing_messages mm ON mm.customer_id = c.customer_id
			WHERE mm.status NOT IN ('Failed', 'Processing', 'Unknown')
				AND mm.sent_at <= c.ts AND c.ts - mm.sent_at <= ${REACHED_S}
		)
		SELECT
			SUM(CASE WHEN c.campaign_id IS NOT NULL OR c.short_link_id IS NOT NULL THEN 1 ELSE 0 END) AS clicked_orders,
			SUM(CASE WHEN c.campaign_id IS NOT NULL OR c.short_link_id IS NOT NULL THEN c.net ELSE 0 END) AS clicked_net,
			SUM(CASE WHEN c.campaign_id IS NOT NULL OR c.short_link_id IS NOT NULL OR r.order_id IS NOT NULL THEN 1 ELSE 0 END) AS reached_orders,
			SUM(CASE WHEN c.campaign_id IS NOT NULL OR c.short_link_id IS NOT NULL OR r.order_id IS NOT NULL THEN c.net ELSE 0 END) AS reached_net
		FROM counted c
		LEFT JOIN credited r ON r.order_id = c.id AND r.rn = 1
	`)
	const row = totals[0] ?? {}
	return {
		days: input.days,
		currency: await orderCurrency(db),
		messagesSent: num(sent[0]?.messages),
		guestsReached: num(sent[0]?.guests),
		clicked: {
			orders: num(row.clicked_orders),
			revenueMinor: num(row.clicked_net),
		},
		reached: {
			orders: num(row.reached_orders),
			revenueMinor: num(row.reached_net),
		},
	}
}

/** One broadcast's orders and revenue, both ways. */
export async function campaignAttribution(
	db: TenantDatabase,
	campaignId: string,
): Promise<{
	currency: string
	clicked: AttributionTotals
	reached: AttributionTotals
}> {
	const rows = await db.all<Row>(sql`
		WITH counted AS (SELECT * FROM ${countedOrders()}),
		credited AS (
			SELECT c.id AS order_id, mm.campaign_id AS campaign_id,
				ROW_NUMBER() OVER (
					PARTITION BY c.id ORDER BY mm.sent_at DESC, mm.id DESC
				) AS rn
			FROM counted c
			JOIN marketing_messages mm ON mm.customer_id = c.customer_id
			WHERE mm.status NOT IN ('Failed', 'Processing', 'Unknown')
				AND mm.sent_at <= c.ts AND c.ts - mm.sent_at <= ${REACHED_S}
		)
		SELECT
			SUM(CASE WHEN c.campaign_id = ${campaignId} THEN 1 ELSE 0 END) AS clicked_orders,
			SUM(CASE WHEN c.campaign_id = ${campaignId} THEN c.net ELSE 0 END) AS clicked_net,
			SUM(CASE WHEN c.campaign_id = ${campaignId} OR r.campaign_id = ${campaignId} THEN 1 ELSE 0 END) AS reached_orders,
			SUM(CASE WHEN c.campaign_id = ${campaignId} OR r.campaign_id = ${campaignId} THEN c.net ELSE 0 END) AS reached_net
		FROM counted c
		LEFT JOIN credited r ON r.order_id = c.id AND r.rn = 1
	`)
	const row = rows[0] ?? {}
	return {
		currency: await orderCurrency(db),
		clicked: {
			orders: num(row.clicked_orders),
			revenueMinor: num(row.clicked_net),
		},
		reached: {
			orders: num(row.reached_orders),
			revenueMinor: num(row.reached_net),
		},
	}
}

export type StepAttribution = {
	nodeId: string
	clicked: AttributionTotals
	reached: AttributionTotals
}

/** An automation's orders and revenue per step, both ways. */
export async function journeyStepAttribution(
	db: TenantDatabase,
	journeyId: string,
): Promise<StepAttribution[]> {
	const rows = await db.all<Row>(sql`
		WITH counted AS (SELECT * FROM ${countedOrders()}),
		credited AS (
			SELECT c.id AS order_id, jse.node_id AS node_id, jse.journey_id AS journey_id,
				ROW_NUMBER() OVER (
					PARTITION BY c.id ORDER BY mm.sent_at DESC, mm.id DESC
				) AS rn
			FROM counted c
			JOIN marketing_messages mm ON mm.customer_id = c.customer_id
			JOIN journey_step_executions jse ON jse.id = mm.journey_step_execution_id
			WHERE mm.status NOT IN ('Failed', 'Processing', 'Unknown')
				AND mm.sent_at <= c.ts AND c.ts - mm.sent_at <= ${REACHED_S}
		),
		steps AS (
			SELECT DISTINCT node_id FROM journey_step_executions WHERE journey_id = ${journeyId}
		)
		SELECT s.node_id AS node_id,
			COALESCE(SUM(CASE WHEN c.campaign_id = ${journeyId} AND c.step_id = s.node_id THEN 1 ELSE 0 END), 0) AS clicked_orders,
			COALESCE(SUM(CASE WHEN c.campaign_id = ${journeyId} AND c.step_id = s.node_id THEN c.net ELSE 0 END), 0) AS clicked_net,
			COALESCE(SUM(CASE WHEN (c.campaign_id = ${journeyId} AND c.step_id = s.node_id)
				OR (r.journey_id = ${journeyId} AND r.node_id = s.node_id) THEN 1 ELSE 0 END), 0) AS reached_orders,
			COALESCE(SUM(CASE WHEN (c.campaign_id = ${journeyId} AND c.step_id = s.node_id)
				OR (r.journey_id = ${journeyId} AND r.node_id = s.node_id) THEN c.net ELSE 0 END), 0) AS reached_net
		FROM steps s
		LEFT JOIN counted c ON 1 = 1
		LEFT JOIN credited r ON r.order_id = c.id AND r.rn = 1
		GROUP BY s.node_id
		ORDER BY s.node_id
	`)
	return rows.map((row) => ({
		nodeId: String(row.node_id),
		clicked: {
			orders: num(row.clicked_orders),
			revenueMinor: num(row.clicked_net),
		},
		reached: {
			orders: num(row.reached_orders),
			revenueMinor: num(row.reached_net),
		},
	}))
}

/** Words for a campaign id an order carries: the broadcast's or automation's name. */
export async function campaignNamesById(
	db: TenantDatabase,
	ids: readonly string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>()
	if (ids.length === 0) return names
	const campaigns = await queryInChunks([...ids], (chunk) =>
		db
			.select({ id: marketingCampaigns.id, name: marketingCampaigns.name })
			.from(marketingCampaigns)
			.where(inArray(marketingCampaigns.id, chunk)),
	)
	const journeys = await queryInChunks([...ids], (chunk) =>
		db
			.select({ id: marketingJourneys.id, name: marketingJourneys.name })
			.from(marketingJourneys)
			.where(inArray(marketingJourneys.id, chunk)),
	)
	for (const row of [...campaigns, ...journeys]) {
		if (!names.has(row.id)) names.set(row.id, row.name)
	}
	return names
}
