import { describe, expect, it } from 'vitest'
import { daysOverdue } from './past-due.ts'

describe('daysOverdue (#237)', () => {
	const now = new Date('2026-11-10T12:00:00Z')

	it('counts whole days from the first past-due event', () => {
		expect(daysOverdue('past_due', new Date('2026-11-03T12:00:00Z'), now)).toBe(
			7,
		)
		expect(daysOverdue('past_due', new Date('2026-11-10T01:00:00Z'), now)).toBe(
			0,
		)
	})

	it('is null unless the subscription is past due and the start is known', () => {
		expect(
			daysOverdue('active', new Date('2026-11-03T12:00:00Z'), now),
		).toBeNull()
		expect(daysOverdue('past_due', null, now)).toBeNull()
		expect(daysOverdue(null, null, now)).toBeNull()
	})
})
