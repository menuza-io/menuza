import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { ORDER_STATUSES } from '../records.ts'
import {
	addDaysIso,
	creditLines,
	creditTotalMinor,
	cutoffPassed,
	levelsOrdered,
	MAX_ORDER_PACKS,
	needsOrder,
	nextOrderableDelivery,
	orderAcceptsDelivery,
	orderCutoffFor,
	orderLineComplete,
	orderLineTotalMinor,
	orderStatusAfterReceipt,
	orderTotalMinor,
	outstandingQuantity,
	packsQuantity,
	packsToMilli,
	priceRiseAlert,
	shortOfMinimumMinor,
	suggestLevelsFromUse,
	suggestOrderQuantity,
	weekdayOf,
} from './orders-rules.ts'

const KG = 1_000_000 // 1 kg in base thousandths

describe('suggested order quantity', () => {
	test('rounds UP to whole packs to reach fill up to', () => {
		// 6 kg on hand, fill up to 30 kg, 10 kg boxes: need 24 kg → 3 boxes.
		const result = suggestOrderQuantity({
			onHand: 6 * KG,
			orderBelow: 8 * KG,
			fillUpTo: 30 * KG,
			packBase: 10 * KG,
		})
		expect(result).toMatchObject({
			packs: 3,
			packsMilli: 3000,
			quantity: 30 * KG,
			needed: 24 * KG,
			capped: false,
		})
		// 25 kg needed is 2.5 boxes: still 3.
		expect(
			suggestOrderQuantity({
				onHand: 5 * KG,
				orderBelow: 8 * KG,
				fillUpTo: 30 * KG,
				packBase: 10 * KG,
			})?.packs,
		).toBe(3)
	})

	test('an exact multiple is not rounded further', () => {
		expect(
			suggestOrderQuantity({
				onHand: 10 * KG,
				orderBelow: 12 * KG,
				fillUpTo: 30 * KG,
				packBase: 10 * KG,
			})?.packs,
		).toBe(2)
	})

	test('a pack bigger than the need still orders one whole pack', () => {
		const result = suggestOrderQuantity({
			onHand: 7 * KG,
			orderBelow: 8 * KG,
			fillUpTo: 9 * KG,
			packBase: 25 * KG,
		})
		expect(result?.packs).toBe(1)
		expect(result?.quantity).toBe(25 * KG)
	})

	test('nothing is suggested at or above the level, or with no level set', () => {
		expect(
			suggestOrderQuantity({
				onHand: 8 * KG,
				orderBelow: 8 * KG,
				fillUpTo: 30 * KG,
				packBase: KG,
			}),
		).toBeNull()
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: null,
				fillUpTo: null,
				packBase: KG,
			}),
		).toBeNull()
		// Levels of zero never trigger: there is nothing to reach.
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 0,
				fillUpTo: 0,
				packBase: KG,
			}),
		).toBeNull()
	})

	test('only "fill up to": order when out; only "order below": fill to it', () => {
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: null,
				fillUpTo: 5 * KG,
				packBase: KG,
			})?.packs,
		).toBe(5)
		expect(
			suggestOrderQuantity({
				onHand: KG,
				orderBelow: null,
				fillUpTo: 5 * KG,
				packBase: KG,
			}),
		).toBeNull()
		expect(
			suggestOrderQuantity({
				onHand: 2 * KG,
				orderBelow: 4 * KG,
				fillUpTo: null,
				packBase: KG,
			})?.packs,
		).toBe(2)
	})

	test('out with order-below zero but a fill up to still orders', () => {
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 0,
				fillUpTo: 4 * KG,
				packBase: KG,
			})?.packs,
		).toBe(4)
	})

	test('negative on hand counts as none', () => {
		expect(
			suggestOrderQuantity({
				onHand: -3 * KG,
				orderBelow: 2 * KG,
				fillUpTo: 10 * KG,
				packBase: KG,
			})?.packs,
		).toBe(10)
	})

	test('stock already on order counts, so a sent order is not suggested twice', () => {
		expect(
			suggestOrderQuantity({
				onHand: 2 * KG,
				onOrder: 28 * KG,
				orderBelow: 8 * KG,
				fillUpTo: 30 * KG,
				packBase: KG,
			}),
		).toBeNull()
		expect(
			suggestOrderQuantity({
				onHand: 2 * KG,
				onOrder: 10 * KG,
				orderBelow: 20 * KG,
				fillUpTo: 30 * KG,
				packBase: 10 * KG,
			})?.packs,
		).toBe(2)
	})

	test('a misconfigured fill up to below order-below still orders one pack', () => {
		expect(
			suggestOrderQuantity({
				onHand: 2 * KG,
				orderBelow: 8 * KG,
				fillUpTo: 5 * KG,
				packBase: 10 * KG,
			})?.packs,
		).toBe(1)
	})

	test('priced by weight orders in halves, others whole', () => {
		// 12 kg needed with 10 kg boxes: 1.2 boxes → 1.5 (half-box step) vs 2 whole.
		const input = {
			onHand: 0,
			orderBelow: KG,
			fillUpTo: 12 * KG,
			packBase: 10 * KG,
		}
		expect(
			suggestOrderQuantity({ ...input, pricedByWeight: true }),
		).toMatchObject({ packs: 1.5, packsMilli: 1500, quantity: 15 * KG })
		expect(suggestOrderQuantity(input)?.packs).toBe(2)
		// 1 kg packs by weight: half-kilo steps.
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: KG,
				fillUpTo: 2_200,
				packBase: KG,
				pricedByWeight: true,
			})?.packs,
		).toBe(0.5)
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 1,
				fillUpTo: 2.2 * KG,
				packBase: KG,
				pricedByWeight: true,
				fractionalStep: 250,
			})?.packsMilli,
		).toBe(2250)
	})

	test('a minimum number of packs per line', () => {
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 1,
				fillUpTo: KG,
				packBase: KG,
				minOrder: 3,
			})?.packs,
		).toBe(3)
		expect(
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 1,
				fillUpTo: 5 * KG,
				packBase: KG,
				minOrder: 3,
			})?.packs,
		).toBe(5)
	})

	test('caps the pack count', () => {
		const result = suggestOrderQuantity({
			onHand: 0,
			orderBelow: 1,
			fillUpTo: 9_000_000_000,
			packBase: 1,
		})
		expect(result?.capped).toBe(true)
		expect(result?.packs).toBe(MAX_ORDER_PACKS)
	})

	test('refuses impossible inputs', () => {
		expect(() =>
			suggestOrderQuantity({
				onHand: 0,
				orderBelow: 1,
				fillUpTo: 1,
				packBase: 0,
			}),
		).toThrow(RangeError)
		expect(() =>
			suggestOrderQuantity({
				onHand: 1.5,
				orderBelow: 1,
				fillUpTo: 1,
				packBase: 1,
			}),
		).toThrow(RangeError)
	})

	test('property: the order reaches fill up to, overshoots by less than a step, and is a whole number of steps', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 50_000_000 }),
				fc.integer({ min: 1, max: 80_000_000 }),
				fc.integer({ min: 1, max: 30_000_000 }),
				fc.boolean(),
				(onHand, fillUpTo, packBase, byWeight) => {
					const result = suggestOrderQuantity({
						onHand,
						orderBelow: fillUpTo,
						fillUpTo,
						packBase,
						pricedByWeight: byWeight,
					})
					if (onHand >= fillUpTo) {
						expect(result).toBeNull()
						return
					}
					expect(result).not.toBeNull()
					if (result!.capped) return
					const step = byWeight ? 500 : 1000
					expect(result!.packsMilli % step).toBe(0)
					expect(result!.packsMilli).toBeGreaterThanOrEqual(step)
					// Reaches the target (rounding of a half pack to a thousandth aside).
					expect(onHand + result!.quantity).toBeGreaterThanOrEqual(fillUpTo - 1)
					// Less than one step too many: one step fewer would not reach it.
					if (result!.packsMilli > step) {
						expect(
							onHand + packsQuantity(result!.packsMilli - step, packBase),
						).toBeLessThan(fillUpTo + 1)
					}
				},
			),
		)
	})

	test('needsOrder agrees with the Low and Out badges', () => {
		expect(needsOrder({ onHand: 5, orderBelow: 8, fillUpTo: 30 })).toBe(true)
		expect(needsOrder({ onHand: 8, orderBelow: 8, fillUpTo: 30 })).toBe(false)
		expect(needsOrder({ onHand: 0, orderBelow: null, fillUpTo: null })).toBe(
			false,
		)
	})
})

