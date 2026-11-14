import { describe, expect, it } from 'vitest'
import {
	cancelRefusalKey,
	cancelWindowEnd,
	createCancelAttempt,
	formatCancelRemaining,
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
