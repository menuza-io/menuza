import { describe, expect, it } from 'vitest'
import {
	applyPinFailure,
	applyRefusedAttempt,
	applyPinSuccess,
	checkPin,
	decayedPinFailures,
	EMPTY_PIN_BACKOFF_STATE,
	generatePin,
	normalizePinDigits,
	PIN_BACKOFF,
	pinBackoffDelaySeconds,
	pinBackoffRemainingSeconds,
	pinLookupMessage,
	secureRandomInt,
	shouldAlertManagerOnPinFailures,
	type PinBackoffState,
} from './pin.ts'

describe('checkPin', () => {
	it('accepts a normal PIN', () => {
		expect(checkPin('4827')).toBeNull()
		expect(checkPin('482715', 6)).toBeNull()
	})
	it('rejects non-digits and wrong lengths', () => {
		expect(checkPin('48a7')).toBe('not_digits')
		expect(checkPin('')).toBe('not_digits')
		expect(checkPin('482')).toBe('wrong_length')
		expect(checkPin('48271')).toBe('wrong_length')
		expect(checkPin('4827', 6)).toBe('wrong_length')
	})
	it('rejects repeated and sequential PINs in both directions', () => {
		expect(checkPin('1111')).toBe('all_same_digit')
		expect(checkPin('1234')).toBe('sequential')
		expect(checkPin('9876')).toBe('sequential')
		expect(checkPin('123456', 6)).toBe('sequential')
		expect(checkPin('1235')).toBeNull()
	})
	it('accepts Arabic-Indic digits typed on an Arabic keypad', () => {
		expect(normalizePinDigits('٤٨٢٧')).toBe('4827')
		expect(normalizePinDigits('۴۸۲۷')).toBe('4827')
		expect(checkPin('٤٨٢٧')).toBeNull()
	})
	it('does not treat whitespace or signs as digits', () => {
		expect(checkPin(' 4827')).toBe('not_digits')
		expect(checkPin('-482')).toBe('not_digits')
		expect(checkPin('4827\n')).toBe('not_digits')
	})
})

describe('generatePin', () => {
	it('always generates an acceptable PIN of the requested length', () => {
		for (const length of [4, 5, 6]) {
			for (let i = 0; i < 300; i++) {
				const pin = generatePin(length)
				expect(pin).toHaveLength(length)
				expect(checkPin(pin, length)).toBeNull()
			}
		}
	})
	it('skips weak candidates from the random source', () => {
		const sequence = [1, 1, 1, 1, 1, 2, 3, 4, 4, 8, 2, 7]
		let i = 0
		const pin = generatePin(4, () => sequence[i++ % sequence.length]!)
		expect(pin).toBe('4827')
	})
	it('refuses lengths outside 4 to 6', () => {
		expect(() => generatePin(3)).toThrow()
		expect(() => generatePin(7)).toThrow()
		expect(() => generatePin(4.5)).toThrow()
	})
	it('gives up instead of looping forever on a broken random source', () => {
		expect(() => generatePin(4, () => 0)).toThrow('acceptable PIN')
	})
})

describe('secureRandomInt', () => {
	it('stays within range and covers every digit', () => {
		const seen = new Set<number>()
		for (let i = 0; i < 2000; i++) {
			const n = secureRandomInt(10)
			expect(n).toBeGreaterThanOrEqual(0)
			expect(n).toBeLessThan(10)
			seen.add(n)
		}
		expect(seen.size).toBe(10)
	})
	it('rejects invalid bounds', () => {
		expect(() => secureRandomInt(0)).toThrow(RangeError)
		expect(() => secureRandomInt(-1)).toThrow(RangeError)
		expect(() => secureRandomInt(1.5)).toThrow(RangeError)
	})
})

describe('pinLookupMessage', () => {
	it('is scoped to org and scope and contains no staff id', () => {
		expect(pinLookupMessage('org1', 'locA', '4827')).toBe(
			'staff-pin:org1:locA:4827',
		)
		expect(pinLookupMessage('org1', 'locA', '4827')).not.toBe(
			pinLookupMessage('org1', 'locB', '4827'),
		)
		expect(pinLookupMessage('org1', 'locA', '٤٨٢٧')).toBe(
			'staff-pin:org1:locA:4827',
		)
	})
	it('refuses ids that could smuggle a different scope', () => {
		expect(() => pinLookupMessage('org1:x', 'locA', '4827')).toThrow()
		expect(() => pinLookupMessage('org1', 'loc:A', '4827')).toThrow()
		expect(() => pinLookupMessage('', 'locA', '4827')).toThrow()
	})
})