describe('order money', () => {
	test('a line is packs × pack price, half up', () => {
		expect(
			orderLineTotalMinor({ packsMilli: 3000, packPriceMinor: 28_000 }),
		).toBe(84_000)
		expect(
			orderLineTotalMinor({ packsMilli: 1500, packPriceMinor: 28_000 }),
		).toBe(42_000)
		// 0.5 × 3 halalas = 1.5 → 2.
		expect(orderLineTotalMinor({ packsMilli: 500, packPriceMinor: 3 })).toBe(2)
		expect(orderLineTotalMinor({ packsMilli: 0, packPriceMinor: 3 })).toBe(0)
	})

	test('totals priced lines and counts the unpriced ones', () => {
		expect(
			orderTotalMinor([
				{ packs: 3, packPriceMinor: 28_000 },
				{ packs: 1.5, packPriceMinor: 10_000 },
				{ packs: 2, packPriceMinor: null },
			]),
		).toEqual({ totalMinor: 99_000, unpricedLines: 1 })
		expect(orderTotalMinor([])).toEqual({ totalMinor: 0, unpricedLines: 0 })
	})

	test('how far under the supplier minimum', () => {
		expect(shortOfMinimumMinor(31_000, 40_000)).toBe(9_000)
		expect(shortOfMinimumMinor(40_000, 40_000)).toBe(0)
		expect(shortOfMinimumMinor(10, null)).toBe(0)
		expect(shortOfMinimumMinor(10, 0)).toBe(0)
	})

	test('packs convert exactly', () => {
		expect(packsToMilli(2.5)).toBe(2500)
		expect(packsToMilli(0.001)).toBe(1)
		expect(() => packsToMilli(-1)).toThrow(RangeError)
		expect(packsQuantity(2500, 10 * KG)).toBe(25 * KG)
	})
})

