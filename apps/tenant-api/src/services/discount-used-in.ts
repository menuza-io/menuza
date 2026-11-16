import {
	DISCOUNT_USED_IN_MAX,
	parseMarketingOffer,
	type DiscountUsedIn,
} from '@repo/discounts'
import {
	discountIssuedCodes,
	marketingCampaigns,
	marketingJourneys,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm'

/**
 * Where a discount is promised (#236): ids, operator-written names and one
 * count. No recipient or address is read. `instr` narrows the rows in SQL (D1
 * rejects long LIKE patterns) and the stored offer is then parsed, so a
 * discount id that only appears inside some other text is never a match.
 */
export async function findDiscountUsedIn(
	db: TenantDatabase,
	discountId: string,
	now = Date.now(),
): Promise<DiscountUsedIn> {
	const campaignRows = await db
		.select({
			id: marketingCampaigns.id,
			name: marketingCampaigns.name,
			status: marketingCampaigns.status,
			scheduledAt: marketingCampaigns.scheduledAt,
			discountOffer: marketingCampaigns.discountOffer,
		})
		.from(marketingCampaigns)
		.where(
			and(
				// Only what can still go out: waiting, or sending now.
				inArray(marketingCampaigns.status, ['Scheduled', 'Processing']),
				sql`instr(coalesce(${marketingCampaigns.discountOffer}, ''), ${discountId}) > 0`,
			),
		)
		.limit(DISCOUNT_USED_IN_MAX * 2)
		.all()
	const broadcasts = campaignRows
		.filter(
			(row) =>
				parseMarketingOffer(row.discountOffer)?.discountId === discountId,
		)
		.slice(0, DISCOUNT_USED_IN_MAX)
		.map((row) => ({
			id: row.id,
			name: row.name,
			status: row.status as 'Scheduled' | 'Processing',
			scheduledAt:
				row.status === 'Scheduled' && row.scheduledAt
					? row.scheduledAt.getTime()
					: null,
		}))

	const journeyRows = await db
		.select({
			id: marketingJourneys.id,
			name: marketingJourneys.name,
			nodes: marketingJourneys.nodes,
		})
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				sql`instr(coalesce(${marketingJourneys.nodes}, ''), ${discountId}) > 0`,
			),
		)
		.limit(DISCOUNT_USED_IN_MAX * 2)
		.all()
	const automations = journeyRows
		.filter((row) => nodesOffer(row.nodes, discountId))
		.slice(0, DISCOUNT_USED_IN_MAX)
		.map((row) => ({ id: row.id, name: row.name }))

	const [issued] = await db
		.select({ n: count() })
		.from(discountIssuedCodes)
		.where(
			and(
				eq(discountIssuedCodes.discountId, discountId),
				gt(discountIssuedCodes.expiresAt, now),
			),
		)

	return { broadcasts, automations, issuedCodes: issued?.n ?? 0 }
}

/** Whether any email or text step of the journey carries this discount. */
function nodesOffer(nodes: unknown, discountId: string): boolean {
	let list: unknown = nodes
	if (typeof nodes === 'string') {
		try {
			list = JSON.parse(nodes)
		} catch {
			return false
		}
	}
	if (!Array.isArray(list)) return false
	return list.some((node) => {
		const data = (node as { data?: { discountOffer?: unknown } } | null)?.data
		return parseMarketingOffer(data?.discountOffer)?.discountId === discountId
	})
}
