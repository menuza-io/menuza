import { type LoyaltyCart } from './cart.ts'
import { type LoyaltyPurchaseSnapshot } from './earning.ts'
import { type LoyaltyEarningRule } from './program.ts'
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
	cart: LoyaltyCart
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
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
			otherDiscountMinor: 0,
			lines: [cartLine('l1', 'tea', 300)],
		},
		expected: { ok: false, code: 'reward_not_applicable' },
	},
	{
		id: 'no-stacking',
		rule: 'A bill that already has a discretionary discount takes no reward.',
		reward: reward({
			kind: 'order',
			name: '$1 off',
			pointsCost: 20,
			discount: { type: 'fixed', amountMinor: 100 },
		}),
		cart: {
			currency: 'USD',
			otherDiscountMinor: 200,
			lines: [cartLine('l1', 'tea', 300)],
		},
		expected: { ok: false, code: 'stacking_not_allowed' },
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
			otherDiscountMinor: 0,
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
