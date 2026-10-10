import { describe, expect, it } from 'vitest'
import { type ReportValueInfo } from './dsl.ts'
import {
	formatCurrency,
	formatMeasuredValue,
	formatResultHeadline,
	segmentPercent,
	segmentTableColumns,
} from './format.ts'

const en = { locale: 'en-US' }

const sales: ReportValueInfo = {
	measure: 'sum',
	field: 'total',
	label: 'Sales',
	type: 'currency',
	currency: 'USD',
}

const averageRating: ReportValueInfo = {
	measure: 'average',
	field: 'stars',
	label: 'Average rating',
	type: 'number',
}

describe('formatCurrency', () => {
	it('formats ISO currency codes in any case', () => {
		expect(formatCurrency(1234.5, 'usd', en)).toBe('$1,234.50')
		expect(formatCurrency(1234.5, 'SAR', en)).toMatch(/^SAR\s1,234\.50$/u)
		expect(formatCurrency(1500, 'USD', { ...en, compact: true })).toBe('$1.5K')
	})

	it('falls back to the raw code when Intl rejects it', () => {
		expect(formatCurrency(5, 'xx1', en)).toBe('5 XX1')
	})
})

describe('formatMeasuredValue', () => {
	it('reads like the measured field', () => {
		expect(formatMeasuredValue(12, sales, en)).toBe('$12.00')
		expect(formatMeasuredValue(4.3333, averageRating, en)).toBe('4.33')
		// Mixed currencies have no symbol but still read as money.
		expect(
			formatMeasuredValue(2.5, { ...sales, currency: undefined }, en),
		).toBe('2.50')
	})
})

describe('formatResultHeadline', () => {
	it('shows the measured value, or the count without one', () => {
		expect(formatResultHeadline({ total: 1234 }, en)).toBe('1,234')
		expect(
			formatResultHeadline({ total: 3, value: 99.5, valueInfo: sales }, en),
		).toBe('$99.50')
	})

	it('shows a dash for an average of nothing', () => {
		expect(
			formatResultHeadline({ total: 0, valueInfo: averageRating }, en),
		).toBe('—')
	})
})

describe('segmentPercent', () => {
	const segment = { key: 'a', label: 'A', count: 1, percent: 25, value: 30 }

	it('uses the share of the sum for sums', () => {
		expect(segmentPercent(segment, { value: 120, valueInfo: sales })).toBe(25)
		expect(segmentPercent(segment, { value: 0, valueInfo: sales })).toBe(0)
	})

	it('uses the share of records otherwise', () => {
		expect(segmentPercent({ ...segment, percent: 60 }, {})).toBe(60)
		expect(
			segmentPercent({ ...segment, percent: 60 }, { valueInfo: averageRating }),
		).toBe(60)
	})
})

describe('segmentTableColumns', () => {
	it('leaves the percent out next to averages', () => {
		expect(segmentTableColumns(false, {})).toEqual({
			count: true,
			value: null,
			percent: true,
		})
		expect(segmentTableColumns(true, { valueInfo: sales })).toEqual({
			count: false,
			value: sales,
			percent: true,
		})
		expect(segmentTableColumns(false, { valueInfo: averageRating })).toEqual({
			count: true,
			value: averageRating,
			percent: false,
		})
	})
})
