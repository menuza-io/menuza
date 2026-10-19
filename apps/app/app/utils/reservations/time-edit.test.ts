import { describe, expect, it } from 'vitest'
import { resolveEditedStartMin, startMinPatch } from './time-edit.ts'

describe('overnight start-time editing keeps business-day minutes', () => {
	it('a notes-only edit of a 1470 reservation sends no time change', () => {
		// The time input shows 00:30 for minute 1470 and the operator left it alone.
		expect(startMinPatch(1470, '00:30')).toEqual({})
		expect(startMinPatch(1140, '19:00')).toEqual({})
	})

	it('changing 00:30 (+1d) to 00:45 saves 1485', () => {
		expect(startMinPatch(1470, '00:45')).toEqual({ localStartMin: 1485 })
		expect(resolveEditedStartMin('00:45', 1470)).toBe(1485)
	})

	it('keeps same-day times on the same business day', () => {
		expect(startMinPatch(1470, '23:30')).toEqual({ localStartMin: 1410 })
		expect(startMinPatch(1140, '19:30')).toEqual({ localStartMin: 1170 })
	})

	it('moving an evening booking past midnight stays overnight', () => {
		expect(startMinPatch(1080, '01:00')).toEqual({ localStartMin: 1500 })
	})

	it('ignores invalid text', () => {
		expect(resolveEditedStartMin('', 1470)).toBeNull()
		expect(startMinPatch(1470, '25:00')).toEqual({})
	})
})
