import { describe, expect, it } from 'vitest'
import { demand, person, shift, week } from './schedule-fixtures.ts'
import {
	demandSchema,
	shiftDeleteSchema,
	shiftSchema,
	shiftWriteSchema,
	weekViewSchema,
} from './schedule-types.ts'

describe('schedule response schemas accept what the node sends', () => {
	it('a week with shifts, conflicts and a pending edit', () => {
		const view = week({
			people: [person()],
			shifts: [
				shift({
					state: 'changed',
					conflicts: [
						{ code: 'overtime', shiftId: 'sh1', detail: { minutes: 30 } },
					],
					published: {
						staffId: 's1',
						positionId: 'p1',
						startsAt: 0,
						endsAt: 1,
						unpaidBreakMinutes: 0,
						notes: null,
					},
				}),
				shift({ id: 'sh2', staffId: null, state: 'cancel_pending' }),
			],
		})
		expect(weekViewSchema.safeParse(view).success).toBe(true)
	})

	it('keeps money keys optional and unknown conflict codes', () => {
		const withMoney = shift({ costMinor: 1500, currency: 'USD' })
		expect(shiftSchema.parse(withMoney).costMinor).toBe(1500)
		const plain = shiftSchema.parse(shift())
		expect(plain.costMinor).toBeUndefined()
		const future = {
			...shift(),
			conflicts: [{ code: 'new_rule', shiftId: 'sh1' }],
		}
		expect(shiftSchema.safeParse(future).success).toBe(true)
	})

	it('the demand guide', () => {
		expect(demandSchema.safeParse(demand()).success).toBe(true)
	})

	it('write and delete results', () => {
		expect(shiftWriteSchema.safeParse({ shifts: [shift()] }).success).toBe(true)
		expect(
			shiftDeleteSchema.safeParse({ state: 'deleted', id: 'sh1' }).success,
		).toBe(true)
		expect(
			shiftDeleteSchema.safeParse({ state: 'cancel_pending', shift: shift() })
				.success,
		).toBe(true)
		expect(shiftDeleteSchema.safeParse({ state: 'other' }).success).toBe(false)
	})

	it('refuses a week missing its dates', () => {
		const broken: Record<string, unknown> = { ...week() }
		delete broken.dates
		expect(weekViewSchema.safeParse(broken).success).toBe(false)
	})
})
