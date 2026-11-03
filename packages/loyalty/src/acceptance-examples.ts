import { type z } from 'zod'
import { type LoyaltyCart, type loyaltyCartSchema } from './cart.ts'
import { type LoyaltyPurchaseSnapshot } from './earning.ts'
import { type LoyaltyEarningRule } from './program.ts'
import {
	type LoyaltyPromotion,
	type LoyaltyPromotionStacking,
} from './promotions.ts'
import { type LoyaltyRewardDefinition } from './rewards.ts'

/**
 * Frozen acceptance examples. Each one is a business rule stated as numbers;
 * `acceptance-examples.test.ts` checks the math against them and
 * `docs/loyalty.md` quotes them. Change an expectation only with a product
 * decision.
 */

type EarningExample = {
	id: string
	rule: string
	earning: LoyaltyEarningRule
	minimumSpendMinor: number
	snapshot: LoyaltyPurchaseSnapshot
	visitAlreadyAwarded?: boolean
	expectedPoints: number
	expectedReason: string | null
}

const line = (
	lineId: string,
	itemId: string,
	netMinor: number,
	extra: Partial<LoyaltyPurchaseSnapshot['lines'][number]> = {},
) => ({
	lineId,
	itemId,
	categoryIds: [] as string[],
	quantity: 1,
	netMinor,
	rewardUnits: 0,
	...extra,
})

export const EARNING_EXAMPLES: readonly EarningExample[] = [
	{
		id: 'spend-excludes-tax-tip-fees',
		rule: '1 point per $1 of merchandise after discounts; tax, tip and delivery fee earn nothing.',
		earning: { method: 'spend', points: 1, perMinor: 100 },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			// $12.50 + $4.25 merchandise, $1.50 tax, $2.00 tip, $3.99 delivery.
			totalPaidMinor: 2424,
			lines: [line('l1', 'burger', 1250), line('l2', 'fries', 425)],
		},
		expectedPoints: 16,
		expectedReason: null,
	},
	{
		id: 'spend-rounds-once-per-order',
		rule: '10 points per $3: $10.00 earns 33 (rounded down once), not 16 + 16 per line.',
		earning: { method: 'spend', points: 10, perMinor: 300 },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 500), line('l2', 'b', 500)],
		},
		expectedPoints: 33,
		expectedReason: null,
	},
	{
		id: 'visit-below-minimum',
		rule: 'A visit needs the minimum qualifying spend ($5.00): $4.99 earns nothing.',
		earning: { method: 'visit', points: 25 },
		minimumSpendMinor: 500,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 543,
			lines: [line('l1', 'coffee', 499)],
		},
		expectedPoints: 0,
		expectedReason: 'below_minimum',
	},
	{
		id: 'visit-once-per-local-day',
		rule: 'A second qualifying purchase on the same local day earns no visit.',
		earning: { method: 'visit', points: 25 },
		minimumSpendMinor: 500,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 800,
			lines: [line('l1', 'coffee', 800)],
		},
		visitAlreadyAwarded: true,
		expectedPoints: 0,
		expectedReason: 'visit_already_awarded',
	},
	{
		id: 'items-per-unit',
		rule: '5 points per latte: two lattes and a muffin earn 10.',
		earning: { method: 'items', points: 5, itemIds: ['latte'] },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1300,
			lines: [
				line('l1', 'latte', 900, { quantity: 2 }),
				line('l2', 'muffin', 400),
			],
		},
		expectedPoints: 10,
		expectedReason: null,
	},
	{
		id: 'categories-never-double-count',
		rule: 'A latte in both selected categories (coffee, hot drinks) counts once: 2 units x 3 = 6.',
		earning: {
			method: 'categories',
			points: 3,
			categoryIds: ['coffee', 'hot'],
		},
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 900,
			lines: [
				line('l1', 'latte', 900, {
					quantity: 2,
					categoryIds: ['coffee', 'hot'],
				}),
			],
		},
		expectedPoints: 6,
		expectedReason: null,
	},
	{
		id: 'free-reward-unit-earns-nothing',
		rule: 'The latte a free-item reward gave away earns no item points, even with paid oat milk; the paid latte earns 5.',
		earning: { method: 'items', points: 5, itemIds: ['latte'] },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 510,
			lines: [
				line('l1', 'latte', 60, { rewardUnits: 1 }),
				line('l2', 'latte', 450),
			],
		},
		expectedPoints: 5,
		expectedReason: null,
	},
	{
		id: 'fully-discounted-line-earns-nothing',
		rule: 'A line discounted to zero earns no item points.',
		earning: { method: 'items', points: 5, itemIds: ['cookie'] },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 300,
			lines: [line('l1', 'cookie', 0), line('l2', 'tea', 300)],
		},
		expectedPoints: 0,
		expectedReason: 'nothing_eligible',
	},
]

