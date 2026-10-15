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

const ACTIVE_WAITLIST_STATUSES = new Set(['waiting', 'notified'])

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

	// Track per-table earliest availability in epoch ms
	const tableAvailableAt = new Map<string, number>()
	for (const t of input.tables) {
		if (t.active === false || t.active === 0) continue
		tableAvailableAt.set(t.id, input.nowMs)
	}

	for (const occ of input.occupancies ?? []) {
		if (occ.status && INACTIVE_OCCUPANCY_STATUSES.has(occ.status)) continue
		if (occ.endAt <= input.nowMs) continue
		// If occupancy is currently active or starting soon before tables free up, mark table busy until endAt
		for (const tid of occ.tableIds) {
			const prev = tableAvailableAt.get(tid) ?? input.nowMs
			if (occ.startAt <= prev + defaultTurnMin * 60_000 && occ.endAt > prev) {
				tableAvailableAt.set(tid, occ.endAt)
			}
		}
	}

	const candidateAvailableAt = (tableIds: readonly string[]): number => {
		let maxMs = input.nowMs
		for (const tid of tableIds) {
			const avail = tableAvailableAt.get(tid) ?? input.nowMs
			if (avail > maxMs) maxMs = avail
		}
		return maxMs
	}

	const targetTableSet = new Set<string>()
	for (const c of fittingForTarget) {
		for (const tid of c.tableIds) targetTableSet.add(tid)
	}

	let fittingPartiesAhead = 0

	// Simulate FIFO placement of each waiting party ahead
	for (const entry of activeAhead) {
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
				availAt: candidateAvailableAt(candidate.tableIds),
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

		const turnDurationMs =
			((entry.turnMin ?? defaultTurnMin) + bufferMin) * 60_000
		const nextFreeAt = chosen.availAt + turnDurationMs
		for (const tid of chosen.candidate.tableIds) {
			tableAvailableAt.set(tid, nextFreeAt)
		}
	}

	// Now pick the earliest-releasing candidate for our party
	const scoredTarget = fittingForTarget.map((candidate) => ({
		candidate,
		availAt: candidateAvailableAt(candidate.tableIds),
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
