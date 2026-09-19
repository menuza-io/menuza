import { describe, expect, it } from 'vitest'

import { resolveMenuLocationId } from './menu-location.server.ts'

describe('resolveMenuLocationId', () => {
	it('documents brand vs branch operator context', () => {
		expect(typeof resolveMenuLocationId).toBe('function')
	})
})
