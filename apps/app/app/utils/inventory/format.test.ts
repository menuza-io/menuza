import { describe, expect, it } from 'vitest'
import {
	defaultEntryUnit,
	entryStep,
	estimateValueMinor,
	fillRatio,
	formatCostPerUnit,
	formatMoney,
	formatQuantity,
	formatUnitName,
	quantityParts,
	type UnitLabels,
	unitChoices,
} from './format.ts'

const labels: UnitLabels = {
	piece: (amount) => `${amount} pieces`,
	pieceName: 'pieces',
	quart: (amount) => `${amount} qt`,
	quartName: 'qt',
}

const metric = { system: 'metric', locale: 'en', labels } as const

describe('formatQuantity', () => {
	it('shows thousandths in the count unit', () => {
		expect(
			formatQuantity(6_000_000, { ...metric, baseUnit: 'g', countUnit: 'kg' }),
		).toBe('6 kg')
		expect(
			formatQuantity(2_300_000, { ...metric, baseUnit: 'ml', countUnit: 'l' }),
		).toBe('2.3 L')
	})

	it('shows an item counted in a named unit by that unit name', () => {
		const units = [{ id: 'u1', name: 'Box', baseQuantity: 10_000_000 }]
		expect(
			formatQuantity(25_000_000, {
				...metric,
				baseUnit: 'g',
				countUnit: 'unit:u1',
				units,
			}),
		).toBe('2.5 Box')
	})

	it('picks the best-fitting unit without a count unit', () => {
		expect(formatQuantity(450_000, { ...metric, baseUnit: 'g' })).toBe('450 g')
		expect(formatQuantity(1_500_000, { ...metric, baseUnit: 'g' })).toBe(
			'1.5 kg',
		)
		expect(formatQuantity(1_500_000, { ...metric, baseUnit: 'ml' })).toBe(
			'1.5 L',
		)
	})

	it('shows US units for a US organization', () => {
		const us = { ...metric, system: 'us' } as const
		expect(formatQuantity(453_592.37 * 2, { ...us, baseUnit: 'g' })).toBe(
			'2 lb',
		)
		expect(formatQuantity(113_398, { ...us, baseUnit: 'g' })).toBe('4 oz')
	})

	it('uses the labels for units Intl has no name for', () => {
		expect(
			formatQuantity(3_000, {
				...metric,
				baseUnit: 'piece',
				countUnit: 'piece',
			}),
		).toBe('3 pieces')
		expect(
			formatQuantity(1_892_705, { ...metric, baseUnit: 'ml', countUnit: 'qt' }),
		).toBe('2 qt')
	})

	it('falls back to the best unit when the count unit does not fit the item', () => {
		expect(
			formatQuantity(2_000_000, { ...metric, baseUnit: 'g', countUnit: 'l' }),
		).toBe('2 kg')
		expect(
			formatQuantity(2_000_000, {
				...metric,
				baseUnit: 'g',
				countUnit: 'unit:gone',
				units: [],
			}),
		).toBe('2 kg')
	})

	it('keeps fractions of open packs and negative stock', () => {
		expect(
			formatQuantity(250, { ...metric, baseUnit: 'piece', countUnit: 'piece' }),
		).toBe('0.25 pieces')
		expect(
			formatQuantity(-1_000_000, { ...metric, baseUnit: 'g', countUnit: 'kg' }),
		).toBe('-1 kg')
	})

	it('reports the amount and unit as parts', () => {
		expect(
			quantityParts(6_000_000, { ...metric, baseUnit: 'g', countUnit: 'kg' }),
		).toMatchObject({ amount: 6, unitRef: 'kg' })
	})
})

describe('unit names and choices', () => {
	it('names units', () => {
		expect(formatUnitName('kg', { locale: 'en', labels })).toBe('kg')
		expect(formatUnitName('piece', { locale: 'en', labels })).toBe('pieces')
		expect(
			formatUnitName('unit:u1', {
				locale: 'en',
				labels,
				units: [{ id: 'u1', name: 'Case', baseQuantity: 6000 }],
			}),
		).toBe('Case')
	})

	it('offers standard units of the base, then the item units, never archived ones', () => {
		expect(
			unitChoices(
				'g',
				[
					{ id: 'a', name: 'Box', baseQuantity: 1000 },
					{ id: 'b', name: 'Old', baseQuantity: 1000, archived: true },
				],
				'metric',
			),
		).toEqual(['g', 'kg', 'unit:a'])
		expect(unitChoices('piece', [], 'us')).toEqual(['piece'])
	})

	it('starts amounts in the count unit, else the usual unit for the system', () => {
		expect(defaultEntryUnit('g', 'kg', [], 'metric')).toBe('kg')
		expect(defaultEntryUnit('g', null, [], 'metric')).toBe('kg')
		expect(defaultEntryUnit('g', null, [], 'us')).toBe('lb')
		expect(defaultEntryUnit('ml', null, [], 'metric')).toBe('l')
		expect(defaultEntryUnit('piece', null, [], 'us')).toBe('piece')
		expect(defaultEntryUnit('g', 'unit:gone', [], 'metric')).toBe('kg')
	})

	it('steps by a sensible amount for each unit', () => {
		expect(entryStep('g')).toBe(50)
		expect(entryStep('kg')).toBe(0.5)
		expect(entryStep('piece')).toBe(1)
		expect(entryStep(null)).toBe(1)
	})
})

describe('money and levels', () => {
	it('formats minor units in the currency', () => {
		expect(formatMoney(16_800, 'SAR', 'en')).toContain('168.00')
		expect(formatMoney(1_000, undefined, 'en')).toContain('10.00')
	})

	it('prices one count unit from the cost per base unit', () => {
		// 2.8 SAR per gram-thousandth math: 28 SAR/kg = 2_800_000 micro-halalas/g
		expect(formatCostPerUnit(2_800_000, 1_000_000, 'SAR', 'en')).toContain(
			'28.00',
		)
	})

	it('estimates a value only when a cost is known', () => {
		expect(estimateValueMinor(2_000_000, 2_800_000)).toBe(5_600)
		expect(estimateValueMinor(2_000_000, null)).toBeNull()
		expect(estimateValueMinor(2_000_000, undefined)).toBeNull()
	})

	it('fills the bar between zero and one, and not at all without a level', () => {
		expect(fillRatio(6, 30)).toBeCloseTo(0.2)
		expect(fillRatio(40, 30)).toBe(1)
		expect(fillRatio(-3, 30)).toBe(0)
		expect(fillRatio(6, null)).toBeNull()
		expect(fillRatio(6, 0)).toBeNull()
	})
})
