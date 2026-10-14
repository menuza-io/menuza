import { describe, expect, it } from 'vitest'
import {
	DEFAULT_TIMEZONE,
	getTimezoneOptions,
	TIMEZONE_OPTIONS,
} from './timezone-options.ts'

describe('TIMEZONE_OPTIONS', () => {
	it('offers well beyond the original ten zones', () => {
		expect(TIMEZONE_OPTIONS.length).toBeGreaterThan(10)
	})

	it('includes the zones the common markets need', () => {
		const values = TIMEZONE_OPTIONS.map((option) => option.value)
		for (const zone of [
			'America/New_York',
			'America/Chicago',
			'America/Denver',
			'America/Los_Angeles',
			'America/Toronto',
			'America/Vancouver',
			'Europe/London',
			'Europe/Paris',
			'Asia/Riyadh',
			'Asia/Dubai',
		]) {
			expect(values).toContain(zone)
		}
	})

	it('contains only valid, unique IANA zones with labels', () => {
		const seen = new Set<string>()
		for (const option of TIMEZONE_OPTIONS) {
			expect(seen.has(option.value)).toBe(false)
			seen.add(option.value)
			expect(option.label.trim()).not.toBe('')
			expect(
				() => new Intl.DateTimeFormat('en-US', { timeZone: option.value }),
			).not.toThrow()
		}
	})

	it('keeps the default selectable', () => {
		expect(TIMEZONE_OPTIONS.map((option) => option.value)).toContain(
			DEFAULT_TIMEZONE,
		)
	})
})

describe('getTimezoneOptions', () => {
	it('returns the curated list when the current zone is listed or empty', () => {
		expect(getTimezoneOptions('Asia/Riyadh')).toBe(TIMEZONE_OPTIONS)
		expect(getTimezoneOptions(undefined)).toBe(TIMEZONE_OPTIONS)
		expect(getTimezoneOptions(null)).toBe(TIMEZONE_OPTIONS)
	})

	it('keeps an unlisted saved zone selectable', () => {
		const options = getTimezoneOptions('America/Argentina/Buenos_Aires')
		expect(options[0]).toEqual({
			value: 'America/Argentina/Buenos_Aires',
			label: 'America/Argentina/Buenos Aires',
		})
		expect(options).toHaveLength(TIMEZONE_OPTIONS.length + 1)
	})
})
