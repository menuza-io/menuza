import { describe, expect, it } from 'vitest'
import {
	amountInputOf,
	bpToPercentText,
	currenciesOf,
	formatShare,
	formatTarget,
	hoursOf,
	isSalesSource,
	parseLaborSearch,
	percentToBp,
	positionLabel,
	rangeOf,
	readAmountInput,
	readOrdersPerHour,
	shiftRange,
	writeLaborSearch,
} from './labor-view.ts'

const TODAY = '2026-03-10'

describe('parseLaborSearch', () => {
	const parse = (query: string) =>
		parseLaborSearch(new URLSearchParams(query), TODAY, 'loc-1')

	it('defaults to the overview of the last seven days at the first workplace', () => {
		expect(parse('')).toEqual({
			view: 'overview',
			scopeId: 'loc-1',
			end: TODAY,
			days: 7,
		})
	})
	it('reads a view, workplace, end date and length', () => {
		expect(parse('view=tips&scope=loc-2&end=2026-03-01&days=30')).toEqual({
			view: 'tips',
			scopeId: 'loc-2',
			end: '2026-03-01',
			days: 30,
		})
	})
	it('ignores anything it does not recognize, and never runs past today', () => {
		expect(parse('view=admin&days=99&end=2026-04-01')).toMatchObject({
			view: 'overview',
			days: 7,
			end: TODAY,
		})
		expect(parse('end=not-a-date').end).toBe(TODAY)
	})
})

describe('writeLaborSearch', () => {
	it('keeps the address bar short: defaults are not written', () => {
		const next = writeLaborSearch(
			new URLSearchParams('view=tips&days=14&end=2026-03-01'),
			{ view: 'overview', days: 7, end: TODAY },
			TODAY,
		)
		expect(next.toString()).toBe('')
	})
	it('writes what differs and keeps what it was not asked to change', () => {
		const next = writeLaborSearch(
			new URLSearchParams('scope=loc-2'),
			{ view: 'sales', days: 14 },
			TODAY,
		)
		expect(next.get('scope')).toBe('loc-2')
		expect(next.get('view')).toBe('sales')
		expect(next.get('days')).toBe('14')
	})
})

describe('ranges', () => {
	it('ends on the chosen day and runs back by its length', () => {
		expect(rangeOf('2026-03-10', 7)).toEqual({
			from: '2026-03-04',
			to: '2026-03-10',
		})
		expect(rangeOf('2026-03-01', 30)).toEqual({
			from: '2026-01-31',
			to: '2026-03-01',
		})
	})
	it('moves by its own length and stops at today', () => {
		expect(shiftRange('2026-03-10', 7, -1, TODAY)).toBe('2026-03-03')
		expect(shiftRange('2026-03-05', 7, 1, TODAY)).toBe(TODAY)
		expect(shiftRange(TODAY, 7, 1, TODAY)).toBe(TODAY)
	})
})

describe('numbers', () => {
	it('formats a share in basis points as a one-decimal percentage', () => {
		expect(formatShare(2843, 'en')).toBe('28.4%')
		expect(formatShare(0, 'en')).toBe('0.0%')
		expect(formatTarget(3000, 'en')).toBe('30%')
	})
	it('formats hours to one decimal', () => {
		expect(hoursOf(90, 'en')).toBe('1.5')
		expect(hoursOf(0, 'en')).toBe('0.0')
	})
	it('reads amounts exactly and shows them back with two decimals', () => {
		expect(readAmountInput('')).toEqual({ state: 'empty' })
		expect(readAmountInput('1,234.50')).toEqual({ state: 'ok', minor: 123_450 })
		expect(readAmountInput('abc')).toMatchObject({ state: 'invalid' })
		expect(readAmountInput('-5')).toMatchObject({ state: 'invalid' })
		expect(amountInputOf(123_450)).toBe('1234.50')
		expect(amountInputOf(5)).toBe('0.05')
		// What the box shows reads back as the same amount.
		for (const minor of [0, 5, 99, 100, 123_456, 100_000_000]) {
			expect(readAmountInput(amountInputOf(minor))).toEqual({
				state: 'ok',
				minor,
			})
		}
	})
	it('reads percentages and orders per hour', () => {
		expect(percentToBp('3')).toBe(300)
		expect(percentToBp('2.9')).toBe(290)
		expect(percentToBp('2,95')).toBe(295)
		expect(percentToBp('2.955')).toBeNull()
		expect(percentToBp('')).toBeNull()
		expect(percentToBp('-1')).toBeNull()
		expect(bpToPercentText(300)).toBe('3')
		expect(bpToPercentText(295)).toBe('2.95')
		expect(bpToPercentText(250)).toBe('2.5')
		expect(readOrdersPerHour('12.5')).toBe(12.5)
		expect(readOrdersPerHour('0.4')).toBeNull()
		expect(readOrdersPerHour('201')).toBeNull()
		expect(readOrdersPerHour('12.55')).toBeNull()
		expect(readOrdersPerHour('')).toBeNull()
	})
})

describe('small helpers', () => {
	it('knows a sales source', () => {
		expect(isSalesSource('manual')).toBe(true)
		expect(isSalesSource('pos')).toBe(false)
	})
	it('lists currencies once, sorted', () => {
		expect(
			currenciesOf([
				{ currency: 'USD' },
				{ currency: 'SAR' },
				{ currency: 'USD' },
			] as never),
		).toEqual(['SAR', 'USD'])
	})
	it('picks the Arabic position name in Arabic when there is one', () => {
		const position = { name: 'Cook', nameAr: 'طباخ' }
		expect(positionLabel(position, 'ar')).toBe('طباخ')
		expect(positionLabel(position, 'en')).toBe('Cook')
		expect(positionLabel({ name: 'Cook', nameAr: null }, 'ar')).toBe('Cook')
	})
})
