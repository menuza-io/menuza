import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { evaluateDiscounts } from './evaluate.ts'
import {
	makeContext,
	makeDiscount,
	makeInput,
	makeLine,
} from './test-fixtures.ts'

const lineArb = fc.record({
	unitMinor: fc.integer({ min: 0, max: 50_000 }),
	quantity: fc.integer({ min: 1, max: 6 }),
	itemId: fc.constantFrom('a', 'b', 'c'),
	excluded: fc.boolean(),
})

const discountParams = fc.record({
	percentBp: fc.integer({ min: 1, max: 10_000 }),
	combinable: fc.boolean(),
	priority: fc.integer({ min: 0, max: 5 }),
	scope: fc.constantFrom('order', 'items'),
	rule: fc.constantFrom<'none' | 'exact' | 'minimum' | 'bogo'>(
		'none',
		'exact',
		'minimum',
		'bogo',
	),
	n: fc.integer({ min: 1, max: 4 }),
	cap: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
	maxMinor: fc.option(fc.integer({ min: 1, max: 20_000 }), { nil: null }),
})

function buildDiscount(
	value: typeof discountParams extends fc.Arbitrary<infer T> ? T : never,
	index: number,
) {
	{
		const scope = value.rule === 'bogo' ? 'items' : value.scope
		return makeDiscount({
			id: `d${index}`,
			percentBp: value.percentBp,
			combinable: value.combinable,
			priority: value.priority,
			maxDiscountMinor: value.maxMinor,
			target: {
				scope: scope as 'order' | 'items',
				itemIds: ['a', 'b'],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			},
			quantityRule:
				value.rule === 'none'
					? { kind: 'none' }
					: value.rule === 'bogo'
						? { kind: 'bogo', buyQuantity: value.n, getQuantity: 1 }
						: { kind: value.rule, quantity: value.n },
			maxDiscountedUnits: scope === 'items' ? value.cap : null,
		})
	}
}

describe('engine invariants', () => {
	it('never over-discounts a line, always splits exactly, and is deterministic', () => {
		fc.assert(
			fc.property(
				fc.array(lineArb, { minLength: 1, maxLength: 6 }),
				fc.array(discountParams, { maxLength: 4 }),
				(rawLines, rawDiscounts) => {
					const lines = rawLines.map((line, index) =>
						makeLine({ ...line, lineId: String(index) }),
					)
					const discounts = rawDiscounts.map(buildDiscount)
					const input = makeInput({ lines, discounts, context: makeContext() })
					const result = evaluateDiscounts(input)

					let sum = 0
					for (const line of lines) {
						const discounted = result.lineDiscounts[line.lineId] ?? 0
						expect(discounted).toBeGreaterThanOrEqual(0)
						expect(discounted).toBeLessThanOrEqual(
							line.unitMinor * line.quantity,
						)
						if (line.excluded) expect(discounted).toBe(0)
						sum += discounted
					}
					expect(result.totalDiscountMinor).toBe(
						sum + result.deliveryDiscountMinor,
					)

					for (const applied of result.applied) {
						expect(applied.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(
							applied.amountMinor,
						)
					}
					const perLine: Record<string, number> = {}
					for (const applied of result.applied) {
						for (const l of applied.lines) {
							perLine[l.lineId] = (perLine[l.lineId] ?? 0) + l.amountMinor
						}
					}
					expect(perLine).toEqual(result.lineDiscounts)

					expect(evaluateDiscounts(input)).toEqual(result)
				},
			),
			{ numRuns: 300 },
		)
	})
})
