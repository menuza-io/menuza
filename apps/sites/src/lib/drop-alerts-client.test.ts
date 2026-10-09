import { describe, expect, it } from 'vitest'
import { isVisibleInState } from './drop-alerts-client'

describe('isVisibleInState', () => {
	it('matches any state in the space-separated list', () => {
		expect(isVisibleInState('phone code signed-in', 'code')).toBe(true)
		expect(isVisibleInState('phone code signed-in', 'done')).toBe(false)
		expect(isVisibleInState('done', 'done')).toBe(true)
	})

	it('treats a missing list as never visible', () => {
		expect(isVisibleInState(undefined, 'phone')).toBe(false)
	})
})
