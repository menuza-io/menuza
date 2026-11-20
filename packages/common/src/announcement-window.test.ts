import { zonedLocalToUtc } from '@repo/zoned-time'
import { describe, expect, it } from 'vitest'
import {
	activeAnnouncements,
	announcementIsInWindow,
	announcementStatus,
	cacheControlBeforeBoundary,
	isAnnouncementWindowValid,
	nextAnnouncementBoundary,
} from './announcement-window.ts'

const T0 = Date.UTC(2026, 4, 10, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

describe('announcement window (#238)', () => {
	it('an announcement with neither date behaves as before: shown', () => {
		expect(announcementIsInWindow({}, T0)).toBe(true)
		expect(announcementIsInWindow({ startsAt: null, endsAt: null }, T0)).toBe(
			true,
		)
		expect(
			announcementStatus({ isEnabled: true, startsAt: null, endsAt: null }, T0),
		).toBe('showing')
		expect(
			announcementStatus(
				{ isEnabled: false, startsAt: null, endsAt: null },
				T0,
			),
		).toBe('off')
	})

	it('appears at its start instant and disappears at its end instant', () => {
		const window = { startsAt: iso(T0), endsAt: iso(T0 + 60_000) }
		expect(announcementIsInWindow(window, T0 - 1)).toBe(false)
		expect(announcementIsInWindow(window, T0)).toBe(true)
		expect(announcementIsInWindow(window, T0 + 59_999)).toBe(true)
		expect(announcementIsInWindow(window, T0 + 60_000)).toBe(false)
	})

	it('open-ended windows', () => {
		expect(announcementIsInWindow({ startsAt: iso(T0) }, T0 - 1)).toBe(false)
		expect(announcementIsInWindow({ startsAt: iso(T0) }, T0 + 10 ** 12)).toBe(
			true,
		)
		expect(announcementIsInWindow({ endsAt: iso(T0) }, T0 - 10 ** 9)).toBe(true)
		expect(announcementIsInWindow({ endsAt: iso(T0) }, T0)).toBe(false)
	})

	it('lists Scheduled, Showing and Ended; Ended wins over Off', () => {
		const base = { startsAt: iso(T0), endsAt: iso(T0 + 1000) }
		expect(announcementStatus({ ...base, isEnabled: true }, T0 - 1)).toBe(
			'scheduled',
		)
		expect(announcementStatus({ ...base, isEnabled: true }, T0)).toBe('showing')
		expect(announcementStatus({ ...base, isEnabled: true }, T0 + 1000)).toBe(
			'ended',
		)
		expect(announcementStatus({ ...base, isEnabled: false }, T0 + 1000)).toBe(
			'ended',
		)
		expect(announcementStatus({ ...base, isEnabled: false }, T0)).toBe('off')
	})

	it('"until" must be after "from"', () => {
		expect(
			isAnnouncementWindowValid({ startsAt: iso(T0), endsAt: iso(T0) }),
		).toBe(false)
		expect(
			isAnnouncementWindowValid({ startsAt: iso(T0), endsAt: iso(T0 - 1) }),
		).toBe(false)
		expect(
			isAnnouncementWindowValid({ startsAt: iso(T0), endsAt: iso(T0 + 1) }),
		).toBe(true)
		expect(isAnnouncementWindowValid({ startsAt: iso(T0) })).toBe(true)
		expect(isAnnouncementWindowValid({ endsAt: iso(T0) })).toBe(true)
		expect(isAnnouncementWindowValid({})).toBe(true)
	})

	it('filters the list at request time without a republish', () => {
		const list = [
			{ id: 'always' },
			{ id: 'soon', startsAt: iso(T0 + 1000) },
			{ id: 'ended', endsAt: iso(T0 - 1000) },
			{ id: 'now', startsAt: iso(T0 - 1000), endsAt: iso(T0 + 1000) },
		]
		expect(activeAnnouncements(list, T0).map((a) => a.id)).toEqual([
			'always',
			'now',
		])
		expect(activeAnnouncements(list, T0 + 1000).map((a) => a.id)).toEqual([
			'always',
			'soon',
		])
		expect(activeAnnouncements(list, T0 + 10 ** 9).map((a) => a.id)).toEqual([
			'always',
			'soon',
		])
	})

	it('across a spring-forward change "show from 9:00, until 18:00 local" stays 9 to 18 local', () => {
		// New York, 8 March 2026: 02:00 jumps to 03:00 (UTC-5 becomes UTC-4).
		const zone = 'America/New_York'
		const before = {
			startsAt: iso(zonedLocalToUtc(2026, 3, 7, 9, 0, zone)),
			endsAt: iso(zonedLocalToUtc(2026, 3, 7, 18, 0, zone)),
		}
		const across = {
			startsAt: iso(zonedLocalToUtc(2026, 3, 8, 9, 0, zone)),
			endsAt: iso(zonedLocalToUtc(2026, 3, 8, 18, 0, zone)),
		}
		// 09:00 EST is 14:00 UTC; 09:00 EDT is 13:00 UTC.
		expect(before.startsAt).toBe('2026-03-07T14:00:00.000Z')
		expect(across.startsAt).toBe('2026-03-08T13:00:00.000Z')
		expect(across.endsAt).toBe('2026-03-08T22:00:00.000Z')
		const at = (h: number, m = 0) => Date.UTC(2026, 2, 8, h, m)
		expect(announcementIsInWindow(across, at(12, 59))).toBe(false)
		expect(announcementIsInWindow(across, at(13))).toBe(true)
		expect(announcementIsInWindow(across, at(21, 59))).toBe(true)
		expect(announcementIsInWindow(across, at(22))).toBe(false)
	})

	it('across a fall-back change the window is 25 hours long when it spans the repeated hour', () => {
		const zone = 'America/New_York'
		// 1 November 2026: 02:00 EDT falls back to 01:00 EST.
		const window = {
			startsAt: iso(zonedLocalToUtc(2026, 11, 1, 0, 0, zone)),
			endsAt: iso(zonedLocalToUtc(2026, 11, 2, 0, 0, zone)),
		}
		const hours =
			(new Date(window.endsAt).getTime() -
				new Date(window.startsAt).getTime()) /
			3_600_000
		expect(hours).toBe(25)
	})

	it('finds the next start or end after now', () => {
		const list = [
			{ startsAt: iso(T0 + 5000), endsAt: iso(T0 + 9000) },
			{ endsAt: iso(T0 + 2000) },
			{ endsAt: iso(T0 - 5000) },
		]
		expect(nextAnnouncementBoundary(list, T0)).toBe(T0 + 2000)
		expect(nextAnnouncementBoundary(list, T0 + 2000)).toBe(T0 + 5000)
		expect(nextAnnouncementBoundary(list, T0 + 9000)).toBeNull()
		expect(nextAnnouncementBoundary([{}], T0)).toBeNull()
	})

	it('never keeps a cached page past the next boundary', () => {
		const usual = { maxAge: 60, staleWhileRevalidate: 300 }
		expect(cacheControlBeforeBoundary(null, T0, usual)).toBe(
			'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
		)
		// Far boundary: usual lifetime.
		expect(cacheControlBeforeBoundary(T0 + 3600_000, T0, usual)).toContain(
			'max-age=60, s-maxage=60, stale-while-revalidate=300',
		)
		// 200 seconds away: max-age 60, stale window shrinks so 60 + 140 = 200.
		expect(cacheControlBeforeBoundary(T0 + 200_000, T0, usual)).toBe(
			'public, max-age=60, s-maxage=60, stale-while-revalidate=140',
		)
		// 45 seconds away: only 45 seconds, no stale window.
		expect(cacheControlBeforeBoundary(T0 + 45_000, T0, usual)).toBe(
			'public, max-age=45, s-maxage=45',
		)
		// Under a second away: do not cache.
		expect(cacheControlBeforeBoundary(T0 + 500, T0, usual)).toBe('no-store')
		// Invariant: fresh plus stale never exceeds the time to the boundary.
		for (const secs of [1, 5, 59, 60, 61, 120, 359, 360, 361]) {
			const header = cacheControlBeforeBoundary(T0 + secs * 1000, T0, usual)
			const maxAge = Number(/max-age=(\d+)/.exec(header)?.[1] ?? 0)
			const stale = Number(
				/stale-while-revalidate=(\d+)/.exec(header)?.[1] ?? 0,
			)
			expect(maxAge + stale).toBeLessThanOrEqual(
				Math.max(secs, usual.maxAge + usual.staleWhileRevalidate),
			)
			if (secs < 360) expect(maxAge + stale).toBeLessThanOrEqual(secs)
		}
	})
})
