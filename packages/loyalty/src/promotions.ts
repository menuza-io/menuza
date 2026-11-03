import {
	localMinutesSinceMidnight,
	businessDateOf,
	dayOfWeek,
} from '@repo/zoned-time'
import { z } from 'zod'
import {
	earningUnits,
	type EarningResult,
	type LoyaltyPurchaseLine,
	type LoyaltyPurchaseSnapshot,
} from './earning.ts'
import { LOYALTY_MAX_POINTS, mulDiv } from './money.ts'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	loyaltyCatalogIdSchema,
	loyaltyCatalogLabelsSchema,
	refineCatalogLabels,
} from './catalog.ts'

/**
 * Promotions: bonus points on top of what a purchase earns.
 *
 * A promotion is part of the program definition, so it is versioned with it:
 * a purchase is judged by the program version in force when the sale finished,
 * and editing a promotion later never changes a past award. Evaluation is a
 * pure step after base earning: it reads the same purchase snapshot and the
 * base result, and never touches the base rules.
 *
 * - `multiplier`: the points the promotion's scope earned are multiplied
 *   (`value` is the total multiplier in basis points, 20_000 is 2x). The bonus
 *   is the extra, rounded down once per promotion.
 * - `bonus`: a flat number of extra points: once per purchase for the whole
 *   order, once per unit for items and categories.
 *
 * Promotions only apply to a purchase that earned (a purchase below the
 * minimum, or a second visit on the same day, earns nothing and so gets no
 * bonus). Several matching promotions either compete (`best`: the largest
 * bonus wins) or add up (`add`).
 */

export const LOYALTY_MAX_PROMOTIONS = 25
export const LOYALTY_MAX_LOCATION_IDS = 100
export const LOYALTY_PROMOTION_KINDS = ['multiplier', 'bonus'] as const
export type LoyaltyPromotionKind = (typeof LOYALTY_PROMOTION_KINDS)[number]
export const LOYALTY_PROMOTION_STACKING = ['best', 'add'] as const
export type LoyaltyPromotionStacking =
	(typeof LOYALTY_PROMOTION_STACKING)[number]

/** One whole multiplier, in basis points. */
export const LOYALTY_MULTIPLIER_ONE_BP = 10_000
/** The largest multiplier a promotion may have: 10x. */
export const LOYALTY_MULTIPLIER_MAX_BP = 100_000
export const LOYALTY_PROMOTION_MAX_FLAT_POINTS = 100_000

export const loyaltyPromotionScopeSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('order') }).strict(),
	z
		.object({
			type: z.literal('items'),
			itemIds: z
				.array(loyaltyCatalogIdSchema)
				.min(1)
				.max(LOYALTY_MAX_ITEM_IDS)
				.refine((ids) => new Set(ids).size === ids.length, 'Duplicate id'),
		})
		.strict(),
	z
		.object({
			type: z.literal('categories'),
			categoryIds: z
				.array(loyaltyCatalogIdSchema)
				.min(1)
				.max(LOYALTY_MAX_CATEGORY_IDS)
				.refine((ids) => new Set(ids).size === ids.length, 'Duplicate id'),
		})
		.strict(),
])
export type LoyaltyPromotionScope = z.infer<typeof loyaltyPromotionScopeSchema>

/** A weekly window in the program's time zone: `fromMinute` up to `toMinute`. */
export const loyaltyPromotionRecurringSchema = z
	.object({
		/** 0 = Sunday ... 6 = Saturday, in the program's time zone. */
		weekdays: z
			.array(z.number().int().min(0).max(6))
			.min(1)
			.max(7)
			.refine((days) => new Set(days).size === days.length, 'Duplicate day'),
		/** Minutes after local midnight the window opens (`0..1439`). */
		fromMinute: z.number().int().min(0).max(1439),
		/** Minutes after local midnight it closes (`1..1440`), after `fromMinute`. */
		toMinute: z.number().int().min(1).max(1440),
	})
	.strict()
	.refine((window) => window.toMinute > window.fromMinute, {
		message: 'The window must end after it starts',
		path: ['toMinute'],
	})
