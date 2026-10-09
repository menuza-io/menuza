import { describe, expect, it } from 'vitest'
import {
	formatHoldClock,
	formatMinutesLong,
	holdAnnouncement,
	isAnnouncementMark,
	isFinalMinute,
	liveHoldRemainingMs,
	minutesLeft,
} from './hold-timer.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const sec = (s: number) => s * 1000

describe('liveHoldRemainingMs', () => {
	it('returns the time left for a pending order with a future hold', () => {
		expect(
			liveHoldRemainingMs(
				{ paymentStatus: 'pending', holdExpiresAt: '2026-10-09T12:04:59Z' },
				NOW,
			),
		).toBe(sec(299))
	})

	it('ignores holds that are past, missing, or unparseable', () => {
		expect(
			liveHoldRemainingMs(
				{ paymentStatus: 'pending', holdExpiresAt: '2026-10-09T11:59:59Z' },
				NOW,
			),
		).toBeNull()
		expect(
			liveHoldRemainingMs(
				{ paymentStatus: 'pending', holdExpiresAt: '2026-10-09T12:00:00Z' },
				NOW,
			),
		).toBeNull()
		expect(
			liveHoldRemainingMs(
				{ paymentStatus: 'pending', holdExpiresAt: null },
				NOW,
			),
		).toBeNull()
		expect(
			liveHoldRemainingMs(
				{ paymentStatus: 'pending', holdExpiresAt: 'soon' },
				NOW,
			),
		).toBeNull()
	})

	it('only counts down while payment is pending', () => {
		for (const paymentStatus of ['paid', 'failed', 'expired', 'unpaid', null]) {
			expect(
				liveHoldRemainingMs(
					{ paymentStatus, holdExpiresAt: '2026-10-09T12:05:00Z' },
					NOW,
				),
			).toBeNull()
		}
	})
})

describe('minutesLeft', () => {
	it('rounds partial minutes up so the boundary is the exact minute', () => {
		expect(minutesLeft(sec(241))).toBe(5)
		expect(minutesLeft(sec(240))).toBe(4)
		expect(minutesLeft(sec(240) + 999)).toBe(4)
		expect(minutesLeft(sec(1))).toBe(1)
		expect(minutesLeft(0)).toBe(0)
		expect(minutesLeft(-5)).toBe(0)
	})
})

describe('isAnnouncementMark', () => {
	it('announces every minute in the last five, then every 5, then every 10', () => {
		expect([1, 2, 3, 4, 5].every(isAnnouncementMark)).toBe(true)
		expect(isAnnouncementMark(0)).toBe(false)
		expect(isAnnouncementMark(6)).toBe(false)
		expect(isAnnouncementMark(10)).toBe(true)
		expect(isAnnouncementMark(25)).toBe(true)
		expect(isAnnouncementMark(35)).toBe(false)
		expect(isAnnouncementMark(40)).toBe(true)
		expect(isAnnouncementMark(120)).toBe(true)
	})
})

describe('holdAnnouncement', () => {
	it('stays silent on the first tick and within a minute', () => {
		expect(holdAnnouncement(null, sec(299))).toBeNull()
		expect(holdAnnouncement(sec(299), sec(298))).toBeNull()
		expect(holdAnnouncement(sec(242), sec(241))).toBeNull()
	})

	it('announces exactly when a whole minute is reached', () => {
		expect(holdAnnouncement(sec(241), sec(240))).toBe(4)
		expect(holdAnnouncement(sec(61), sec(60))).toBe(1)
	})

	it('does not announce zero; the released state takes over', () => {
		expect(holdAnnouncement(sec(1), 0)).toBeNull()
	})

	it('throttles long holds to marks', () => {
		// 8:00 is not a mark; 10:00 is.
		expect(holdAnnouncement(sec(481), sec(480))).toBeNull()
		expect(holdAnnouncement(sec(601), sec(600))).toBe(10)
	})

	it('catches up once after a backgrounded tab skips ticks', () => {
		// Jumped from 9:30 to 6:10: crossed the 7, 8 and 9 minute boundaries,
		// none of which are marks.
		expect(holdAnnouncement(sec(570), sec(370))).toBeNull()
		// Jumped from 12:00 to 3:30: crossed 10 and 5, announce the current 4.
		expect(holdAnnouncement(sec(720), sec(210))).toBe(4)
	})
})

describe('isFinalMinute', () => {
	it('is true from 1:00 down to just above zero', () => {
		expect(isFinalMinute(sec(61))).toBe(false)
		expect(isFinalMinute(sec(60))).toBe(true)
		expect(isFinalMinute(sec(1))).toBe(true)
		expect(isFinalMinute(0)).toBe(false)
	})
})

describe('formatHoldClock', () => {
	it('formats minutes and seconds', () => {
		expect(formatHoldClock(sec(299))).toBe('4:59')
		expect(formatHoldClock(sec(60))).toBe('1:00')
		expect(formatHoldClock(sec(5) + 900)).toBe('0:05')
		expect(formatHoldClock(-1000)).toBe('0:00')
	})

	it('adds hours for long holds', () => {
		expect(formatHoldClock(sec(3900))).toBe('1:05:00')
	})

	it('uses the locale digits', () => {
		expect(formatHoldClock(sec(299), 'ar-EG')).toBe('٤:٥٩')
	})
})

describe('formatMinutesLong', () => {
	it('lets Intl handle plurals', () => {
		expect(formatMinutesLong(1, 'en')).toBe('1 minute')
		expect(formatMinutesLong(15, 'en')).toBe('15 minutes')
	})
})
