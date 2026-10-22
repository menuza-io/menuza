import { describe, expect, it } from 'vitest'
import {
	EMPTY_GUARD,
	afterFailure,
	afterSuccess,
	waitSeconds,
	type PinGuard,
} from './pin-guard.ts'

const fail = (g: PinGuard, now: number) => afterFailure(g, now)

describe('offline attempt guard', () => {
	it('allows four typos, then starts an escalating wait', () => {
		let g = EMPTY_GUARD
		for (let i = 0; i < 4; i++) {
			const r = fail(g, 1000 + i)
			expect(r.delaySeconds).toBe(0)
			g = r.guard
		}
		const fifth = fail(g, 2000)
		expect(fifth.delaySeconds).toBe(30)
		expect(waitSeconds(fifth.guard, 2000)).toBe(30)
		const sixth = fail(fifth.guard, 2000)
		expect(sixth.delaySeconds).toBe(60)
		expect(fail(sixth.guard, 2000).delaySeconds).toBe(120)
	})

	it('never waits longer than five minutes', () => {
		let g = EMPTY_GUARD
		let last = 0
		for (let i = 0; i < 30; i++) {
			const r = fail(g, 5000)
			g = r.guard
			last = r.delaySeconds
		}
		expect(last).toBe(300)
	})

	it('counts the wait down, and a wait that is over is not a wait', () => {
		const g = fail(
			{ failures: 4, lastFailureAt: 0, blockedUntil: null },
			10_000,
		).guard
		expect(waitSeconds(g, 10_000)).toBe(30)
		expect(waitSeconds(g, 25_000)).toBe(15)
		expect(waitSeconds(g, 40_001)).toBe(0)
		expect(waitSeconds(EMPTY_GUARD, 1)).toBe(0)
	})

	it('forgets mistakes after five quiet minutes, one per period', () => {
		const g: PinGuard = { failures: 4, lastFailureAt: 0, blockedUntil: null }
		// 10 quiet minutes forgive two of the four: the next failure is the third, still free.
		expect(fail(g, 10 * 60 * 1000).delaySeconds).toBe(0)
		// Immediately, it is the fifth.
		expect(fail(g, 1000).delaySeconds).toBe(30)
	})

	it('a correct PIN forgives one mistake and never clears them all', () => {
		const g: PinGuard = { failures: 4, lastFailureAt: 1000, blockedUntil: null }
		const after = afterSuccess(g, 2000)
		expect(after.failures).toBe(3)
		expect(afterSuccess(after, 3000).failures).toBe(2)
		expect(
			afterSuccess({ failures: 1, lastFailureAt: 1, blockedUntil: null }, 2),
		).toEqual(EMPTY_GUARD)
	})

	it('a correct PIN does not shorten a wait that is running', () => {
		const g: PinGuard = {
			failures: 6,
			lastFailureAt: 1000,
			blockedUntil: 61_000,
		}
		expect(afterSuccess(g, 2000).blockedUntil).toBe(61_000)
		expect(afterSuccess(g, 70_000).blockedUntil).toBeNull()
	})
})
