import { describe, expect, it } from 'vitest'
import {
	computePromisedTime,
	deliveryArrivalWindowMinutes,
	isLargeOrder,
	largeOrderExtraMinutes,
	locationDeliveryArrivalMinutes,
	MAX_PROMISED_DELAY_MINUTES,
	planPromisedDelay,
	readLargeOrderRule,
	type PromisedTimeInput,
} from './promised-time.ts'

const NOW = new Date('2026-11-13T18:00:00.000Z')
const MIN = 60_000

function input(overrides: Partial<PromisedTimeInput> = {}): PromisedTimeInput {
	return {
		now: NOW,
		fulfillment: 'pickup',
		scheduledFor: null,
		location: {
			timezone: 'America/New_York',
			prepTime: 20,
			deliveryConfig: {
				providers: ['in_house'],
				estimatedDeliveryTimeMin: 30,
				estimatedDeliveryTimeMax: 45,
			} as never,
		},
		largeOrder: null,
		subtotalCents: 2_000,
		itemCount: 2,
		...overrides,
	}
}

const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN)

describe('computePromisedTime', () => {
	it('promises pickup at now + prep time, one time, no range', () => {
		expect(computePromisedTime(input())).toEqual({
			promisedAt: at(20),
			promisedUntil: null,
		})
	})

	it('adds busy minutes while busy mode is on, and not after it ended', () => {
		const busy = (until: string | null) =>
			input({
				location: {
					...input().location,
					busyMode: { extraPrepMinutes: 15, until },
				},
			})
		expect(computePromisedTime(busy(null)).promisedAt).toEqual(at(35))
		expect(
			computePromisedTime(busy('2026-11-13T17:00:00.000Z')).promisedAt,
		).toEqual(at(20))
	})

	it('adds large-order prep over an amount threshold (major units)', () => {
		const largeOrder = {
			threshold: 100,
			thresholdType: 'amount' as const,
			extraPrepMinutes: 15,
		}
		expect(
			computePromisedTime(input({ largeOrder, subtotalCents: 10_001 }))
				.promisedAt,
		).toEqual(at(35))
		// Exactly at the threshold is not over it ("exceeds").
		expect(
			computePromisedTime(input({ largeOrder, subtotalCents: 10_000 }))
				.promisedAt,
		).toEqual(at(20))
	})

	it('adds large-order prep over an item-count threshold', () => {
		const largeOrder = {
			threshold: 10,
			thresholdType: 'items' as const,
			extraPrepMinutes: 10,
		}
		expect(
			computePromisedTime(input({ largeOrder, itemCount: 11 })).promisedAt,
		).toEqual(at(30))
		expect(
			computePromisedTime(input({ largeOrder, itemCount: 10 })).promisedAt,
		).toEqual(at(20))
	})

	it('promises the scheduled time when scheduled, for pickup and delivery', () => {
		const scheduledFor = '2026-11-13T23:30:00.000Z'
		for (const fulfillment of ['pickup', 'delivery'] as const) {
			expect(
				computePromisedTime(
					input({
						fulfillment,
						scheduledFor,
						largeOrder: {
							threshold: 1,
							thresholdType: 'items',
							extraPrepMinutes: 30,
						},
					}),
				),
			).toEqual({ promisedAt: new Date(scheduledFor), promisedUntil: null })
		}
	})

	it('promises delivery as prep plus the delivery range, busy and large order included', () => {
		// 20 min prep + a 30-45 min range.
		expect(computePromisedTime(input({ fulfillment: 'delivery' }))).toEqual({
			promisedAt: at(50),
			promisedUntil: at(65),
		})
		expect(
			computePromisedTime(
				input({
					fulfillment: 'delivery',
					location: {
						...input().location,
						busyMode: { extraPrepMinutes: 10, until: null },
					},
					largeOrder: {
						threshold: 1,
						thresholdType: 'items',
						extraPrepMinutes: 5,
					},
				}),
			),
			// + 10 busy (once) + 5 large-order extra.
		).toEqual({ promisedAt: at(65), promisedUntil: at(80) })
	})

	it('promises a scheduled delivery at its slot, without prep or range', () => {
		expect(
			computePromisedTime(
				input({ fulfillment: 'delivery', scheduledFor: at(120).toISOString() }),
			),
		).toEqual({ promisedAt: at(120), promisedUntil: null })
	})

	it('has no promised time for table rounds and drops', () => {
		const none = { promisedAt: null, promisedUntil: null }
		expect(computePromisedTime(input({ fulfillment: 'dine_in' }))).toEqual(none)
		expect(computePromisedTime(input({ drop: true }))).toEqual(none)
	})

	it('rounds up to the whole minute', () => {
		const now = new Date(NOW.getTime() + 20_500)
		expect(computePromisedTime(input({ now })).promisedAt).toEqual(at(21))
	})
})

