import { describe, expect, it } from 'vitest'
import {
	conversionFactor,
	convertCostMicro,
	convertQuantity,
	quantityInCurrentUnit,
} from './unit-change.ts'

describe('conversionFactor', () => {
	it('reads 1 piece = 180 g as 180', () => {
		expect(conversionFactor('1', '180')).toEqual({
			ok: true,
			factor: { num: 180, den: 1 },
		})
	})
	it('reads 180 g = 1 piece as 1/180', () => {
		expect(conversionFactor('180', '1')).toEqual({
			ok: true,
			factor: { num: 1, den: 180 },
		})
	})
	it('keeps a density exact', () => {
		expect(conversionFactor('1.03', '1')).toEqual({
			ok: true,
			factor: { num: 100, den: 103 },
		})
	})
	it('refuses zero, negative and long decimals', () => {
		for (const bad of ['0', '-1', '1.1234567', 'abc', '']) {
			expect(conversionFactor(bad, '1').ok).toBe(false)
		}
	})
})

describe('conversions', () => {
	it('converts quantities and keeps the money', () => {
		const factor = { num: 180, den: 1 }
		// 12 pieces (12000 thousandths) become 2160 g.
		expect(convertQuantity(12_000, factor)).toBe(2_160_000)
		// SAR 1.80 a piece is 1_800_000_000 micro per piece-thousandth? use per base unit:
		const pieceCost = 1_800_000 // micro-minor per piece (thousandths scale not applied)
		const gramCost = convertCostMicro(pieceCost, factor)
		expect(gramCost).toBe(10_000)
		// 12 pieces at the old cost equal 2160 g at the new one.
		expect(12_000 * pieceCost).toBe(2_160_000 * gramCost)
	})
	it('rounds half up and handles negatives', () => {
		expect(convertQuantity(1, { num: 1, den: 2 })).toBe(1)
		expect(convertQuantity(-3, { num: 1, den: 2 })).toBe(-2)
		expect(convertQuantity(0, { num: 5, den: 3 })).toBe(0)
	})
	it('never prices anything at zero', () => {
		expect(convertCostMicro(1, { num: 1000, den: 1 })).toBe(1)
	})
	it('converts history written before each change, oldest first', () => {
		const changes = [
			{ at: 100, factor: { num: 180, den: 1 } },
			{ at: 200, factor: { num: 1, den: 1000 } },
		]
		expect(quantityInCurrentUnit(10, 50, changes)).toBe(2) // both apply
		expect(quantityInCurrentUnit(1800, 150, changes)).toBe(2) // second only
		expect(quantityInCurrentUnit(7, 250, changes)).toBe(7) // none
	})
})
