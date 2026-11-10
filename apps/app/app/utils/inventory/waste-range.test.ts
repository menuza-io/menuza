import { describe, expect, it } from 'vitest'
import {
	resolveWasteRange,
	shareOfPurchases,
	toIsoDate,
	wasteLimit,
	withWasteRange,
} from './waste-range.ts'

const NOW = new Date(2026, 10, 8, 15, 30) // 8 November 2026, local

describe('waste range', () => {
	it('defaults to the last seven days', () => {
		expect(resolveWasteRange(new URLSearchParams(), NOW)).toEqual({
			range: '7d',
			from: '2026-11-02',
			to: '2026-11-08',
			invalidCustom: false,
		})
	})

	it('resolves the presets', () => {
		expect(
			resolveWasteRange(new URLSearchParams('range=30d'), NOW),
		).toMatchObject({ from: '2026-10-10', to: '2026-11-08' })
		expect(
			resolveWasteRange(new URLSearchParams('range=month'), NOW),
		).toMatchObject({ from: '2026-11-01', to: '2026-11-08' })
	})

	it('uses a custom range when it is valid', () => {
		expect(
			resolveWasteRange(
				new URLSearchParams('range=custom&from=2026-10-01&to=2026-10-15'),
				NOW,
			),
		).toEqual({
			range: 'custom',
			from: '2026-10-01',
			to: '2026-10-15',
			invalidCustom: false,
		})
	})

	it('falls back, and says so, for unusable custom dates', () => {
		for (const query of [
			'range=custom',
			'range=custom&from=2026-10-15&to=2026-10-01',
			'range=custom&from=2026-02-31&to=2026-03-01',
			'range=custom&from=2020-01-01&to=2026-11-08',
		]) {
			expect(resolveWasteRange(new URLSearchParams(query), NOW)).toMatchObject({
				range: '7d',
				invalidCustom: true,
			})
		}
	})

	it('ignores an unknown range', () => {
		expect(
			resolveWasteRange(new URLSearchParams('range=forever'), NOW).range,
		).toBe('7d')
	})

	it('writes the URL, keeping the location and reason', () => {
		const current = new URLSearchParams(
			'locationId=l2&reason=expired&limit=100',
		)
		expect(withWasteRange(current, '30d').toString()).toBe(
			'locationId=l2&reason=expired&range=30d',
		)
		expect(
			withWasteRange(current, 'custom', {
				from: '2026-10-01',
				to: '2026-10-05',
			}).toString(),
		).toBe(
			'locationId=l2&reason=expired&range=custom&from=2026-10-01&to=2026-10-05',
		)
		expect(
			withWasteRange(new URLSearchParams('range=30d'), '7d').toString(),
		).toBe('')
	})

	it('formats a local date', () => {
		expect(toIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
	})

	it('limits the log', () => {
		expect(wasteLimit(new URLSearchParams())).toBe(25)
		expect(wasteLimit(new URLSearchParams('limit=75'))).toBe(75)
		expect(wasteLimit(new URLSearchParams('limit=9999'))).toBe(200)
	})

	it('works out the share of purchases only when it can', () => {
		expect(shareOfPurchases(2_500, 100_000)).toBe(2.5)
		expect(shareOfPurchases(15_000, 100_000)).toBe(15)
		expect(shareOfPurchases(2_500, 0)).toBeNull()
		expect(shareOfPurchases(undefined, 100_000)).toBeNull()
		expect(shareOfPurchases(2_500, undefined)).toBeNull()
	})
})
