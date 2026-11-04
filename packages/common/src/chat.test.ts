import { describe, expect, it } from 'vitest'
import { isValidReactionEmoji } from './chat.ts'

describe('isValidReactionEmoji', () => {
	it('accepts a single pictograph', () => {
		expect(isValidReactionEmoji('👍')).toBe(true)
	})

	it('accepts ZWJ family emoji', () => {
		expect(isValidReactionEmoji('👨‍👩‍👧‍👦')).toBe(true)
	})

	it('accepts every quick reaction, including the heart with its emoji selector', () => {
		for (const emoji of ['👍', '❤️', '😂', '🎉', '👀', '🙏']) {
			expect(isValidReactionEmoji(emoji)).toBe(true)
		}
		// U+2764 U+FE0F, the form a keyboard or picker produces.
		expect(isValidReactionEmoji('\u2764\uFE0F')).toBe(true)
		expect(isValidReactionEmoji('\u2764')).toBe(true)
	})

	it('accepts a skin tone and a selector inside a ZWJ sequence', () => {
		expect(isValidReactionEmoji('👍🏽')).toBe(true)
		expect(isValidReactionEmoji('🏳️‍🌈')).toBe(true)
		expect(isValidReactionEmoji('👁️‍🗨️')).toBe(true)
	})

	it('accepts flags and keycaps', () => {
		expect(isValidReactionEmoji('🇸🇦')).toBe(true)
		expect(isValidReactionEmoji('1️⃣')).toBe(true)
	})

	it('rejects a skin tone on something that does not take one, and a lone tone', () => {
		expect(isValidReactionEmoji('\u2764\u{1F3FD}')).toBe(false)
		expect(isValidReactionEmoji('\u2764\uFE0F\u{1F3FD}')).toBe(false)
		expect(isValidReactionEmoji('\u{1F3FD}')).toBe(false)
		expect(isValidReactionEmoji('\u{1F44D}\u{1F3FD}')).toBe(true)
	})

	it('still rejects free text, spaces and a lone selector', () => {
		expect(isValidReactionEmoji('ok')).toBe(false)
		expect(isValidReactionEmoji('👍 👍')).toBe(false)
		expect(isValidReactionEmoji('\uFE0F')).toBe(false)
		expect(isValidReactionEmoji('')).toBe(false)
	})

	it('rejects text with a trailing pictograph', () => {
		expect(isValidReactionEmoji('not-emoji👍')).toBe(false)
	})
})
