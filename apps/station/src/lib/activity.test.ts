import { describe, expect, it } from 'vitest'
import { IDLE_LOCK_CHOICES, idleMs, shouldLock, touch } from './activity.ts'

const base = {
	signInRequired: true,
	signedIn: true,
	idleLockSeconds: 120,
	idleMs: 0,
}

describe('shouldLock', () => {
	it('locks once the idle time reaches the setting, not before', () => {
		expect(shouldLock({ ...base, idleMs: 119_999 })).toBe(false)
		expect(shouldLock({ ...base, idleMs: 120_000 })).toBe(true)
		expect(shouldLock({ ...base, idleMs: 9_999_999 })).toBe(true)
	})

	it('never locks a till that does not require sign-in, or that nobody is signed in to', () => {
		expect(shouldLock({ ...base, signInRequired: false, idleMs: 1e9 })).toBe(
			false,
		)
		expect(shouldLock({ ...base, signedIn: false, idleMs: 1e9 })).toBe(false)
	})

	it('"never" means never', () => {
		expect(shouldLock({ ...base, idleLockSeconds: 0, idleMs: 1e9 })).toBe(false)
	})

	it('offers sensible choices, ending with never', () => {
		expect(IDLE_LOCK_CHOICES.map((c) => c.seconds)).toEqual([
			30, 60, 120, 300, 600, 0,
		])
		expect(IDLE_LOCK_CHOICES.at(-1)!.label).toBe('Never')
	})
})

describe('activity', () => {
	it('measures time since the last touch', () => {
		touch(1_000)
		expect(idleMs(4_500)).toBe(3_500)
		touch(10_000)
		expect(idleMs(10_001)).toBe(1)
	})
})
