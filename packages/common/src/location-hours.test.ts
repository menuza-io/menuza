import { describe, expect, it } from 'vitest'

import {
	emptyWeeklyHours,
	validateLocationHoursBundle,
	validateWeeklyHoursNoOverlap,
} from './location-hours.ts'

describe('validateWeeklyHoursNoOverlap', () => {
	it('accepts non-overlapping shifts', () => {
		const weekly = emptyWeeklyHours()
		weekly[1] = [
			{ open: '09:00', close: '14:00' },
			{ open: '17:00', close: '21:00' },
		]
		expect(validateWeeklyHoursNoOverlap(weekly)).toBeNull()
	})

	it('rejects overlapping shifts', () => {
		const weekly = emptyWeeklyHours()
		weekly[2] = [
			{ open: '09:00', close: '15:00' },
			{ open: '14:00', close: '18:00' },
		]
		expect(validateWeeklyHoursNoOverlap(weekly)).toMatch(/overlap/)
	})
})

describe('validateLocationHoursBundle', () => {
	it('validates store and online calendars', () => {
		const error = validateLocationHoursBundle({
			store: emptyWeeklyHours(),
			online: {
				...emptyWeeklyHours(),
				3: [{ open: '22:00', close: '10:00' }],
			},
		})
		expect(error).toMatch(/Online hours/)
	})
})
