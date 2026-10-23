import { describe, expect, it } from 'vitest'
import { HostApiError } from './api.ts'
import { dayFeedSchema } from './feed.ts'
import dayFeed from './fixtures/day-feed.json'
import { afterFailedRefresh, type HostStandState } from './useHostStand.ts'

const ready: HostStandState = {
	status: 'ready',
	feed: dayFeedSchema.parse(dayFeed),
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
