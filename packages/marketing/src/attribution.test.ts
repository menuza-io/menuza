import { describe, expect, it } from 'vitest'
import {
	attributionFigures,
	formatAttributionMoney,
	readAttributionView,
} from './attribution.ts'

describe('attribution figures (#115)', () => {
	const view = {
		clicked: { orders: 3, revenueMinor: 4500 },
		reached: { orders: 8, revenueMinor: 12000 },
	}

	it('shows the clicked or the reached figures', () => {
		expect(attributionFigures(view, 'clicked')).toEqual(view.clicked)
		expect(attributionFigures(view, 'reached')).toEqual(view.reached)
	})

	it('reached is never below clicked', () => {
		const odd = {
			clicked: { orders: 5, revenueMinor: 9000 },
			reached: { orders: 2, revenueMinor: 1000 },
		}
		expect(attributionFigures(odd, 'reached')).toEqual(odd.clicked)
	})

	it('reads a malformed answer as none', () => {
		expect(readAttributionView(null)).toEqual({
			currency: 'usd',
			clicked: { orders: 0, revenueMinor: 0 },
			reached: { orders: 0, revenueMinor: 0 },
		})
		expect(
			readAttributionView({
				currency: 'sar',
				clicked: { orders: 'x' },
				reached: { orders: -2, revenueMinor: 7.9 },
			}),
		).toEqual({
			currency: 'sar',
			clicked: { orders: 0, revenueMinor: 0 },
			reached: { orders: 0, revenueMinor: 7 },
		})
	})

	it('formats money in the order currency', () => {
		expect(formatAttributionMoney(12050, 'usd', 'en')).toBe('$120.50')
		expect(formatAttributionMoney(100, 'nope', 'en')).toBe('1.00')
	})
})