type DiscountExample = {
	id: string
	rule: string
	reward: LoyaltyRewardDefinition
	cart: z.input<typeof loyaltyCartSchema>
	targetLineId?: string
	expected:
		| { ok: true; discountMinor: number; lines: Record<string, number> }
		| { ok: false; code: string }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never

const reward = (
	definition: DistributiveOmit<
		LoyaltyRewardDefinition,
		'description' | 'labels'
	>,
): LoyaltyRewardDefinition =>
	({
		description: null,
		labels: { items: {}, categories: {} },
		...definition,
	}) as LoyaltyRewardDefinition

const cartLine = (
	lineId: string,
	itemId: string,
	unitMinor: number,
	extra: Partial<LoyaltyCart['lines'][number]> = {},
) => ({
	lineId,
	itemId,
	variantId: null,
	categoryIds: [] as string[],
	quantity: 1,
	unitBaseMinor: unitMinor,
	unitMinor,
	discountedMinor: 0,
	...extra,
})

export const DISCOUNT_EXAMPLES: readonly DiscountExample[] = [
	{
		id: 'fixed-capped-at-eligible',
		rule: '$5 off the order on a $3.50 order takes $3.50 off, never more.',
		reward: reward({
			kind: 'order',
			name: '$5 off',
			pointsCost: 100,
			discount: { type: 'fixed', amountMinor: 500 },
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'tea', 350)],
		},
		expected: { ok: true, discountMinor: 350, lines: { l1: 350 } },
	},
	{
		id: 'percent-with-maximum',
		rule: '20% off pastries, at most $3: $20 of pastries takes $3 off.',
		reward: reward({
			kind: 'categories',
			name: 'Pastry 20%',
			pointsCost: 150,
			discount: { type: 'percent', percentBp: 2000, maxDiscountMinor: 300 },
			categoryIds: ['pastry'],
		}),
		cart: {
			currency: 'USD',
			lines: [
				cartLine('l1', 'croissant', 500, {
					quantity: 4,
					categoryIds: ['pastry'],
				}),
				cartLine('l2', 'coffee', 300),
			],
		},
		expected: { ok: true, discountMinor: 300, lines: { l1: 300 } },
	},
	{
		id: 'percent-rounds-down',
		rule: '15% off a $2.99 bagel is 44 cents (rounded down).',
		reward: reward({
			kind: 'items',
			name: 'Bagel 15%',
			pointsCost: 50,
			discount: { type: 'percent', percentBp: 1500, maxDiscountMinor: null },
			itemIds: ['bagel'],
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'bagel', 299)],
		},
		expected: { ok: true, discountMinor: 44, lines: { l1: 44 } },
	},
	{
		id: 'free-item-dearest-variant',
		rule: 'A free latte takes the dearest variant base price off; modifiers stay chargeable.',
		reward: reward({
			kind: 'free_item',
			name: 'Free latte',
			pointsCost: 200,
			itemId: 'latte',
		}),
		cart: {
			currency: 'USD',
			lines: [
				cartLine('small', 'latte', 360, {
					variantId: 'small',
					unitBaseMinor: 300,
				}),
				cartLine('large', 'latte', 400, {
					variantId: 'large',
					unitBaseMinor: 400,
				}),
			],
		},
		expected: { ok: true, discountMinor: 400, lines: { large: 400 } },
	},
	{
		id: 'free-item-chosen-variant',
		rule: 'The customer may pick the small latte: $3.00 off, the 60 cent oat milk is still paid.',
		reward: reward({
			kind: 'free_item',
			name: 'Free latte',
			pointsCost: 200,
			itemId: 'latte',
		}),
		cart: {
			currency: 'USD',
			lines: [
				cartLine('small', 'latte', 360, {
					variantId: 'small',
					unitBaseMinor: 300,
				}),
				cartLine('large', 'latte', 400, {
					variantId: 'large',
					unitBaseMinor: 400,
				}),
			],
		},
		targetLineId: 'small',
		expected: { ok: true, discountMinor: 300, lines: { small: 300 } },
	},
	{
		id: 'largest-remainder-allocation',
		rule: '$1 off three $1 lines splits 34 / 33 / 33, the extra cent to the first line.',
		reward: reward({
			kind: 'order',
			name: '$1 off',
			pointsCost: 20,
			discount: { type: 'fixed', amountMinor: 100 },
		}),
		cart: {
			currency: 'USD',
			lines: [
				cartLine('a', 'x', 100),
				cartLine('b', 'y', 100),
				cartLine('c', 'z', 100),
			],
		},
		expected: { ok: true, discountMinor: 100, lines: { a: 34, b: 33, c: 33 } },
	},
	{
		id: 'zero-value-rejected',
		rule: 'A free item whose base price is zero is refused, and no points are spent.',
		reward: reward({
			kind: 'free_item',
			name: 'Free water',
			pointsCost: 10,
			itemId: 'water',
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'water', 50, { unitBaseMinor: 0 })],
		},
		expected: { ok: false, code: 'zero_value' },
	},
	{
		id: 'not-applicable',
		rule: 'An item reward with none of its items on the bill does not apply.',
		reward: reward({
			kind: 'items',
			name: 'Bagel $1',
			pointsCost: 50,
			discount: { type: 'fixed', amountMinor: 100 },
			itemIds: ['bagel'],
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'tea', 300)],
		},
		expected: { ok: false, code: 'reward_not_applicable' },
	},
	{
		id: 'reward-on-discounted-line',
		rule: 'A $3 coupon already took $1 off a $3 tea: 50% off the order is half of the $2 left (100 cents), not half of $3.',
		reward: reward({
			kind: 'order',
			name: '50% off',
			pointsCost: 80,
			discount: { type: 'percent', percentBp: 5000, maxDiscountMinor: null },
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'tea', 300, { discountedMinor: 100 })],
		},
		expected: { ok: true, discountMinor: 100, lines: { l1: 100 } },
	},
	{
		id: 'fixed-reward-capped-at-what-is-left',
		rule: '$5 off the order after discounts left $3.50: the reward takes $3.50.',
		reward: reward({
			kind: 'order',
			name: '$5 off',
			pointsCost: 100,
			discount: { type: 'fixed', amountMinor: 500 },
		}),
		cart: {
			currency: 'USD',
			lines: [
				cartLine('l1', 'tea', 300, { discountedMinor: 50 }),
				cartLine('l2', 'cake', 400, { discountedMinor: 300 }),
			],
		},
		expected: { ok: true, discountMinor: 350, lines: { l1: 250, l2: 100 } },
	},
	{
		id: 'free-item-on-discounted-line',
		rule: 'A free latte on a $4.00 latte that a coupon cut by $1.50 is worth the $2.50 left.',
		reward: reward({
			kind: 'free_item',
			name: 'Free latte',
			pointsCost: 200,
			itemId: 'latte',
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'latte', 400, { discountedMinor: 150 })],
		},
		expected: { ok: true, discountMinor: 250, lines: { l1: 250 } },
	},
	{
		id: 'fully-discounted-line-takes-no-reward',
		rule: 'A line a coupon already made free has nothing left for an order reward.',
		reward: reward({
			kind: 'order',
			name: '$1 off',
			pointsCost: 20,
			discount: { type: 'fixed', amountMinor: 100 },
		}),
		cart: {
			currency: 'USD',
			lines: [cartLine('l1', 'tea', 300, { discountedMinor: 300 })],
		},
		expected: { ok: false, code: 'reward_not_applicable' },
	},
	{
		id: 'currency-locked',
		rule: 'A USD reward never applies to a SAR bill.',
		reward: reward({
			kind: 'order',
			name: '$1 off',
			pointsCost: 20,
			discount: { type: 'fixed', amountMinor: 100 },
		}),
		cart: {
			currency: 'SAR',
			lines: [cartLine('l1', 'tea', 300)],
		},
		expected: { ok: false, code: 'currency_mismatch' },
	},
]

