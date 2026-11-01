import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	orderContextDiscountsTolerantSchema,
	parseOrderContextDiscounts,
} from './contract.ts'
import { makeDiscount } from './test-fixtures.ts'

const code = (over: Record<string, unknown> = {}) => ({
	id: 'c1',
	discountId: 'd1',
	normalizedCode: 'SAVE10',
	maxUses: null,
	...over,
})

const field = (over: Record<string, unknown> = {}) => ({
	features: { automatic: true, coupons: true },
	discounts: [makeDiscount({ id: 'd1' }), makeDiscount({ id: 'd2' })],
	codes: [code()],
	...over,
})

afterEach(() => vi.restoreAllMocks())

describe('parseOrderContextDiscounts', () => {
	it('keeps every valid record and counts nothing dropped', () => {
		const parsed = parseOrderContextDiscounts(field())
		expect(parsed.value?.discounts.map((d) => d.id)).toEqual(['d1', 'd2'])
		expect(parsed.value?.codes).toHaveLength(1)
		expect(parsed.droppedDiscounts).toBe(0)
		expect(parsed.droppedCodes).toBe(0)
	})

	it('drops only the bad discount record, keeps the rest, and counts it', () => {
		const parsed = parseOrderContextDiscounts(
			field({
				discounts: [
					makeDiscount({ id: 'good' }),
					{ ...makeDiscount({ id: 'bad' }), percentBp: 'lots' },
					'not even an object',
				],
			}),
		)
		expect(parsed.value?.discounts.map((d) => d.id)).toEqual(['good'])
		expect(parsed.droppedDiscounts).toBe(2)
		expect(parsed.droppedDiscountIds).toEqual(['bad', '?'])
	})

	it('drops only the bad code row (over-length, parked placeholder) and keeps the rest', () => {
		const parsed = parseOrderContextDiscounts(
			field({
				codes: [
					code({ id: 'ok' }),
					code({ id: 'long', normalizedCode: `parked:${'x'.repeat(24)}` }),
					code({ id: 'noid', discountId: undefined }),
				],
			}),
		)
		expect(parsed.value?.codes.map((c) => c.id)).toEqual(['ok'])
		expect(parsed.droppedCodes).toBe(2)
		expect(parsed.droppedCodeIds).toEqual(['long', 'noid'])
		// Ids only: no code value reaches the report.
		expect(JSON.stringify(parsed.droppedCodeIds)).not.toContain('SAVE10')
	})

	it('reads as off when the field or its features are unusable', () => {
		expect(parseOrderContextDiscounts(undefined).value).toBeUndefined()
		expect(parseOrderContextDiscounts('x').value).toBeUndefined()
		expect(
			parseOrderContextDiscounts(field({ features: { automatic: true } }))
				.value,
		).toBeUndefined()
		expect(
			parseOrderContextDiscounts(field({ discounts: 'nope' })).value,
		).toBeUndefined()
	})

	it('ignores unknown top-level keys from a newer App', () => {
		const parsed = parseOrderContextDiscounts(field({ somethingNew: 1 }))
		expect(parsed.value?.discounts).toHaveLength(2)
	})

	it('keeps the per-record schema strict', () => {
		const parsed = parseOrderContextDiscounts(
			field({
				codes: [code({ extra: 'field' })],
			}),
		)
		expect(parsed.droppedCodes).toBe(1)
	})
})

describe('orderContextDiscountsTolerantSchema', () => {
	it('logs ids and counts, never codes, when a record is dropped', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const value = orderContextDiscountsTolerantSchema.parse(
			field({
				discounts: [makeDiscount({ id: 'good' }), { id: 'bad' }],
				codes: [code({ normalizedCode: 'SECRETCODE', id: 'c9', maxUses: 0 })],
			}),
		)
		expect(value?.discounts.map((d) => d.id)).toEqual(['good'])
		expect(value?.codes).toEqual([])
		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]![0])
		expect(message).toContain('1 discount(s) [bad]')
		expect(message).toContain('1 code row(s) [c9]')
		expect(message).not.toContain('SECRETCODE')
	})

	it('is silent when nothing is dropped and reads missing as undefined', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		expect(orderContextDiscountsTolerantSchema.parse(field())).toBeDefined()
		expect(orderContextDiscountsTolerantSchema.parse(undefined)).toBeUndefined()
		expect(warn).not.toHaveBeenCalled()
	})
})
