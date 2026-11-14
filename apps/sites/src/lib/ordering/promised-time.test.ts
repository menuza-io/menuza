import { describe, expect, it } from 'vitest'
import { formatPromisedTime, promisedTimeIsLive } from './promised-time.ts'

const labels = {
	readyAround: 'Ready around {time}',
	arrivingAround: 'Arriving around {time}',
	arriving: 'Arriving {range}',
}

// 2026-11-13T23:40:00Z is 6:40 PM in New York (EST, UTC-5).
const base = {
	promisedAt: '2026-11-13T23:40:00.000Z',
	promisedUntil: null,
	fulfillment: 'pickup',
	status: 'preparing',
	paymentStatus: 'paid',
	timeZone: 'America/New_York',
	locale: 'en-US',
}

describe('formatPromisedTime', () => {
	it('says when a pickup order will be ready', () => {
		expect(formatPromisedTime(base, labels)).toMatch(/^Ready around 6:40\sPM$/)
	})

	it('shows a delivery range', () => {
		const text = formatPromisedTime(
			{
				...base,
				fulfillment: 'delivery',
				promisedUntil: '2026-11-13T23:55:00.000Z',
			},
			labels,
		)
		expect(text).toMatch(/^Arriving 6:40.{1,3}6:55\sPM$/)
	})

	it('shows a single time for delivery without a range', () => {
		expect(
			formatPromisedTime({ ...base, fulfillment: 'delivery' }, labels),
		).toMatch(/^Arriving around 6:40\sPM$/)
	})

	it('uses the location time zone, not the browser', () => {
		const text = formatPromisedTime(
			{ ...base, timeZone: 'Asia/Riyadh' },
			labels,
		)
		expect(text).toMatch(/^Ready around 2:40\sAM$/)
	})

	it('formats for the page locale', () => {
		const text = formatPromisedTime(
			{ ...base, locale: 'ar', timeZone: 'Asia/Riyadh' },
			labels,
		)
		expect(text).toMatch(/2:40\s?ص/)
	})

	it('falls back to UTC for an unknown time zone', () => {
		expect(
			formatPromisedTime({ ...base, timeZone: 'Nope/Zone' }, labels),
		).toMatch(/^Ready around 11:40\sPM$/)
	})

	it('is null without a time or with an invalid one', () => {
		expect(formatPromisedTime({ ...base, promisedAt: null }, labels)).toBeNull()
		expect(
			formatPromisedTime({ ...base, promisedAt: 'soon' }, labels),
		).toBeNull()
	})

	it('hides for settled and unconfirmed orders', () => {
		for (const status of [
			'completed',
			'cancelled',
			'expired',
			'payment_review',
		]) {
			expect(formatPromisedTime({ ...base, status }, labels)).toBeNull()
		}
		for (const paymentStatus of ['pending', 'failed', 'expired']) {
			expect(formatPromisedTime({ ...base, paymentStatus }, labels)).toBeNull()
		}
		expect(
			promisedTimeIsLive({ status: 'ready', paymentStatus: 'unpaid' }),
		).toBe(true)
	})
})
