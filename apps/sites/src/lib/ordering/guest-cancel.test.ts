import { describe, expect, it } from 'vitest'
import {
	cancelAnnounceKey,
	cancelHiddenKey,
	cancelRefusalKey,
	cancelWindowEnd,
	clockOffsetMs,
	createCancelAttempt,
	formatCancelRemaining,
	nextCancelAnnouncement,
	orderStage,
	paidOnline,
	refundView,
	visibleCancelReason,
} from './guest-cancel.ts'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const until = (seconds: number) => new Date(NOW + seconds * 1000).toISOString()

describe('cancelWindowEnd', () => {
	it('opens while allowed and before the end', () => {
		expect(
			cancelWindowEnd(
				{ status: 'accepted', cancel: { allowed: true, until: until(120) } },
				NOW,
			),
		).toBe(NOW + 120_000)
	})

	it('stays hidden without a cancel block (older node, flag off)', () => {
		expect(cancelWindowEnd({ status: 'accepted' }, NOW)).toBeNull()
	})

	it('stays hidden when the region says not allowed (dine-in, table orders)', () => {
		expect(
			cancelWindowEnd(
				{ status: 'accepted', cancel: { allowed: false, until: null } },
				NOW,
			),
		).toBeNull()
		expect(
			cancelWindowEnd(
				{ status: 'accepted', cancel: { allowed: false, until: until(60) } },
				NOW,
			),
		).toBeNull()
	})

	it('hides once the end has passed, without any request', () => {
		const order = {
			status: 'accepted',
			cancel: { allowed: true, until: until(30) },
		}
		expect(cancelWindowEnd(order, NOW + 29_999)).not.toBeNull()
		expect(cancelWindowEnd(order, NOW + 30_000)).toBeNull()
	})

	it('hides for a cancelled order and for a bad end', () => {
		expect(
			cancelWindowEnd(
				{ status: 'cancelled', cancel: { allowed: true, until: until(60) } },
				NOW,
			),
		).toBeNull()
		expect(
			cancelWindowEnd(
				{ status: 'accepted', cancel: { allowed: true, until: 'soon' } },
				NOW,
			),
		).toBeNull()
		expect(
			cancelWindowEnd(
				{ status: 'accepted', cancel: { allowed: true, until: null } },
				NOW,
			),
		).toBeNull()
	})

	it('keeps the button while the restaurant has not answered', () => {
		expect(
			cancelWindowEnd(
				{
					status: 'pending_acceptance',
					cancel: { allowed: true, until: until(300) },
				},
				NOW,
			),
		).not.toBeNull()
	})
})

describe('formatCancelRemaining', () => {
	it('counts whole minutes, rounded up, then seconds in the last minute', () => {
		expect(formatCancelRemaining(120_000)).toBe('2 minutes')
		expect(formatCancelRemaining(61_000)).toBe('2 minutes')
		expect(formatCancelRemaining(60_000)).toBe('60 seconds')
		expect(formatCancelRemaining(45_200)).toBe('46 seconds')
		expect(formatCancelRemaining(500)).toBe('1 second')
	})
})

describe('order stage and refund view', () => {
	it('tells waiting, turned down and cancelled apart', () => {
		expect(orderStage({ status: 'pending_acceptance' })).toBe('waiting')
		expect(orderStage({ status: 'cancelled', rejected: true })).toBe('rejected')
		expect(
			orderStage({ status: 'cancelled', cancelledBy: 'guest' } as never),
		).toBe('cancelled')
		expect(orderStage({ status: 'accepted' })).toBe('normal')
	})

	it('shows a reason only when it is guest-visible', () => {
		expect(
			visibleCancelReason({
				status: 'cancelled',
				cancelReason: 'out_of_stock',
			}),
		).toBe('out_of_stock')
		expect(
			visibleCancelReason({ status: 'cancelled', cancelReason: 'too_busy' }),
		).toBeNull()
		expect(visibleCancelReason({ status: 'cancelled' })).toBeNull()
	})

	it('maps the refund states', () => {
		expect(
			refundView({
				status: 'cancelled',
				refundStatus: 'pending',
				refundPendingCents: 1250,
			}),
		).toEqual({ kind: 'pending', amountCents: 1250 })
		expect(
			refundView({
				status: 'cancelled',
				refundStatus: 'full',
				refundedCents: 900,
			}),
		).toEqual({ kind: 'refunded', amountCents: 900 })
		expect(refundView({ status: 'cancelled', refundStatus: 'failed' })).toEqual(
			{
				kind: 'failed',
			},
		)
		expect(refundView({ status: 'cancelled', refundStatus: 'none' })).toEqual({
			kind: 'none',
		})
	})

	it('knows a paid online order from a pay-at-handoff one', () => {
		expect(paidOnline({ paymentStatus: 'paid' })).toBe(true)
		expect(paidOnline({ paymentStatus: 'not_required' })).toBe(false)
	})

	it('promises a refund only for an online payment, never for a handoff order marked paid', () => {
		expect(paidOnline({ paymentMethod: 'online', paymentStatus: 'paid' })).toBe(
			true,
		)
		expect(
			paidOnline({ paymentMethod: 'handoff', paymentStatus: 'paid' }),
		).toBe(false)
		expect(
			paidOnline({ paymentMethod: 'online', paymentStatus: 'pending' }),
		).toBe(false)
	})

	it('lets the region decide with refundsOnCancel when it sends it', () => {
		expect(paidOnline({ refundsOnCancel: false, paymentStatus: 'paid' })).toBe(
			false,
		)
		expect(
			paidOnline({
				refundsOnCancel: true,
				paymentMethod: 'handoff',
				paymentStatus: 'paid',
			}),
		).toBe(true)
	})
})