describe('readLargeOrderRule / isLargeOrder', () => {
	it('reads one location and fails safe on anything malformed', () => {
		const rule = {
			threshold: 50,
			thresholdType: 'amount',
			extraPrepMinutes: 10,
		}
		expect(readLargeOrderRule({ loc1: rule }, 'loc1')).toEqual(rule)
		expect(readLargeOrderRule({ loc1: rule }, 'loc2')).toBeNull()
		expect(readLargeOrderRule(undefined, 'loc1')).toBeNull()
		expect(readLargeOrderRule([rule], '0')).toBeNull()
		expect(
			readLargeOrderRule(
				{ loc1: { ...rule, thresholdType: 'dollars' } },
				'loc1',
			),
		).toBeNull()
		expect(
			readLargeOrderRule({ loc1: { ...rule, extraPrepMinutes: -5 } }, 'loc1'),
		).toBeNull()
		expect(isLargeOrder(null, { subtotalCents: 1e9, itemCount: 1e3 })).toBe(
			false,
		)
	})
})

describe('largeOrderExtraMinutes', () => {
	const amount = {
		threshold: 50,
		thresholdType: 'amount' as const,
		extraPrepMinutes: 10,
	}
	const items = {
		threshold: 3,
		thresholdType: 'items' as const,
		extraPrepMinutes: 15,
	}

	it('is strictly over the amount threshold (major units x100)', () => {
		expect(
			largeOrderExtraMinutes(amount, { subtotalCents: 4999, itemCount: 1 }),
		).toBe(0)
		expect(
			largeOrderExtraMinutes(amount, { subtotalCents: 5000, itemCount: 1 }),
		).toBe(0)
		expect(
			largeOrderExtraMinutes(amount, { subtotalCents: 5001, itemCount: 1 }),
		).toBe(10)
	})

	it('is strictly over the item count threshold', () => {
		expect(
			largeOrderExtraMinutes(items, { subtotalCents: 1e6, itemCount: 2 }),
		).toBe(0)
		expect(
			largeOrderExtraMinutes(items, { subtotalCents: 1e6, itemCount: 3 }),
		).toBe(0)
		expect(
			largeOrderExtraMinutes(items, { subtotalCents: 0, itemCount: 4 }),
		).toBe(15)
	})

	it('is 0 without a rule', () => {
		expect(
			largeOrderExtraMinutes(null, { subtotalCents: 1e9, itemCount: 99 }),
		).toBe(0)
	})

	it('equals what placement stores, for pickup and delivery', () => {
		const cart = { subtotalCents: 6000, itemCount: 2 }
		const extra = largeOrderExtraMinutes(amount, cart)
		const base = input({ largeOrder: amount, ...cart })
		const pickup = computePromisedTime(base)
		expect(pickup.promisedAt).toEqual(at(20 + extra))
		const delivery = computePromisedTime({ ...base, fulfillment: 'delivery' })
		const window = locationDeliveryArrivalMinutes(base.location, NOW, {
			largeOrderExtraMinutes: extra,
		})
		expect(delivery.promisedAt).toEqual(at(window.min))
		expect(delivery.promisedUntil).toEqual(at(window.max))
	})
})

