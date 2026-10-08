import { describe, expect, it } from 'vitest'
import {
	holdIsLive,
	interpretPaymentStatus,
	shouldContinuePolling,
} from './payment-poll.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z')

describe('interpretPaymentStatus', () => {
	it('treats paid as terminal success regardless of the hold', () => {
		expect(
			interpretPaymentStatus({ status: 'paid', holdExpiresAt: null, now: NOW }),
		).toEqual({ kind: 'paid' })
	})

	it('allows a retry while the hold is still live after a failure', () => {
		expect(
			interpretPaymentStatus({
				status: 'failed',
				holdExpiresAt: '2026-10-09T12:05:00Z',
				now: NOW,
			}),
		).toEqual({ kind: 'failed', canRetry: true })
	})

	it('forbids a retry when the failure has no live hold', () => {
		expect(
			interpretPaymentStatus({
				status: 'failed',
				holdExpiresAt: '2026-10-09T11:55:00Z',
				now: NOW,
			}),
		).toEqual({ kind: 'failed', canRetry: false })
		expect(
			interpretPaymentStatus({
				status: 'failed',
				holdExpiresAt: null,
				now: NOW,
			}),
		).toEqual({ kind: 'failed', canRetry: true })
	})

	it('treats an expired order status as expired even while pending', () => {
		expect(
			interpretPaymentStatus({
				status: 'pending',
				orderStatus: 'expired',
				holdExpiresAt: null,
				now: NOW,
			}),
		).toEqual({ kind: 'expired' })
	})

	it('treats a lapsed hold as expired', () => {
		expect(
			interpretPaymentStatus({
				status: 'pending',
				holdExpiresAt: '2026-10-09T11:59:59Z',
				now: NOW,
			}),
		).toEqual({ kind: 'expired' })
	})

	it('keeps polling for pending or unknown statuses with a live hold', () => {
		expect(
			interpretPaymentStatus({
				status: 'pending',
				holdExpiresAt: '2026-10-09T12:05:00Z',
				now: NOW,
			}),
		).toEqual({ kind: 'pending' })
		expect(
			interpretPaymentStatus({
				status: 'unknown',
				holdExpiresAt: null,
				now: NOW,
			}),
		).toEqual({ kind: 'pending' })
		expect(
			interpretPaymentStatus({ status: null, holdExpiresAt: null, now: NOW }),
		).toEqual({ kind: 'pending' })
	})
})

describe('holdIsLive', () => {
	it('treats missing or unparseable holds as live', () => {
		expect(holdIsLive(null, NOW)).toBe(true)
		expect(holdIsLive(undefined, NOW)).toBe(true)
		expect(holdIsLive('not-a-date', NOW)).toBe(true)
	})
	it('compares valid instants against now', () => {
		expect(holdIsLive('2026-10-09T12:00:01Z', NOW)).toBe(true)
		expect(holdIsLive('2026-10-09T12:00:00Z', NOW)).toBe(false)
	})
})

describe('shouldContinuePolling', () => {
	it('stops at the timeout cap', () => {
		expect(shouldContinuePolling(0)).toBe(true)
		expect(shouldContinuePolling(119_999)).toBe(true)
		expect(shouldContinuePolling(120_000)).toBe(false)
		expect(shouldContinuePolling(5_000, 3_000)).toBe(false)
	})
})
