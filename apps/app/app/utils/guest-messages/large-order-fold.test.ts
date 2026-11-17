import { describe, expect, it } from 'vitest'

import { foldLargeOrder } from './settings.ts'

const row = (over: Record<string, unknown> = {}) => ({
	id: 'loc-1',
	largeOrderThreshold: 100,
	largeOrderThresholdType: 'dollars',
	largeOrderExtraPrepTime: 15,
	onlineOrderingSettings: null as string | null,
	...over,
})

const settings = (largeOrder: unknown) =>
	JSON.stringify({
		buffers: { openingBufferMinutes: 0, closingBufferMinutes: 0 },
		pickup: 'follow_online',
		delivery: 'follow_online',
		catering: 'follow_online',
		syncOnlineWithStore: true,
		largeOrder,
	})

describe('foldLargeOrder (#355)', () => {
	it('keeps reading the single threshold of a location that was never re-saved', () => {
		expect(foldLargeOrder([row()])['loc-1']).toMatchObject({
			threshold: 100,
			thresholdType: 'amount',
			extraPrepMinutes: 15,
		})
		expect(
			foldLargeOrder([
				row({ largeOrderThreshold: 12, largeOrderThresholdType: 'items' }),
			])['loc-1'],
		).toMatchObject({ threshold: 12, thresholdType: 'items' })
	})

	it('builds a rule with both thresholds from the new settings', () => {
		const out = foldLargeOrder([
			row({
				onlineOrderingSettings: settings({
					itemThreshold: 12,
					amountMinor: 30_000,
					extraMinutes: 20,
				}),
			}),
		])
		expect(out['loc-1']).toMatchObject({
			itemThreshold: 12,
			amountThresholdMinor: 30_000,
			extraPrepMinutes: 20,
		})
	})

	it('lets the new settings win over the old columns', () => {
		const out = foldLargeOrder([
			row({
				onlineOrderingSettings: settings({
					itemThreshold: null,
					amountMinor: 50_000,
					extraMinutes: 10,
				}),
			}),
		])
		expect(out['loc-1']).toMatchObject({ amountThresholdMinor: 50_000 })
		expect(out['loc-1']?.itemThreshold).toBeUndefined()
	})

	it('treats saved settings with no threshold as the rule turned off, not as the old one', () => {
		const out = foldLargeOrder([
			row({
				onlineOrderingSettings: settings({
					itemThreshold: null,
					amountMinor: null,
					extraMinutes: 15,
				}),
			}),
		])
		expect(out['loc-1']).toBeUndefined()
	})

	it('falls back to the old columns when the settings cannot be read', () => {
		expect(
			foldLargeOrder([row({ onlineOrderingSettings: '{not json' })])['loc-1'],
		).toMatchObject({ thresholdType: 'amount' })
	})

	it('lists only locations that have a rule', () => {
		const out = foldLargeOrder([
			row(),
			row({ id: 'loc-2', largeOrderExtraPrepTime: 0 }),
		])
		expect(Object.keys(out)).toEqual(['loc-1'])
	})
})