describe('pinBackoffDelaySeconds', () => {
	it('adds no delay for a few typos', () => {
		for (const n of [0, 1, 2, 3, 4]) expect(pinBackoffDelaySeconds(n)).toBe(0)
	})
	it('starts at 30 seconds, doubles, and caps at 5 minutes', () => {
		expect(pinBackoffDelaySeconds(5)).toBe(30)
		expect(pinBackoffDelaySeconds(6)).toBe(60)
		expect(pinBackoffDelaySeconds(7)).toBe(120)
		expect(pinBackoffDelaySeconds(8)).toBe(240)
		expect(pinBackoffDelaySeconds(9)).toBe(300)
		expect(pinBackoffDelaySeconds(10_000)).toBe(PIN_BACKOFF.maxDelaySeconds)
	})
	it('treats nonsense counters as no delay or the cap, never NaN', () => {
		expect(pinBackoffDelaySeconds(Number.NaN)).toBe(0)
		expect(pinBackoffDelaySeconds(-5)).toBe(0)
		expect(pinBackoffDelaySeconds(Infinity)).toBe(PIN_BACKOFF.maxDelaySeconds)
	})
	it('alerts a manager at the hourly ceiling', () => {
		expect(shouldAlertManagerOnPinFailures(29)).toBe(false)
		expect(shouldAlertManagerOnPinFailures(30)).toBe(true)
	})
})

describe('persisted PIN backoff', () => {
	const T0 = 1_000_000_000_000

	it('is silent for the first typos, then imposes a doubling delay', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		const delays: number[] = []
		for (let i = 0; i < 10; i++) {
			const out = applyPinFailure(state, T0 + i)
			delays.push(out.delaySeconds)
			state = out.state
		}
		expect(delays).toEqual([0, 0, 0, 0, 30, 60, 120, 240, 300, 300])
		expect(pinBackoffRemainingSeconds(state, T0 + 10)).toBe(300)
		expect(pinBackoffRemainingSeconds(state, T0 + 301_000)).toBe(0)
	})

	it('forgives one failure per quiet window instead of resetting', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		for (let i = 0; i < 10; i++) state = applyPinFailure(state, T0).state
		expect(decayedPinFailures(state, T0)).toBe(10)
		expect(decayedPinFailures(state, T0 + 5 * 60_000)).toBe(9)
		expect(decayedPinFailures(state, T0 + 50 * 60_000)).toBe(0)
		// An attacker who waits out the delay still faces the maximum delay.
		const next = applyPinFailure(state, T0 + 5 * 60_000 + 1)
		expect(next.delaySeconds).toBe(300)
	})

	it('a correct PIN forgives only one failure, so it cannot be used to reset the counter', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		for (let i = 0; i < 8; i++) state = applyPinFailure(state, T0).state
		const afterSuccess = applyPinSuccess(state, T0 + 400_000)
		expect(afterSuccess.failures).toBe(6)
		const fail = applyPinFailure(afterSuccess, T0 + 400_001)
		expect(fail.delaySeconds).toBeGreaterThan(0)
	})

	it('raises the hourly alert once per hour window', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		let alerts = 0
		for (let i = 0; i < 60; i++) {
			const out = applyPinFailure(state, T0 + i * 1000)
			if (out.alertManager) alerts++
			state = out.state
		}
		expect(alerts).toBe(1)
		const later = applyPinFailure(state, T0 + 2 * 60 * 60_000)
		expect(later.state.hourFailures).toBe(1)
	})

	it('counts refused attempts toward the hourly alert without extending the delay', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		for (let i = 0; i < 5; i++) state = applyPinFailure(state, T0).state
		const blockedUntil = state.blockedUntil
		let alerts = 0
		for (let i = 0; i < 40; i++) {
			const out = applyRefusedAttempt(state, T0 + 1000 + i)
			if (out.alertManager) alerts++
			state = out.state
		}
		expect(alerts).toBe(1)
		expect(state.blockedUntil).toBe(blockedUntil)
		expect(state.failures).toBe(5)
	})

	it('restarts the decay clock on success so a forgiven failure is not decayed twice', () => {
		let state: PinBackoffState = EMPTY_PIN_BACKOFF_STATE
		for (let i = 0; i < 8; i++) state = applyPinFailure(state, T0).state
		const later = T0 + 10 * 60_000
		const afterSuccess = applyPinSuccess(state, later)
		expect(afterSuccess.failures).toBe(5)
		expect(afterSuccess.lastFailureAt).toBe(later)
		expect(decayedPinFailures(afterSuccess, later)).toBe(5)
		// The next failure is the sixth, so a delay applies at once.
		expect(applyPinFailure(afterSuccess, later).delaySeconds).toBe(60)
	})

	it('never goes negative or throws on corrupt counters', () => {
		const corrupt: PinBackoffState = {
			...EMPTY_PIN_BACKOFF_STATE,
			failures: -5,
			lastFailureAt: T0,
		}
		expect(decayedPinFailures(corrupt, T0)).toBe(0)
		expect(applyPinSuccess(corrupt, T0).failures).toBe(0)
		const huge = {
			...EMPTY_PIN_BACKOFF_STATE,
			failures: 1e9,
			lastFailureAt: T0,
		}
		expect(applyPinFailure(huge, T0).delaySeconds).toBe(300)
	})
})