type RefundExample = {
	id: string
	rule: string
	earning: LoyaltyEarningRule
	minimumSpendMinor: number
	snapshot: LoyaltyPurchaseSnapshot
	awardedPoints: number
	/** Cumulative refunded amount after each event, and the points taken back by it. */
	steps: Array<{
		cumulativeRefundedMinor: number
		reversePoints: number
		fullRefund: boolean
	}>
}

export const REFUND_EXAMPLES: readonly RefundExample[] = [
	{
		id: 'spend-partial-then-full',
		rule: '$40 of merchandise paid $45 (tax and tip): each $9 refund takes back 8 points, the final full refund the rest.',
		earning: { method: 'spend', points: 1, perMinor: 100 },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 4500,
			lines: [line('l1', 'steak', 4000)],
		},
		awardedPoints: 40,
		steps: [
			{ cumulativeRefundedMinor: 900, reversePoints: 8, fullRefund: false },
			{ cumulativeRefundedMinor: 1800, reversePoints: 8, fullRefund: false },
			{ cumulativeRefundedMinor: 4500, reversePoints: 24, fullRefund: true },
		],
	},
	{
		id: 'visit-falls-below-minimum',
		rule: 'A visit with a $10 minimum is taken back when a refund leaves less than $10.',
		earning: { method: 'visit', points: 25 },
		minimumSpendMinor: 1000,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1200,
			lines: [line('l1', 'lunch', 1200)],
		},
		awardedPoints: 25,
		steps: [
			{ cumulativeRefundedMinor: 100, reversePoints: 0, fullRefund: false },
			{ cumulativeRefundedMinor: 300, reversePoints: 25, fullRefund: false },
		],
	},
	{
		id: 'items-proportional',
		rule: 'Three items at 5 points each ($10, $5, $3): a $3 refund keeps 12 of 15 points.',
		earning: {
			method: 'items',
			points: 5,
			itemIds: ['burger', 'fries', 'soda'],
		},
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1800,
			lines: [
				line('l1', 'burger', 1000),
				line('l2', 'fries', 500),
				line('l3', 'soda', 300),
			],
		},
		awardedPoints: 15,
		steps: [
			{ cumulativeRefundedMinor: 300, reversePoints: 3, fullRefund: false },
			{ cumulativeRefundedMinor: 300, reversePoints: 0, fullRefund: false },
		],
	},
]

