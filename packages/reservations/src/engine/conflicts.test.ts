import { describe, expect, it } from 'vitest'
import { detectConflicts } from './conflicts.ts'

describe('detectConflicts structured conflict reporting', () => {
	const startAt = 1_700_000_000_000
	const endAt = startAt + 90 * 60_000

	it('reports table_overlap, blocked_table, archived_table, shrunk_capacity, unassigned, pacing_exceeded, and outside_service_hours', () => {
		const conflicts = detectConflicts({
			tables: [
				{
					id: 't1',
					areaId: 'a1',
					label: 'T1',
					minSeats: 2,
					maxSeats: 2,
					active: true,
				},
				{
					id: 't_archived',
					areaId: 'a1',
					label: 'TArch',
					minSeats: 2,
					maxSeats: 4,
					active: false,
				},
			],
			combinations: [],
			bookings: [
				{
					id: 'b_overlap_1',
					status: 'booked',
					partySize: 2,
					localStartMin: 18 * 60,
					startAt,
					endAt,
					tableIds: ['t1'],
					serviceId: 'srv_dinner',
				},
				{
					id: 'b_overlap_2',
					status: 'confirmed',
					partySize: 2,
					localStartMin: 18 * 60,
					startAt: startAt + 15 * 60_000,
					endAt: endAt + 15 * 60_000,
					tableIds: ['t1'],
					serviceId: 'srv_dinner',
				},
				{
					id: 'b_archived',
					status: 'booked',
					partySize: 2,
					localStartMin: 18 * 60,
					startAt,
					endAt,
					tableIds: ['t_archived'],
					serviceId: 'srv_dinner',
				},
				{
					id: 'b_shrunk',
					status: 'booked',
					partySize: 4, // > t1.maxSeats (2)
					localStartMin: 20 * 60,
					startAt: startAt + 120 * 60_000,
					endAt: endAt + 120 * 60_000,
					tableIds: ['t1'],
					serviceId: 'srv_dinner',
				},
				{
					id: 'b_unassigned',
					status: 'booked',
					partySize: 2,
					localStartMin: 19 * 60,
					startAt: startAt + 60 * 60_000,
					endAt: endAt + 60 * 60_000,
					tableIds: [],
					serviceId: 'srv_dinner',
				},
				{
					id: 'b_outside_hours',
					status: 'booked',
					partySize: 2,
					localStartMin: 15 * 60, // before 17:00 dinner start
					startAt: startAt - 180 * 60_000,
					endAt: startAt - 90 * 60_000,
					tableIds: ['t1'],
					serviceId: 'srv_dinner',
				},
			],
			blocks: [
				{
					id: 'blk_1',
					tableIds: ['t1'],
					startAt,
					endAt,
				},
			],
			services: [
				{
					id: 'srv_dinner',
					name: 'Dinner',
					startMin: 17 * 60,
					endMin: 22 * 60,
					lastSeatingMin: 21 * 60,
				},
			],
			pacingRules: [
				{
					id: 'pace_1',
					serviceId: 'srv_dinner',
					areaId: null,
					windowStartMin: null,
					windowEndMin: null,
					maxCoversPerSlot: 2, // 18:00 has b_overlap_1 (2) + b_overlap_2 (2) + b_archived (2) = 6 > 2
					maxPartiesPerSlot: 1,
					maxOnlineCoversForService: null,
				},
			],
		})

		const kinds = conflicts.map((c) => c.kind)
		expect(kinds).toContain('table_overlap')
		expect(kinds).toContain('blocked_table')
		expect(kinds).toContain('archived_table')
		expect(kinds).toContain('shrunk_capacity')
		expect(kinds).toContain('unassigned')
		expect(kinds).toContain('pacing_exceeded')
		expect(kinds).toContain('outside_service_hours')
	})
})