describe('order status after a receipt', () => {
	const full = { orderedQuantity: 10 * KG, receivedQuantity: 10 * KG }
	const none = { orderedQuantity: 10 * KG, receivedQuantity: 0 }
	const some = { orderedQuantity: 10 * KG, receivedQuantity: 4 * KG }

	test('everything in is received, something in is partly received', () => {
		expect(
			orderStatusAfterReceipt({ status: 'sent', lines: [full, full] }),
		).toBe('received')
		expect(
			orderStatusAfterReceipt({ status: 'sent', lines: [full, some] }),
		).toBe('partly_received')
		expect(
			orderStatusAfterReceipt({
				status: 'partly_received',
				lines: [some, none],
			}),
		).toBe('partly_received')
	})

	test('nothing in keeps the status; over-delivery counts as complete', () => {
		expect(orderStatusAfterReceipt({ status: 'sent', lines: [none] })).toBe(
			'sent',
		)
		expect(
			orderStatusAfterReceipt({
				status: 'sent',
				lines: [{ orderedQuantity: 10 * KG, receivedQuantity: 12 * KG }],
			}),
		).toBe('received')
		expect(orderStatusAfterReceipt({ status: 'draft', lines: [] })).toBe(
			'draft',
		)
	})

	test('a draft received against becomes partly received or received', () => {
		expect(orderStatusAfterReceipt({ status: 'draft', lines: [some] })).toBe(
			'partly_received',
		)
		expect(orderStatusAfterReceipt({ status: 'draft', lines: [full] })).toBe(
			'received',
		)
	})

	test('closing the order ends it received even with short lines', () => {
		expect(
			orderStatusAfterReceipt({
				status: 'partly_received',
				lines: [some, none],
				closeOrder: true,
			}),
		).toBe('received')
	})

	test('closed orders never change', () => {
		expect(
			orderStatusAfterReceipt({ status: 'cancelled', lines: [full] }),
		).toBe('cancelled')
		expect(
			orderStatusAfterReceipt({
				status: 'received',
				lines: [none],
				closeOrder: true,
			}),
		).toBe('received')
	})

	test('priced-by-weight lines are complete within 5%', () => {
		const weight = (received: number) => ({
			orderedQuantity: 10 * KG,
			receivedQuantity: received,
			pricedByWeight: true,
		})
		expect(orderLineComplete(weight(9.5 * KG))).toBe(true)
		expect(orderLineComplete(weight(9.49 * KG))).toBe(false)
		expect(
			orderLineComplete({
				orderedQuantity: 10 * KG,
				receivedQuantity: 9.9 * KG,
			}),
		).toBe(false)
		expect(
			orderStatusAfterReceipt({ status: 'sent', lines: [weight(9.7 * KG)] }),
		).toBe('received')
	})

	test('only open orders accept a delivery', () => {
		expect(ORDER_STATUSES.filter(orderAcceptsDelivery)).toEqual([
			'draft',
			'sent',
			'partly_received',
		])
	})

	test('outstanding is never negative', () => {
		expect(outstandingQuantity(10, 4)).toBe(6)
		expect(outstandingQuantity(10, 12)).toBe(0)
	})

	test('property: received lines are never reported short, and status is monotone in what arrived', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						orderedQuantity: fc.integer({ min: 0, max: 1_000_000 }),
						receivedQuantity: fc.integer({ min: 0, max: 2_000_000 }),
						pricedByWeight: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 8 },
				),
				(lines) => {
					const status = orderStatusAfterReceipt({ status: 'sent', lines })
					const credit = creditLines(
						lines.map((l, i) => ({ ...l, itemId: `i${i}` })),
					)
					if (status === 'received') expect(credit).toEqual([])
					for (const line of credit) {
						expect(line.shortQuantity).toBeGreaterThan(0)
						expect(line.shortQuantity).toBeLessThanOrEqual(line.orderedQuantity)
					}
					// More arriving never moves an order backwards.
					const more = orderStatusAfterReceipt({
						status,
						lines: lines.map((l) => ({
							...l,
							receivedQuantity: l.receivedQuantity + l.orderedQuantity,
						})),
					})
					expect(more).toBe('received')
				},
			),
		)
	})
})

