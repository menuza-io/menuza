import { describe, expect, it } from 'vitest'
import {
	computePromisedTime,
	isLargeOrder,
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

	it('promises delivery as the delivery estimate range, busy and large order included', () => {
		expect(computePromisedTime(input({ fulfillment: 'delivery' }))).toEqual({
			promisedAt: at(30),
			promisedUntil: at(45),
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
		).toEqual({ promisedAt: at(45), promisedUntil: at(60) })
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
