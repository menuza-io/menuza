import { recordBatchSchema } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import { batchProblems, buildBatch, emptyBatchDraft } from './batch-form.ts'

const ids = { clientId: 'b-12345678', locationId: 'main' }

describe('batch form', () => {
	it('starts as one batch', () => {
		expect(buildBatch(emptyBatchDraft(), ids)).toEqual({
			...ids,
			made: { kind: 'batches', count: 1 },
		})
	})

	it('needs a number of batches above zero', () => {
		expect(batchProblems({ ...emptyBatchDraft(), count: 0 })).toEqual(['count'])
		expect(batchProblems({ ...emptyBatchDraft(), count: null })).toEqual([
			'count',
		])
		expect(batchProblems({ ...emptyBatchDraft(), count: 1001 })).toEqual([
			'count',
		])
	})

	it('builds the amount that came out, with a trimmed note', () => {
		const body = buildBatch(
			{
				kind: 'amount',
				count: 1,
				amount: 3.5,
				unit: 'l',
				note: '  big pot  ',
			},
			ids,
		)
		expect(body).toEqual({
			...ids,
			made: { kind: 'amount', amount: 3.5, unit: 'l' },
			note: 'big pot',
		})
		expect(recordBatchSchema.safeParse(body).success).toBe(true)
	})

	it('needs an amount and a unit for the amount that came out', () => {
		expect(batchProblems({ ...emptyBatchDraft(), kind: 'amount' })).toEqual([
			'amount',
			'unit',
		])
		expect(buildBatch({ ...emptyBatchDraft(), kind: 'amount' }, ids)).toBeNull()
	})
})
