import { describe, expect, it } from 'vitest'
import { fanOutReservationsTick } from './rsv-tick-fanout.ts'
import { type ReservationsTickResult } from './rsv-tick-service.ts'

const noMessages = {
	sent: 0,
	failed: 0,
	retried: 0,
	suppressed: 0,
	dropped: 0,
	cancelled: 0,
	held: 0,
}
const noOutbox = { groups: 0, delivered: 0, retried: 0, failed: 0 }

function ran(
	orgId: string,
	extra: Partial<ReservationsTickResult> = {},
): ReservationsTickResult {
	return {
		orgId,
		status: 'ran',
		at: 0,
		tasks: [
			{ name: 'expire_holds', status: 'ok', count: 2 },
			{ name: 'expire_requests', status: 'ok', count: 1 },
			{ name: 'auto_no_show', status: 'ok', count: 3 },
			{ name: 'purge', status: 'ok', count: 40 },
		],
		messages: { ...noMessages, sent: 4 },
		outbox: { ...noOutbox, delivered: 5 },
		needsFollowUp: false,
		nextDueAt: null,
		...extra,
	}
}

describe('fanning the reservations tick out over organizations', () => {
	it('folds results into counts', async () => {
		const totals = await fanOutReservationsTick({
			orgIds: ['a', 'b', 'c'],
			run: async (orgId) =>
				orgId === 'c'
					? {
							...ran(orgId),
							status: 'skipped',
							reason: 'no_reservations',
							tasks: [],
						}
					: ran(orgId),
		})
		expect(totals).toEqual({
			orgsRan: 2,
			orgsSkipped: 1,
			orgsDeferred: 0,
			holdsExpired: 4,
			requestsExpired: 2,
			noShowsMarked: 6,
			messagesSent: 8,
			alertsDelivered: 10,
			errors: 0,
		})
	})

	it('counts a failed organization without stopping the others', async () => {
		const totals = await fanOutReservationsTick({
			orgIds: ['a', 'b', 'c'],
			run: async (orgId) => (orgId === 'a' ? null : ran(orgId)),
		})
		expect(totals.errors).toBe(1)
		expect(totals.orgsRan).toBe(2)
	})

	it('counts failed tasks inside a ran organization as errors', async () => {
		const totals = await fanOutReservationsTick({
			orgIds: ['a'],
			run: async (orgId) =>
				ran(orgId, {
					tasks: [
						{
							name: 'deliver_outbox',
							status: 'error',
							count: 0,
							reason: 'task_failed',
						},
						{ name: 'purge', status: 'ok', count: 1 },
					],
				}),
		})
		expect(totals).toMatchObject({ orgsRan: 1, errors: 1 })
	})

	it('defers what it cannot reach before the deadline', async () => {
		let clock = 0
		const totals = await fanOutReservationsTick({
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

	it('runs every organization exactly once', async () => {
		const seen: string[] = []
		await fanOutReservationsTick({
			orgIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
			run: async (orgId) => {
				seen.push(orgId)
				return ran(orgId)
			},
		})
		expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
	})

	it('never runs more organizations at once than the concurrency allows', async () => {
		let active = 0
		let peak = 0
		await fanOutReservationsTick({
			orgIds: Array.from({ length: 12 }, (_, i) => `org_${i}`),
			concurrency: 3,
			run: async (orgId) => {
				active++
				peak = Math.max(peak, active)
				await new Promise((resolve) => setTimeout(resolve, 2))
				active--
				return ran(orgId)
			},
		})
		expect(peak).toBeLessThanOrEqual(3)
		expect(peak).toBeGreaterThan(1)
	})

	it('defaults to four at a time', async () => {
		let active = 0
		let peak = 0
		await fanOutReservationsTick({
			orgIds: Array.from({ length: 16 }, (_, i) => `org_${i}`),
			run: async (orgId) => {
				active++
				peak = Math.max(peak, active)
				await new Promise((resolve) => setTimeout(resolve, 2))
				active--
				return ran(orgId)
			},
		})
		expect(peak).toBeLessThanOrEqual(4)
	})

	it('handles no organizations', async () => {
		const totals = await fanOutReservationsTick({
			orgIds: [],
			run: async () => null,
		})
		expect(totals.orgsRan + totals.orgsSkipped + totals.errors).toBe(0)
		expect(totals.orgsDeferred).toBe(0)
	})

	it('answers counts only: no organization id, guest or reservation', async () => {
		const totals = await fanOutReservationsTick({
			orgIds: ['org_secret_id'],
			run: async (orgId) => ran(orgId),
		})
		expect(Object.keys(totals).sort()).toEqual([
			'alertsDelivered',
			'errors',
			'holdsExpired',
			'messagesSent',
			'noShowsMarked',
			'orgsDeferred',
			'orgsRan',
			'orgsSkipped',
			'requestsExpired',
		])
		expect(JSON.stringify(totals)).not.toContain('org_secret_id')
	})
})
