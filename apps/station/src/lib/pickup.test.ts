import { describe, expect, it } from 'vitest'
import { parsePickupLocal, pickupLocalValue } from './pickup.ts'

describe('restaurant pickup time', () => {
	it('uses the restaurant zone, including fractional offsets, not the device zone', () => {
		expect(parsePickupLocal('2026-10-24T18:30', 'Asia/Riyadh')).toBe(
			Date.parse('2026-10-24T15:30:00Z'),
		)
		expect(parsePickupLocal('2026-10-24T18:30', 'Asia/Kathmandu')).toBe(
			Date.parse('2026-10-24T12:45:00Z'),
		)
		expect(
			pickupLocalValue(Date.parse('2026-10-24T15:30:00Z'), 'Asia/Riyadh'),
		).toBe('2026-10-24T18:30')
	})
	it('rejects invalid dates and missing, nonexistent or ambiguous DST times', () => {
		for (const value of ['', '2026-02-30T18:00', '2026-10-24T25:30'])
			expect(parsePickupLocal(value, 'UTC')).toBeNull()
		expect(parsePickupLocal('2026-03-08T02:30', 'America/New_York')).toBeNull()
		expect(parsePickupLocal('2026-11-01T01:30', 'America/New_York')).toBeNull()
		expect(parsePickupLocal('2026-03-08T03:30', 'America/New_York')).toBe(
			Date.parse('2026-03-08T07:30:00Z'),
		)
	})
})
