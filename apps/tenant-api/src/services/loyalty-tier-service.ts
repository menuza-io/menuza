import {
	addCalendarMonths,
	evaluateMemberTier,
	LOYALTY_TIER_PRE_REVIEW_WARN_DAYS,
	mulDiv,
	resolveTierByMetric,
	tierById,
	type LoyaltyProgramConfig,
	type LoyaltyTierDefinition,
	type LoyaltyTiersConfig,
	type LoyaltyWallet,
	type LoyaltyMemberSummary,
} from '@repo/loyalty'
import {
	loyaltyMembers,
	loyaltyPurchases,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, gte, isNotNull, lte, or } from 'drizzle-orm'
import {
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import {
	dispatchLoyaltyNotice,
	type LoyaltyNoticePayload,
} from './loyalty-notices-service.ts'
import { readProgramInTx } from './loyalty-program-service.ts'

const DAY_MS = 24 * 60 * 60_000
const TIER_TICK_BATCH_LIMIT = 200

function remainingSpendMinor(purchase: {
	eligibleMinor: number
	totalPaidMinor: number
	refundedMinor: number
}): number {
	const eligible = Math.max(0, purchase.eligibleMinor)
	if (eligible === 0 || purchase.refundedMinor <= 0) return eligible
	const paid = Math.max(0, purchase.totalPaidMinor)
	if (paid === 0 || purchase.refundedMinor >= paid) return 0
	const refundedShare = Math.min(
		eligible,
		mulDiv(eligible, purchase.refundedMinor, paid, 'ceil'),
	)
	return Math.max(0, eligible - refundedShare)
}

/**
 * Computes a member's tier-qualifying progress over the configured rolling
 * window. Only completed purchases contribute (`qualifyingPoints` or net
 * eligible spend): redemptions, welcome bonuses, and referral rewards never
 * inflate or reduce tier standing.
 */
export async function computeMemberTierMetricInTx(
	db: LoyaltyReader,
	input: { memberId: string; config: LoyaltyTiersConfig; now: number },
): Promise<number> {
	if (!input.config.enabled) return 0
	const since = addCalendarMonths(input.now, -input.config.periodMonths)
	const rows = await db
		.select({
			eligibleMinor: loyaltyPurchases.eligibleMinor,
			totalPaidMinor: loyaltyPurchases.totalPaidMinor,
			refundedMinor: loyaltyPurchases.refundedMinor,
			qualifyingPoints: loyaltyPurchases.qualifyingPoints,
		})
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.memberId, input.memberId),
				eq(loyaltyPurchases.state, 'completed'),
				gte(loyaltyPurchases.occurredAt, since),
				lte(loyaltyPurchases.occurredAt, input.now),
			),
		)
		.all()

	let total = 0
	for (const row of rows) {
		if (input.config.metric === 'qualifying_points') {
			total += Math.max(0, row.qualifyingPoints)
		} else {
			total += remainingSpendMinor(row)
		}
	}
	return total
}

export function activeTierDefinition(
	config: LoyaltyTiersConfig,
	tierId: string | null | undefined,
): LoyaltyTierDefinition | null {
	return tierById(config, tierId).tier
}

/**
 * Evaluates and persists a member's tier after an earn, refund, or tick.
 * Returns any pending pre-downgrade warning notice to be dispatched once the
 * transaction commits.
 */
export async function refreshMemberTierInTx(
	tx: LoyaltyTx,
	input: {
		orgId: string | null
		memberId: string
		config: LoyaltyProgramConfig
		now: number
		reason: 'earn' | 'refund' | 'tick'
	},
): Promise<{
	tierId: string | null
	changed: boolean
	direction: 'upgraded' | 'downgraded' | 'unchanged'
	notice: LoyaltyNoticePayload | null
}> {
	const member = await tx
		.select()
		.from(loyaltyMembers)
		.where(eq(loyaltyMembers.id, input.memberId))
		.get()
	if (!member || member.status === 'erased') {
		return {
			tierId: null,
			changed: false,
			direction: 'unchanged',
			notice: null,
		}
	}

	const tiersConfig = input.config.tiers
	const metricValue = await computeMemberTierMetricInTx(tx, {
		memberId: member.id,
		config: tiersConfig,
		now: input.now,
	})
	const evaluation = evaluateMemberTier({
		config: tiersConfig,
		currentTierId: member.tierId,
		reviewAt: member.tierReviewAt,
		graceUntil: member.tierGraceUntil,
		metricValue,
		now: input.now,
		reason: input.reason,
	})

	if (
		evaluation.tierId !== member.tierId ||
		evaluation.reviewAt !== member.tierReviewAt ||
		evaluation.graceUntil !== member.tierGraceUntil
	) {
		await tx
			.update(loyaltyMembers)
			.set({
				tierId: evaluation.tierId,
				tierReviewAt: evaluation.reviewAt,
				tierGraceUntil: evaluation.graceUntil,
				tierUpdatedAt: evaluation.changed ? input.now : member.tierUpdatedAt,
				updatedAt: input.now,
			})
			.where(eq(loyaltyMembers.id, member.id))
	}

	if (evaluation.changed) {
		await recordLoyaltyAudit(tx, {
			actorKind: 'system',
			action:
				evaluation.direction === 'upgraded'
					? 'tier.upgraded'
					: 'tier.downgraded',
			entityType: 'member',
			entityId: member.id,
			changes: {
				fromTierId: member.tierId,
				toTierId: evaluation.tierId,
				reason: input.reason,
				metricValue,
			},
			at: input.now,
		})
	}

	let notice: LoyaltyNoticePayload | null = null
	if (
		evaluation.warnDowngrade &&
		evaluation.tierId &&
		input.reason === 'tick'
	) {
		const currentTier = tierById(tiersConfig, evaluation.tierId).tier
		const pendingTier = tierById(tiersConfig, evaluation.pendingTierId).tier
		const actionDate = evaluation.graceUntil ?? evaluation.reviewAt ?? input.now
		notice = {
			kind: 'tier_downgrade_warning',
			memberId: member.id,
			dedupeKey: `${evaluation.tierId}:${evaluation.graceUntil ?? evaluation.reviewAt ?? Math.floor(input.now / DAY_MS)}`,
			programName: input.config.name,
			unitLabel: input.config.unitLabel,
			currentTierName: currentTier?.name ?? evaluation.tierId,
			pendingTierName: pendingTier?.name ?? null,
			actionDate,
			pointsNeeded: currentTier
				? Math.max(1, currentTier.threshold - metricValue)
				: 0,
			now: input.now,
		}
	}

	return {
		tierId: evaluation.tierId,
		changed: evaluation.changed,
		direction: evaluation.direction,
		notice,
	}
}

