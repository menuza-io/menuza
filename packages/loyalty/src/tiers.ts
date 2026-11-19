import { z } from 'zod'
import {
	LOYALTY_MAX_MINOR,
	LOYALTY_MAX_POINTS,
	LOYALTY_MULTIPLIER_MAX_BP,
	LOYALTY_MULTIPLIER_ONE_BP,
	mulDiv,
} from './money.ts'

export const LOYALTY_MAX_TIERS = 4
export const LOYALTY_TIER_METRICS = [
	'qualifying_points',
	'spend_minor',
] as const
export type LoyaltyTierMetric = (typeof LOYALTY_TIER_METRICS)[number]

export const LOYALTY_TIER_PERIOD_MIN_MONTHS = 1
export const LOYALTY_TIER_PERIOD_MAX_MONTHS = 24
export const LOYALTY_TIER_PERIOD_DEFAULT_MONTHS = 12
export const LOYALTY_TIER_GRACE_MAX_DAYS = 90
export const LOYALTY_TIER_GRACE_DEFAULT_DAYS = 30
/** Advance notice window before a scheduled tier review date when a member is short of their tier. */
export const LOYALTY_TIER_PRE_REVIEW_WARN_DAYS = 14

const DAY_MS = 24 * 60 * 60_000

export const loyaltyTierIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(
		/^[A-Za-z0-9_-]+$/,
		'Tier id may only contain letters, numbers, hyphens, and underscores',
	)

export const loyaltyTierDefinitionSchema = z
	.object({
		id: loyaltyTierIdSchema,
		name: z.string().trim().min(1).max(40),
		threshold: z.number().int().min(1).max(LOYALTY_MAX_MINOR),
		/** Basis points multiplier (10_000 = 1.0x, 15_000 = 1.5x, 20_000 = 2.0x). */
		multiplierBp: z
			.number()
			.int()
			.min(LOYALTY_MULTIPLIER_ONE_BP)
			.max(LOYALTY_MULTIPLIER_MAX_BP)
			.default(LOYALTY_MULTIPLIER_ONE_BP),
	})
	.strict()

export type LoyaltyTierDefinition = z.infer<typeof loyaltyTierDefinitionSchema>

export const loyaltyTiersConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		metric: z.enum(LOYALTY_TIER_METRICS).default('qualifying_points'),
		periodMonths: z
			.number()
			.int()
			.min(LOYALTY_TIER_PERIOD_MIN_MONTHS)
			.max(LOYALTY_TIER_PERIOD_MAX_MONTHS)
			.default(LOYALTY_TIER_PERIOD_DEFAULT_MONTHS),
		graceDays: z
			.number()
			.int()
			.min(0)
			.max(LOYALTY_TIER_GRACE_MAX_DAYS)
			.default(LOYALTY_TIER_GRACE_DEFAULT_DAYS),
		tiers: z
			.array(loyaltyTierDefinitionSchema)
			.max(LOYALTY_MAX_TIERS)
			.default([]),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.enabled && value.tiers.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['tiers'],
				message: 'Add at least one tier when tiers are enabled',
			})
		}
		const seenIds = new Set<string>()
		const seenNames = new Set<string>()
		let prevThreshold = 0
		for (const [index, tier] of value.tiers.entries()) {
			if (seenIds.has(tier.id)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['tiers', index, 'id'],
					message: 'Duplicate tier id',
				})
			}
			seenIds.add(tier.id)

			const lowerName = tier.name.toLowerCase()
			if (seenNames.has(lowerName)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['tiers', index, 'name'],
					message: 'Duplicate tier name',
				})
			}
			seenNames.add(lowerName)

			if (index > 0 && tier.threshold <= prevThreshold) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['tiers', index, 'threshold'],
					message:
						'Tier thresholds must increase strictly from lowest to highest',
				})
			}
			prevThreshold = tier.threshold
		}
	})

export type LoyaltyTiersConfig = z.infer<typeof loyaltyTiersConfigSchema>

export const DEFAULT_LOYALTY_TIERS_CONFIG: Readonly<LoyaltyTiersConfig> =
	Object.freeze({
		enabled: false,
		metric: 'qualifying_points',
		periodMonths: LOYALTY_TIER_PERIOD_DEFAULT_MONTHS,
		graceDays: LOYALTY_TIER_GRACE_DEFAULT_DAYS,
		tiers: [],
	})

/**
 * Adds whole UTC calendar months, clamping the day of month when the target
 * month has fewer days (e.g. Jan 31 + 1 month -> Feb 28/29).
 */
