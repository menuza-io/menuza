import { describe, expect, it } from 'vitest'
import {
	formatDropDate,
	formatDropDateTime,
	formatRemaining,
	formatTimeRange,
	getDropPhase,
	summarizePickup,
	zonedTimeToUtc,
} from './format.ts'

const NOW = new Date('2026-10-07T12:00:00Z')
const TZ = 'America/Chicago'

const remainingLabels = {
	in: 'in {t}',
	days: '{n} days',
	oneDay: '1 day',
	hoursMinutes: '{h}h {m}m',
	minutes: '{n} min',
	lessThanMinute: 'less than a minute',
}

const pickupLabels = { dates: '{n} dates', locations: '{n} locations' }

// Intl inserts narrow no-break spaces before AM/PM and around range dashes.
const plain = (value: string) => value.replace(/[\u202f\u2009\u00a0]/g, ' ')

describe('getDropPhase', () => {
	it('follows the order window', () => {
		expect(
			getDropPhase(
				{
					status: 'scheduled',
					ordersOpenAt: '2026-10-09T00:00:00Z',
					ordersCloseAt: null,
				},
				NOW,
			),
		).toBe('upcoming')
		expect(
			getDropPhase(
				{
					status: 'live',
					ordersOpenAt: '2026-10-01T00:00:00Z',
					ordersCloseAt: '2026-10-12T00:00:00Z',
				},
				NOW,
			),
		).toBe('live')
		expect(
			getDropPhase(
				{
					status: 'live',
					ordersOpenAt: '2026-10-01T00:00:00Z',
					ordersCloseAt: '2026-10-05T00:00:00Z',
				},
				NOW,
			),
		).toBe('ended')
		expect(
			getDropPhase(
				{ status: 'completed', ordersOpenAt: null, ordersCloseAt: null },
				NOW,
			),
		).toBe('ended')
	})

	it('treats previewed drafts as live', () => {
		expect(
			getDropPhase(
				{ status: 'draft', ordersOpenAt: null, ordersCloseAt: null },
				NOW,
			),
		).toBe('live')
	})
})

describe('zonedTimeToUtc', () => {
	it('converts wall-clock pickup times in the location timezone', () => {
		expect(zonedTimeToUtc('2026-10-09', '09:30', TZ)?.toISOString()).toBe(
			'2026-10-09T14:30:00.000Z',
		)
		expect(zonedTimeToUtc('2026-01-09', '09:30', TZ)?.toISOString()).toBe(
			'2026-01-09T15:30:00.000Z',
		)
		expect(
			zonedTimeToUtc('2026-10-09', '09:30', 'Asia/Riyadh')?.toISOString(),
		).toBe('2026-10-09T06:30:00.000Z')
	})

	it('rejects malformed dates', () => {
		expect(zonedTimeToUtc('tomorrow', '09:30', TZ)).toBeNull()
	})
})

describe('formatting', () => {
	it('formats calendar dates without shifting the day', () => {
		expect(formatDropDate('2026-10-09', 'en-US', TZ)).toBe('Fri, Oct 9')
		expect(formatDropDate('2026-10-09', 'en-US', 'Pacific/Auckland')).toBe(
			'Fri, Oct 9',
		)
		expect(formatDropDate('2026-10-09', 'en-US', TZ, { weekday: false })).toBe(
			'Oct 9',
		)
	})

	it('formats date-times in the pickup timezone', () => {
		expect(plain(formatDropDateTime('2026-10-09T23:00:00Z', 'en-US', TZ))).toBe(
			'Fri, Oct 9 · 6:00 PM',
		)
		expect(
			plain(
				formatDropDateTime('2026-10-09T23:00:00Z', 'en-US', TZ, {
					month: false,
				}),
			),
		).toBe('Fri · 6:00 PM')
	})

	it('formats pickup window ranges', () => {
		expect(
			plain(formatTimeRange('09:30', '12:00', 'en-US', TZ, '2026-10-09')),
		).toBe('9:30 AM – 12:00 PM')
	})
})

describe('summarizePickup', () => {
	it('summarizes one date and many locations', () => {
		expect(
			summarizePickup(
				['2026-10-09', '2026-10-09'],
				['Baxter Village', 'Eastside', 'Downtown', 'Airport'],
				'en-US',
				TZ,
				pickupLabels,
			),
		).toBe('Fri, Oct 9 · 4 locations')
	})

	it('summarizes many dates and one location', () => {
		expect(
			summarizePickup(
				['2026-10-11', '2026-10-09', '2026-10-10'],
				['Baxter Village'],
				'en-US',
				TZ,
				pickupLabels,
			),
		).toBe('3 dates · Baxter Village')
	})

	it('returns an empty string without windows', () => {
		expect(summarizePickup([], [], 'en-US', TZ, pickupLabels)).toBe('')
	})
})

describe('formatRemaining', () => {
	it('uses days, hours and minutes, then minutes only', () => {
		expect(formatRemaining(2 * 24 * 3600_000 + 5000, remainingLabels)).toBe(
			'in 2 days',
		)
		expect(formatRemaining(26 * 3600_000, remainingLabels)).toBe('in 1 day')
		expect(formatRemaining(3 * 3600_000 + 12 * 60_000, remainingLabels)).toBe(
			'in 3h 12m',
		)
		expect(formatRemaining(5 * 60_000 + 59_000, remainingLabels)).toBe(
			'in 5 min',
		)
		expect(formatRemaining(30_000, remainingLabels)).toBe(
			'in less than a minute',
		)
		expect(formatRemaining(-5000, remainingLabels)).toBe(
			'in less than a minute',
		)
	})
})