describe('credit lines', () => {
	test('lists short and missing lines in input order, skipping complete and over-delivered', () => {
		const lines = creditLines([
			{
				itemId: 'chicken',
				orderLineId: 'l1',
				orderedQuantity: 30 * KG,
				receivedQuantity: 24 * KG,
				costMicro: 2_800_000,
			},
			{ itemId: 'rice', orderedQuantity: 25 * KG, receivedQuantity: 25 * KG },
			{
				itemId: 'oil',
				orderedQuantity: 10 * KG,
				receivedQuantity: 0,
				costMicro: 1_000_000,
			},
			{ itemId: 'salt', orderedQuantity: 5 * KG, receivedQuantity: 6 * KG },
		])
		expect(lines).toEqual([
			{
				itemId: 'chicken',
				orderLineId: 'l1',
				orderedQuantity: 30 * KG,
				receivedQuantity: 24 * KG,
				shortQuantity: 6 * KG,
				kind: 'short',
				valueMinor: 16_800,
			},
			{
				itemId: 'oil',
				orderLineId: null,
				orderedQuantity: 10 * KG,
				receivedQuantity: 0,
				shortQuantity: 10 * KG,
				kind: 'missing',
				valueMinor: 10_000,
			},
		])
		expect(creditTotalMinor(lines)).toBe(26_800)
	})

	test('no cost, no value; a weight line within tolerance is not credited', () => {
		const [line] = creditLines([
			{ itemId: 'x', orderedQuantity: 10 * KG, receivedQuantity: 5 * KG },
		])
		expect(line).not.toHaveProperty('valueMinor')
		expect(
			creditLines([
				{
					itemId: 'beef',
					orderedQuantity: 10 * KG,
					receivedQuantity: 9.6 * KG,
					pricedByWeight: true,
				},
			]),
		).toEqual([])
		expect(creditTotalMinor([])).toBe(0)
	})
})

