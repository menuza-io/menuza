import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
	costMicroFromPackPrice,
	inventoryValueMinor,
	weightedAverageCostMicro,
} from './cost.ts'

describe('item cost per base unit', () => {
	test('turns a pack price into micro-minor units per base unit', () => {
		// SAR 280 for a 10 kg box: 2.8 halalas a gram.
		expect(costMicroFromPackPrice(28_000, 10_000_000)).toBe(2_800_000)
		// SAR 10 for 10,000 napkins: 0.1 halala each.
		expect(costMicroFromPackPrice(1_000, 10_000_000)).toBe(100_000)
		// SAR 2 for a kg of salt.
		expect(costMicroFromPackPrice(200, 1_000_000)).toBe(200_000)
		// Saffron at SAR 20,000 a kg stays a safe integer.
		expect(costMicroFromPackPrice(2_000_000, 1_000_000)).toBe(2_000_000_000)
	})

	test('values quantities in minor units, rounding half up, signed', () => {
		// 1.5 kg of chicken at 2.8 halalas a gram: SAR 42.
		expect(inventoryValueMinor(1_500_000, 2_800_000)).toBe(4_200)
		expect(inventoryValueMinor(-1_500_000, 2_800_000)).toBe(-4_200)
		// 2.5 g of salt is half a halala: rounds up.
		expect(inventoryValueMinor(2_500, 200_000)).toBe(1)
		expect(inventoryValueMinor(0, 2_800_000)).toBe(0)
	})

	test('refuses non-integers and impossible inputs', () => {
		expect(() => costMicroFromPackPrice(1, 0)).toThrow(RangeError)
		expect(() => costMicroFromPackPrice(1.5, 10)).toThrow(RangeError)
		expect(() => inventoryValueMinor(1, -1)).toThrow(RangeError)
	})

	test('a pack valued at its own cost gives its price back, within the rounding of one micro-minor per base unit', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 100_000_000 }),
				// At least one base unit per pack (a gram, a millilitre, a piece).
				fc.integer({ min: 1_000, max: 9_000_000_000 }),
				(price, pack) => {
					const cost = costMicroFromPackPrice(price, pack)
					const back = inventoryValueMinor(pack, cost)
					// Rounding the cost moves it at most half a micro-minor per base
					// unit, i.e. pack / 2e9 minor over the pack, plus half a minor unit.
					expect(Math.abs(back - price)).toBeLessThanOrEqual(1 + pack / 2e9)
				},
			),
		)
	})
})

describe('weighted average cost', () => {
	test('averages what is on hand with what arrived', () => {
		expect(
			weightedAverageCostMicro({
				onHandQuantity: 10_000_000,
				averageCostMicro: 2_000_000,
				receivedQuantity: 10_000_000,
				receivedCostMicro: 3_000_000,
			}),
		).toBe(2_500_000)
	})

	test('uses the delivery price with nothing on hand, no average yet, or stock below zero', () => {
		for (const input of [
			{ onHandQuantity: 0, averageCostMicro: 2_000_000 },
			{ onHandQuantity: 5_000, averageCostMicro: null },
			{ onHandQuantity: -4_000_000, averageCostMicro: 2_000_000 },
		]) {
			expect(
				weightedAverageCostMicro({
					...input,
					receivedQuantity: 1_000_000,
					receivedCostMicro: 3_000_000,
				}),
			).toBe(3_000_000)
		}
	})

	test('keeps the old average when nothing arrives and nothing is on hand', () => {
		expect(
			weightedAverageCostMicro({
				onHandQuantity: 0,
				averageCostMicro: 2_000_000,
				receivedQuantity: 0,
				receivedCostMicro: 9,
			}),
		).toBe(2_000_000)
	})

	test('stays between the two prices', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 9_000_000_000 }),
				fc.integer({ min: 0, max: 2_000_000_000 }),
				fc.integer({ min: 1, max: 9_000_000_000 }),
				fc.integer({ min: 0, max: 2_000_000_000 }),
				(onHand, average, received, price) => {
					const result = weightedAverageCostMicro({
						onHandQuantity: onHand,
						averageCostMicro: average,
						receivedQuantity: received,
						receivedCostMicro: price,
					})
					expect(result).toBeGreaterThanOrEqual(Math.min(average, price))
					expect(result).toBeLessThanOrEqual(Math.max(average, price))
				},
			),
		)
	})
})
