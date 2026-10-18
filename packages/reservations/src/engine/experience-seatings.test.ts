import { describe, expect, it } from 'vitest'
import {
	experienceRemainingCovers,
	experienceSeatingsOn,
	scheduleAppliesOn,
	scheduleSeatingMins,
	type ExperienceScheduleInput,
} from './experience-seatings.ts'

function schedule(
	patch: Partial<ExperienceScheduleInput> = {},
): ExperienceScheduleInput {
	return {
		id: 's1',
		fromDate: '2030-01-01',
		toDate: '2030-12-31',
		daysMask: 127,
		seatingMins: [19 * 60, 21 * 60],
		startMin: null,
		endMin: null,
		intervalMin: null,
		turnMin: 90,
		coversCapPerSeating: 8,
		coversCapPerDay: null,
		areaIds: null,
		serviceId: null,
		...patch,
	}
}

describe('scheduleSeatingMins', () => {
	it('prefers explicit seatings and sorts them', () => {
		expect(
			scheduleSeatingMins(schedule({ seatingMins: [1260, 1140, 1140] })),
		).toEqual([1140, 1260])
	})
	it('steps start to end inclusive', () => {
		expect(
			scheduleSeatingMins(
				schedule({
					seatingMins: null,
					startMin: 1080,
					endMin: 1200,
					intervalMin: 60,
				}),
			),
		).toEqual([1080, 1140, 1200])
	})
	it('caps generated seatings', () => {
		expect(
			scheduleSeatingMins(
				schedule({
					seatingMins: null,
					startMin: 0,
					endMin: 2880,
					intervalMin: 1,
				}),
			),
		).toHaveLength(48)
	})
})

describe('scheduleAppliesOn', () => {
	// 2030-01-05 is a Saturday: Monday-zero bit 5.
	it('honors the weekday mask (bit 0 = Monday)', () => {
		expect(
			scheduleAppliesOn(schedule({ daysMask: 1 << 5 }), '2030-01-05'),
		).toBe(true)
		expect(
			scheduleAppliesOn(schedule({ daysMask: 1 << 6 }), '2030-01-05'),
		).toBe(false)
	})
	it('honors the date range inclusively', () => {
		const s = schedule({ fromDate: '2030-01-05', toDate: '2030-01-05' })
		expect(scheduleAppliesOn(s, '2030-01-05')).toBe(true)
		expect(scheduleAppliesOn(s, '2030-01-04')).toBe(false)
		expect(scheduleAppliesOn(s, '2030-01-06')).toBe(false)
	})
})

describe('experienceSeatingsOn', () => {
	it('gives a duplicated start to the first schedule', () => {
		const out = experienceSeatingsOn(
			[
				schedule({ id: 'a', seatingMins: [1140] }),
				schedule({ id: 'b', seatingMins: [1140, 1260] }),
			],
			'2030-01-05',
		)
		expect(out).toEqual([
			{ scheduleId: 'a', seatingMin: 1140 },
			{ scheduleId: 'b', seatingMin: 1260 },
		])
	})
})

describe('experienceRemainingCovers', () => {
	it('stops exactly at the per-seating cap', () => {
		const s = schedule()
		const booked = new Map([[1140, 6]])
		expect(
			experienceRemainingCovers({
				schedule: s,
				seatingMin: 1140,
				bookedBySeating: booked,
			}),
		).toBe(2)
		booked.set(1140, 8)
		expect(
			experienceRemainingCovers({
				schedule: s,
				seatingMin: 1140,
				bookedBySeating: booked,
			}),
		).toBe(0)
		expect(
			experienceRemainingCovers({
				schedule: s,
				seatingMin: 1260,
				bookedBySeating: booked,
			}),
		).toBe(8)
	})
	it('applies the day cap across seatings', () => {
		const s = schedule({ coversCapPerDay: 10 })
		const booked = new Map([
			[1140, 6],
			[1260, 4],
		])
		expect(
			experienceRemainingCovers({
				schedule: s,
				seatingMin: 1140,
				bookedBySeating: booked,
			}),
		).toBe(0)
		expect(
			experienceRemainingCovers({
				schedule: s,
				seatingMin: 1260,
				bookedBySeating: booked,
			}),
		).toBe(0)
	})
	it('is unbounded with no caps', () => {
		expect(
			experienceRemainingCovers({
				schedule: schedule({ coversCapPerSeating: null }),
				seatingMin: 1140,
				bookedBySeating: new Map(),
			}),
		).toBe(Number.POSITIVE_INFINITY)
	})
})