describe('price rise alert', () => {
	test('more than 5% is an alert, 20% or more is big', () => {
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 1_140_000 }),
		).toEqual({ changeBp: 1400, severity: 'rise' })
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 1_200_000 }),
		).toEqual({ changeBp: 2000, severity: 'big' })
	})

	test('exactly 5%, falls, equal and unknown previous are not alerts', () => {
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 1_050_000 }),
		).toBeNull()
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 1_051_000 }),
		).not.toBeNull()
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 900_000 }),
		).toBeNull()
		expect(
			priceRiseAlert({ previousCostMicro: 1_000_000, costMicro: 1_000_000 }),
		).toBeNull()
		expect(priceRiseAlert({ previousCostMicro: null, costMicro: 5 })).toBeNull()
		expect(priceRiseAlert({ previousCostMicro: 0, costMicro: 5 })).toBeNull()
	})

	test('a custom threshold', () => {
		expect(
			priceRiseAlert({
				previousCostMicro: 1_000_000,
				costMicro: 1_030_000,
				thresholdBp: 200,
			}),
		).toEqual({ changeBp: 300, severity: 'rise' })
	})
})

describe('levels from use', () => {
	test('"you use about 22 kg a week"', () => {
		// 88 kg over 28 days: 22 kg a week.
		const result = suggestLevelsFromUse({ usedQuantity: 88 * KG, days: 28 })
		expect(result).toEqual({
			weeklyUseQuantity: 22 * KG,
			fillUpToQuantity: 22 * KG,
			orderBelowQuantity: Math.ceil((88 * KG * 3) / 28),
		})
	})

	test('rounds up to a pack and never lets order-below pass fill up to', () => {
		const result = suggestLevelsFromUse({
			usedQuantity: 88 * KG,
			days: 28,
			roundTo: 10 * KG,
		})
		expect(result?.fillUpToQuantity).toBe(30 * KG)
		expect(result?.orderBelowQuantity).toBe(10 * KG)
		const tight = suggestLevelsFromUse({
			usedQuantity: 100,
			days: 10,
			coverDays: 1,
			orderBelowDays: 5,
		})
		expect(tight!.orderBelowQuantity).toBeLessThanOrEqual(
			tight!.fillUpToQuantity,
		)
	})

	test('nothing used or no days is no suggestion', () => {
		expect(suggestLevelsFromUse({ usedQuantity: 0, days: 28 })).toBeNull()
		expect(suggestLevelsFromUse({ usedQuantity: 5, days: 0 })).toBeNull()
	})

	test('levels must be in order', () => {
		expect(levelsOrdered(8, 30)).toBe(true)
		expect(levelsOrdered(30, 30)).toBe(true)
		expect(levelsOrdered(31, 30)).toBe(false)
		expect(levelsOrdered(null, 30)).toBe(true)
		expect(levelsOrdered(5, null)).toBe(true)
		expect(levelsOrdered(undefined, undefined)).toBe(true)
	})

	test('property: fill up to covers the window use', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 5_000_000 }),
				fc.integer({ min: 1, max: 90 }),
				fc.integer({ min: 1, max: 14 }),
				(used, days, cover) => {
					const levels = suggestLevelsFromUse({
						usedQuantity: used,
						days,
						coverDays: cover,
					})!
					expect(levels.fillUpToQuantity * days).toBeGreaterThanOrEqual(
						used * cover,
					)
					expect(levels.orderBelowQuantity).toBeLessThanOrEqual(
						levels.fillUpToQuantity,
					)
				},
			),
		)
	})
})

