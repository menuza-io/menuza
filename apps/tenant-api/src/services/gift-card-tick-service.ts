import { giftCards, getTenantDb } from '@repo/tenant-db'
import { and, eq, isNotNull, isNull, min, or, sql } from 'drizzle-orm'
import { forEachWithBudget } from '../lib/concurrency.ts'
import { runGiftCardTick, type GiftCardTickTotals } from './gift-card-purchase-service.ts'

/**
 * The gift-card tick for one organization: releases timed holds, voids
 * purchases whose payment never started, sends the receipts and cards that
 * are due. It never stops on the flags or the kill switch: everything here
 * finishes work that already started (a paid purchase still gets delivered).
 * Results are counts only.
 */
export type GiftCardTickResult = GiftCardTickTotals & {
	needsFollowUp: boolean
	nextDueAt: number | null
}

const HOUR_MS = 60 * 60_000

export async function runGiftCardTickForOrg(
	orgId: string,
	options: { now?: number } = {},
): Promise<GiftCardTickResult> {
	const now = options.now ?? Date.now()
	const totals = await runGiftCardTick(orgId, { now })
	const db = await getTenantDb(orgId)
	// The next time something is due: a hold ends, a card is to be delivered, a
	// purchase's payment window closes. Nothing pending means no follow-up.
	const [row] = await db
		.select({
			hold: min(sql`case when ${giftCards.status} = 'held' then ${giftCards.holdUntil} end`),
			deliver: min(
				sql`case when ${giftCards.status} in ('active', 'held') and ${giftCards.deliveredAt} is null and ${giftCards.sealedCode} is not null then coalesce(${giftCards.deliverAt}, ${now}) end`,
			),
			payment: min(
				sql`case when ${giftCards.status} = 'pending' and ${giftCards.paymentStatus} = 'pending' then ${giftCards.paymentHoldExpiresAt} end`,
			),
		})
		.from(giftCards)
		.where(
			or(
				and(eq(giftCards.status, 'held'), isNotNull(giftCards.holdUntil)),
				and(isNull(giftCards.deliveredAt), isNotNull(giftCards.sealedCode)),
				eq(giftCards.status, 'pending'),
			),
		)
	const due = [row?.hold, row?.deliver, row?.payment]
		.map((value) => (value === null || value === undefined ? null : Number(value)))
		.filter((value): value is number => value !== null && Number.isFinite(value))
	const nextDueAt = due.length > 0 ? Math.min(...due) : null
	return {
		...totals,
		// Follow up soon while something is due within the next hours.
		needsFollowUp: nextDueAt !== null && nextDueAt - now < 6 * HOUR_MS,
		nextDueAt,
	}
}

export async function runGiftCardTickLogged(
	orgId: string,
): Promise<GiftCardTickResult | null> {
	try {
		return await runGiftCardTickForOrg(orgId)
	} catch (error) {
		console.error(
			'Gift card tick failed for organization',
			orgId,
			error instanceof Error ? error.name : 'unknown',
		)
		return null
	}
}

export type GiftCardTickAggregate = GiftCardTickTotals & {
	orgs: number
	errors: number
	orgsDeferred: number
}

export async function fanOutGiftCardTick(options: {
	orgIds: readonly string[]
	run: (orgId: string) => Promise<GiftCardTickResult | null>
	budgetMs?: number
	concurrency?: number
	now?: () => number
}): Promise<GiftCardTickAggregate> {
	const now = options.now ?? Date.now
	const total: GiftCardTickAggregate = {
		orgs: 0,
		errors: 0,
		orgsDeferred: 0,
		released: 0,
		expired: 0,
		delivered: 0,
		failed: 0,
	}
	const run = await forEachWithBudget(
		options.orgIds,
		{
			concurrency: options.concurrency ?? 4,
			deadline: now() + (options.budgetMs ?? 50_000),
			now,
		},
		async (orgId) => {
			const result = await options.run(orgId)
			if (!result) {
				total.errors++
				return
			}
			total.orgs++
			total.released += result.released
			total.expired += result.expired
			total.delivered += result.delivered
			total.failed += result.failed
		},
	)
	total.orgsDeferred = run.skipped
	return total
}
