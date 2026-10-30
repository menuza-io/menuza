import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLoyaltyKillSwitchOn } from './loyalty-switches.ts'

describe('isLoyaltyKillSwitchOn', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('unset means loyalty runs', () => {
		vi.stubEnv('LOYALTY_ENABLED', '')
		expect(isLoyaltyKillSwitchOn()).toBe(false)
	})

	it('truthy values mean loyalty runs', () => {
		for (const value of ['true', '1', 'on', 'yes']) {
			vi.stubEnv('LOYALTY_ENABLED', value)
			expect(isLoyaltyKillSwitchOn()).toBe(false)
		}
	})

	it('the disabled words switch loyalty off, any case, padded', () => {
		for (const value of [
			'false',
			'0',
			'off',
			'no',
			'disabled',
			' OFF ',
			'No',
		]) {
			vi.stubEnv('LOYALTY_ENABLED', value)
			expect(isLoyaltyKillSwitchOn()).toBe(true)
		}
	})

	it('a boolean false switches loyalty off', () => {
		vi.stubEnv('LOYALTY_ENABLED', false as unknown as string)
		expect(isLoyaltyKillSwitchOn()).toBe(true)
	})
})
