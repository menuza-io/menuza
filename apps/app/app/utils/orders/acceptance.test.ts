import { describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	decideOrder,
	formatClock,
	isAlreadyDecided,
	isRejectedOrder,
	secondsUntil,
} from './acceptance.ts'

describe('acceptance helpers', () => {
	it('sends accept and reject bodies', async () => {
		const request = vi.fn().mockResolvedValue({})
		await decideOrder(request, 'o 1', { kind: 'accept' })
		expect(request).toHaveBeenLastCalledWith('/o%201', {
			method: 'PATCH',
			body: '{"status":"accepted"}',
		})
		await decideOrder(request, 'o1', { kind: 'reject', reason: 'other' })
		expect(request).toHaveBeenLastCalledWith('/o1', {
			method: 'PATCH',
			body: '{"status":"cancelled","rejectReason":"other"}',
		})
	})

	it('treats order_not_pending and stale_version as already decided', () => {
		expect(
			isAlreadyDecided(new OperatorRequestError('x', 'order_not_pending', 409)),
		).toBe(true)
		expect(
			isAlreadyDecided(new OperatorRequestError('x', 'stale_version', 409)),
		).toBe(true)
		expect(
			isAlreadyDecided(new OperatorRequestError('x', 'refund_forbidden', 403)),
		).toBe(false)
	})

	it('counts down and formats the clock', () => {
		const now = Date.parse('2026-01-01T00:00:00Z')
		expect(secondsUntil('2026-01-01T00:03:12Z', now)).toBe(192)
		expect(secondsUntil('2025-12-31T23:59:00Z', now)).toBe(-60)
		expect(secondsUntil(null, now)).toBeNull()
		expect(formatClock(192)).toBe('3:12')
		expect(formatClock(-4)).toBe('0:00')
	})

	it('recognises rejected and timed-out orders', () => {
		expect(
			isRejectedOrder({ status: 'cancelled', rejectedReason: 'too_busy' }),
		).toBe(true)
		expect(
			isRejectedOrder({
				status: 'cancelled',
				cancelledBy: 'system',
				cancelReason: 'not_accepted_in_time',
			}),
		).toBe(true)
		expect(
			isRejectedOrder({ status: 'cancelled', cancelReason: 'guest_asked' }),
		).toBe(false)
	})
})