export type LoyaltyPromotionRecurring = z.infer<
	typeof loyaltyPromotionRecurringSchema
>

const loyaltyPromotionObject = z
	.object({
		id: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/, 'Invalid id'),
		/** Shown to the customer in the wallet and on the receipt. */
		name: z.string().trim().min(1).max(80),
		enabled: z.boolean().default(true),
		kind: z.enum(LOYALTY_PROMOTION_KINDS),
		/** Basis points for a multiplier (total, 20_000 is 2x); points for a bonus. */
		value: z.number().int().min(1).max(LOYALTY_MULTIPLIER_MAX_BP),
		scope: loyaltyPromotionScopeSchema.default({ type: 'order' }),
		/** Epoch ms; sales finishing before this instant do not qualify. `null`: no start. */
		startsAt: z.number().int().nonnegative().nullable().default(null),
		/** Epoch ms; sales finishing at or after it do not qualify. `null`: no end. */
		endsAt: z.number().int().nonnegative().nullable().default(null),
		recurring: loyaltyPromotionRecurringSchema.nullable().default(null),
		/** `null` is every location. A purchase with no location never matches a list. */
		locationIds: z
			.array(loyaltyCatalogIdSchema)
			.min(1)
			.max(LOYALTY_MAX_LOCATION_IDS)
			.refine((ids) => new Set(ids).size === ids.length, 'Duplicate id')
			.nullable()
			.default(null),
		/** Most bonus points this promotion gives one purchase. `null`: no cap of its own. */
		maxPointsPerPurchase: z
			.number()
			.int()
			.min(1)
			.max(LOYALTY_MAX_POINTS)
			.nullable()
			.default(null),
		labels: loyaltyCatalogLabelsSchema.default({ items: {}, categories: {} }),
	})
	.strict()

export const loyaltyPromotionSchema = loyaltyPromotionObject.superRefine(
	(promotion, ctx) => {
		if (promotion.kind === 'multiplier') {
			if (
				promotion.value <= LOYALTY_MULTIPLIER_ONE_BP ||
				promotion.value > LOYALTY_MULTIPLIER_MAX_BP
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['value'],
					message: 'A multiplier must be above 1x and at most 10x',
				})
			}
		} else if (promotion.value > LOYALTY_PROMOTION_MAX_FLAT_POINTS) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['value'],
				message: 'Too many bonus points',
			})
		}
		if (
			promotion.startsAt !== null &&
			promotion.endsAt !== null &&
			promotion.endsAt <= promotion.startsAt
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['endsAt'],
				message: 'The promotion must end after it starts',
			})
		}
		refineCatalogLabels(
			promotion.labels,
			{
				itemIds:
					promotion.scope.type === 'items' ? promotion.scope.itemIds : [],
				categoryIds:
					promotion.scope.type === 'categories'
						? promotion.scope.categoryIds
						: [],
			},
			ctx,
		)
	},
)
export type LoyaltyPromotion = z.infer<typeof loyaltyPromotionSchema>

export const loyaltyPromotionsSchema = z
	.array(loyaltyPromotionSchema)
	.max(LOYALTY_MAX_PROMOTIONS)
	.refine(
		(promotions) =>
			new Set(promotions.map((promotion) => promotion.id)).size ===
			promotions.length,
		'Duplicate promotion id',
	)

export type AppliedPromotion = {
	id: string
	name: string
	points: number
}

export type PromotionBonus = {
	/** Extra points on top of the base award; never negative. */
	points: number
	/** The promotions that counted, with what each gave (after its own cap). */
	applied: AppliedPromotion[]
}

export const NO_PROMOTION_BONUS: PromotionBonus = { points: 0, applied: [] }

