import { and, desc, eq, gte, lte, ne, or } from 'drizzle-orm'
import {
	type BroadcastOverlap,
	isManyOverlap,
	OVERLAP_WINDOW_MS,
} from '@repo/common/broadcast-checks'
import {
	marketingCampaigns,
	type MarketingCampaign,
	type TenantDatabase,
} from '@repo/tenant-db'
import { audienceIdRule, audienceRule } from './broadcast-dispatch.ts'
import { loadBroadcastAudience } from './marketing-audience.ts'
import { resolveAudienceWhere } from './marketing-audience-service.ts'

/**
 * Overlapping broadcasts (#393). When an operator schedules a broadcast, the
 * region counts how many guests it would reach that another broadcast in the
 * same window (24 hours either side) would reach too. Only counts, the other
 * broadcast's own title and its time leave this function: no guest id, name or
 * contact ever goes to the control plane. A warning, never a block; the
 * single-broadcast checks of #232 are unchanged.
 */

/** Other broadcasts compared, most imminent first: bounds the work of one check. */
const MAX_COMPARED = 10
/** Overlaps reported, the biggest first. */
const MAX_REPORTED = 5

type Audience = {
	channel: 'email' | 'sms' | 'push'
	audience?: string | null
	audienceId?: string | null
	retargetOf?: string | null
}

async function guestIds(
	db: TenantDatabase,
	input: Audience,
	now: number,
): Promise<Set<string> | null> {
	let audienceWhere
	if (input.audienceId) {
		const resolved = await resolveAudienceWhere(db, input.audienceId, now)
		// A saved audience that is gone reaches nobody (the send would fail).
		if (!resolved) return null
		audienceWhere = resolved.where
	}
	const customers = await loadBroadcastAudience(db, {
		channel: input.channel,
		audience: input.audience,
		retargetOf: input.retargetOf ?? undefined,
		audienceWhere,
	})
	return new Set(customers.map((customer) => customer.id))
}

function channelOf(
	row: Pick<MarketingCampaign, 'channel'>,
): Audience['channel'] {
	return row.channel === 'sms'
		? 'sms'
		: row.channel === 'push'
			? 'push'
			: 'email'
}

export async function findAudienceOverlaps(
	db: TenantDatabase,
	input: Audience & {
		/** When the broadcast being checked would start (epoch ms). */
		sendAtMs: number
		/** The broadcast being edited, which is not compared with itself. */
		excludeCampaignId?: string | null
		now?: number
	},
): Promise<BroadcastOverlap[]> {
	const now = input.now ?? Date.now()
	const ours = await guestIds(db, input, now)
	if (!ours || ours.size === 0) return []

	const from = new Date(input.sendAtMs - OVERLAP_WINDOW_MS)
	const to = new Date(input.sendAtMs + OVERLAP_WINDOW_MS)
	const others = await db
		.select()
		.from(marketingCampaigns)
		.where(
			and(
				input.excludeCampaignId
					? ne(marketingCampaigns.id, input.excludeCampaignId)
					: undefined,
				or(
					// Scheduled for a time inside the window...
					and(
						eq(marketingCampaigns.status, 'Scheduled'),
						gte(marketingCampaigns.scheduledAt, from),
						lte(marketingCampaigns.scheduledAt, to),
					),
					// ...or sending right now (inside the window of a send now).
					eq(marketingCampaigns.status, 'Processing'),
				),
			),
		)
		.orderBy(desc(marketingCampaigns.scheduledAt))
		.limit(50)
		.all()

	const inWindow = others
		.filter((row) => {
			if (row.status === 'Processing') {
				return Math.abs(input.sendAtMs - now) <= OVERLAP_WINDOW_MS
			}
			const at = row.scheduledAt?.getTime()
			return at !== undefined && at >= from.getTime() && at <= to.getTime()
		})
		.sort(
			(a, b) =>
				Math.abs((a.scheduledAt?.getTime() ?? now) - input.sendAtMs) -
				Math.abs((b.scheduledAt?.getTime() ?? now) - input.sendAtMs),
		)
		.slice(0, MAX_COMPARED)

	const found: BroadcastOverlap[] = []
	for (const row of inWindow) {
		const theirs = await guestIds(
			db,
			{
				channel: channelOf(row),
				audience: audienceRule(row.segmentationRules),
				audienceId: audienceIdRule(row.segmentationRules),
				retargetOf: row.retargetOfCampaignId,
			},
			now,
		)
		if (!theirs || theirs.size === 0) continue
		let shared = 0
		const [small, large] =
			ours.size <= theirs.size ? [ours, theirs] : [theirs, ours]
		for (const id of small) if (large.has(id)) shared++
		if (!isManyOverlap(shared, ours.size, theirs.size)) continue
		found.push({
			campaignId: row.id,
			name: row.name,
			channel: channelOf(row),
			scheduledAt:
				row.status === 'Processing'
					? null
					: (row.scheduledAt?.getTime() ?? null),
			overlapCount: shared,
			audienceCount: ours.size,
			otherAudienceCount: theirs.size,
		})
	}
	return found
		.sort((a, b) => b.overlapCount - a.overlapCount)
		.slice(0, MAX_REPORTED)
}