export async function buildWalletTierViewInTx(
	db: LoyaltyReader,
	input: {
		member: typeof loyaltyMembers.$inferSelect
		config: LoyaltyProgramConfig
		now: number
	},
): Promise<LoyaltyWallet['tier']> {
	const tiersConfig = input.config.tiers
	if (!tiersConfig.enabled || tiersConfig.tiers.length === 0) return null
	const metricValue = await computeMemberTierMetricInTx(db, {
		memberId: input.member.id,
		config: tiersConfig,
		now: input.now,
	})
	const current = tierById(tiersConfig, input.member.tierId)
	const nextTierDef = tiersConfig.tiers[current.rank] ?? null
	const pendingDowngrade =
		input.member.tierGraceUntil !== null
			? (resolveTierByMetric(tiersConfig.tiers, metricValue).tier?.name ?? null)
			: null

	return {
		current: current.tier
			? {
					id: current.tier.id,
					name: current.tier.name,
					multiplierBp: current.tier.multiplierBp,
				}
			: null,
		next: nextTierDef
			? {
					id: nextTierDef.id,
					name: nextTierDef.name,
					threshold: nextTierDef.threshold,
					pointsRemaining: Math.max(0, nextTierDef.threshold - metricValue),
					multiplierBp: nextTierDef.multiplierBp,
				}
			: null,
		metric: tiersConfig.metric,
		progressValue: metricValue,
		periodMonths: tiersConfig.periodMonths,
		reviewAt: input.member.tierReviewAt,
		graceUntil: input.member.tierGraceUntil,
		pendingDowngradeTierName: pendingDowngrade,
	}
}

export async function buildOperatorMemberTierInTx(
	db: LoyaltyReader,
	input: {
		member: typeof loyaltyMembers.$inferSelect
		config: LoyaltyProgramConfig
		now: number
	},
): Promise<LoyaltyMemberSummary['tier']> {
	const tiersConfig = input.config.tiers
	if (!tiersConfig.enabled || tiersConfig.tiers.length === 0) return null
	const metricValue = await computeMemberTierMetricInTx(db, {
		memberId: input.member.id,
		config: tiersConfig,
		now: input.now,
	})
	const current = tierById(tiersConfig, input.member.tierId).tier
	return {
		id: current?.id ?? null,
		name: current?.name ?? null,
		multiplierBp: current?.multiplierBp ?? 10_000,
		reviewAt: input.member.tierReviewAt,
		graceUntil: input.member.tierGraceUntil,
		progressValue: metricValue,
	}
}

/**
 * Scheduled tier tick: warns members approaching downgrade ahead of their
 * review date, starts grace periods at review, and completes downgrades after grace.
 */
export async function processTierReviewTickForOrg(
	orgId: string,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<{ warned: number; downgraded: number }> {
	const now = options.now ?? Date.now()
	const db = options.db ?? undefined
	const active = db ? await readProgramInTx(db) : null
	const warnCutoff = now + LOYALTY_TIER_PRE_REVIEW_WARN_DAYS * DAY_MS

	const notices: LoyaltyNoticePayload[] = []
	let downgraded = 0

	const dueIds = await (async () => {
		const reader =
			db ?? (await (await import('@repo/tenant-db')).getTenantDb(orgId))
		const program = active ?? (await readProgramInTx(reader))
		if (!program || !program.current.config.tiers.enabled) return []
		return reader
			.select({ id: loyaltyMembers.id })
			.from(loyaltyMembers)
			.where(
				and(
					eq(loyaltyMembers.status, 'active'),
					isNotNull(loyaltyMembers.tierId),
					or(
						lte(loyaltyMembers.tierReviewAt, warnCutoff),
						lte(loyaltyMembers.tierGraceUntil, now),
					),
				),
			)
			.limit(TIER_TICK_BATCH_LIMIT)
			.all()
	})()

	if (dueIds.length === 0) return { warned: 0, downgraded: 0 }

	await withLoyaltyWrite({ orgId, db, now }, async (tx, ctx) => {
		const program = await readProgramInTx(tx)
		if (!program || !program.current.config.tiers.enabled) return
		for (const row of dueIds) {
			const result = await refreshMemberTierInTx(tx, {
				orgId,
				memberId: row.id,
				config: program.current.config,
				now: ctx.now,
				reason: 'tick',
			})
			if (result.direction === 'downgraded') downgraded += 1
			if (result.notice) notices.push(result.notice)
		}
	})

	let warned = 0
	for (const notice of notices) {
		const delivery = await dispatchLoyaltyNotice(orgId, notice, { db })
		if (delivery.sent) warned += 1
	}
	return { warned, downgraded }
}
