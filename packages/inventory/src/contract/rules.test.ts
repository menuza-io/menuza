import { describe, expect, test } from 'vitest'
import { countEntriesSchema, createItemSchema } from './index.ts'
import { foodCostBp, needsReview, priceChangeBp, stockStatus } from './rules.ts'

describe('stock status', () => {
	test.each([
		[0, null, 'out'],
		[-5, 10, 'out'],
		[5, null, 'ok'],
		[5, 10, 'low'],
		[10, 10, 'ok'],
	] as const)('%i with level %s is %s', (onHand, level, status) => {
		expect(stockStatus(onHand, level)).toBe(status)
	})
})

describe('count review', () => {
	test('small differences pass', () => {
		expect(
			needsReview({ expected: 1000, counted: 900, differenceValueMinor: 9000 }),
		).toBe(false)
	})
	test('big share and big money needs a look', () => {
		expect(
			needsReview({
				expected: 1000,
				counted: 700,
				differenceValueMinor: -3000,
			}),
		).toBe(true)
	})
	test('big share but cheap passes', () => {
		expect(
			needsReview({ expected: 1000, counted: 700, differenceValueMinor: -100 }),
		).toBe(false)
	})
	test('unknown cost uses the share alone', () => {
		expect(
			needsReview({ expected: 1000, counted: 700, differenceValueMinor: null }),
		).toBe(true)
	})
	test('found stock where none was expected', () => {
		expect(
			needsReview({ expected: 0, counted: 5, differenceValueMinor: null }),
		).toBe(true)
		expect(
			needsReview({ expected: 0, counted: 0, differenceValueMinor: null }),
		).toBe(false)
	})
})

describe('food cost', () => {
	test('opening + purchases − closing over sales', () => {
		expect(
			foodCostBp({
				openingMinor: 10_000,
				purchasesMinor: 5_000,
				closingMinor: 9_000,
				salesMinor: 20_000,
			}),
		).toBe(3000)
	})
	test('no sales is unknown, negative usage is zero', () => {
		expect(
			foodCostBp({
				openingMinor: 1,
				purchasesMinor: 1,
				closingMinor: 1,
				salesMinor: 0,
			}),
		).toBeNull()
		expect(
			foodCostBp({
				openingMinor: 1,
				purchasesMinor: 0,
				closingMinor: 5,
				salesMinor: 10,
			}),
		).toBe(0)
	})
	test('price change', () => {
		expect(priceChangeBp(1_000_000, 1_140_000)).toBe(1400)
		expect(priceChangeBp(null, 5)).toBeNull()
	})
})

describe('contract', () => {
	test('item names are one plain string, never a locale map', () => {
		const base = {
			clientId: 'client-0001',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
		}
		expect(
			createItemSchema.safeParse({ ...base, name: 'Chicken thighs' }).success,
		).toBe(true)
		expect(
			createItemSchema.safeParse({
				...base,
				name: { en: 'Chicken', ar: 'دجاج' },
			}).success,
		).toBe(false)
	})
	test('count entries accept a cleared amount and named units', () => {
		expect(
			countEntriesSchema.safeParse({
				entries: [
					{
						clientId: 'client-0001',
						itemId: 'it_1',
						areaId: null,
						amount: null,
						unit: 'kg',
					},
					{
						clientId: 'client-0002',
						itemId: 'it_1',
						areaId: 'a1',
						amount: 2.5,
						unit: 'unit:u1',
					},
				],
			}).success,
		).toBe(true)
	})
})
