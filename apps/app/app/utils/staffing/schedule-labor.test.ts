import { describe, expect, it } from 'vitest'
import { dayShares, hasShareRow } from './schedule-labor.ts'
import { type ScheduleWeek } from './schedule-types.ts'

function week(over: Partial<NonNullable<ScheduleWeek['laborTarget']>> = {}) {
	return {
		dates: ['2026-03-09', '2026-03-10'],
		footers: [
			{
				date: '2026-03-09',
				minutes: 480,
				overtimeMinutes: 0,
				headcount: 1,
				openShifts: 0,
				openMinutes: 0,
				costMinorByCurrency: { USD: 16_000 },
			},
			{
				date: '2026-03-10',
				minutes: 0,
				overtimeMinutes: 0,
				headcount: 0,
				openShifts: 0,
				openMinutes: 0,
				costMinorByCurrency: {},
			},
		],
		laborTarget: {
			targetBp: 2000,
			salesSource: 'manual',
			salesComplete: true,
			targetColoring: true,
			days: [
				{ date: '2026-03-09', guideSalesMinorByCurrency: { USD: 100_000 } },
				{ date: '2026-03-10', guideSalesMinorByCurrency: {} },
			],
			currencies: [],
			...over,
		},
	} as unknown as ScheduleWeek
}

describe('dayShares', () => {
	it('divides a day of wages by the expected sales and judges it against the target', () => {
		expect(dayShares(week(), '2026-03-09')).toEqual([
			{ currency: 'USD', laborBp: 1600, targetStatus: 'within' },
		])
		expect(
			dayShares(week({ targetBp: 1500 }), '2026-03-09')[0]!.targetStatus,
		).toBe('over')
	})

	it('never judges a share built on online orders alone', () => {
		const online = week({
			salesSource: 'online_orders',
			salesComplete: false,
			targetColoring: false,
		})
		expect(dayShares(online, '2026-03-09')).toEqual([
			{ currency: 'USD', laborBp: 1600, targetStatus: null },
		])
	})

	it('has no share without expected sales, and nothing for a day with no wages', () => {
		const none = week({
			days: [{ date: '2026-03-09', guideSalesMinorByCurrency: {} }],
		})
		expect(dayShares(none, '2026-03-09')).toEqual([
			{ currency: 'USD', laborBp: null, targetStatus: null },
		])
		expect(dayShares(week(), '2026-03-10')).toEqual([])
	})

	it('keeps currencies apart', () => {
		const mixed = week({
			days: [
				{
					date: '2026-03-09',
					guideSalesMinorByCurrency: { USD: 100_000, SAR: 5_000 },
				},
			],
		})
		mixed.footers[0]!.costMinorByCurrency = { USD: 16_000, SAR: 1_000 }
		expect(dayShares(mixed, '2026-03-09')).toEqual([
			{ currency: 'SAR', laborBp: 2000, targetStatus: 'within' },
			{ currency: 'USD', laborBp: 1600, targetStatus: 'within' },
		])
	})

	it('is empty for a token without the labor grant', () => {
		const bare = week()
		delete (bare as { laborTarget?: unknown }).laborTarget
		expect(dayShares(bare, '2026-03-09')).toEqual([])
		expect(hasShareRow(bare)).toBe(false)
		expect(hasShareRow(week())).toBe(true)
	})
})
