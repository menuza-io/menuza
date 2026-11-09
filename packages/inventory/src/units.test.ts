import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
	displayUnitFor,
	fromBaseQuantity,
	INVENTORY_BASE_UNITS,
	QUANTITY_SCALE,
	roundForDisplay,
	STANDARD_UNIT_SPECS,
	STANDARD_UNITS,
	standardUnitsFor,
	toBaseQuantity,
	UnitMismatchError,
} from './units.ts'

const kg = { kind: 'standard', unit: 'kg' } as const

describe('quantities', () => {
	test('stores thousandths of the base unit', () => {
		expect(toBaseQuantity(1.5, kg, 'g')).toBe(1_500_000)
		expect(
			toBaseQuantity(0.25, { kind: 'standard', unit: 'piece' }, 'piece'),
		).toBe(250)
		expect(
			toBaseQuantity(2, { kind: 'named', baseQuantity: 10_000_000 }, 'g'),
		).toBe(20_000_000)
		expect(toBaseQuantity(1, { kind: 'standard', unit: 'lb' }, 'g')).toBe(
			453_592,
		)
	})

	test('refuses a unit of another dimension', () => {
		expect(() =>
			toBaseQuantity(1, { kind: 'standard', unit: 'l' }, 'g'),
		).toThrow(UnitMismatchError)
		expect(() => toBaseQuantity(1, kg, 'piece')).toThrow(UnitMismatchError)
	})

	test('refuses non-numbers', () => {
		expect(() => toBaseQuantity(Number.NaN, kg, 'g')).toThrow(RangeError)
	})

	test('every standard unit maps to a base unit', () => {
		for (const unit of STANDARD_UNITS) {
			expect(INVENTORY_BASE_UNITS).toContain(STANDARD_UNIT_SPECS[unit].base)
		}
	})

	test('round trips stay within half a thousandth', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...STANDARD_UNITS),
				fc.double({ min: 0, max: 100_000, noNaN: true }),
				(unit, amount) => {
					const base = STANDARD_UNIT_SPECS[unit].base
					const u = { kind: 'standard', unit } as const
					const stored = toBaseQuantity(amount, u, base)
					expect(Number.isInteger(stored)).toBe(true)
					const back = fromBaseQuantity(stored, u, base)
					const perUnit = STANDARD_UNIT_SPECS[unit].factor * QUANTITY_SCALE
					expect(Math.abs(back - amount) * perUnit).toBeLessThanOrEqual(0.5)
				},
			),
		)
	})

	test('units offered per base and system', () => {
		expect(standardUnitsFor('g', 'metric')).toEqual(['g', 'kg'])
		expect(standardUnitsFor('g', 'us')).toEqual(['g', 'kg', 'oz', 'lb'])
		expect(standardUnitsFor('piece', 'us')).toEqual(['piece'])
	})

	test('display unit reads best', () => {
		expect(displayUnitFor(999_000, 'g', 'metric')).toBe('g')
		expect(displayUnitFor(1_000_000, 'g', 'metric')).toBe('kg')
		expect(displayUnitFor(2_000_000, 'ml', 'metric')).toBe('l')
		expect(displayUnitFor(500_000, 'g', 'us')).toBe('lb')
		expect(displayUnitFor(100_000, 'g', 'us')).toBe('oz')
		expect(displayUnitFor(3, 'piece', 'us')).toBe('piece')
	})

	test('display rounding', () => {
		expect(roundForDisplay(123.456)).toBe(123)
		expect(roundForDisplay(12.3456)).toBe(12.35)
		expect(roundForDisplay(0.12345)).toBe(0.123)
	})
})
