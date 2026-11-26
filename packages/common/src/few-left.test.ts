import { describe, expect, it } from 'vitest'

import {
	FEW_LEFT_COUNT_MAX_AGE_MS,
	onlineFewLeftLabel,
	portionsLeft,
	stationFewLeftLabel,
} from './few-left.ts'

const now = 1_700_000_000_000

describe('few left (#473)', () => {
	it('shows 3 left on the till when three portions remain', () => {
		const portions = portionsLeft({
			lines: [{ itemId: 'flour', quantity: 100 }],
			onHand: new Map([['flour', 300]]),
			countedAt: new Map([['flour', now - 1000]]),
			now,
		})
		expect(portions).toBe(3)
		expect(stationFewLeftLabel(portions)).toBe('3 left')
	})

	it('shows nothing when an ingredient was not counted in 7 days', () => {
		const portions = portionsLeft({
			lines: [{ itemId: 'flour', quantity: 100 }],
			onHand: new Map([['flour', 300]]),
			countedAt: new Map([['flour', now - FEW_LEFT_COUNT_MAX_AGE_MS - 1]]),
			now,
		})
		expect(portions).toBeNull()
		expect(stationFewLeftLabel(portions)).toBeNull()
		expect(stationFewLeftLabel(null)).toBeNull()
	})

	it('the online badge never includes the number and stays off by default', () => {
		expect(onlineFewLeftLabel(3, { enabled: false })).toBeNull()
		expect(onlineFewLeftLabel(3, { enabled: true })).toBe('Only a few left')
		expect(onlineFewLeftLabel(3, { enabled: true })).not.toMatch(/\d/)
		expect(onlineFewLeftLabel(9, { enabled: true })).toBeNull()
	})
})
