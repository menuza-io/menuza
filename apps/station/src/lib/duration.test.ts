import { describe, expect, it } from 'vitest'
import { shortDuration } from './duration.ts'

describe('a short duration', () => {
	it('stays in minutes under an hour, then hours and minutes', () => {
		expect(shortDuration(12, 'en')).toBe('12 min')
		expect(shortDuration(213, 'en')).toBe('3 hr 33 min')
		expect(shortDuration(120, 'en')).toBe('2 hr')
		expect(shortDuration(-4, 'en')).toBe('0 min')
	})
	it('speaks the till’s language', () => {
		expect(shortDuration(213, 'ar')).not.toContain('hr')
	})
})
