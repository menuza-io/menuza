import { describe, expect, it } from 'vitest'
import { groupSlots } from './sheets.tsx'

describe('times grouped for a booking', () => {
	const at = (hour: number, minute = 0) => ({
		localStartMin: hour * 60 + minute,
	})
	it('splits the day into morning, afternoon and evening, in order', () => {
		const groups = groupSlots([at(11), at(12), at(16, 45), at(17), at(21)])
		expect(groups.map((g) => [g.part, g.slots.length])).toEqual([
			['morning', 1],
			['afternoon', 2],
			['evening', 2],
		])
	})
	it('puts what is after midnight in its own group, still on this day', () => {
		const groups = groupSlots([at(22), at(23, 45), at(24), at(25, 30)])
		expect(groups.map((g) => [g.part, g.slots.length])).toEqual([
			['evening', 2],
			['night', 2],
		])
	})
})
