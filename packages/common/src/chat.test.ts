import { describe, expect, it } from 'vitest'
import { isValidReactionEmoji } from './chat.ts'

describe('isValidReactionEmoji', () => {
	it('accepts a single pictograph', () => {
		expect(isValidReactionEmoji('👍')).toBe(true)
	})

	it('accepts ZWJ family emoji', () => {
		expect(isValidReactionEmoji('👨‍👩‍👧‍👦')).toBe(true)
	})

	it('rejects text with a trailing pictograph', () => {
		expect(isValidReactionEmoji('not-emoji👍')).toBe(false)
	})
})
