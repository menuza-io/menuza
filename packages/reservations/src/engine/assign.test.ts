import { describe, expect, it } from 'vitest'
import {
	MAX_BOOK_EXPANSIONS,
	MAX_REFLOW_EXPANSIONS,
	MAX_SEARCH_SLOT_EXPANSIONS,
	assignTables,
	reflowDay,
	scoreCandidate,
	type AssignCandidate,
	type AssignDayBooking,
	type AssignEngineInput,
} from './assign.ts'

describe('assignTables, scoreCandidate, bounded repair, and reflowDay', () => {
	const nowMs = 1_700_000_000_000
	const startAt = nowMs + 3 * 3600_000 // 3 hours in the future (outside 60m freeze)
	const endAt = startAt + 90 * 60_000

	it('scores candidates deterministically (least wasted seats, single before combo, preserve combinable, gap penalties, priority, ID tie-break)', () => {
		const singleTight: AssignCandidate = {
			id: 't1',
			kind: 'single',
			areaId: 'a1',
			tableIds: ['t1'],
			minSeats: 2,
			maxSeats: 2,
			priority: 0,
			combinable: false,
			onlineBookable: true,
			isOutdoor: false,
			isBar: false,
		}
		const singleLoose: AssignCandidate = {
			...singleTight,
			id: 't2',
			tableIds: ['t2'],
			maxSeats: 4,
		}
		const singleCombinable: AssignCandidate = {
			...singleTight,
			id: 't3',
			tableIds: ['t3'],
			combinable: true,
		}
		const comboSameSeats: AssignCandidate = {
			...singleLoose,
			id: 'c1',
			kind: 'combo',
			tableIds: ['t4', 't5'],
		}

		const sTight = scoreCandidate({
			candidate: singleTight,
			partySize: 2,
			startAt,
			endAt,
			minTurnMin: 60,
		})
		const sLoose = scoreCandidate({
			candidate: singleLoose,
			partySize: 2,
			startAt,
			endAt,
			minTurnMin: 60,
		})
		const sCombinable = scoreCandidate({
			candidate: singleCombinable,
			partySize: 2,
			startAt,
			endAt,
			minTurnMin: 60,
		})
		const sCombo = scoreCandidate({
			candidate: comboSameSeats,
			partySize: 4,
			startAt,
			endAt,
			minTurnMin: 60,
		})
		const sSingleFor4 = scoreCandidate({
			candidate: singleLoose,
			partySize: 4,
			startAt,
			endAt,
			minTurnMin: 60,
		})

		expect(sTight).toBeLessThan(sLoose)
		expect(sTight).toBeLessThan(sCombinable) // preserves combinable table for small party
		expect(sSingleFor4).toBeLessThan(sCombo) // prefers single table over combo of same seats
	})

	it('performs a 1-step swap repair when direct candidates are occupied by a movable soft booking', () => {
		expect(MAX_SEARCH_SLOT_EXPANSIONS).toBe(200)
		expect(MAX_BOOK_EXPANSIONS).toBe(2_000)
		// Setup:
		// Table t_small (2..2) and Table t_med (2..4).
		// Existing soft booking R1 (partySize 2) is sitting on t_med (2..4), while t_small (2..2) is free!
		// New booking is partySize 4. It can only fit t_med (2..4).
		// 1-step repair moves R1 from t_med -> t_small and assigns the new 4-top to t_med!
		const input: AssignEngineInput = {
			nowMs,
			assignmentFreezeMin: 60,
			tables: [
				{
					id: 't_small',
					areaId: 'a1',
					label: 'T1',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
				{
					id: 't_med',
					areaId: 'a1',
					label: 'T2',
					minSeats: 2,
					maxSeats: 4,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
			],
			combinations: [],
			existingBookings: [
				{
					id: 'r1',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 2,
					startAt,
					endAt,
					tableIds: ['t_med'],
					tableLocked: false,
				},
			],
			request: {
				partySize: 4,
				startAt,
				endAt,
				channel: 'online',
			},
		}

		const result = assignTables(input)
		expect(result.assigned).toBe(true)
		if (result.assigned) {
			expect(result.tableIds).toEqual(['t_med'])
			expect(result.repairedMoves).toEqual([
				{
					bookingId: 'r1',
					fromTableIds: ['t_med'],
					toTableIds: ['t_small'],
					toCombinationId: null,
				},
			])
			expect(result.expansionsUsed).toBeLessThanOrEqual(
				MAX_SEARCH_SLOT_EXPANSIONS,
			)
		}
	})

	it('performs a 2-step swap repair when placing a new party requires a chain of two movable soft bookings', () => {
		// Setup:
		// t_2 (2..2) is free.
		// t_4 (2..4) has soft booking R1 (partySize 2).
		// t_6 (4..6) has soft booking R2 (partySize 4).
		// New booking is partySize 6 (only fits t_6).
		// 2-step repair: move R1 (2p) from t_4 -> t_2, move R2 (4p) from t_6 -> t_4, assign new 6p to t_6!
		const result = assignTables({
			nowMs,
			assignmentFreezeMin: 60,
			tables: [
				{
					id: 't_2',
					areaId: 'a1',
					label: 'T2',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
				{
					id: 't_4',
					areaId: 'a1',
					label: 'T4',
					minSeats: 2,
					maxSeats: 4,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
				{
					id: 't_6',
					areaId: 'a1',
					label: 'T6',
					minSeats: 4,
					maxSeats: 6,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
			],
			combinations: [],
			existingBookings: [
				{
					id: 'r1',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 2,
					startAt,
					endAt,
					tableIds: ['t_4'],
					tableLocked: false,
				},
				{
					id: 'r2',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 4,
					startAt,
					endAt,
					tableIds: ['t_6'],
					tableLocked: false,
				},
			],
			request: {
				partySize: 6,
				startAt,
				endAt,
				channel: 'online',
			},
		})

		expect(result.assigned).toBe(true)
		if (result.assigned) {
			expect(result.tableIds).toEqual(['t_6'])
			expect(result.repairedMoves).toHaveLength(2)
		}
	})

	it('never moves seated, table_locked, or freeze-window bookings during repair (Invariant I5)', () => {
		const baseTables = [
			{
				id: 't_small',
				areaId: 'a1',
				label: 'T1',
				minSeats: 2,
				maxSeats: 2,
				onlineBookable: true,
				combinable: false,
				priority: 0,
				active: true,
			},
			{
				id: 't_med',
				areaId: 'a1',
				label: 'T2',
				minSeats: 2,
				maxSeats: 4,
				onlineBookable: true,
				combinable: false,
				priority: 0,
				active: true,
			},
		]

		// Case 1: tableLocked = true
		const lockedRes = assignTables({
			nowMs,
			assignmentFreezeMin: 60,
			tables: baseTables,
			combinations: [],
			existingBookings: [
				{
					id: 'r_locked',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 2,
					startAt,
					endAt,
					tableIds: ['t_med'],
					tableLocked: true,
				},
			],
			request: { partySize: 4, startAt, endAt, channel: 'online' },
		})
		expect(lockedRes.assigned).toBe(false)

		// Case 2: status = 'seated'
		const seatedRes = assignTables({
			nowMs,
			assignmentFreezeMin: 60,
			tables: baseTables,
			combinations: [],
			existingBookings: [
				{
					id: 'r_seated',
					kind: 'reservation',
					status: 'seated',
					channel: 'online',
					partySize: 2,
					startAt,
					endAt,
					tableIds: ['t_med'],
					tableLocked: false,
				},
			],
			request: { partySize: 4, startAt, endAt, channel: 'online' },
		})
		expect(seatedRes.assigned).toBe(false)

		// Case 2b: status = 'arrived' and 'partially_arrived' are also hard-locked in both repair and reflow (Invariant I5)
		for (const arrivedStatus of ['arrived', 'partially_arrived'] as const) {
			const arrivedRes = assignTables({
				nowMs,
				assignmentFreezeMin: 60,
				tables: baseTables,
				combinations: [],
				existingBookings: [
					{
						id: `r_${arrivedStatus}`,
						kind: 'reservation',
						status: arrivedStatus,
						channel: 'online',
						partySize: 2,
						startAt,
						endAt,
						tableIds: ['t_med'],
						tableLocked: false,
					},
				],
				request: { partySize: 4, startAt, endAt, channel: 'online' },
			})
			expect(arrivedRes.assigned).toBe(false)

			const reflowArrived = reflowDay({
				nowMs,
				assignmentFreezeMin: 60,
				tables: baseTables,
				combinations: [],
				bookings: [
					{
						id: `r_${arrivedStatus}`,
						kind: 'reservation',
						status: arrivedStatus,
						channel: 'online',
						partySize: 2,
						startAt,
						endAt,
						tableIds: ['t_med'],
						tableLocked: false,
					},
				],
			})
			expect(reflowArrived.moves).toHaveLength(0)
			expect(
				reflowArrived.assignments.get(`r_${arrivedStatus}`)?.tableIds,
			).toEqual(['t_med'])
		}

		// Case 3: inside freeze window (startAt = nowMs + 30 min <= nowMs + 60 min)
		const frozenStart = nowMs + 30 * 60_000
		const frozenEnd = frozenStart + 90 * 60_000
		const frozenRes = assignTables({
			nowMs,
			assignmentFreezeMin: 60,
			tables: baseTables,
			combinations: [],
			existingBookings: [
				{
					id: 'r_frozen',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 2,
					startAt: frozenStart,
					endAt: frozenEnd,
					tableIds: ['t_med'],
					tableLocked: false,
				},
			],
			request: {
				partySize: 4,
				startAt: frozenStart,
				endAt: frozenEnd,
				channel: 'online',
			},
		})
		expect(frozenRes.assigned).toBe(false)
	})

	it('reflowDay reassigns soft bookings after a block or table shrink while keeping hard-locked bookings put', () => {
		expect(MAX_REFLOW_EXPANSIONS).toBe(5_000)

		const bookings: AssignDayBooking[] = [
			// Soft booking on t1, which is now blocked -> should move to t2
			{
				id: 'b_soft_blocked',
				kind: 'reservation',
				status: 'booked',
				channel: 'online',
				partySize: 2,
				startAt,
				endAt,
				tableIds: ['t1'],
				tableLocked: false,
			},
			// Hard-locked booking on t3 (which is shrunk to maxSeats 2, while partySize is 4) -> stays put on t3 and emits conflict
			{
				id: 'b_hard_shrunk',
				kind: 'reservation',
				status: 'booked',
				channel: 'operator',
				partySize: 4,
				startAt,
				endAt,
				tableIds: ['t3'],
				tableLocked: true,
			},
		]

		const reflow = reflowDay({
			nowMs,
			assignmentFreezeMin: 60,
			tables: [
				{
					id: 't1',
					areaId: 'a1',
					label: 'T1',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
				{
					id: 't2',
					areaId: 'a1',
					label: 'T2',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
				{
					id: 't3',
					areaId: 'a1',
					label: 'T3',
					minSeats: 2,
					maxSeats: 2, // shrunk from 4 to 2
					onlineBookable: true,
					combinable: false,
					priority: 0,
					active: true,
				},
			],
			combinations: [],
			bookings,
			blocks: [
				{
					id: 'blk_1',
					tableIds: ['t1'],
					startAt,
					endAt,
				},
			],
		})

		expect(reflow.expansionsUsed).toBeLessThanOrEqual(MAX_REFLOW_EXPANSIONS)
		expect(reflow.moves).toEqual([
			{
				bookingId: 'b_soft_blocked',
				fromTableIds: ['t1'],
				toTableIds: ['t2'],
				toCombinationId: null,
			},
		])
		expect(reflow.unassignedIds).toEqual([])
		expect(
			reflow.conflicts.some(
				(c) => c.bookingId === 'b_hard_shrunk' && c.kind === 'shrunk_capacity',
			),
		).toBe(true)

		// When a soft booking cannot fit anywhere, reflowDay resets to original assignments (moves: [], status: 'no_fit')
		const unresolvableReflow = reflowDay({
			nowMs,
			assignmentFreezeMin: 60,
			areas: [{ id: 'a1', name: 'Main', active: true }],
			tables: [
				{
					id: 't1',
					areaId: 'a1',
					label: 'T1',
					minSeats: 2,
					maxSeats: 2,
					onlineBookable: true,
					combinable: false,
					priority: 10,
					active: true,
				},
			],
			combinations: [],
			bookings: [
				{
					id: 'b_ok',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 2,
					startAt,
					endAt,
					tableIds: ['t1'],
				},
				{
					id: 'b_impossible',
					kind: 'reservation',
					status: 'booked',
					channel: 'online',
					partySize: 6,
					startAt,
					endAt,
					tableIds: ['t1'],
				},
			],
		})
		expect(unresolvableReflow.status).toBe('no_fit')
		expect(unresolvableReflow.moves).toEqual([])
		expect(unresolvableReflow.unresolvable).toContain('b_impossible')
	})

	it('ignores expired holds in occupancies and in existingHolds (Invariant I4)', () => {
		const tables = [
			{
				id: 't_only',
				areaId: 'a1',
				label: 'T1',
				minSeats: 2,
				maxSeats: 4,
				onlineBookable: true,
				combinable: false,
				priority: 0,
				active: true,
			},
		]
		const request = {
			partySize: 2,
			startAt,
			endAt,
			channel: 'online' as const,
		}
		const hold = (expiresAt: number) => ({
			id: 'h1',
			kind: 'hold' as const,
			partySize: 2,
			startAt,
			endAt,
			tableIds: ['t_only'],
			expiresAt,
		})
		const run = (expiresAt: number, via: 'bookings' | 'holds') =>
			assignTables({
				nowMs,
				assignmentFreezeMin: 60,
				tables,
				combinations: [],
				existingBookings: via === 'bookings' ? [hold(expiresAt)] : [],
				existingHolds: via === 'holds' ? [hold(expiresAt)] : [],
				request,
			})

		for (const via of ['bookings', 'holds'] as const) {
			expect(run(nowMs + 60_000, via).assigned).toBe(false)
			expect(run(nowMs, via).assigned).toBe(true)
			expect(run(nowMs - 60_000, via).assigned).toBe(true)
		}
	})

	it('treats a pending_approval request as occupying its tables', () => {
		const run = (status: string) =>
			assignTables({
				nowMs,
				assignmentFreezeMin: 60,
				tables: [
					{
						id: 't_only',
						areaId: 'a1',
						label: 'T1',
						minSeats: 2,
						maxSeats: 4,
						onlineBookable: true,
						combinable: false,
						priority: 0,
						active: true,
					},
				],
				combinations: [],
				existingBookings: [
					{
						id: 'pending_1',
						kind: 'reservation',
						status,
						channel: 'online',
						partySize: 4,
						startAt,
						endAt,
						tableIds: ['t_only'],
						tableLocked: false,
					},
				],
				request: { partySize: 4, startAt, endAt, channel: 'host' },
			})

		expect(run('pending_approval').assigned).toBe(false)
		expect(run('booked').assigned).toBe(false)
		expect(run('cancelled').assigned).toBe(true)
	})
})
