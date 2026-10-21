import { describe, expect, it } from 'vitest'
import { holdRemainingMs, holdTargetMs } from './hold.ts'

describe('hold countdown', () => {
	const hold = {
		now: '2030-01-01T12:00:00.000Z',
		expiresAt: '2030-01-01T12:07:00.000Z',
	}

	it('counts seven minutes when the device clock is right', () => {
		const device = Date.parse(hold.now)
		const target = holdTargetMs(hold, device)!
		expect(holdRemainingMs(target, device)).toBe(7 * 60_000)
		expect(holdRemainingMs(target, device + 60_000)).toBe(6 * 60_000)
	})

	it('ignores a device clock that is five minutes fast', () => {
		const device = Date.parse(hold.now) + 5 * 60_000
		const target = holdTargetMs(hold, device)!
		expect(holdRemainingMs(target, device)).toBe(7 * 60_000)
	})

	it('ignores a device clock that is slow and never goes negative', () => {
		const device = Date.parse(hold.now) - 10 * 60_000
		const target = holdTargetMs(hold, device)!
		expect(holdRemainingMs(target, device)).toBe(7 * 60_000)
		expect(holdRemainingMs(target, device + 8 * 60_000)).toBe(0)
	})

	it('rejects unreadable timestamps', () => {
		expect(holdTargetMs({ now: 'x', expiresAt: hold.expiresAt })).toBeNull()
	})
})