describe('planPromisedDelay', () => {
	const order = {
		status: 'accepted',
		promisedAt: at(20),
		promisedUntil: null as Date | null,
		promisedVersion: 0,
		promisedDelayMinutes: 0,
	}

	it('moves the time (and a delivery range) later and bumps the version', () => {
		expect(planPromisedDelay(order, 10, 0)).toEqual({
			ok: true,
			promisedAt: at(30),
			promisedUntil: null,
			version: 1,
			delayMinutes: 10,
		})
		expect(
			planPromisedDelay({ ...order, promisedUntil: at(35) }, 5, 0),
		).toMatchObject({ ok: true, promisedAt: at(25), promisedUntil: at(40) })
	})

	it('refuses closed orders, orders without a time, stale versions and the cap', () => {
		for (const status of [
			'completed',
			'cancelled',
			'expired',
			'payment_review',
		])
			expect(planPromisedDelay({ ...order, status }, 5, 0)).toEqual({
				ok: false,
				code: 'order_closed',
			})
		expect(planPromisedDelay({ ...order, promisedAt: null }, 5, 0)).toEqual({
			ok: false,
			code: 'no_promised_time',
		})
		expect(planPromisedDelay(order, 5, 1)).toEqual({
			ok: false,
			code: 'stale_version',
		})
		expect(
			planPromisedDelay({ ...order, promisedDelayMinutes: 80 }, 10, 0),
		).toMatchObject({ ok: true, delayMinutes: MAX_PROMISED_DELAY_MINUTES })
		expect(
			planPromisedDelay({ ...order, promisedDelayMinutes: 80 }, 15, 0),
		).toEqual({ ok: false, code: 'delay_limit' })
	})

	it('never moves earlier: only the offered choices are accepted', () => {
		expect(() => planPromisedDelay(order, -5 as never, 0)).toThrow(RangeError)
		expect(() => planPromisedDelay(order, 20 as never, 0)).toThrow(RangeError)
	})
})

describe('deliveryArrivalWindowMinutes', () => {
	it('is prep + busy + large-order extra + the delivery range', () => {
		expect(
			deliveryArrivalWindowMinutes({
				prepMinutes: 15,
				deliveryMin: 25,
				deliveryMax: 45,
			}),
		).toEqual({ min: 40, max: 60 })
		expect(
			deliveryArrivalWindowMinutes({
				prepMinutes: 15,
				busyMinutes: 10,
				largeOrderExtraMinutes: 5,
				deliveryMin: 25,
				deliveryMax: 45,
			}),
		).toEqual({ min: 55, max: 75 })
	})

	it('never inverts the range and ignores negative inputs', () => {
		expect(
			deliveryArrivalWindowMinutes({
				prepMinutes: 15,
				busyMinutes: -5,
				deliveryMin: 30,
				deliveryMax: 20,
			}),
		).toEqual({ min: 45, max: 45 })
	})
})

describe('locationDeliveryArrivalMinutes', () => {
	const location = input().location

	it('reads prep, busy minutes in force and the delivery range from the location', () => {
		expect(locationDeliveryArrivalMinutes(location, NOW)).toEqual({
			min: 50,
			max: 65,
		})
		expect(
			locationDeliveryArrivalMinutes(
				{ ...location, busyMode: { extraPrepMinutes: 10, until: null } },
				NOW,
			),
		).toEqual({ min: 60, max: 75 })
		// Busy mode that has ended adds nothing.
		expect(
			locationDeliveryArrivalMinutes(
				{
					...location,
					busyMode: {
						extraPrepMinutes: 10,
						until: '2026-11-13T17:00:00.000Z',
					},
				},
				NOW,
			),
		).toEqual({ min: 50, max: 65 })
	})

	it('uses defaults (15 min prep, 25-45 min) and a quoted travel range when given', () => {
		expect(locationDeliveryArrivalMinutes({}, NOW)).toEqual({
			min: 40,
			max: 60,
		})
		expect(
			locationDeliveryArrivalMinutes(location, NOW, {
				travel: { min: 10, max: 20 },
			}),
		).toEqual({ min: 30, max: 40 })
	})

	it('is the window the ordering pages show and the promise stores', () => {
		const busy = {
			...location,
			busyMode: { extraPrepMinutes: 10, until: null },
		}
		const promised = computePromisedTime(
			input({ fulfillment: 'delivery', location: busy }),
		)
		const window = locationDeliveryArrivalMinutes(busy, NOW)
		expect({
			min: (promised.promisedAt!.getTime() - NOW.getTime()) / MIN,
			max: (promised.promisedUntil!.getTime() - NOW.getTime()) / MIN,
		}).toEqual(window)
	})
})
