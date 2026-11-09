import { adjustStockSchema } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	type AdjustDraft,
	adjustDraftProblems,
	buildAdjustPayload,
} from './adjust-form.ts'
import { moveId } from './areas.ts'

const CONTEXT = {
	clientId: 'a-12345678',
	locationId: 'main',
	baseUnit: 'g' as const,
	units: [],
}

const DRAFT: AdjustDraft = {
	direction: 'add',
	amountText: '1.5',
	unit: 'kg',
	reason: 'found',
	note: '',
}

describe('adjust stock', () => {
	it('needs an amount, a unit and a reason', () => {
		expect(
			adjustDraftProblems({
				...DRAFT,
				amountText: '',
				unit: null,
				reason: null,
			}),
		).toEqual(['amount', 'unit', 'reason'])
		expect(adjustDraftProblems(DRAFT)).toEqual([])
	})

	it('signs the change by direction, in base thousandths', () => {
		const add = buildAdjustPayload(DRAFT, CONTEXT)
		expect(add?.quantity).toBe(1_500_000)
		const remove = buildAdjustPayload(
			{ ...DRAFT, direction: 'remove' },
			CONTEXT,
		)
		expect(remove?.quantity).toBe(-1_500_000)
		expect(adjustStockSchema.safeParse(remove).success).toBe(true)
	})

	it('keeps a trimmed note and refuses an incomplete draft', () => {
		expect(
			buildAdjustPayload({ ...DRAFT, note: ' dropped ' }, CONTEXT)?.note,
		).toBe('dropped')
		expect(buildAdjustPayload({ ...DRAFT, reason: null }, CONTEXT)).toBeNull()
		// A litre cannot adjust an item counted in grams.
		expect(buildAdjustPayload({ ...DRAFT, unit: 'l' }, CONTEXT)).toBeNull()
	})
})

describe('moveId', () => {
	it('moves an entry one place and stays inside the list', () => {
		expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
		expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
		expect(moveId(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
		expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
	})
})
