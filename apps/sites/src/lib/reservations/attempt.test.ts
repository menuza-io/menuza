import { describe, expect, it } from 'vitest'
import { createAttemptKeys } from './attempt.ts'

describe('attempt keys', () => {
	it('reuses the key for an identical retry and replaces it when the request changes', () => {
		let n = 0
		const keys = createAttemptKeys(() => `key-${++n}`)
		expect(keys.keyFor('a')).toBe('key-1')
		expect(keys.keyFor('a')).toBe('key-1')
		expect(keys.keyFor('b')).toBe('key-2')
		expect(keys.keyFor('a')).toBe('key-3')
	})

	it('starts a new attempt after a success', () => {
		let n = 0
		const keys = createAttemptKeys(() => `key-${++n}`)
		keys.keyFor('a')
		keys.reset()
		expect(keys.keyFor('a')).toBe('key-2')
	})
})