describe('clockOffsetMs', () => {
	it('is the region clock minus this device clock', () => {
		expect(clockOffsetMs(new Date(NOW + 90_000).toISOString(), NOW)).toBe(
			90_000,
		)
		expect(clockOffsetMs(NOW - 5_000, NOW)).toBe(-5_000)
	})

	it('is 0 when the region sent no usable time', () => {
		expect(clockOffsetMs(undefined, NOW)).toBe(0)
		expect(clockOffsetMs(null, NOW)).toBe(0)
		expect(clockOffsetMs('soon', NOW)).toBe(0)
		expect(clockOffsetMs(Number.NaN, NOW)).toBe(0)
	})
})

describe('cancelWindowEnd with a skewed clock', () => {
	const order = {
		status: 'accepted',
		cancel: { allowed: true, until: until(120) },
	}

	it('keeps the button for a phone whose clock runs fast', () => {
		// The phone is 5 minutes ahead: by its own clock the window already ended.
		const phoneNow = NOW + 5 * 60_000
		const offset = -5 * 60_000
		expect(cancelWindowEnd(order, phoneNow)).toBeNull()
		expect(cancelWindowEnd(order, phoneNow, offset)).toBe(phoneNow + 120_000)
	})

	it('closes on the region clock for a phone whose clock runs slow', () => {
		const phoneNow = NOW - 5 * 60_000
		const offset = 5 * 60_000
		expect(cancelWindowEnd(order, phoneNow)).not.toBeNull()
		expect(cancelWindowEnd(order, phoneNow + 119_999, offset)).not.toBeNull()
		expect(cancelWindowEnd(order, phoneNow + 120_000, offset)).toBeNull()
	})
})

describe('cancel countdown announcements', () => {
	it('rounds up to whole minutes and uses 0 for the last minute', () => {
		expect(cancelAnnounceKey(5 * 60_000)).toBe(5)
		expect(cancelAnnounceKey(4 * 60_000 + 1)).toBe(5)
		expect(cancelAnnounceKey(61_000)).toBe(2)
		expect(cancelAnnounceKey(60_000)).toBe(0)
		expect(cancelAnnounceKey(1)).toBe(0)
		expect(cancelAnnounceKey(-10)).toBe(0)
	})

	it('speaks once per minute mark and once for the last minute, not every second', () => {
		const spoken: number[] = []
		let last: number | null = null
		for (let ms = 3 * 60_000; ms > 0; ms -= 1000) {
			const next = nextCancelAnnouncement(last, ms)
			last = next.key
			if (next.announce) spoken.push(next.key)
		}
		expect(spoken).toEqual([3, 2, 0])
	})

	it('speaks again after the box was hidden and shown anew (key reset)', () => {
		expect(nextCancelAnnouncement(null, 90_000)).toEqual({
			key: 2,
			announce: true,
		})
		expect(nextCancelAnnouncement(2, 89_000)).toEqual({
			key: 2,
			announce: false,
		})
	})
})

describe('cancelHiddenKey', () => {
	it('says nothing when the heading already shows the order is cancelled', () => {
		expect(cancelHiddenKey({ status: 'cancelled' }, NOW)).toBeNull()
		expect(cancelHiddenKey({ status: 'expired' }, NOW)).toBeNull()
	})

	it('explains a kitchen that started, a closed window, or no reason known', () => {
		expect(cancelHiddenKey({ status: 'preparing' }, NOW)).toBe('preparing')
		expect(
			cancelHiddenKey(
				{
					status: 'accepted',
					cancel: { allowed: false, until: until(-30) },
				},
				NOW,
			),
		).toBe('closed')
		expect(
			cancelHiddenKey(
				{
					status: 'accepted',
					cancel: { allowed: false, until: until(300) },
				},
				NOW,
			),
		).toBe('unavailable')
		expect(
			cancelHiddenKey(
				{ status: 'accepted', cancel: { allowed: false, until: null } },
				NOW,
			),
		).toBe('unavailable')
	})

	it('judges the end on the region clock', () => {
		const order = {
			status: 'accepted',
			cancel: { allowed: false, until: until(30) },
		}
		// Phone 2 minutes behind the region: by its own clock the end is 150 s away.
		expect(cancelHiddenKey(order, NOW - 120_000, 120_000)).toBe('unavailable')
		expect(cancelHiddenKey(order, NOW - 120_000 + 31_000, 120_000)).toBe(
			'closed',
		)
	})
})

describe('cancelRefusalKey', () => {
	it('picks a message per refusal code', () => {
		expect(cancelRefusalKey('cancel_window_closed')).toBe('closed')
		expect(cancelRefusalKey('order_in_preparation')).toBe('preparing')
		expect(cancelRefusalKey('guest_cancel_disabled')).toBe('unavailable')
		expect(cancelRefusalKey('not_cancellable')).toBe('unavailable')
	})
})

describe('createCancelAttempt', () => {
	it('reuses the key until the region answers, then mints a new one', () => {
		let n = 0
		const attempt = createCancelAttempt(() => `key-${++n}`)
		expect(attempt.current()).toBe('key-1')
		expect(attempt.current()).toBe('key-1')
		attempt.settle()
		expect(attempt.current()).toBe('key-2')
	})
})
