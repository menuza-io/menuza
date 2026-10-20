import { describe, expect, it } from 'vitest'
import { fanOutStaffTick } from './staff-tick-fanout.ts'
import { type TickResult } from './staff-tick-service.ts'

const empty = { sent: 0, skipped: 0, failed: 0, retry: 0 }

function ran(orgId: string, extra: Partial<TickResult> = {}): TickResult {
	return {
		orgId,
		status: 'ran',
		at: 0,
		tasks: [{ name: 'auto_clock_out', status: 'ok', queued: 2, closed: 1 }],
		staffEmail: { ...empty, sent: 1 },
		managerAlerts: { ...empty, sent: 2 },
		needsFollowUp: false,
		...extra,
	}
}

describe('fanning the tick out over organizations', () => {
	it('folds results into counts', async () => {
		const totals = await fanOutStaffTick({
			orgIds: ['a', 'b', 'c'],
			run: async (orgId) =>
				orgId === 'c'
					? { ...ran(orgId), status: 'skipped', reason: 'no_staff' }
					: ran(orgId),
		})
		expect(totals).toEqual({
			orgsRan: 2,
			orgsSkipped: 1,
			orgsDeferred: 0,
			queued: 4,
			closed: 2,
			staffEmailSent: 2,
			managerAlertsSent: 4,
			errors: 0,
		})
	})

	it('counts a failed organization without stopping the others', async () => {
		const totals = await fanOutStaffTick({
			orgIds: ['a', 'b'],
			run: async (orgId) => (orgId === 'a' ? null : ran(orgId)),
		})
		expect(totals.errors).toBe(1)
		expect(totals.orgsRan).toBe(1)
	})

	it('defers what it cannot reach before the deadline', async () => {
		let clock = 0
		const totals = await fanOutStaffTick({
			orgIds: ['a', 'b', 'c', 'd', 'e'],
			concurrency: 1,
			budgetMs: 25,
			now: () => clock,
			run: async (orgId) => {
				clock += 10
				return ran(orgId)
			},
		})
		expect(totals.orgsRan).toBe(3)
		expect(totals.orgsDeferred).toBe(2)
	})

	it('handles no organizations', async () => {
		const totals = await fanOutStaffTick({ orgIds: [], run: async () => null })
		expect(totals.orgsRan + totals.orgsSkipped + totals.errors).toBe(0)
	})
})
