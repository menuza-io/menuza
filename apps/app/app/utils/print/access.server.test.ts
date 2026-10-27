import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPrintShippingPaused } from './access.server.ts'

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('isPrintShippingPaused', () => {
	it.each(['', ' ', 'true', 'TRUE', '1', 'on', 'yes', 'enabled'])(
		'keeps shipping on for %j',
		(value) => {
			vi.stubEnv('PRINT_SHIPPING_ENABLED', value)
			expect(isPrintShippingPaused()).toBe(false)
		},
	)

	// Any other value pauses, so a typo in the kill switch fails closed.
	it.each(['false', '0', 'off', 'disable', 'paused', 'flase'])(
		'pauses shipping for %j',
		(value) => {
			vi.stubEnv('PRINT_SHIPPING_ENABLED', value)
			expect(isPrintShippingPaused()).toBe(true)
		},
	)
})
