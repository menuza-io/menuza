import { describe, expect, it } from 'vitest'
import { loyaltyCartSchema } from './cart.ts'
import { computeRewardDiscount } from './discount.ts'
import { LOYALTY_MAX_MINOR } from './money.ts'
import {
	LOYALTY_MAX_CATEGORY_IDS,
	LOYALTY_MAX_ITEM_IDS,
	loyaltyCatalogLabelsSchema,
	loyaltyProgramConfigSchema,
} from './program.ts'
import { loyaltyRewardDefinitionSchema } from './rewards.ts'
import { loyaltyOrderRewardSchema } from './schemas/public.ts'
import { loyaltyReportQuerySchema } from './schemas/reports.ts'

const ids = (prefix: string, count: number) =>
	Array.from({ length: count }, (_, index) => `${prefix}${index}`)
const named = (keys: readonly string[]) =>
	Object.fromEntries(keys.map((key) => [key, `Name ${key}`]))

const program = (earning: unknown, labels: unknown) => ({
	name: 'Program',
	unitLabel: 'points',
	currency: 'USD',
	timeZone: 'UTC',
	minimumSpendMinor: 0,
	earning,
	terms: 'Terms',
	labels,
})

const reward = (extra: Record<string, unknown>) => ({
	name: 'Reward',
	pointsCost: 100,
	...(extra.kind === 'free_item'
		? {}
		: { discount: { type: 'fixed', amountMinor: 100 } }),
	...extra,
})

describe('catalog labels', () => {
	it('bounds the maps at the id list limits', () => {
		const ok = loyaltyCatalogLabelsSchema.safeParse({
			items: named(ids('i', LOYALTY_MAX_ITEM_IDS)),
			categories: named(ids('c', LOYALTY_MAX_CATEGORY_IDS)),
		})
		expect(ok.success).toBe(true)
		expect(
			loyaltyCatalogLabelsSchema.safeParse({
				items: named(ids('i', LOYALTY_MAX_ITEM_IDS + 1)),
			}).success,
		).toBe(false)
		expect(
			loyaltyCatalogLabelsSchema.safeParse({
				categories: named(ids('c', LOYALTY_MAX_CATEGORY_IDS + 1)),
			}).success,
		).toBe(false)
	})

	it('only allows labels for the items an earning rule names', () => {
		const rule = { method: 'items', points: 1, itemIds: ['a', 'b'] }
		expect(
			loyaltyProgramConfigSchema.safeParse(
				program(rule, { items: named(['a']), categories: {} }),
			).success,
		).toBe(true)
		const refused = loyaltyProgramConfigSchema.safeParse(
			program(rule, { items: named(['a', 'zzz-secret']), categories: {} }),
		)
		expect(refused.success).toBe(false)
		if (!refused.success) {
			expect(refused.error.issues[0]?.path).toEqual(['labels', 'items'])
			expect(JSON.stringify(refused.error.issues)).not.toContain('zzz-secret')
		}
		expect(
			loyaltyProgramConfigSchema.safeParse(
				program(rule, { items: {}, categories: named(['a']) }),
			).success,
		).toBe(false)
	})

	it('allows no labels on a rule that names no ids', () => {
		const spend = { method: 'spend', points: 1, perMinor: 100 }
		expect(
			loyaltyProgramConfigSchema.safeParse(program(spend, {})).success,
		).toBe(true)
		expect(
			loyaltyProgramConfigSchema.safeParse(
				program(spend, { items: named(['a']) }),
			).success,
		).toBe(false)
	})

	it('only allows labels for the ids a reward names', () => {
		const items = reward({
			kind: 'items',
			itemIds: ['a'],
			labels: { items: named(['a']), categories: {} },
		})
		expect(loyaltyRewardDefinitionSchema.safeParse(items).success).toBe(true)
		expect(
			loyaltyRewardDefinitionSchema.safeParse({
				...items,
				labels: { items: named(['b']), categories: {} },
			}).success,
		).toBe(false)
		expect(
			loyaltyRewardDefinitionSchema.safeParse(
				reward({
					kind: 'free_item',
					itemId: 'a',
					labels: { items: named(['a']) },
				}),
			).success,
		).toBe(true)
		expect(
			loyaltyRewardDefinitionSchema.safeParse(
				reward({ kind: 'order', labels: { categories: named(['c']) } }),
			).success,
		).toBe(false)
		expect(
			loyaltyRewardDefinitionSchema.safeParse(
				reward({
					kind: 'categories',
					categoryIds: ['c'],
					labels: { categories: named(['c']) },
				}),
			).success,
		).toBe(true)
	})
})

