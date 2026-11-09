import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInventoryKillSwitchOn } from './inventory-switches.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('INVENTORY_ENABLED kill switch', () => {
	it('is off when unset, empty or true', () => {
		for (const value of [undefined, '', 'true', '1', 'yes', 'on']) {
			if (value === undefined) vi.stubEnv('INVENTORY_ENABLED', undefined)
			else vi.stubEnv('INVENTORY_ENABLED', value)
			expect(isInventoryKillSwitchOn(), String(value)).toBe(false)
		}
	})

	it('is on for false, 0, off, no and disabled in any case and spacing', () => {
		for (const value of [
			'false',
			'0',
			'off',
			'no',
			'disabled',
			' False ',
			'OFF',
		]) {
			vi.stubEnv('INVENTORY_ENABLED', value)
			expect(isInventoryKillSwitchOn(), value).toBe(true)
		}
	})
})