export function addCalendarMonths(epochMs: number, months: number): number {
	const d = new Date(epochMs)
	const year = d.getUTCFullYear()
	const month = d.getUTCMonth() + months
	const day = d.getUTCDate()
	const hour = d.getUTCHours()
	const minute = d.getUTCMinutes()
	const second = d.getUTCSeconds()
	const ms = d.getUTCMilliseconds()

	const targetMonthStart = new Date(Date.UTC(year, month, 1))
	const targetYear = targetMonthStart.getUTCFullYear()
	const targetMonth = targetMonthStart.getUTCMonth()
	const lastDay = new Date(
		Date.UTC(targetYear, targetMonth + 1, 0),
	).getUTCDate()
	return Date.UTC(
		targetYear,
		targetMonth,
		Math.min(day, lastDay),
		hour,
		minute,
		second,
		ms,
	)
}

/**
 * Scales base earning points by the member's tier multiplier. Always floors and
 * clamps at `LOYALTY_MAX_POINTS` so tier perks never inflate fractions or overflow.
 */
export function applyTierMultiplier(
	basePoints: number,
	multiplierBp: number,
): number {
	if (basePoints <= 0) return 0
	const effectiveBp = Math.max(LOYALTY_MULTIPLIER_ONE_BP, multiplierBp)
	return Math.min(
		LOYALTY_MAX_POINTS,
		mulDiv(basePoints, effectiveBp, LOYALTY_MULTIPLIER_ONE_BP, 'floor'),
	)
}

export function resolveTierByMetric(
	tiers: readonly LoyaltyTierDefinition[],
	metricValue: number,
): {
	tier: LoyaltyTierDefinition | null
	rank: number
	nextTier: LoyaltyTierDefinition | null
} {
	const value = Math.max(0, metricValue)
	let matched: LoyaltyTierDefinition | null = null
	let rank = 0
	let nextTier: LoyaltyTierDefinition | null = null
	for (const [index, tier] of tiers.entries()) {
		if (value >= tier.threshold) {
			matched = tier
			rank = index + 1
		} else {
			nextTier = tier
			break
		}
	}
	return { tier: matched, rank, nextTier }
}

export function tierById(
	config: Pick<LoyaltyTiersConfig, 'enabled' | 'tiers'>,
	tierId: string | null | undefined,
): { tier: LoyaltyTierDefinition | null; rank: number } {
	if (!config.enabled || !tierId) return { tier: null, rank: 0 }
	const index = config.tiers.findIndex((entry) => entry.id === tierId)
	if (index === -1) return { tier: null, rank: 0 }
	return { tier: config.tiers[index] ?? null, rank: index + 1 }
}

export function memberMeetsTier(
	config: Pick<LoyaltyTiersConfig, 'enabled' | 'tiers'>,
	memberTierId: string | null | undefined,
	requiredTierId: string | null | undefined,
): boolean {
	if (!requiredTierId) return true
	if (!config.enabled) return false
	const required = tierById(config, requiredTierId)
	if (!required.tier || required.rank === 0) return false
	const current = tierById(config, memberTierId)
	return current.rank >= required.rank
}

export type EvaluateMemberTierInput = {
	config: LoyaltyTiersConfig
	currentTierId: string | null
	reviewAt: number | null
	graceUntil: number | null
	metricValue: number
	now: number
	reason: 'earn' | 'refund' | 'tick'
}

export type EvaluateMemberTierResult = {
	tierId: string | null
	reviewAt: number | null
	graceUntil: number | null
	changed: boolean
	direction: 'upgraded' | 'downgraded' | 'unchanged'
	graceStarted: boolean
	warnDowngrade: boolean
	pendingTierId: string | null
}

/**
 * Computes the next member tier state after an earn, refund, or scheduled tick.
 * - Upgrades apply immediately and set a full `periodMonths` review window.
 * - Redeeming points never alters the input `metricValue`, so redemptions never
 *   trigger a downgrade.
 * - Refunds reduce qualifying points/spend and downgrade immediately if needed.
 * - Scheduled ticks start the grace period when `now >= reviewAt` and notify
 *   ahead of downgrade (`warnDowngrade`), finalizing downgrade once `graceUntil` lapses.
 */
