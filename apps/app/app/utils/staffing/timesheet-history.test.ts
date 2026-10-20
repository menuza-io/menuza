import { describe, expect, it } from 'vitest'
import { changedFields } from './timesheet-history.ts'

describe('edit history', () => {
	it('lists only the fields that changed', () => {
		const changes = changedFields({
			action: 'update',
			before: {
				clockInAt: 1,
				clockOutAt: 2,
				status: 'closed',
				paidMinutes: 10,
				breaks: [],
				managerNote: null,
				positionId: 'p1',
			},
			after: {
				clockInAt: 1,
				clockOutAt: 3,
				status: 'closed',
				paidMinutes: 20,
				breaks: [{ kind: 'meal', startAt: 5, endAt: 6 }],
				managerNote: 'late',
				positionId: 'p1',
			},
		})
		expect(changes.map((c) => c.field)).toEqual([
			'clockOutAt',
			'breaks',
			'managerNote',
		])
	})

	it('shows nothing for approvals, which the label already says', () => {
		expect(
			changedFields({
				action: 'approve',
				before: { status: 'closed' },
				after: { status: 'approved' },
			}),
		).toEqual([])
	})

	it('never shows money a reader without the pay grant was not sent', () => {
		const changes = changedFields({
			action: 'update',
			before: { clockOutAt: 1 },
			after: { clockOutAt: 2 },
		})
		expect(changes.some((c) => c.field.endsWith('Minor'))).toBe(false)
	})

	it('survives malformed snapshots', () => {
		expect(
			changedFields({
				action: 'update',
				before: null,
				after: { breaks: 'x', clockInAt: 'y' },
			}),
		).toEqual([])
	})
})