describe('supplier schedule', () => {
	// 2026-11-09 is a Monday.
	test('weekday and date arithmetic', () => {
		expect(weekdayOf('2026-11-09')).toBe(1)
		expect(weekdayOf('2026-11-08')).toBe(0)
		expect(addDaysIso('2026-11-30', 1)).toBe('2026-12-01')
		expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29')
		expect(addDaysIso('2026-01-01', -1)).toBe('2025-12-31')
		expect(() => weekdayOf('2026-02-30')).toThrow(RangeError)
		expect(() => weekdayOf('nope')).toThrow(RangeError)
	})

	test('cut-off is the day before at the supplier time by default', () => {
		expect(
			orderCutoffFor('2026-11-12', {
				cutoffTime: '16:00',
				cutoffDaysBefore: 1,
			}),
		).toEqual({ date: '2026-11-11', time: '16:00' })
		expect(
			orderCutoffFor('2026-11-12', {
				cutoffTime: null,
				cutoffDaysBefore: null,
			}),
		).toEqual({ date: '2026-11-11', time: '23:59' })
		expect(
			orderCutoffFor('2026-11-12', {
				cutoffTime: '06:00',
				cutoffDaysBefore: 0,
			}),
		).toEqual({ date: '2026-11-12', time: '06:00' })
	})

	test('cut-off equal to now is still in time', () => {
		const cutoff = { date: '2026-11-11', time: '16:00' }
		expect(cutoffPassed(cutoff, { date: '2026-11-11', time: '16:00' })).toBe(
			false,
		)
		expect(cutoffPassed(cutoff, { date: '2026-11-11', time: '16:01' })).toBe(
			true,
		)
		expect(cutoffPassed(cutoff, { date: '2026-11-10', time: '23:00' })).toBe(
			false,
		)
		expect(cutoffPassed(cutoff, { date: '2026-11-12', time: '00:00' })).toBe(
			true,
		)
	})

	const thursdays = {
		deliveryDays: [4],
		cutoffTime: '16:00',
		cutoffDaysBefore: 1,
	}

	test('the first delivery day whose cut-off has not passed', () => {
		// Monday morning: Thursday 12th, order by Wednesday 16:00.
		expect(
			nextOrderableDelivery(thursdays, { date: '2026-11-09', time: '09:00' }),
		).toEqual({
			expectedDate: '2026-11-12',
			cutoff: { date: '2026-11-11', time: '16:00' },
		})
		// Wednesday 15:59: still the 12th. 16:01: the 19th.
		expect(
			nextOrderableDelivery(thursdays, { date: '2026-11-11', time: '15:59' })
				?.expectedDate,
		).toBe('2026-11-12')
		expect(
			nextOrderableDelivery(thursdays, { date: '2026-11-11', time: '16:01' })
				?.expectedDate,
		).toBe('2026-11-19')
	})

	test('same-day delivery needs a cut-off of zero days', () => {
		const sameDay = {
			deliveryDays: [1],
			cutoffTime: '06:00',
			cutoffDaysBefore: 0,
		}
		expect(
			nextOrderableDelivery(sameDay, { date: '2026-11-09', time: '05:00' })
				?.expectedDate,
		).toBe('2026-11-09')
		expect(
			nextOrderableDelivery(sameDay, { date: '2026-11-09', time: '07:00' })
				?.expectedDate,
		).toBe('2026-11-16')
	})

	test('no delivery days, or none inside the look-ahead, is null', () => {
		expect(
			nextOrderableDelivery(
				{ deliveryDays: [], cutoffTime: null, cutoffDaysBefore: null },
				{ date: '2026-11-09', time: '09:00' },
			),
		).toBeNull()
		expect(
			nextOrderableDelivery(
				thursdays,
				{ date: '2026-11-09', time: '09:00' },
				2,
			),
		).toBeNull()
	})

	test('property: the answer is a delivery day, in time, and nothing earlier fits', () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1 }),
				fc.integer({ min: 0, max: 3 }),
				fc.integer({ min: 0, max: 400 }),
				fc.integer({ min: 0, max: 23 }),
				(deliveryDays, daysBefore, offset, hour) => {
					const schedule = {
						deliveryDays,
						cutoffTime: '12:00',
						cutoffDaysBefore: daysBefore,
					}
					const now = {
						date: addDaysIso('2026-01-01', offset),
						time: `${String(hour).padStart(2, '0')}:30`,
					}
					const found = nextOrderableDelivery(schedule, now)!
					expect(found).not.toBeNull()
					expect(deliveryDays).toContain(weekdayOf(found.expectedDate))
					expect(cutoffPassed(found.cutoff, now)).toBe(false)
					for (
						let date = now.date;
						date < found.expectedDate;
						date = addDaysIso(date, 1)
					) {
						if (!deliveryDays.includes(weekdayOf(date))) continue
						expect(cutoffPassed(orderCutoffFor(date, schedule), now)).toBe(true)
					}
				},
			),
		)
	})
})
