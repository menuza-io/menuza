import { describe, expect, it } from 'vitest'
import {
	buildScheduleDays,
	findSlot,
	formatScheduledFor,
	scheduleLeadMinutes,
	schedulingSettings,
	zonedParts,
} from './schedule.ts'

const week = (start: string, end: string) =>
	[
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({ day, isOpen: true, slots: [{ start, end }] }))

const chicago = {
	timezone: 'America/Chicago',
	onlineHours: week('11:00', '21:00'),
	specialHours: [],
	prepTime: 20,
	scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 3 },
}

describe('schedulingSettings', () => {
	it('is disabled unless explicitly enabled, and clamps the window', () => {
		expect(schedulingSettings({}).enabled).toBe(false)
		expect(
			schedulingSettings({
				scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 200 },
			}),
		).toEqual({ enabled: true, advanceOrderDays: 30 })
		expect(
			schedulingSettings({
				scheduling: JSON.stringify({
					scheduledOrdersEnabled: true,
					advanceOrderDays: 2,
				}),
			}),
		).toEqual({ enabled: true, advanceOrderDays: 2 })
	})
})

describe('buildScheduleDays', () => {
	it('returns nothing when scheduling is disabled', () => {
		expect(
			buildScheduleDays(
				{ ...chicago, scheduling: { scheduledOrdersEnabled: false } },
				{ locale: 'en', mode: 'pickup' },
			),
		).toEqual([])
	})

	it('starts after prep time and steps in 15-minute slots in the location timezone', () => {
		// 2026-10-08 12:03 in Chicago (CDT, UTC-5).
		const now = new Date('2026-10-08T17:03:00Z')
		const days = buildScheduleDays(chicago, {
			now,
			locale: 'en-US',
			mode: 'pickup',
		})
		expect(days.map((d) => d.date)).toEqual([
			'2026-10-08',
			'2026-10-09',
			'2026-10-10',
		])
		const today = days[0]!
		expect(today.offset).toBe(0)
		// 12:03 + 20 min prep = 12:23 → first slot 12:30.
		expect(today.slots[0]).toMatchObject({
			localTime: '12:30',
			iso: '2026-10-08T17:30:00.000Z',
			label: '12:30 PM',
		})
		expect(today.slots.at(-1)?.localTime).toBe('21:00')
		const tomorrow = days[1]!
		expect(tomorrow.slots[0]?.localTime).toBe('11:00')
		expect(tomorrow.weekday).toBe('Fri')
		expect(tomorrow.dayMonth).toBe('Oct 9')
	})

	it('adds the minimum delivery ETA to the lead time for delivery', () => {
		const now = new Date('2026-10-08T17:03:00Z')
		expect(scheduleLeadMinutes(chicago, 'delivery', 30)).toBe(50)
		const days = buildScheduleDays(chicago, {
			now,
			locale: 'en-US',
			mode: 'delivery',
			deliveryEtaMin: 30,
		})
		// 12:03 + 50 = 12:53 → 13:00.
		expect(days[0]?.slots[0]?.localTime).toBe('13:00')
	})

	it('skips a day once its hours have passed and honours special hours', () => {
		const now = new Date('2026-10-09T03:00:00Z') // 22:00 on Oct 8 in Chicago
		const days = buildScheduleDays(
			{
				...chicago,
				specialHours: [
					{ date: '2026-10-09', isOpen: false, slots: [] },
					{
						date: '2026-10-10',
						isOpen: true,
						slots: [{ start: '09:10', end: '10:00' }],
					},
				],
			},
			{ now, locale: 'en-US', mode: 'pickup' },
		)
		expect(days.map((d) => d.date)).toEqual(['2026-10-10'])
		expect(days[0]?.offset).toBe(2)
		expect(days[0]?.slots.map((s) => s.localTime)).toEqual([
			'09:15',
			'09:30',
			'09:45',
			'10:00',
		])
	})

	it('treats a missing schedule as open all day and formats per locale', () => {
		const now = new Date('2026-10-08T20:50:00Z') // 23:50 in Riyadh
		const days = buildScheduleDays(
			{
				timezone: 'Asia/Riyadh',
				prepTime: 15,
				scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 2 },
			},
			{ now, locale: 'ar', mode: 'pickup' },
		)
		expect(days[0]?.date).toBe('2026-10-09')
		expect(days[0]?.slots[0]?.localTime).toBe('00:15')
		expect(days[0]?.slots[0]?.iso).toBe('2026-10-08T21:15:00.000Z')
		expect(days[0]?.slots[0]?.label).toMatch(/ص/)
	})

	it('skips wall-clock times that do not exist on a DST change', () => {
		// US spring-forward: 2026-03-08 02:00 → 03:00 in Chicago.
		const now = new Date('2026-03-08T06:00:00Z') // 00:00 CST
		const days = buildScheduleDays(
			{
				timezone: 'America/Chicago',
				prepTime: 15,
				onlineHours: week('01:00', '04:00'),
				scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 1 },
			},
			{ now, locale: 'en-US', mode: 'pickup' },
		)
		const times = days[0]?.slots.map((s) => s.localTime) ?? []
		expect(times).toContain('01:45')
		expect(times).not.toContain('02:30')
		expect(times).toContain('03:00')
	})
})

describe('findSlot / formatScheduledFor', () => {
	it('finds an offered slot and rejects stale ones', () => {
		const now = new Date('2026-10-08T17:03:00Z')
		const days = buildScheduleDays(chicago, {
			now,
			locale: 'en-US',
			mode: 'pickup',
		})
		expect(findSlot(days, '2026-10-09T16:00:00.000Z')?.slot.localTime).toBe(
			'11:00',
		)
		expect(findSlot(days, '2026-10-08T15:00:00.000Z')).toBeNull()
		expect(findSlot(days, null)).toBeNull()
	})

	it('formats with a day offset in the location timezone', () => {
		const now = new Date('2026-10-08T17:03:00Z')
		expect(
			formatScheduledFor(
				'2026-10-09T23:30:00.000Z',
				'en-US',
				'America/Chicago',
				now,
			),
		).toEqual({ offset: 1, weekday: 'Fri', time: '6:30 PM' })
	})

	it('reads wall-clock parts', () => {
		expect(
			zonedParts(new Date('2026-10-08T05:00:00Z'), 'America/Chicago'),
		).toEqual({
			date: '2026-10-08',
			time: '00:00',
		})
	})
})