type PromotionExample = {
	id: string
	rule: string
	earning: LoyaltyEarningRule
	minimumSpendMinor: number
	snapshot: LoyaltyPurchaseSnapshot
	promotions: Array<Partial<LoyaltyPromotion> & { id: string }>
	stacking?: LoyaltyPromotionStacking
	/** When the sale finished, in epoch ms. */
	occurredAt: number
	timeZone: string
	locationId: string | null
	visitAlreadyAwarded?: boolean
	expectedBasePoints: number
	expectedBonusPoints: number
	expectedApplied: Array<{ id: string; points: number }>
}

const NY = 'America/New_York'
/** Tuesday 2026-01-13 at the given New York wall-clock time (EST, UTC-5). */
const tuesdayNy = (hour: number, minute = 0) =>
	Date.UTC(2026, 0, 13, hour + 5, minute)

const spendOne = { method: 'spend', points: 1, perMinor: 100 } as const

export const PROMOTION_EXAMPLES: readonly PromotionExample[] = [
	{
		id: 'multiplier-order',
		rule: '2x points on the whole order: a $20.00 order earns 20, the promotion adds 20.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 2200,
			lines: [line('l1', 'burger', 2000)],
		},
		promotions: [
			{
				id: 'double',
				name: 'Double points',
				kind: 'multiplier',
				value: 20_000,
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: 'loc_1',
		expectedBasePoints: 20,
		expectedBonusPoints: 20,
		expectedApplied: [{ id: 'double', points: 20 }],
	},
	{
		id: 'multiplier-rounds-down-once',
		rule: '1.5x on an order that earned 33 (10 points per $3, $10.00): the extra is 16.5, rounded down once to 16.',
		earning: { method: 'spend', points: 10, perMinor: 300 },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 500), line('l2', 'b', 500)],
		},
		promotions: [
			{ id: 'half', name: 'Bonus', kind: 'multiplier', value: 15_000 },
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 33,
		expectedBonusPoints: 16,
		expectedApplied: [{ id: 'half', points: 16 }],
	},
	{
		id: 'recurring-window-opens-at-start-closes-at-end',
		rule: 'Tuesday 3 to 5 pm happy hour: 14:59 earns no extra, 15:00 does, 16:59 does, 17:00 does not (New York time).',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{
				id: 'happy',
				name: 'Happy hour',
				kind: 'multiplier',
				value: 20_000,
				recurring: { weekdays: [2], fromMinute: 15 * 60, toMinute: 17 * 60 },
			},
		],
		occurredAt: tuesdayNy(14, 59),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
	{
		id: 'recurring-window-inside',
		rule: 'The same happy hour at 15:00 sharp: the order earns 10 and the promotion adds 10.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{
				id: 'happy',
				name: 'Happy hour',
				kind: 'multiplier',
				value: 20_000,
				recurring: { weekdays: [2], fromMinute: 15 * 60, toMinute: 17 * 60 },
			},
		],
		occurredAt: tuesdayNy(15),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 10,
		expectedApplied: [{ id: 'happy', points: 10 }],
	},
	{
		id: 'recurring-window-closed-at-end',
		rule: 'The same happy hour at 17:00: closed.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{
				id: 'happy',
				name: 'Happy hour',
				kind: 'multiplier',
				value: 20_000,
				recurring: { weekdays: [2], fromMinute: 15 * 60, toMinute: 17 * 60 },
			},
		],
		occurredAt: tuesdayNy(17),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
	{
		id: 'best-wins-by-default',
		rule: 'Two promotions match: 2x gives +10, a flat +15 gives 15. The best one wins: +15.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{ id: 'double', name: 'Double', kind: 'multiplier', value: 20_000 },
			{ id: 'flat', name: 'Flat', kind: 'bonus', value: 15 },
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 15,
		expectedApplied: [{ id: 'flat', points: 15 }],
	},
	{
		id: 'add-stacks-every-match',
		rule: 'The same two promotions with stacking "add": +10 and +15 give +25.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{ id: 'double', name: 'Double', kind: 'multiplier', value: 20_000 },
			{ id: 'flat', name: 'Flat', kind: 'bonus', value: 15 },
		],
		stacking: 'add',
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 25,
		expectedApplied: [
			{ id: 'double', points: 10 },
			{ id: 'flat', points: 15 },
		],
	},
	{
		id: 'per-purchase-cap',
		rule: '3x on a $100.00 order would add 200; a cap of 50 bonus points per purchase holds it to 50.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 10_000,
			lines: [line('l1', 'a', 10_000)],
		},
		promotions: [
			{
				id: 'triple',
				name: 'Triple',
				kind: 'multiplier',
				value: 30_000,
				maxPointsPerPurchase: 50,
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 100,
		expectedBonusPoints: 50,
		expectedApplied: [{ id: 'triple', points: 50 }],
	},
	{
		id: 'category-multiplier-only-boosts-its-lines',
		rule: "2x on dessert only: the $6.00 of desserts earned 6 of the order's 16, so the promotion adds 6, not 16.",
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1600,
			lines: [
				line('l1', 'steak', 1000),
				line('l2', 'cake', 600, { categoryIds: ['dessert'] }),
			],
		},
		promotions: [
			{
				id: 'sweet',
				name: 'Sweet double',
				kind: 'multiplier',
				value: 20_000,
				scope: { type: 'categories', categoryIds: ['dessert'] },
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 16,
		expectedBonusPoints: 6,
		expectedApplied: [{ id: 'sweet', points: 6 }],
	},
	{
		id: 'item-bonus-per-unit',
		rule: '+3 points per latte: two lattes and a muffin add 6.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1100,
			lines: [
				line('l1', 'latte', 800, { quantity: 2 }),
				line('l2', 'muffin', 300),
			],
		},
		promotions: [
			{
				id: 'latte',
				name: 'Latte bonus',
				kind: 'bonus',
				value: 3,
				scope: { type: 'items', itemIds: ['latte'] },
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 11,
		expectedBonusPoints: 6,
		expectedApplied: [{ id: 'latte', points: 6 }],
	},
	{
		id: 'free-reward-unit-gets-no-item-bonus',
		rule: 'A latte given away by a free-item reward is not a unit for the item bonus: one paid latte adds 3.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 400,
			lines: [line('l1', 'latte', 400, { quantity: 2, rewardUnits: 1 })],
		},
		promotions: [
			{
				id: 'latte',
				name: 'Latte bonus',
				kind: 'bonus',
				value: 3,
				scope: { type: 'items', itemIds: ['latte'] },
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 4,
		expectedBonusPoints: 3,
		expectedApplied: [{ id: 'latte', points: 3 }],
	},
	{
		id: 'location-scoped-promotion-at-another-location',
		rule: 'A promotion for loc_2 gives nothing at loc_1, or on a sale with no location.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{
				id: 'second',
				name: 'Second store',
				kind: 'bonus',
				value: 5,
				locationIds: ['loc_2'],
			},
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: 'loc_1',
		expectedBasePoints: 10,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
	{
		id: 'no-bonus-without-a-base-award',
		rule: 'A purchase below the minimum spend earns nothing, so a flat +5 promotion adds nothing either.',
		earning: spendOne,
		minimumSpendMinor: 500,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 400,
			lines: [line('l1', 'a', 400)],
		},
		promotions: [{ id: 'flat', name: 'Flat', kind: 'bonus', value: 5 }],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 0,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
	{
		id: 'no-bonus-on-a-second-visit-the-same-day',
		rule: 'A visit program awards once a day: the second purchase earns nothing and a flat +5 promotion adds nothing.',
		earning: { method: 'visit', points: 10 },
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 400,
			lines: [line('l1', 'a', 400)],
		},
		promotions: [{ id: 'flat', name: 'Flat', kind: 'bonus', value: 5 }],
		visitAlreadyAwarded: true,
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 0,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
	{
		id: 'disabled-promotion-gives-nothing',
		rule: 'A promotion that is switched off gives nothing.',
		earning: spendOne,
		minimumSpendMinor: 0,
		snapshot: {
			currency: 'USD',
			totalPaidMinor: 1000,
			lines: [line('l1', 'a', 1000)],
		},
		promotions: [
			{ id: 'off', name: 'Off', kind: 'bonus', value: 5, enabled: false },
		],
		occurredAt: tuesdayNy(12),
		timeZone: NY,
		locationId: null,
		expectedBasePoints: 10,
		expectedBonusPoints: 0,
		expectedApplied: [],
	},
] as const
