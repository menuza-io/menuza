import { describe, expect, test } from 'vitest'
import {
	itemDetailSchema,
	priceComparisonQuerySchema,
	priceComparisonResultSchema,
} from './index.ts'

describe('price comparison contract (#508)', () => {
	test('query schema defaults to empty optional filters and rejects unknown keys', () => {
		expect(priceComparisonQuerySchema.parse({})).toEqual({})
		expect(
			priceComparisonQuerySchema.parse({
				from: '2026-09-01',
				to: '2026-11-23',
				itemId: 'itm_1',
			}),
		).toEqual({
			from: '2026-09-01',
			to: '2026-11-23',
			itemId: 'itm_1',
		})
		expect(
			priceComparisonQuerySchema.safeParse({ from: '2026-11-01', extra: 1 })
				.success,
		).toBe(false)
		expect(
			priceComparisonQuerySchema.safeParse({ from: 'not-a-date' }).success,
		).toBe(false)
	})

	test('result schema parses per-item and group saving summary', () => {
		const parsed = priceComparisonResultSchema.parse({
			from: '2026-09-01',
			to: '2026-11-23',
			currency: 'SAR',
			totalSavingMinor: 4_000,
			items: [
				{
					itemId: 'itm_1',
					itemName: 'Chicken breast',
					baseUnit: 'g',
					currency: 'SAR',
					entries: [
						{
							locationId: 'loc_a',
							supplierId: 'sup_1',
							supplierName: 'Al Watania',
							costMicro: 2_800_000,
							latestCostMicro: 2_800_000,
							latestPaidAt: 1_700_000_000_000,
							quantity: 10_000_000,
							paidMinor: 28_000,
							deliveriesCount: 1,
							currency: 'SAR',
						},
						{
							locationId: 'loc_b',
							supplierId: 'sup_2',
							supplierName: 'Fresh Foods',
							costMicro: 3_200_000,
							latestCostMicro: 3_200_000,
							latestPaidAt: 1_700_000_100_000,
							quantity: 10_000_000,
							paidMinor: 32_000,
							deliveriesCount: 1,
							currency: 'SAR',
						},
					],
					lowestCostMicro: 2_800_000,
					lowestLocationId: 'loc_a',
					lowestSupplierId: 'sup_1',
					lowestSupplierName: 'Al Watania',
					highestCostMicro: 3_200_000,
					highestLocationId: 'loc_b',
					highestSupplierId: 'sup_2',
					highestSupplierName: 'Fresh Foods',
					spreadCostMicro: 400_000,
					spreadBp: 1429,
					totalQuantity: 20_000_000,
					totalPaidMinor: 60_000,
					savingMinor: 4_000,
				},
			],
		})
		expect(parsed.totalSavingMinor).toBe(4_000)
		expect(parsed.items[0]?.entries).toHaveLength(2)
	})

	test('itemDetailSchema allows optional othersPay', () => {
		const base = {
			id: 'itm_1',
			name: 'Chicken',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
			archived: false,
			version: 1,
			onHand: 1000,
			countUnit: 'kg',
			units: [],
			areaIds: [],
			orderBelowQuantity: null,
			fillUpToQuantity: null,
			status: 'ok',
			lastCountedAt: null,
			notes: null,
			places: [],
			onHandByLocation: [],
			suppliers: [],
			hasMovements: false,
		}
		expect(itemDetailSchema.parse(base).othersPay).toBeUndefined()
		expect(
			itemDetailSchema.parse({
				...base,
				othersPay: {
					locationId: 'loc_b',
					supplierId: 'sup_1',
					supplierName: 'Al Watania',
					costMicro: 2_400_000,
					currency: 'SAR',
					currentCostMicro: 3_000_000,
					diffCostMicro: 600_000,
					savingBp: 2000,
					lastPaidAt: 1_700_000_000_000,
				},
			}).othersPay?.costMicro,
		).toBe(2_400_000)
	})
})