describe('cart bounds', () => {
	const cartLine = (index: number, quantity: number, unit: number) => ({
		lineId: `l${index}`,
		itemId: 'item',
		variantId: null,
		categoryIds: [],
		quantity,
		unitBaseMinor: unit,
		unitMinor: unit,
	})
	const cart = (lines: unknown[]) => ({ currency: 'USD', lines })

	it('refuses a cart whose subtotal outgrows the money bound', () => {
		const lines = Array.from({ length: 200 }, (_, index) =>
			cartLine(index, 1000, LOYALTY_MAX_MINOR),
		)
		expect(loyaltyCartSchema.safeParse(cart(lines)).success).toBe(false)
		// One line alone is quantity times price.
		expect(
			loyaltyCartSchema.safeParse(cart([cartLine(0, 2, LOYALTY_MAX_MINOR)]))
				.success,
		).toBe(false)
	})

	it('accepts a cart at the bound and prices a discount on it', () => {
		const parsed = loyaltyCartSchema.parse(
			cart([cartLine(0, 1, LOYALTY_MAX_MINOR)]),
		)
		const result = computeRewardDiscount(
			{
				currency: 'USD',
				definition: loyaltyRewardDefinitionSchema.parse(
					reward({
						kind: 'order',
						discount: {
							type: 'percent',
							percentBp: 10_000,
							maxDiscountMinor: null,
						},
					}),
				),
			},
			parsed,
		)
		expect(result.ok && result.discountMinor).toBe(LOYALTY_MAX_MINOR)
	})
})

describe('report dates', () => {
	const query = (from: string, to: string) =>
		loyaltyReportQuerySchema.safeParse({ from, to }).success

	it('accepts real calendar days, leap days included', () => {
		expect(query('2026-01-01', '2026-01-31')).toBe(true)
		expect(query('2028-02-29', '2028-03-01')).toBe(true)
	})

	it('refuses dates that only look like dates', () => {
		expect(query('2026-13-45', '2026-13-46')).toBe(false)
		expect(query('2026-02-30', '2026-03-01')).toBe(false)
		expect(query('2027-02-29', '2027-03-01')).toBe(false)
		expect(query('2026-01-01', '2026-00-10')).toBe(false)
		expect(query('2026-01-01', '2026-01-32')).toBe(false)
		expect(query('2026-1-1', '2026-01-31')).toBe(false)
	})
})

/**
 * The same cases run in `@repo/common` against `orderLoyaltySelectionSchema`
 * (packages/common/src/order-loyalty.test.ts); keep the two tables equal.
 */
describe('order reward selection bounds', () => {
	const valid = {
		rewardId: 'r'.repeat(64),
		rewardVersion: 1_000_000,
		expectedDiscountMinor: 1_000_000_000_000,
		targetLineId: 'l'.repeat(100),
	}
	const accepts = (value: unknown) =>
		loyaltyOrderRewardSchema.safeParse(value).success

	it('accepts the largest allowed values', () => {
		expect(accepts(valid)).toBe(true)
	})

	it.each([
		['rewardId', { rewardId: 'r'.repeat(65) }],
		['rewardId', { rewardId: '' }],
		['rewardVersion', { rewardVersion: 1_000_001 }],
		['rewardVersion', { rewardVersion: 0 }],
		['expectedDiscountMinor', { expectedDiscountMinor: 1_000_000_000_001 }],
		['expectedDiscountMinor', { expectedDiscountMinor: -1 }],
		['expectedDiscountMinor', { expectedDiscountMinor: 1.5 }],
		['targetLineId', { targetLineId: 'l'.repeat(101) }],
		['targetLineId', { targetLineId: '' }],
	])('refuses a bad %s', (_field, patch) => {
		expect(accepts({ ...valid, ...patch })).toBe(false)
	})
})
