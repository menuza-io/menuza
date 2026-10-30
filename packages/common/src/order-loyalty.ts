import { z } from 'zod'

/**
 * The reward a signed-in customer picked for an order or a tab payment.
 * Mirrors `loyaltyOrderRewardSchema` in `@repo/loyalty` (`@repo/common` never
 * imports the loyalty package; the tenant-api schema-sync test asserts the
 * two stay in sync, bounds included). The region always re-quotes it: a changed reward,
 * balance or cart is refused, never applied silently.
 */
export const orderLoyaltySelectionSchema = z.strictObject({
	rewardId: z.string().min(1).max(64),
	/** The version the customer saw; a changed reward is re-quoted. */
	rewardVersion: z.number().int().min(1).max(1_000_000),
	/** The discount the customer saw; a different result is refused. */
	expectedDiscountMinor: z.number().int().min(0).max(1_000_000_000_000),
	targetLineId: z.string().min(1).max(100).nullable().default(null),
})

export type OrderLoyaltySelection = z.infer<typeof orderLoyaltySelectionSchema>
