import { describe, expect, it } from 'vitest'
import {
	MAX_CALENDAR_EXPANSIONS,
	calendarSummary,
	quoteWaitlistMin,
	searchAvailability,
	searchExperienceAvailability,
	suggestAlternatives,
} from './engine.ts'

describe('engine barrel exports', () => {
	it('re-exports searchAvailability, suggestAlternatives, calendarSummary, searchExperienceAvailability, and quoteWaitlistMin', () => {
		expect(MAX_CALENDAR_EXPANSIONS).toBe(5_000)
		expect(typeof searchAvailability).toBe('function')
		expect(typeof suggestAlternatives).toBe('function')
		expect(typeof calendarSummary).toBe('function')
		expect(typeof searchExperienceAvailability).toBe('function')
		expect(typeof quoteWaitlistMin).toBe('function')
	})
})
