import { describe, expect, it } from 'vitest'
import {
	allocateByWeight,
	cardFeeMinor,
	computeTipPool,
	DEFAULT_TIP_SETTINGS,
	tipGroupKey,
	tipPoolTable,
	type TipPoolInput,
} from './tip-pool.ts'

const settings = (
	over: Partial<TipPoolInput['settings']> = {},
): TipPoolInput['settings'] => ({
	splitBasis: 'hours',
	cadence: 'period',
	cardFeeBp: 0,
	positionPercentBp: {},
	...over,
})

describe('allocateByWeight', () => {
	it('splits exactly, giving leftover cents to the largest remainders', () => {
		const result = allocateByWeight(100, [
			{ key: 'a', weight: 1 },
			{ key: 'b', weight: 1 },
			{ key: 'c', weight: 1 },
		])
		// 33.33 each: the one spare cent goes to the first key on a tie.
		expect([...result]).toEqual([
			['a', 34],
			['b', 33],
			['c', 33],
		])
	})

	it('always adds up to the total, whatever the weights', () => {
		for (let total = 0; total < 60; total++) {
			for (const weights of [[1, 2, 3], [7, 7, 7, 7], [1, 1000, 3], [5]]) {
				const result = allocateByWeight(
					total,
					weights.map((weight, i) => ({ key: `k${i}`, weight })),
				)
				expect([...result.values()].reduce((s, v) => s + v, 0)).toBe(total)
			}
		}
	})

	it('gives nothing to zero weights and allocates nothing without any weight', () => {
		expect([
			...allocateByWeight(10, [
				{ key: 'a', weight: 0 },
				{ key: 'b', weight: 5 },
			]),
		]).toEqual([
			['a', 0],
			['b', 10],
		])
		expect([...allocateByWeight(10, [{ key: 'a', weight: 0 }])]).toEqual([
			['a', 0],
		])
	})

	it('is deterministic and order independent for equal weights', () => {
		const forward = allocateByWeight(5, [
			{ key: 'a', weight: 1 },
			{ key: 'b', weight: 1 },
		])
		const reversed = allocateByWeight(5, [
			{ key: 'b', weight: 1 },
			{ key: 'a', weight: 1 },
		])
		expect(forward.get('a')).toBe(reversed.get('a'))
		expect(forward.get('b')).toBe(reversed.get('b'))
	})
})

describe('cardFeeMinor', () => {
	it('is a percentage of online tips rounded to the cent', () => {
		expect(cardFeeMinor(10_000, 300)).toBe(300)
		expect(cardFeeMinor(1_234, 290)).toBe(36) // 35.786
		expect(cardFeeMinor(10_000, 0)).toBe(0)
	})
})

describe('computeTipPool: split by hours', () => {
	// Online tips $200, 3% card fee = $6, cash tips $50: pool $244.
	// Hours: Ana 8h, Ben 6h, Cy 6h = 20h. Shares: 97.60, 73.20, 73.20.
	const result = computeTipPool({
		currency: 'USD',
		settings: settings({ cardFeeBp: 300 }),
		onlineTips: [
			{ date: '2026-03-02', minor: 12_000 },
			{ date: '2026-03-03', minor: 8_000 },
		],
		cashTips: [{ date: '2026-03-02', minor: 5_000 }],
		work: [
			{ date: '2026-03-02', staffId: 'ana', positionId: 'srv', minutes: 480 },
			{ date: '2026-03-02', staffId: 'ben', positionId: 'srv', minutes: 360 },
			{ date: '2026-03-03', staffId: 'cy', positionId: 'srv', minutes: 360 },
		],
	})

	it('adds online tips, takes the card fee off them only, then adds cash', () => {
		expect(result).toMatchObject({
			onlineTipsMinor: 20_000,
			cardFeeMinor: 600,
			cashTipsMinor: 5_000,
			poolMinor: 24_400,
			unallocatedMinor: 0,
		})
		expect(result.groups).toHaveLength(1)
		expect(result.groups[0]!.key).toBe('period')
	})

	it('shares the pool by hours worked, to the cent', () => {
		expect(result.people).toEqual([
			{ staffId: 'ana', minutes: 480, shareMinor: 9_760 },
			{ staffId: 'ben', minutes: 360, shareMinor: 7_320 },
			{ staffId: 'cy', minutes: 360, shareMinor: 7_320 },
		])
		expect(result.people.reduce((s, p) => s + p.shareMinor, 0)).toBe(24_400)
	})

	it('keeps the whole pool unallocated when nobody eligible worked', () => {
		const empty = computeTipPool({
			currency: 'USD',
			settings: settings(),
			onlineTips: [{ date: '2026-03-02', minor: 1_000 }],
			cashTips: [],
			work: [],
		})
		expect(empty).toMatchObject({
			poolMinor: 1_000,
			unallocatedMinor: 1_000,
			people: [],
		})
	})
})