export function evaluateMemberTier(
	input: EvaluateMemberTierInput,
): EvaluateMemberTierResult {
	const {
		config,
		currentTierId,
		reviewAt,
		graceUntil,
		metricValue,
		now,
		reason,
	} = input
	if (!config.enabled) {
		const hadState =
			currentTierId !== null || reviewAt !== null || graceUntil !== null
		return {
			tierId: null,
			reviewAt: null,
			graceUntil: null,
			changed: hadState && currentTierId !== null,
			direction: currentTierId !== null ? 'downgraded' : 'unchanged',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	const current = tierById(config, currentTierId)
	const earned = resolveTierByMetric(config.tiers, metricValue)

	// Upgrade immediately when metric qualifies for a higher tier (or recovered removed id -> re-seat cleanly).
	if (earned.rank > current.rank) {
		return {
			tierId: earned.tier!.id,
			reviewAt: addCalendarMonths(now, config.periodMonths),
			graceUntil: null,
			changed: currentTierId !== earned.tier!.id,
			direction: 'upgraded',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	// If no active tier right now (rank 0), stay un-tiered.
	if (current.rank === 0) {
		const needsClear =
			currentTierId !== null || reviewAt !== null || graceUntil !== null
		return {
			tierId: null,
			reviewAt: null,
			graceUntil: null,
			changed: needsClear && currentTierId !== null,
			direction: currentTierId !== null ? 'downgraded' : 'unchanged',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	// Refund reversal can downgrade immediately if qualifying points/spend dropped below current threshold.
	if (reason === 'refund' && earned.rank < current.rank) {
		const nextTierId = earned.tier?.id ?? null
		return {
			tierId: nextTierId,
			reviewAt: nextTierId
				? (reviewAt ?? addCalendarMonths(now, config.periodMonths))
				: null,
			graceUntil: null,
			changed: true,
			direction: 'downgraded',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	// Earned rank matches current rank: still qualified; clear any active grace and roll review date if tick passed it.
	if (earned.rank === current.rank) {
		const rolledReview =
			reason === 'tick' && (reviewAt === null || now >= reviewAt)
				? addCalendarMonths(now, config.periodMonths)
				: (reviewAt ?? addCalendarMonths(now, config.periodMonths))
		return {
			tierId: current.tier!.id,
			reviewAt: rolledReview,
			graceUntil: null,
			changed: false,
			direction: 'unchanged',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	// earned.rank < current.rank
	if (reason !== 'tick') {
		// Earning on an already-protected tier during its period/grace never demotes on earn.
		return {
			tierId: current.tier!.id,
			reviewAt: reviewAt ?? addCalendarMonths(now, config.periodMonths),
			graceUntil,
			changed: false,
			direction: 'unchanged',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: null,
		}
	}

	// Scheduled review tick while below current tier threshold:
	if (graceUntil !== null) {
		if (now >= graceUntil) {
			const nextTierId = earned.tier?.id ?? null
			return {
				tierId: nextTierId,
				reviewAt: nextTierId
					? addCalendarMonths(now, config.periodMonths)
					: null,
				graceUntil: null,
				changed: true,
				direction: 'downgraded',
				graceStarted: false,
				warnDowngrade: false,
				pendingTierId: null,
			}
		}
		return {
			tierId: current.tier!.id,
			reviewAt,
			graceUntil,
			changed: false,
			direction: 'unchanged',
			graceStarted: false,
			warnDowngrade: false,
			pendingTierId: earned.tier?.id ?? null,
		}
	}

	if (reviewAt !== null && now < reviewAt) {
		const warnWindowMs = LOYALTY_TIER_PRE_REVIEW_WARN_DAYS * DAY_MS
		const warnDowngrade = reviewAt - now <= warnWindowMs
		return {
			tierId: current.tier!.id,
			reviewAt,
			graceUntil: null,
			changed: false,
			direction: 'unchanged',
			graceStarted: false,
			warnDowngrade,
			pendingTierId: warnDowngrade ? (earned.tier?.id ?? null) : null,
		}
	}

	// Reached review date below threshold with no grace yet.
	if (config.graceDays > 0) {
		return {
			tierId: current.tier!.id,
			reviewAt: reviewAt ?? now,
			graceUntil: now + config.graceDays * DAY_MS,
			changed: false,
			direction: 'unchanged',
			graceStarted: true,
			warnDowngrade: true,
			pendingTierId: earned.tier?.id ?? null,
		}
	}

	const nextTierId = earned.tier?.id ?? null
	return {
		tierId: nextTierId,
		reviewAt: nextTierId ? addCalendarMonths(now, config.periodMonths) : null,
		graceUntil: null,
		changed: true,
		direction: 'downgraded',
		graceStarted: false,
		warnDowngrade: false,
		pendingTierId: null,
	}
}
