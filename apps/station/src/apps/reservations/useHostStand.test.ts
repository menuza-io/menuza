import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import { dayFeedSchema } from './feed.ts'
import dayFeed from './fixtures/day-feed.json'
import {
	afterFailedRefresh,
	dayKey,
	mayPaint,
	TODAY_KEY,
	viewDate,
	type HostStandState,
} from './useHostStand.ts'

const ready: HostStandState = {
	status: 'ready',
	feed: dayFeedSchema.parse(dayFeed),
	feedDate: null,
	today: '2026-01-16',
	waitlist: [],
	grant: {
		token: 't'.repeat(30),
		expiresAt: 0,
		locationId: 'loc',
		canReadGuest: false,
		features: { waitlist: true, online: true },
	},
	stale: false,
}

describe('a failed refresh', () => {
	it('keeps the floor through anything passing, marked not up to date', () => {
		for (const failure of [
			new HostApiError(0, 'network_unavailable'),
			new HostApiError(503, 'service_unavailable'),
			new HostApiError(429, 'rate_limit_exceeded'),
			new HostApiError(403, 'forbidden'),
		]) {
			expect(afterFailedRefresh(ready, failure)).toMatchObject({
				status: 'ready',
				stale: true,
			})
		}
	})

	it('closes the stand for a refusal about the person or the till', () => {
		for (const code of [
			'staff_session_invalid',
			'not_a_host',
			'reservations_disabled',
			'device_revoked',
		]) {
			expect(
				afterFailedRefresh(ready, new HostApiError(403, code)),
			).toMatchObject({ status: 'blocked' })
		}
	})

	it('with no floor yet, says what went wrong', () => {
		expect(
			afterFailedRefresh(
				{ status: 'loading' },
				new HostApiError(0, 'network_unavailable'),
			),
		).toMatchObject({ status: 'blocked' })
	})
})

describe('looking at another day', () => {
	it('keeps today as null, so it follows the server past midnight', () => {
		expect(viewDate(null, '2026-01-16')).toBeNull()
		expect(viewDate('2026-01-16', '2026-01-16')).toBeNull()
		expect(viewDate('2026-01-17', '2026-01-16')).toBe('2026-01-17')
		// Before today is known, a date stays a date.
		expect(viewDate('2026-01-17', null)).toBe('2026-01-17')
	})

	it('holds each day under its own key (and its own ETag)', () => {
		expect(dayKey(null)).toBe(TODAY_KEY)
		expect(dayKey('2026-01-17')).toBe('2026-01-17')
		expect(dayKey('2026-01-17')).not.toBe(dayKey(null))
	})

	it('draws an answer only for the person and the day still on screen', () => {
		const now = { generation: 3, date: '2026-01-17' as string | null }
		expect(mayPaint({ generation: 3, date: '2026-01-17' }, now)).toBe(true)
		// A slow poll for today, after the host moved to tomorrow.
		expect(mayPaint({ generation: 3, date: null }, now)).toBe(false)
		// An answer for the person before (the till was locked meanwhile).
		expect(mayPaint({ generation: 2, date: '2026-01-17' }, now)).toBe(false)
	})
})