describe('computeTipPool: daily cadence', () => {
	it("pools and splits each day among that day's people only", () => {
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({ cadence: 'daily' }),
			onlineTips: [
				{ date: '2026-03-02', minor: 10_000 },
				{ date: '2026-03-03', minor: 3_000 },
			],
			cashTips: [],
			work: [
				{ date: '2026-03-02', staffId: 'ana', positionId: null, minutes: 300 },
				{ date: '2026-03-02', staffId: 'ben', positionId: null, minutes: 300 },
				{ date: '2026-03-03', staffId: 'ana', positionId: null, minutes: 120 },
			],
		})
		expect(result.groups.map((g) => [g.key, g.poolMinor])).toEqual([
			['2026-03-02', 10_000],
			['2026-03-03', 3_000],
		])
		// Monday split in half; Tuesday all to Ana, who alone worked.
		expect(result.people).toEqual([
			{ staffId: 'ana', minutes: 420, shareMinor: 8_000 },
			{ staffId: 'ben', minutes: 300, shareMinor: 5_000 },
		])
	})

	it('leaves a day nobody worked unallocated, not moved to another day', () => {
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({ cadence: 'daily' }),
			onlineTips: [{ date: '2026-03-04', minor: 900 }],
			cashTips: [],
			work: [
				{ date: '2026-03-02', staffId: 'ana', positionId: null, minutes: 60 },
			],
		})
		expect(result.unallocatedMinor).toBe(900)
		expect(result.people[0]).toMatchObject({ staffId: 'ana', shareMinor: 0 })
	})
})

describe('computeTipPool: split by position percent', () => {
	const percents = { srv: 6_000, bus: 4_000 }

	it('gives each position its set share, then splits it by hours inside the position', () => {
		// Pool $100: servers 60% = $60 split Ana 6h / Ben 3h (40 / 20),
		// bussers 40% = $40 to Cy.
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({
				splitBasis: 'position_percent',
				positionPercentBp: percents,
			}),
			onlineTips: [{ date: '2026-03-02', minor: 10_000 }],
			cashTips: [],
			work: [
				{ date: '2026-03-02', staffId: 'ana', positionId: 'srv', minutes: 360 },
				{ date: '2026-03-02', staffId: 'ben', positionId: 'srv', minutes: 180 },
				{ date: '2026-03-02', staffId: 'cy', positionId: 'bus', minutes: 120 },
			],
		})
		expect(result.people).toEqual([
			{ staffId: 'ana', minutes: 360, shareMinor: 4_000 },
			{ staffId: 'ben', minutes: 180, shareMinor: 2_000 },
			{ staffId: 'cy', minutes: 120, shareMinor: 4_000 },
		])
		expect(result.unallocatedMinor).toBe(0)
	})

	it('re-scales over the positions that worked, so an absent position loses nothing', () => {
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({
				splitBasis: 'position_percent',
				positionPercentBp: percents,
			}),
			onlineTips: [{ date: '2026-03-02', minor: 10_000 }],
			cashTips: [],
			work: [
				{ date: '2026-03-02', staffId: 'cy', positionId: 'bus', minutes: 60 },
			],
		})
		expect(result.people).toEqual([
			{ staffId: 'cy', minutes: 60, shareMinor: 10_000 },
		])
		expect(result.unallocatedMinor).toBe(0)
	})

	it('pays a position with no percentage nothing and reports unallocated if none has one', () => {
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({
				splitBasis: 'position_percent',
				positionPercentBp: { srv: 10_000 },
			}),
			onlineTips: [{ date: '2026-03-02', minor: 1_000 }],
			cashTips: [],
			work: [
				{ date: '2026-03-02', staffId: 'cy', positionId: 'bus', minutes: 60 },
			],
		})
		expect(result.people[0]).toMatchObject({ staffId: 'cy', shareMinor: 0 })
		expect(result.unallocatedMinor).toBe(1_000)
	})

	it('adds up even when percentages and cents do not divide evenly', () => {
		const result = computeTipPool({
			currency: 'USD',
			settings: settings({
				splitBasis: 'position_percent',
				positionPercentBp: { a: 3_333, b: 3_333, c: 3_334 },
			}),
			onlineTips: [{ date: '2026-03-02', minor: 10_001 }],
			cashTips: [{ date: '2026-03-02', minor: 7 }],
			work: ['a', 'b', 'c'].flatMap((position, i) => [
				{
					date: '2026-03-02',
					staffId: `p${i}x`,
					positionId: position,
					minutes: 100,
				},
				{
					date: '2026-03-02',
					staffId: `p${i}y`,
					positionId: position,
					minutes: 77,
				},
			]),
		})
		const paid = result.people.reduce((s, p) => s + p.shareMinor, 0)
		expect(paid + result.unallocatedMinor).toBe(10_008)
		expect(result.unallocatedMinor).toBe(0)
	})
})

describe('helpers', () => {
	it('keys the group by day or by the whole period', () => {
		expect(tipGroupKey('2026-03-02', 'daily')).toBe('2026-03-02')
		expect(tipGroupKey('2026-03-02', 'period')).toBe('period')
	})

	it('defaults to a conservative setup: hours, whole period, no fee, pickup only', () => {
		expect(DEFAULT_TIP_SETTINGS).toEqual({
			splitBasis: 'hours',
			cadence: 'period',
			cardFeeBp: 0,
			fulfillment: ['pickup'],
			positionPercentBp: {},
		})
	})

	it('builds a table with each person and the pool lines, formula-safe names left to the CSV builder', () => {
		const table = tipPoolTable([
			{
				currency: 'USD',
				onlineTipsMinor: 20_000,
				cardFeeMinor: 600,
				cashTipsMinor: 5_000,
				poolMinor: 24_400,
				unallocatedMinor: 0,
				people: [
					{
						employeeNumber: '7',
						firstName: '=cmd',
						lastName: 'Ng',
						minutes: 450,
						shareMinor: 9_760,
					},
				],
			},
		])
		expect(table.rows[0]).toEqual(['7', '=cmd', 'Ng', 7.5, 'USD', 97.6])
		expect(table.rows.map((r) => r[1])).toEqual([
			'=cmd',
			'Online order tips',
			'Card fee deduction',
			'Declared cash tips',
			'Pool',
			'Not allocated',
		])
		expect(table.rows[2]![5]).toBe(-6)
	})
})
