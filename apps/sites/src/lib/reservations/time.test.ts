import { describe, expect, it } from 'vitest'
import { addDaysIso, formatHhmm, parseHhmm, todayIn, zoneNote } from './time.ts'

describe('reservation time helpers', () => {
	it('formats and parses local minutes', () => {
		expect(formatHhmm(1140)).toBe('19:00')
		expect(formatHhmm(25 * 60 + 5)).toBe('01:05')
		expect(parseHhmm('19:30')).toBe(1170)
		expect(parseHhmm('24:00')).toBeNull()
		expect(parseHhmm('')).toBeNull()
	})

	it('adds days across month ends', () => {
		expect(addDaysIso('2030-01-31', 1)).toBe('2030-02-01')
		expect(addDaysIso('2030-03-01', -1)).toBe('2030-02-28')
	})

	it('reads today in the restaurant zone, not the device zone', () => {
		const instant = Date.parse('2030-06-01T22:30:00Z')
		expect(todayIn('Asia/Riyadh', instant)).toBe('2030-06-02')
		expect(todayIn('America/Los_Angeles', instant)).toBe('2030-06-01')
	})

	it('names the restaurant zone only when the visitor is elsewhere', () => {
		expect(zoneNote('Asia/Riyadh', 'Asia/Riyadh')).toBeNull()
		expect(zoneNote('Asia/Riyadh', 'America/Los_Angeles')).toContain(
			'Asia/Riyadh',
		)
		expect(zoneNote('Asia/Riyadh', null)).toBeNull()
	})
})
