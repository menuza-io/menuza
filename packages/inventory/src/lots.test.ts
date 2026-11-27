import { describe, expect, test } from 'vitest'
import {
	daysUntilUseBy,
	localDateIn,
	remainingLots,
	useByFromShelfLife,
	useByInstant,
	useByStatus,
	validateConfirmedLots,
	type StockLot,
} from './lots.ts'

const lot = (
	id: string,
	useByDate: string,
	quantity: number,
	createdAt = 1,
	baseline = false,
): StockLot => ({ id, useByDate, quantity, createdAt, baseline })

describe('use-by status', () => {
	test('counts whole days and flags expired, today and soon', () => {
		expect(daysUntilUseBy('2026-11-29', '2026-11-27')).toBe(2)
		expect(daysUntilUseBy('2026-12-01', '2026-11-30')).toBe(1)
		expect(useByStatus('2026-11-26', '2026-11-27')).toBe('expired')
		expect(useByStatus('2026-11-27', '2026-11-27')).toBe('today')
		expect(useByStatus('2026-11-29', '2026-11-27')).toBe('soon')
		expect(useByStatus('2026-11-30', '2026-11-27')).toBe('ok')
	})

	test('derives the date from a shelf life in the location time zone', () => {
		// 23:30 on the 27th in Riyadh (UTC+3) is 20:30 UTC.
		const at = Date.UTC(2026, 10, 27, 20, 30)
		expect(localDateIn(at, 'Asia/Riyadh')).toBe('2026-11-27')
		expect(
			useByFromShelfLife({ at, shelfLifeHours: 24, timeZone: 'Asia/Riyadh' }),
		).toBe('2026-11-28')
		// Six hours later it is already the 28th in Riyadh, but still the 27th in UTC.
		expect(
			useByFromShelfLife({ at, shelfLifeHours: 4, timeZone: 'Asia/Riyadh' }),
		).toBe('2026-11-28')
		expect(
			useByFromShelfLife({ at, shelfLifeHours: 4, timeZone: 'UTC' }),
		).toBe('2026-11-28')
		expect(useByInstant(at, 48)).toBe(at + 48 * 3_600_000)
	})
})

describe('remaining lots, oldest date first', () => {
	const today = '2026-11-27'

	test('with nothing used, every lot is whole and sorted by date', () => {
		const stock = remainingLots({
			onHand: 10_000,
			lots: [lot('b', '2026-12-02', 6_000), lot('a', '2026-11-29', 4_000)],
			takes: [],
			today,
		})
		expect(stock.lots.map((row) => [row.id, row.remaining])).toEqual([
			['a', 4_000],
			['b', 6_000],
		])
		expect(stock.undated).toBe(0)
	})

	test('totals reduce the oldest date first', () => {
		// 10 received, 5 used by sales: the older 4 go, then 1 of the newer lot.
		const stock = remainingLots({
			onHand: 5_000,
			lots: [lot('a', '2026-11-29', 4_000), lot('b', '2026-12-02', 6_000)],
			takes: [],
			today,
		})
		expect(stock.lots.map((row) => [row.id, row.remaining])).toEqual([
			['b', 5_000],
		])
		expect(stock.undated).toBe(0)
	})

	test('a take lowers its own lot, not the oldest', () => {
		// Two expired lots; the newer one is thrown away on its own.
		const stock = remainingLots({
			onHand: 5_000,
			lots: [lot('a', '2026-11-20', 2_000), lot('b', '2026-11-25', 3_000)],
			takes: [{ lotId: 'b', quantity: 3_000 }],
			today,
		})
		expect(stock.lots.map((row) => [row.id, row.remaining, row.status])).toEqual(
			[['a', 2_000, 'expired']],
		)
		// The ledger said 5 on hand but the lots now explain 2: 3 are undated.
		expect(stock.undated).toBe(3_000)
	})

	test('stock the lots do not explain is undated and used first', () => {
		// 8 on hand, only 3 with a date: 5 came before tracking.
		const keep = remainingLots({
			onHand: 8_000,
			lots: [lot('a', '2026-11-29', 3_000)],
			takes: [],
			today,
		})
		expect(keep.undated).toBe(5_000)
		expect(keep.lots[0]!.remaining).toBe(3_000)
		// After 6 are used the undated stock is gone and 2 of the dated lot remain.
		const used = remainingLots({
			onHand: 2_000,
			lots: [lot('a', '2026-11-29', 3_000)],
			takes: [],
			today,
		})
		expect(used.undated).toBe(0)
		expect(used.lots[0]!.remaining).toBe(2_000)
	})

	test('a confirmed count of dates replaces everything before it', () => {
		const stock = remainingLots({
			onHand: 5_000,
			lots: [
				lot('old', '2026-11-20', 9_000, 10),
				lot('c1', '2026-11-28', 2_000, 50, true),
				lot('c2', '2026-12-03', 3_000, 50, true),
				lot('later', '2026-12-10', 4_000, 60),
			],
			takes: [],
			today,
		})
		// On hand 5: 2 + 3 confirmed + 4 received later = 9 lots, 4 already used.
		expect(stock.lots.map((row) => [row.id, row.remaining])).toEqual([
			['c2', 1_000],
			['later', 4_000],
		])
	})

	test('never goes negative when the ledger is below zero', () => {
		const stock = remainingLots({
			onHand: -2_000,
			lots: [lot('a', '2026-11-29', 3_000)],
			takes: [],
			today,
		})
		expect(stock.lots).toEqual([])
		expect(stock.onHand).toBe(0)
	})
})

describe('confirming dates', () => {
	test('checks quantities against on hand', () => {
		const ok = [{ useByDate: '2026-11-29', quantity: 2_000 }]
		expect(validateConfirmedLots(ok, 3_000)).toBe('ok')
		expect(validateConfirmedLots(ok, 1_000)).toBe('too_much')
		expect(validateConfirmedLots([], 1_000)).toBe('empty')
		expect(
			validateConfirmedLots([{ useByDate: '2026-11-29', quantity: 0 }], 1_000),
		).toBe('quantity')
		expect(
			validateConfirmedLots(
				[
					{ useByDate: '2026-11-29', quantity: 1 },
					{ useByDate: '2026-11-29', quantity: 1 },
				],
				5,
			),
		).toBe('duplicate_date')
	})
})
