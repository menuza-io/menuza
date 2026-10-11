import { describe, expect, it } from 'vitest'
import {
	laborCents,
	laborPercent,
	singleCurrencyTotal,
	staffRatesInputSchema,
} from './pay.ts'

describe('labor math', () => {
	it('costs paid minutes at an hourly rate, rounded to the cent', () => {
		expect(laborCents(90, 1500)).toBe(2250)
		expect(laborCents(7, 1333)).toBe(156)
		expect(laborCents(0, 1500)).toBe(0)
	})

	it('has no percent without sales', () => {
		expect(laborPercent(3000, 10_000)).toBe(30)
		expect(laborPercent(3000, 0)).toBeNull()
		expect(laborPercent(null, 10_000)).toBeNull()
	})

	it('refuses to add amounts across currencies', () => {
		expect(
			singleCurrencyTotal([
				{ cents: 100, currency: 'USD' },
				{ cents: 250, currency: 'USD' },
			]),
		).toEqual({ currency: 'USD', cents: 350, mixed: false })
		expect(
			singleCurrencyTotal([
				{ cents: 100, currency: 'USD' },
				{ cents: 250, currency: 'SAR' },
			]),
		).toEqual({ currency: null, cents: null, mixed: true })
		expect(singleCurrencyTotal([])).toEqual({
			currency: null,
			cents: 0,
			mixed: false,
		})
	})

	it('bounds rates', () => {
		const rate = (rateCents: number | null) =>
			staffRatesInputSchema.safeParse({
				rates: [{ locationId: 'l', positionId: 'p', rateCents }],
			}).success
		expect(rate(1800)).toBe(true)
		expect(rate(null)).toBe(true)
		expect(rate(-1)).toBe(false)
		expect(rate(12.5)).toBe(false)
		expect(rate(10_000_000)).toBe(false)
	})
})
