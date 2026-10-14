import { describe, expect, it } from 'vitest'
import { HOUR, NINE_AM, shift } from './schedule-fixtures.ts'
import {
	EMPTY_SCOPE,
	NO_POSITION,
	buildCreateBodies,
	buildUpdateBody,
	emptyForm,
	formFromShift,
	hasErrors,
	repeatCount,
	scopeFromState,
	spanMinutes,
	validateShiftForm,
	weekChoices,
} from './schedule-form.ts'

const form = () => emptyForm({ rowKey: 's1', date: '2026-03-02' })

describe('spanMinutes', () => {
	it('treats an end at or before the start as the next day', () => {
		expect(spanMinutes('09:00', '17:00')).toBe(480)
		expect(spanMinutes('22:00', '02:00')).toBe(240)
		expect(spanMinutes('22:00', '22:00')).toBe(1440)
	})
})

describe('validateShiftForm', () => {
	it('accepts the default shift', () => {
		expect(hasErrors(validateShiftForm(form(), { creating: true }))).toBe(false)
	})

	it('refuses an end equal to the start', () => {
		const errors = validateShiftForm(
			{ ...form(), endTime: '09:00' },
			{ creating: true },
		)
		expect(errors.endTime).toBe('same_time')
	})

	it('refuses a break as long as the shift, or one that is not a number', () => {
		expect(
			validateShiftForm({ ...form(), unpaidBreak: '480' }, { creating: true })
				.unpaidBreak,
		).toBe('break_too_long')
		expect(
			validateShiftForm({ ...form(), unpaidBreak: '479' }, { creating: true })
				.unpaidBreak,
		).toBeUndefined()
		expect(
			validateShiftForm({ ...form(), unpaidBreak: '-5' }, { creating: true })
				.unpaidBreak,
		).toBe('break_invalid')
		expect(
			validateShiftForm({ ...form(), unpaidBreak: '1e3' }, { creating: true })
				.unpaidBreak,
		).toBe('break_invalid')
		expect(
			validateShiftForm({ ...form(), unpaidBreak: '' }, { creating: true })
				.unpaidBreak,
		).toBeUndefined()
	})

	it('needs a day when creating but not when editing', () => {
		const none = { ...form(), dates: [] }
		expect(validateShiftForm(none, { creating: true }).dates).toBe('no_dates')
		expect(validateShiftForm(none, { creating: false }).dates).toBeUndefined()
	})

	it('limits notes', () => {
		expect(
			validateShiftForm(
				{ ...form(), notes: 'x'.repeat(501) },
				{ creating: true },
			).notes,
		).toBe('note_too_long')
		expect(
			validateShiftForm(
				{ ...form(), notes: ' '.repeat(600) },
				{ creating: true },
			).notes,
		).toBeUndefined()
	})

	it('checks the second shift of a split', () => {
		const split = { ...form(), split: true }
		expect(
			validateShiftForm(
				{ ...split, startTime2: '18:00', endTime2: '22:00' },
				{ creating: true },
			).time2,
		).toBeUndefined()
		expect(
			validateShiftForm(
				{ ...split, startTime2: '12:00', endTime2: '12:00' },
				{ creating: true },
			).time2,
		).toBe('second_same_time')
		expect(
			validateShiftForm(
				{ ...split, startTime2: '16:00', endTime2: '20:00' },
				{ creating: true },
			).time2,
		).toBe('second_overlaps')
		// Back to back is fine.
		expect(
			validateShiftForm(
				{ ...split, startTime2: '17:00', endTime2: '20:00' },
				{ creating: true },
			).time2,
		).toBeUndefined()
	})
})

describe('buildCreateBodies', () => {
	it('makes an open shift with no position when asked', () => {
		const [body] = buildCreateBodies({ ...form(), staffId: 'open' }, 'loc-1')
		expect(body).toMatchObject({
			scopeId: 'loc-1',
			staffId: null,
			positionId: null,
			dates: ['2026-03-02'],
		})
	})

	it('sorts the days, trims notes and splits a shift into two requests', () => {
		const bodies = buildCreateBodies(
			{
				...form(),
				dates: ['2026-03-04', '2026-03-02'],
				notes: '  Patio  ',
				unpaidBreak: '30',
				split: true,
				positionId: 'p1',
			},
			'loc-1',
		)
		expect(bodies).toHaveLength(2)
		expect(bodies[0]).toMatchObject({
			dates: ['2026-03-02', '2026-03-04'],
			notes: 'Patio',
			unpaidBreakMinutes: 30,
			positionId: 'p1',
			startTime: '09:00',
			endTime: '17:00',
		})
		expect(bodies[1]).toMatchObject({
			unpaidBreakMinutes: 0,
			startTime: '18:00',
			endTime: '22:00',
		})
		expect(
			repeatCount({ ...form(), dates: ['a', 'b', 'c'], split: true }),
		).toBe(6)
	})
})

describe('buildUpdateBody', () => {
	const original = shift({ version: 4, unpaidBreakMinutes: 30, notes: 'Patio' })

	it('is null when nothing changed', () => {
		expect(buildUpdateBody(formFromShift(original), original)).toBeNull()
	})

	it('sends only what changed, with the version', () => {
		const edited = {
			...formFromShift(original),
			endTime: '18:00',
			staffId: 'open',
		}
		expect(buildUpdateBody(edited, original)).toEqual({
			expectedVersion: 4,
			startTime: '09:00',
			endTime: '18:00',
			staffId: null,
		})
	})

	it('clears notes and the position', () => {
		const edited = {
			...formFromShift(original),
			notes: '   ',
			positionId: NO_POSITION,
		}
		expect(buildUpdateBody(edited, original)).toEqual({
			expectedVersion: 4,
			positionId: null,
			notes: null,
		})
	})

	it('moves the date and reads an overnight shift back as entered', () => {
		const night = shift({
			startsAt: NINE_AM + 12 * HOUR,
			endsAt: NINE_AM + 18 * HOUR,
		})
		const f = formFromShift(night)
		expect([f.startTime, f.endTime]).toEqual(['21:00', '03:00'])
		expect(buildUpdateBody({ ...f, dates: ['2026-03-03'] }, night)).toEqual({
			expectedVersion: 1,
			date: '2026-03-03',
		})
	})
})

describe('workplace', () => {
	it('everything needs nothing chosen; narrower workplaces need a choice', () => {
		expect(scopeFromState(EMPTY_SCOPE)).toEqual({ mode: 'all' })
		expect(scopeFromState({ ...EMPTY_SCOPE, mode: 'positions' })).toBeNull()
		expect(
			scopeFromState({
				...EMPTY_SCOPE,
				mode: 'positions',
				positionIds: ['p1'],
			}),
		).toEqual({ mode: 'positions', positionIds: ['p1'] })
		expect(scopeFromState({ ...EMPTY_SCOPE, mode: 'people' })).toBeNull()
		expect(
			scopeFromState({
				...EMPTY_SCOPE,
				mode: 'people',
				staffIds: ['s1'],
				positionIds: ['p1'],
			}),
		).toEqual({ mode: 'people', staffIds: ['s1'] })
	})

	it('lists weeks around a start', () => {
		expect(weekChoices('2026-03-02', 2, 1)).toEqual([
			'2026-02-16',
			'2026-02-23',
			'2026-03-02',
			'2026-03-09',
		])
	})
})