/** Whether a promotion is running for a sale at this moment and place. */
export function promotionIsLive(
	promotion: LoyaltyPromotion,
	at: { occurredAt: number; timeZone: string; locationId: string | null },
): boolean {
	if (!promotion.enabled) return false
	if (promotion.startsAt !== null && at.occurredAt < promotion.startsAt) {
		return false
	}
	if (promotion.endsAt !== null && at.occurredAt >= promotion.endsAt) {
		return false
	}
	if (promotion.locationIds !== null) {
		if (at.locationId === null) return false
		if (!promotion.locationIds.includes(at.locationId)) return false
	}
	if (promotion.recurring) {
		const date = businessDateOf(at.occurredAt, at.timeZone)
		if (!promotion.recurring.weekdays.includes(dayOfWeek(date))) return false
		const minute = localMinutesSinceMidnight(at.occurredAt, at.timeZone)
		if (
			minute < promotion.recurring.fromMinute ||
			minute >= promotion.recurring.toMinute
		) {
			return false
		}
	}
	return true
}

function lineInScope(
	scope: LoyaltyPromotionScope,
	line: LoyaltyPurchaseLine,
): boolean {
	if (scope.type === 'items') return scope.itemIds.includes(line.itemId)
	if (scope.type === 'categories') {
		return line.categoryIds.some((id) => scope.categoryIds.includes(id))
	}
	return true
}

function promotionPoints(
	promotion: LoyaltyPromotion,
	earning: EarningResult,
	snapshot: Pick<LoyaltyPurchaseSnapshot, 'lines'>,
): number {
	const { scope } = promotion
	let points = 0
	if (promotion.kind === 'multiplier') {
		let scoped = 0
		if (scope.type === 'order') {
			scoped = earning.points
		} else {
			const lines = new Map(snapshot.lines.map((line) => [line.lineId, line]))
			for (const earned of earning.lines) {
				const line = lines.get(earned.lineId)
				if (line && lineInScope(scope, line)) scoped += earned.points
			}
		}
		points = mulDiv(
			scoped,
			promotion.value - LOYALTY_MULTIPLIER_ONE_BP,
			LOYALTY_MULTIPLIER_ONE_BP,
		)
	} else if (scope.type === 'order') {
		points = promotion.value
	} else {
		const units = snapshot.lines
			.filter((line) => lineInScope(scope, line))
			.reduce((sum, line) => sum + earningUnits(line), 0)
		points = units * promotion.value
	}
	if (promotion.maxPointsPerPurchase !== null) {
		points = Math.min(points, promotion.maxPointsPerPurchase)
	}
	return Math.max(0, points)
}

/**
 * The bonus a purchase earns from the promotions running at `occurredAt`.
 * `earning` is the base result for the same snapshot; a purchase that earned
 * nothing gets no bonus. The total never takes the purchase past one ledger
 * entry (`LOYALTY_MAX_POINTS`).
 */
export function computePromotionBonus(input: {
	promotions: readonly LoyaltyPromotion[]
	stacking: LoyaltyPromotionStacking
	earning: EarningResult
	snapshot: Pick<LoyaltyPurchaseSnapshot, 'lines'>
	occurredAt: number
	timeZone: string
	locationId: string | null
}): PromotionBonus {
	if (
		input.promotions.length === 0 ||
		input.earning.reason !== null ||
		input.earning.points <= 0
	) {
		return NO_PROMOTION_BONUS
	}
	const at = {
		occurredAt: input.occurredAt,
		timeZone: input.timeZone,
		locationId: input.locationId,
	}
	const candidates: AppliedPromotion[] = []
	for (const promotion of input.promotions) {
		if (!promotionIsLive(promotion, at)) continue
		const points = promotionPoints(promotion, input.earning, input.snapshot)
		if (points > 0) {
			candidates.push({ id: promotion.id, name: promotion.name, points })
		}
	}
	if (candidates.length === 0) return NO_PROMOTION_BONUS
	let applied = candidates
	if (input.stacking === 'best') {
		// The largest bonus wins; the first listed wins a tie.
		applied = [
			candidates.reduce((best, next) =>
				next.points > best.points ? next : best,
			),
		]
	}
	const room = Math.max(0, LOYALTY_MAX_POINTS - input.earning.points)
	let remaining = room
	const capped: AppliedPromotion[] = []
	for (const entry of applied) {
		const points = Math.min(entry.points, remaining)
		if (points <= 0) break
		capped.push({ ...entry, points })
		remaining -= points
	}
	return {
		points: capped.reduce((sum, entry) => sum + entry.points, 0),
		applied: capped,
	}
}
