import { z } from 'zod'
import { BASIS_POINTS, currencySchema, positiveMinorSchema } from './money.ts'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	loyaltyCatalogIdSchema,
	loyaltyCatalogLabelsSchema,
	refineCatalogLabels,
} from './program.ts'

/**
 * Reward definitions. Every edit is a new immutable version; redemptions keep
 * the version (and a snapshot of it) they were made with, and archiving keeps
 * the history readable.
 */

export const LOYALTY_REWARD_KINDS = [
	'order',
	'categories',
	'items',
	'free_item',
] as const
export type LoyaltyRewardKind = (typeof LOYALTY_REWARD_KINDS)[number]

export const LOYALTY_REWARD_STATUSES = ['active', 'archived'] as const
export type LoyaltyRewardStatus = (typeof LOYALTY_REWARD_STATUSES)[number]

export const LOYALTY_MAX_REWARD_COST = 10_000_000

export const loyaltyDiscountSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('fixed'),
			amountMinor: positiveMinorSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal('percent'),
			/** Basis points: 1000 = 10%. */
			percentBp: z.number().int().min(1).max(BASIS_POINTS),
			/** Optional ceiling on the discount; percentage rewards only. */
			maxDiscountMinor: positiveMinorSchema.nullable(),
		})
		.strict(),
])
export type LoyaltyDiscount = z.infer<typeof loyaltyDiscountSchema>

const baseFields = {
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(280).nullable().default(null),
	pointsCost: z.number().int().min(1).max(LOYALTY_MAX_REWARD_COST),
	labels: loyaltyCatalogLabelsSchema.default({ items: {}, categories: {} }),
}

const idList = (max: number) =>
	z
		.array(loyaltyCatalogIdSchema)
		.min(1)
		.max(max)
		.refine((ids) => new Set(ids).size === ids.length, 'Duplicate id')

const rewardDefinitionObject = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('order'),
			...baseFields,
			discount: loyaltyDiscountSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('categories'),
			...baseFields,
			discount: loyaltyDiscountSchema,
			categoryIds: idList(LOYALTY_MAX_CATEGORY_IDS),
		})
		.strict(),
	z
		.object({
			kind: z.literal('items'),
			...baseFields,
			discount: loyaltyDiscountSchema,
			itemIds: idList(LOYALTY_MAX_ITEM_IDS),
		})
		.strict(),
	z
		.object({
			kind: z.literal('free_item'),
			...baseFields,
			/** One unit of this item; the customer picks the variant, paid modifiers stay chargeable. */
			itemId: loyaltyCatalogIdSchema,
		})
		.strict(),
])

export const loyaltyRewardDefinitionSchema = rewardDefinitionObject.superRefine(
	(definition, ctx) => {
		// A label belongs to an id the reward names; a reward on the whole order
		// names none.
		refineCatalogLabels(
			definition.labels,
			{
				itemIds:
					definition.kind === 'items'
						? definition.itemIds
						: definition.kind === 'free_item'
							? [definition.itemId]
							: [],
				categoryIds:
					definition.kind === 'categories' ? definition.categoryIds : [],
			},
			ctx,
		)
	},
)

export type LoyaltyRewardDefinition = z.infer<
	typeof loyaltyRewardDefinitionSchema
>

/** A reward version as stored and snapshotted onto redemptions. */
export const loyaltyRewardSnapshotSchema = z
	.object({
		rewardId: z.string().min(1).max(64),
		version: z.number().int().min(1),
		currency: currencySchema,
		definition: loyaltyRewardDefinitionSchema,
	})
	.strict()
export type LoyaltyRewardSnapshot = z.infer<typeof loyaltyRewardSnapshotSchema>
