import { isValidTimeZone } from '@repo/zoned-time'
import { z } from 'zod'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	loyaltyCatalogIdSchema,
	loyaltyCatalogLabelsSchema,
	refineCatalogLabels,
} from './catalog.ts'
import { currencySchema, minorSchema } from './money.ts'
import {
	LOYALTY_PROMOTION_STACKING,
	loyaltyPromotionsSchema,
} from './promotions.ts'

/**
 * Program definition. One program per organization; every edit is a new
 * immutable version, and purchases keep the version they were earned under, so
 * later edits never change past awards. Exactly one earning method is active
 * at a time; switching it never touches balances.
 */

export const LOYALTY_EARNING_METHODS = [
	'spend',
	'visit',
	'items',
	'categories',
] as const
export type LoyaltyEarningMethod = (typeof LOYALTY_EARNING_METHODS)[number]

/** Display label for the same integer unit. Not two currencies. */
export const LOYALTY_UNIT_LABELS = ['points', 'stars'] as const
export type LoyaltyUnitLabel = (typeof LOYALTY_UNIT_LABELS)[number]

export const LOYALTY_PROGRAM_STATUSES = ['draft', 'active', 'paused'] as const
export type LoyaltyProgramStatus = (typeof LOYALTY_PROGRAM_STATUSES)[number]

export const LOYALTY_MAX_RULE_POINTS = 100_000
/** Largest spend one spend rule step may need (1,000,000.00 in major units). */
export const LOYALTY_MAX_SPEND_PER_MINOR = 100_000_000

const pointsSchema = z.number().int().min(1).max(LOYALTY_MAX_RULE_POINTS)

function uniqueIds(ids: readonly string[]): boolean {
	return new Set(ids).size === ids.length
}

const idListSchema = (max: number) =>
	z
		.array(loyaltyCatalogIdSchema)
		.min(1)
		.max(max)
		.refine(uniqueIds, 'Duplicate id')

export const loyaltyEarningRuleSchema = z.discriminatedUnion('method', [
	z
		.object({
			method: z.literal('spend'),
			/** Points per `perMinor` of qualifying spend, rounded down once per order. */
			points: pointsSchema,
			perMinor: z.number().int().min(1).max(LOYALTY_MAX_SPEND_PER_MINOR),
		})
		.strict(),
	z
		.object({
			method: z.literal('visit'),
			/** Points per qualifying purchase, at most once per member per local day. */
			points: pointsSchema,
		})
		.strict(),
	z
		.object({
			method: z.literal('items'),
			/** Points per purchased unit of a selected item. */
			points: pointsSchema,
			itemIds: idListSchema(LOYALTY_MAX_ITEM_IDS),
		})
		.strict(),
	z
		.object({
			method: z.literal('categories'),
			/** Points per purchased unit in a selected category, once per line. */
			points: pointsSchema,
			categoryIds: idListSchema(LOYALTY_MAX_CATEGORY_IDS),
		})
		.strict(),
])
export type LoyaltyEarningRule = z.infer<typeof loyaltyEarningRuleSchema>

export const loyaltyTimeZoneSchema = z
	.string()
	.min(1)
	.max(64)
	.refine((value) => isValidTimeZone(value), 'Invalid time zone')

const loyaltyProgramConfigObject = z
	.object({
		name: z.string().trim().min(1).max(80),
		unitLabel: z.enum(LOYALTY_UNIT_LABELS),
		/** Locked to the organization's currency; orders in another currency never earn. */
		currency: currencySchema,
		/** Decides the local calendar day for visit awards. */
		timeZone: loyaltyTimeZoneSchema,
		/** Merchandise after discounts, excluding tax, tips and fees. */
		minimumSpendMinor: minorSchema,
		earning: loyaltyEarningRuleSchema,
		/**
		 * Display text shown in the wallet. Editing it never stops anyone earning
		 * or spending: there is no acceptance step. Blank means none.
		 */
		terms: z.string().trim().max(4000).default(''),
		labels: loyaltyCatalogLabelsSchema.default({ items: {}, categories: {} }),
		/** Bonus-point promotions, versioned with the program. See `promotions.ts`. */
		promotions: loyaltyPromotionsSchema.default([]),
		/** Several promotions at once: the best one wins, or they add up. */
		promotionStacking: z.enum(LOYALTY_PROMOTION_STACKING).default('best'),
	})
	.strict()

export const loyaltyProgramConfigSchema =
	loyaltyProgramConfigObject.superRefine((config, ctx) => {
		// One purchase can never earn more than one ledger entry holds
		// (LOYALTY_MAX_POINTS, and no sale is larger than
		// LOYALTY_MAX_SPEND_PER_MINOR): a spend rule whose points outrun its
		// spend unit would clamp every largest sale, so it is refused on save.
		if (
			config.earning.method === 'spend' &&
			config.earning.points > config.earning.perMinor
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['earning', 'points'],
				message: 'Points cannot exceed the spend unit',
			})
		}
		refineCatalogLabels(
			config.labels,
			{
				itemIds:
					config.earning.method === 'items' ? config.earning.itemIds : [],
				categoryIds:
					config.earning.method === 'categories'
						? config.earning.categoryIds
						: [],
			},
			ctx,
		)
	})
export type LoyaltyProgramConfig = z.infer<typeof loyaltyProgramConfigSchema>

export type LoyaltyProgramVersionFacts = {
	version: number
	status: LoyaltyProgramStatus
	effectiveAt: number
}

/**
 * The version in force at an instant: the latest one that took effect at or
 * before it. Offline sales earn under the version of their sale time.
 */
export function programVersionAt<T extends LoyaltyProgramVersionFacts>(
	versions: readonly T[],
	at: number,
): T | null {
	let best: T | null = null
	for (const version of versions) {
		if (version.effectiveAt > at) continue
		if (
			!best ||
			version.effectiveAt > best.effectiveAt ||
			(version.effectiveAt === best.effectiveAt &&
				version.version > best.version)
		) {
			best = version
		}
	}
	return best
}

/** Sale times that cannot be trusted go to review instead of earning. */
export const LOYALTY_SALE_TIME_MAX_FUTURE_MS = 5 * 60_000
export const LOYALTY_SALE_TIME_MAX_AGE_MS = 30 * 24 * 60 * 60_000

export type SaleTimeVerdict = 'ok' | 'future' | 'stale'

export function classifySaleTime(
	occurredAt: number,
	receivedAt: number,
	limits: { maxFutureMs?: number; maxAgeMs?: number } = {},
): SaleTimeVerdict {
	const maxFuture = limits.maxFutureMs ?? LOYALTY_SALE_TIME_MAX_FUTURE_MS
	const maxAge = limits.maxAgeMs ?? LOYALTY_SALE_TIME_MAX_AGE_MS
	if (occurredAt > receivedAt + maxFuture) return 'future'
	if (occurredAt < receivedAt - maxAge) return 'stale'
	return 'ok'
}

export * from './catalog.ts'
export * from './promotions.ts'
