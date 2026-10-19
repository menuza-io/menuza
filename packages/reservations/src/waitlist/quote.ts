import { compareScoredCandidates, scoreCandidate } from '../engine/assign.ts'
import {
	type EngineAreaInput,
	type EngineCombinationInput,
	type EngineTableInput,
	buildCandidates,
} from '../engine/day-state.ts'

export type WaitlistOccupancyInput = {
	id: string
	tableIds: readonly string[]
	startAt: number
	endAt: number
	status?: string
}

export type WaitlistEntryAheadInput = {
	id: string
	partySize: number
	status?: string
	createdAt?: number
	turnMin?: number
	areaId?: string | null
}

export type QuoteWaitlistInput = {
	partySize: number
	nowMs: number
	tables: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	occupancies?: readonly WaitlistOccupancyInput[]
	entriesAhead?: readonly WaitlistEntryAheadInput[]
	defaultTurnMin?: number
	bufferMin?: number
	areaId?: string | null
}

export type QuoteWaitlistResult = {
	quotedWaitMin: number | null
	positionInLine: number
	fittingPartiesAhead: number
	candidateId: string | null
	tableIds: string[]
}

const INACTIVE_OCCUPANCY_STATUSES = new Set([
	'cancelled',
	'no_show',
	'declined',
	'expired',
	'finished',
])

const ACTIVE_WAITLIST_STATUSES = new Set(['waiting', 'notified', 'on_the_way'])

/**
 * Pure waitlist wait-time estimator (`architecture.md` §6.9, `VAL-FND-006`).
 * Simulates table release times across active occupancies and FIFO waitlist entries ahead.
 */
export function quoteWaitlistMin(
	input: QuoteWaitlistInput,
): QuoteWaitlistResult {
	const defaultTurnMin = input.defaultTurnMin ?? 60
	const bufferMin = input.bufferMin ?? 15

	const candidates = buildCandidates({
		tables: input.tables.map((t) => ({
			...t,
			label: t.label ?? t.id,
		})),
		areas: input.areas,
		combinations: input.combinations,
		channel: 'walk_in',
	})

	const fittingForTarget = candidates.filter((c) => {
		if (input.partySize < c.minSeats || input.partySize > c.maxSeats) {
			return false
		}
		if (input.areaId && c.areaId !== input.areaId) {
			return false
		}
		return true
	})

	const activeAhead = [...(input.entriesAhead ?? [])]
		.filter((e) => (e.status ? ACTIVE_WAITLIST_STATUSES.has(e.status) : true))
		.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))

	const positionInLine = activeAhead.length + 1

	if (fittingForTarget.length === 0) {
		return {
			quotedWaitMin: null,
			positionInLine,
			fittingPartiesAhead: 0,
			candidateId: null,
			tableIds: [],
		}
	}

	// Per-table busy intervals (epoch ms), sorted by start. Future reservations
	// and blocks stay in the list so a seating is never placed over them: the
	// simulation looks for the earliest gap that fits the whole turn + buffer.
	const busy = new Map<string, Array<{ start: number; end: number }>>()
	for (const t of input.tables) {
		if (t.active === false || t.active === 0) continue
		busy.set(t.id, [])
	}
	const addBusy = (tid: string, start: number, end: number) => {
		const list = busy.get(tid)
		if (!list) return
		list.push({ start, end })
		list.sort((a, b) => a.start - b.start || a.end - b.end)
	}

	for (const occ of input.occupancies ?? []) {
		if (occ.status && INACTIVE_OCCUPANCY_STATUSES.has(occ.status)) continue
		if (occ.endAt <= input.nowMs) continue
		for (const tid of occ.tableIds) addBusy(tid, occ.startAt, occ.endAt)
	}

	/** Earliest start >= now where every table is free for `durationMs`. */
	const earliestFit = (
		tableIds: readonly string[],
		durationMs: number,
	): number => {
		let t = input.nowMs
		for (;;) {
			let pushedTo = t
			for (const tid of tableIds) {
				for (const iv of busy.get(tid) ?? []) {
					if (iv.start < t + durationMs && iv.end > t && iv.end > pushedTo) {
						pushedTo = iv.end
					}
				}
			}
			if (pushedTo === t) return t
			t = pushedTo
		}
	}

	const targetDurationMs = (defaultTurnMin + bufferMin) * 60_000

	const targetTableSet = new Set<string>()
	for (const c of fittingForTarget) {
		for (const tid of c.tableIds) targetTableSet.add(tid)
	}

	let fittingPartiesAhead = 0

	// Simulate FIFO placement of each waiting party ahead
	for (const entry of activeAhead) {
		const entryDurationMs =
			((entry.turnMin ?? defaultTurnMin) + bufferMin) * 60_000
		const fittingForEntry = candidates
			.filter((c) => {
				if (entry.partySize < c.minSeats || entry.partySize > c.maxSeats) {
					return false
				}
				if (entry.areaId && c.areaId !== entry.areaId) {
					return false
				}
				return true
			})
			.map((candidate) => ({
				candidate,
				availAt: earliestFit(candidate.tableIds, entryDurationMs),
				score: scoreCandidate({
					candidate,
					partySize: entry.partySize,
				}),
			}))

		if (fittingForEntry.length === 0) continue

		fittingForEntry.sort((a, b) => {
			if (a.availAt !== b.availAt) return a.availAt - b.availAt
			return compareScoredCandidates(a, b)
		})

		const chosen = fittingForEntry[0]!
		if (chosen.candidate.tableIds.some((tid) => targetTableSet.has(tid))) {
			fittingPartiesAhead++
		}

		for (const tid of chosen.candidate.tableIds) {
			addBusy(tid, chosen.availAt, chosen.availAt + entryDurationMs)
		}
	}

	// Now pick the earliest-releasing candidate for our party
	const scoredTarget = fittingForTarget.map((candidate) => ({
		candidate,
		availAt: earliestFit(candidate.tableIds, targetDurationMs),
		score: scoreCandidate({
			candidate,
			partySize: input.partySize,
		}),
	}))

	scoredTarget.sort((a, b) => {
		if (a.availAt !== b.availAt) return a.availAt - b.availAt
		return compareScoredCandidates(a, b)
	})

	const best = scoredTarget[0]!
	const waitMs = Math.max(0, best.availAt - input.nowMs)
	const quotedWaitMin = Math.ceil(waitMs / 60_000)

	return {
		quotedWaitMin,
		positionInLine,
		fittingPartiesAhead,
		candidateId: best.candidate.id,
		tableIds: [...best.candidate.tableIds],
	}
}
