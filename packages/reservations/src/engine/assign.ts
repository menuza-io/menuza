import { type SeatingPreference } from '../config.ts'
import { type ConflictItem, detectConflicts } from './conflicts.ts'
import {
	type AssignCandidate,
	type BookingChannel,
	type CandidateAttributeTag,
	type EngineAreaInput,
	type EngineCombinationInput,
	type EngineServiceTableModeInput,
	type EngineTableInput,
	buildCandidates,
	candidateMatchesPreference,
	isBookingHardLocked,
} from './day-state.ts'
import {
	OccupancyIndex,
	type TableIntervalEntry,
	intervalsOverlap,
} from './occupancy.ts'
import { type EnginePacingRuleInput } from './pacing.ts'

export { type AssignCandidate }
export const MAX_SEARCH_SLOT_EXPANSIONS = 200
export const MAX_REPAIR_EXPANSIONS = 200
export const MAX_BOOK_EXPANSIONS = 2_000
export const MAX_DAY_EXPANSIONS = 2_000
export const MAX_REFLOW_EXPANSIONS = 5_000

export type ScoreCandidateInput = {
	candidate: AssignCandidate
	partySize: number
	startAt?: number
	endAt?: number
	seatingPreference?: SeatingPreference | null
	requestedAttributes?: readonly CandidateAttributeTag[]
	gapBeforeMin?: number | null
	gapAfterMin?: number | null
	minTurnMin?: number
}

function candidateHasAttribute(
	candidate: AssignCandidate,
	attr: CandidateAttributeTag,
): boolean {
	switch (attr) {
		case 'accessible':
			return Boolean(candidate.isAccessible)
		case 'high_top':
			return Boolean(candidate.isHighTop)
		case 'window':
			return Boolean(candidate.isWindow)
		case 'booth':
			return Boolean(candidate.isBooth)
		case 'patio':
			return Boolean(candidate.isPatio || candidate.isOutdoor)
		case 'bar':
			return Boolean(candidate.isBar)
	}
}

/**
 * Deterministic candidate scoring (`architecture.md` §6.5).
 * Lower score is better. Preserves strict lexicographic priority across:
 *   1. Wasted seats (`candidate.maxSeats - partySize`)
 *   2. Single table (0) before combination (`tableIds.length - 1`)
 *   3. Non-combinable single table (0) before combinable single table (1)
 *   4. Seating preference match (0) before mismatch (1)
 *   5. Requested attribute match (missing count)
 *   6. Orphan gap penalty (`0 < gap < minTurnMin`)
 *   7. Operator priority (`candidate.priority`)
 */
export function scoreCandidate(input: ScoreCandidateInput): number {
	const { candidate, partySize } = input
	const wastedSeats = Math.max(0, candidate.maxSeats - partySize)
	const comboSteps =
		candidate.kind === 'combo' ? Math.max(1, candidate.tableIds.length - 1) : 0
	const breaksCombo =
		candidate.kind === 'single' && candidate.combinable ? 1 : 0
	const prefPenalty = candidateMatchesPreference(
		candidate,
		input.seatingPreference,
	)
		? 0
		: 1

	let missingAttrs = 0
	if (input.requestedAttributes && input.requestedAttributes.length > 0) {
		for (const attr of input.requestedAttributes) {
			if (!candidateHasAttribute(candidate, attr)) missingAttrs++
		}
	}

	const minTurnMin = input.minTurnMin ?? 60
	let orphanGaps = 0
	if (
		input.gapBeforeMin !== undefined &&
		input.gapBeforeMin !== null &&
		input.gapBeforeMin > 0 &&
		input.gapBeforeMin < minTurnMin
	) {
		orphanGaps += 1
	}
	if (
		input.gapAfterMin !== undefined &&
		input.gapAfterMin !== null &&
		input.gapAfterMin > 0 &&
		input.gapAfterMin < minTurnMin
	) {
		orphanGaps += 1
	}

	const priority = Math.max(-50, Math.min(999, candidate.priority ?? 0)) + 50

	return (
		wastedSeats * 100_000_000 +
		comboSteps * 10_000_000 +
		breaksCombo * 1_000_000 +
		prefPenalty * 200_000 +
		missingAttrs * 50_000 +
		orphanGaps * 10_000 +
		priority
	)
}

export function compareScoredCandidates(
	a: { candidate: AssignCandidate; score: number },
	b: { candidate: AssignCandidate; score: number },
): number {
	if (a.score !== b.score) return a.score - b.score
	return a.candidate.id.localeCompare(b.candidate.id)
}

export type AssignBookingRecord = {
	id: string
	kind?: 'reservation' | 'hold' | 'block'
	partySize: number
	localStartMin?: number
	startAt: number
	endAt: number
	tableIds: readonly string[]
	combinationId?: string | null
	status?: string
	tableLocked?: boolean | number
	overbook?: boolean | number
	channel?: BookingChannel
	serviceId?: string | null
	areaId?: string | null
	seatingPreference?: SeatingPreference | null
}

export type AssignDayBooking = AssignBookingRecord

export type AssignHoldRecord = {
	id: string
	partySize?: number
	startAt: number
	endAt: number
	tableIds: readonly string[]
	combinationId?: string | null
	expiresAt?: number
}

export type AssignBlockRecord = {
	id: string
	tableIds?: readonly string[]
	areaId?: string | null
	startAt: number
	endAt: number
}

export type TableSwap = {
	bookingId: string
	fromTableIds: string[]
	toTableIds: string[]
	toCombinationId: string | null
}

export type AssignRequestInput = {
	partySize: number
	startAt: number
	endAt: number
	channel?: BookingChannel
	serviceId?: string | null
	areaId?: string | null
	seatingPreference?: SeatingPreference | null
	requestedAttributes?: readonly CandidateAttributeTag[]
}

export type AssignTablesConfigSubset = {
	tables: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	serviceTableModes?: readonly EngineServiceTableModeInput[]
	pacingRules?: readonly EnginePacingRuleInput[]
	settings?: {
		assignmentFreezeMin?: number
		defaultTurnMin?: number
		bufferMin?: number
	}
}

export type PrebuiltOccupancyContext = {
	occupancy: OccupancyIndex
	bookingsById: Map<string, AssignBookingRecord & { hardLocked: boolean }>
}

export type AssignTablesInput = {
	partySize?: number
	startAt?: number
	endAt?: number
	channel?: BookingChannel
	serviceId?: string | null
	areaId?: string | null
	seatingPreference?: SeatingPreference | null
	requestedAttributes?: readonly CandidateAttributeTag[]
	request?: AssignRequestInput
	config?: AssignTablesConfigSubset
	tables?: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	serviceTableModes?: readonly EngineServiceTableModeInput[]
	bookings?: readonly AssignBookingRecord[]
	existingBookings?: readonly AssignBookingRecord[]
	holds?: readonly AssignHoldRecord[]
	existingHolds?: readonly AssignHoldRecord[]
	blocks?: readonly AssignBlockRecord[]
	tableBlocks?: readonly AssignBlockRecord[]
	nowMs?: number
	assignmentFreezeMin?: number
	minTurnMin?: number
	serviceStartAt?: number
	serviceEndAt?: number
	maxExpansions?: number
	allowRepair?: boolean
	prebuiltOccupancy?: PrebuiltOccupancyContext
	candidatePoolCache?: Map<string, AssignCandidate[]>
	existingCandidatesCache?: Map<
		string,
		Array<{ candidate: AssignCandidate; score: number }>
	>
}

export type AssignEngineInput = AssignTablesInput

export type AssignTablesResult =
	| {
			assigned: true
			status: 'assigned'
			budgetExhausted: false
			tableIds: string[]
			combinationId: string | null
			areaId: string
			candidateId: string
			score: number
			repaired: boolean
			swaps: TableSwap[]
			repairedMoves: TableSwap[]
			expansions: number
			expansionsUsed: number
	  }
	| {
			assigned: false
			status: 'no_fit'
			budgetExhausted: boolean
			tableIds: []
			combinationId: null
			repaired: false
			swaps: []
			repairedMoves: []
			expansions: number
			expansionsUsed: number
			reason:
				'no_fitting_candidate' | 'tables_occupied' | 'repair_budget_exhausted'
	  }

const ACTIVE_BOOKING_STATUSES = new Set([
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
])

function computeCandidateGaps(
	occupancy: OccupancyIndex,
	candidate: AssignCandidate,
	startAt: number,
	endAt: number,
	serviceStartAt?: number,
	serviceEndAt?: number,
	ignoreOwners?: ReadonlySet<string>,
): { gapBeforeMin: number | null; gapAfterMin: number | null } {
	let tightestBeforeMin: number | null = null
	let tightestAfterMin: number | null = null

	for (const tableId of candidate.tableIds) {
		const { prevEnd, nextStart } = occupancy.neighborBoundsOnTable(
			tableId,
			startAt,
			endAt,
			ignoreOwners,
		)
		const effectivePrev = prevEnd ?? serviceStartAt ?? null
		const effectiveNext = nextStart ?? serviceEndAt ?? null

		if (effectivePrev !== null && effectivePrev <= startAt) {
			const gapMin = Math.floor((startAt - effectivePrev) / 60_000)
			if (tightestBeforeMin === null || gapMin < tightestBeforeMin) {
				tightestBeforeMin = gapMin
			}
		}
		if (effectiveNext !== null && effectiveNext >= endAt) {
			const gapMin = Math.floor((effectiveNext - endAt) / 60_000)
			if (tightestAfterMin === null || gapMin < tightestAfterMin) {
				tightestAfterMin = gapMin
			}
		}
	}

	return { gapBeforeMin: tightestBeforeMin, gapAfterMin: tightestAfterMin }
}

export function buildOccupancyIndex(input: {
	tables: readonly EngineTableInput[]
	bookings?: readonly AssignBookingRecord[]
	holds?: readonly AssignHoldRecord[]
	blocks?: readonly AssignBlockRecord[]
	nowMs: number
	assignmentFreezeMin: number
}): PrebuiltOccupancyContext {
	const entries: TableIntervalEntry[] = []
	const bookingsById = new Map<
		string,
		AssignBookingRecord & { hardLocked: boolean }
	>()

	for (const b of input.bookings ?? []) {
		if (b.kind === 'block') {
			for (const tableId of b.tableIds) {
				entries.push({
					ownerId: `block:${b.id}`,
					ownerKind: 'block',
					tableId,
					startAt: b.startAt,
					endAt: b.endAt,
					hardLocked: true,
					overbook: false,
				})
			}
			continue
		}
		if (b.kind === 'hold') {
			for (const tableId of b.tableIds) {
				entries.push({
					ownerId: `hold:${b.id}`,
					ownerKind: 'hold',
					tableId,
					startAt: b.startAt,
					endAt: b.endAt,
					hardLocked: true,
					overbook: false,
				})
			}
			continue
		}
		if (b.status && !ACTIVE_BOOKING_STATUSES.has(b.status)) continue
		const overbook = b.overbook === true || b.overbook === 1
		const hardLocked = isBookingHardLocked({
			status: b.status,
			tableLocked: b.tableLocked,
			startAt: b.startAt,
			nowMs: input.nowMs,
			assignmentFreezeMin: input.assignmentFreezeMin,
		})
		bookingsById.set(b.id, { ...b, hardLocked })
		for (const tableId of b.tableIds) {
			entries.push({
				ownerId: b.id,
				ownerKind: 'reservation',
				tableId,
				startAt: b.startAt,
				endAt: b.endAt,
				hardLocked,
				overbook,
			})
		}
	}

	for (const h of input.holds ?? []) {
		if (h.expiresAt !== undefined && h.expiresAt <= input.nowMs) continue
		for (const tableId of h.tableIds) {
			entries.push({
				ownerId: `hold:${h.id}`,
				ownerKind: 'hold',
				tableId,
				startAt: h.startAt,
				endAt: h.endAt,
				hardLocked: true,
				overbook: false,
			})
		}
	}

	for (const blk of input.blocks ?? []) {
		const tids = blk.tableIds ? [...blk.tableIds] : []
		if (blk.areaId) {
			for (const t of input.tables) {
				const tArea = t.areaId ?? t.area_id
				if (tArea === blk.areaId && !tids.includes(t.id)) {
					tids.push(t.id)
				}
			}
		}
		for (const tableId of tids) {
			entries.push({
				ownerId: `block:${blk.id}`,
				ownerKind: 'block',
				tableId,
				startAt: blk.startAt,
				endAt: blk.endAt,
				hardLocked: true,
				overbook: false,
			})
		}
	}

	return {
		occupancy: new OccupancyIndex(entries),
		bookingsById,
	}
}

/**
 * Best-fit table assignment with bounded 1-step and 2-step swap repair
 * (`architecture.md` §6.5, §6.7, `VAL-FND-007`).
 */
export function assignTables(input: AssignTablesInput): AssignTablesResult {
	const req = input.request
	const partySize = req?.partySize ?? input.partySize ?? 1
	const startAt = req?.startAt ?? input.startAt ?? 0
	const endAt = req?.endAt ?? input.endAt ?? 0
	const channel = req?.channel ?? input.channel ?? 'online'
	const serviceId = req?.serviceId ?? input.serviceId
	const areaId = req?.areaId ?? input.areaId
	const seatingPreference = req?.seatingPreference ?? input.seatingPreference
	const requestedAttributes =
		req?.requestedAttributes ?? input.requestedAttributes
	const existingBookings = input.existingBookings ?? input.bookings ?? []
	const holds = input.existingHolds ?? input.holds
	const blocks = input.tableBlocks ?? input.blocks

	const tables = input.tables ?? input.config?.tables ?? []
	const areas = input.areas ?? input.config?.areas
	const combinations = input.combinations ?? input.config?.combinations
	const serviceTableModes =
		input.serviceTableModes ?? input.config?.serviceTableModes

	const nowMs = input.nowMs ?? 0
	const assignmentFreezeMin =
		input.assignmentFreezeMin ??
		input.config?.settings?.assignmentFreezeMin ??
		0
	const minTurnMin =
		input.minTurnMin ?? input.config?.settings?.defaultTurnMin ?? 60
	const maxExpansions = Math.min(
		MAX_BOOK_EXPANSIONS,
		input.maxExpansions ?? MAX_BOOK_EXPANSIONS,
	)
	const allowRepair = input.allowRepair ?? true

	const candidatePoolCache =
		input.candidatePoolCache ?? new Map<string, AssignCandidate[]>()
	const primaryCacheKey = `${serviceId ?? ''}::${channel}`
	let allCandidates = candidatePoolCache.get(primaryCacheKey)
	if (!allCandidates) {
		allCandidates = buildCandidates({
			tables,
			areas,
			combinations,
			serviceTableModes,
			serviceId,
			channel,
		})
		candidatePoolCache.set(primaryCacheKey, allCandidates)
	}

	// Candidates that fit the new party's size (and optional area filter)
	const fittingCandidates = allCandidates.filter((c) => {
		if (partySize < c.minSeats || partySize > c.maxSeats) {
			return false
		}
		if (areaId && c.areaId !== areaId) {
			return false
		}
		return true
	})

	if (fittingCandidates.length === 0) {
		return {
			assigned: false,
			status: 'no_fit',
			budgetExhausted: false,
			tableIds: [],
			combinationId: null,
			repaired: false,
			swaps: [],
			repairedMoves: [],
			expansions: 0,
			expansionsUsed: 0,
			reason: 'no_fitting_candidate',
		}
	}

	const { occupancy, bookingsById } =
		input.prebuiltOccupancy ??
		buildOccupancyIndex({
			tables,
			bookings: existingBookings,
			holds,
			blocks,
			nowMs,
			assignmentFreezeMin,
		})

	let expansions = 0

	// 1. Direct fit: evaluate all fitting candidates that are currently free
	const scoredFree: Array<{ candidate: AssignCandidate; score: number }> = []
	const occupiedCandidates: AssignCandidate[] = []

	for (const candidate of fittingCandidates) {
		if (occupancy.areTablesFree(candidate.tableIds, startAt, endAt)) {
			const { gapBeforeMin, gapAfterMin } = computeCandidateGaps(
				occupancy,
				candidate,
				startAt,
				endAt,
				input.serviceStartAt,
				input.serviceEndAt,
			)
			const score = scoreCandidate({
				candidate,
				partySize,
				seatingPreference,
				requestedAttributes,
				gapBeforeMin,
				gapAfterMin,
				minTurnMin,
			})
			scoredFree.push({ candidate, score })
		} else {
			occupiedCandidates.push(candidate)
		}
	}

	if (scoredFree.length > 0) {
		scoredFree.sort(compareScoredCandidates)
		const best = scoredFree[0]!
		return {
			assigned: true,
			status: 'assigned',
			budgetExhausted: false,
			tableIds: [...best.candidate.tableIds],
			combinationId: best.candidate.kind === 'combo' ? best.candidate.id : null,
			areaId: best.candidate.areaId,
			candidateId: best.candidate.id,
			score: best.score,
			repaired: false,
			swaps: [],
			repairedMoves: [],
			expansions,
			expansionsUsed: expansions,
		}
	}

	if (!allowRepair || maxExpansions <= 0) {
		return {
			assigned: false,
			status: 'no_fit',
			budgetExhausted: allowRepair,
			tableIds: [],
			combinationId: null,
			repaired: false,
			swaps: [],
			repairedMoves: [],
			expansions,
			expansionsUsed: expansions,
			reason: allowRepair ? 'repair_budget_exhausted' : 'tables_occupied',
		}
	}

	const scoredOccupied: Array<{ candidate: AssignCandidate; score: number }> =
		occupiedCandidates.map((candidate) => {
			const { gapBeforeMin, gapAfterMin } = computeCandidateGaps(
				occupancy,
				candidate,
				startAt,
				endAt,
				input.serviceStartAt,
				input.serviceEndAt,
			)
			const score = scoreCandidate({
				candidate,
				partySize,
				seatingPreference,
				requestedAttributes,
				gapBeforeMin,
				gapAfterMin,
				minTurnMin,
			})
			return { candidate, score }
		})
	scoredOccupied.sort(compareScoredCandidates)

	const existingCandidatesCache =
		input.existingCandidatesCache ??
		new Map<string, Array<{ candidate: AssignCandidate; score: number }>>()

	// Helper to get valid candidates for an existing booking B
	const candidatesForExisting = (
		booking: AssignBookingRecord,
	): Array<{ candidate: AssignCandidate; score: number }> => {
		const bServiceId = booking.serviceId ?? serviceId
		const bChannel = booking.channel ?? 'online'
		const existingKey = `${bServiceId ?? ''}::${bChannel}::${booking.partySize}::${booking.areaId ?? ''}::${booking.seatingPreference ?? ''}`
		const cached = existingCandidatesCache.get(existingKey)
		if (cached) return cached

		const cacheKey = `${bServiceId ?? ''}::${bChannel}`
		let pool = candidatePoolCache.get(cacheKey)
		if (!pool) {
			pool = buildCandidates({
				tables,
				areas,
				combinations,
				serviceTableModes,
				serviceId: bServiceId,
				channel: bChannel,
			})
			candidatePoolCache.set(cacheKey, pool)
		}
		const valid: Array<{ candidate: AssignCandidate; score: number }> = []
		for (const c of pool) {
			if (booking.partySize < c.minSeats || booking.partySize > c.maxSeats) {
				continue
			}
			if (booking.areaId && c.areaId !== booking.areaId) {
				continue
			}
			const score = scoreCandidate({
				candidate: c,
				partySize: booking.partySize,
				seatingPreference: booking.seatingPreference,
				minTurnMin,
			})
			valid.push({ candidate: c, score })
		}
		valid.sort(compareScoredCandidates)
		existingCandidatesCache.set(existingKey, valid)
		return valid
	}

	let budgetHit = false

	// 2. Bounded 1-step swap repair
	for (const { candidate: candNew, score: scoreNew } of scoredOccupied) {
		if (expansions >= maxExpansions) {
			budgetHit = true
			break
		}
		expansions++

		const conflicts = occupancy.conflictsForTables(
			candNew.tableIds,
			startAt,
			endAt,
		)
		if (conflicts.some((c) => c.ownerKind !== 'reservation' || c.hardLocked)) {
			continue
		}
		const uniqueOwnerIds = [...new Set(conflicts.map((c) => c.ownerId))]
		if (uniqueOwnerIds.length !== 1) continue

		const b1Id = uniqueOwnerIds[0]!
		const b1 = bookingsById.get(b1Id)
		if (!b1 || b1.hardLocked) continue

		const ignoreSet1 = new Set<string>([b1.id])
		const b1Candidates = candidatesForExisting(b1)

		for (const { candidate: candB1 } of b1Candidates) {
			if (expansions >= maxExpansions) {
				budgetHit = true
				break
			}
			expansions++

			if (
				intervalsOverlap(b1.startAt, b1.endAt, startAt, endAt) &&
				candB1.tableIds.some((t) => candNew.tableIds.includes(t))
			) {
				continue
			}

			if (
				occupancy.areTablesFree(
					candB1.tableIds,
					b1.startAt,
					b1.endAt,
					ignoreSet1,
				)
			) {
				const comboId = candB1.kind === 'combo' ? candB1.id : null
				const moves: TableSwap[] = [
					{
						bookingId: b1.id,
						fromTableIds: [...b1.tableIds],
						toTableIds: [...candB1.tableIds],
						toCombinationId: comboId,
					},
				]
				return {
					assigned: true,
					status: 'assigned',
					budgetExhausted: false,
					tableIds: [...candNew.tableIds],
					combinationId: candNew.kind === 'combo' ? candNew.id : null,
					areaId: candNew.areaId,
					candidateId: candNew.id,
					score: scoreNew,
					repaired: true,
					swaps: moves,
					repairedMoves: moves,
					expansions,
					expansionsUsed: expansions,
				}
			}
		}
	}

	// 3. Bounded 2-step swap repair
	if (!budgetHit) {
		for (const { candidate: candNew, score: scoreNew } of scoredOccupied) {
			if (expansions >= maxExpansions) {
				budgetHit = true
				break
			}
			const conflicts = occupancy.conflictsForTables(
				candNew.tableIds,
				startAt,
				endAt,
			)
			if (
				conflicts.some((c) => c.ownerKind !== 'reservation' || c.hardLocked)
			) {
				continue
			}
			const uniqueOwnerIds = [...new Set(conflicts.map((c) => c.ownerId))]
			if (uniqueOwnerIds.length !== 1) continue

			const b1Id = uniqueOwnerIds[0]!
			const b1 = bookingsById.get(b1Id)
			if (!b1 || b1.hardLocked) continue

			const ignoreB1 = new Set<string>([b1.id])
			const b1Candidates = candidatesForExisting(b1)

			for (const { candidate: candB1 } of b1Candidates) {
				if (expansions >= maxExpansions) {
					budgetHit = true
					break
				}
				expansions++

				if (
					intervalsOverlap(b1.startAt, b1.endAt, startAt, endAt) &&
					candB1.tableIds.some((t) => candNew.tableIds.includes(t))
				) {
					continue
				}

				const b1Conflicts = occupancy.conflictsForTables(
					candB1.tableIds,
					b1.startAt,
					b1.endAt,
					ignoreB1,
				)
				if (
					b1Conflicts.some((c) => c.ownerKind !== 'reservation' || c.hardLocked)
				) {
					continue
				}
				const b2OwnerIds = [...new Set(b1Conflicts.map((c) => c.ownerId))]
				if (b2OwnerIds.length !== 1) continue

				const b2Id = b2OwnerIds[0]!
				const b2 = bookingsById.get(b2Id)
				if (!b2 || b2.hardLocked) continue

				const ignoreB1B2 = new Set<string>([b1.id, b2.id])
				const b2Candidates = candidatesForExisting(b2)

				for (const { candidate: candB2 } of b2Candidates) {
					if (expansions >= maxExpansions) {
						budgetHit = true
						break
					}
					expansions++

					if (
						intervalsOverlap(b2.startAt, b2.endAt, startAt, endAt) &&
						candB2.tableIds.some((t) => candNew.tableIds.includes(t))
					) {
						continue
					}
					if (
						intervalsOverlap(b2.startAt, b2.endAt, b1.startAt, b1.endAt) &&
						candB2.tableIds.some((t) => candB1.tableIds.includes(t))
					) {
						continue
					}

					if (
						occupancy.areTablesFree(
							candB2.tableIds,
							b2.startAt,
							b2.endAt,
							ignoreB1B2,
						)
					) {
						const c1Id = candB1.kind === 'combo' ? candB1.id : null
						const c2Id = candB2.kind === 'combo' ? candB2.id : null
						const moves: TableSwap[] = [
							{
								bookingId: b1.id,
								fromTableIds: [...b1.tableIds],
								toTableIds: [...candB1.tableIds],
								toCombinationId: c1Id,
							},
							{
								bookingId: b2.id,
								fromTableIds: [...b2.tableIds],
								toTableIds: [...candB2.tableIds],
								toCombinationId: c2Id,
							},
						]
						return {
							assigned: true,
							status: 'assigned',
							budgetExhausted: false,
							tableIds: [...candNew.tableIds],
							combinationId: candNew.kind === 'combo' ? candNew.id : null,
							areaId: candNew.areaId,
							candidateId: candNew.id,
							score: scoreNew,
							repaired: true,
							swaps: moves,
							repairedMoves: moves,
							expansions,
							expansionsUsed: expansions,
						}
					}
				}
			}
		}
	}

	return {
		assigned: false,
		status: 'no_fit',
		budgetExhausted: budgetHit,
		tableIds: [],
		combinationId: null,
		repaired: false,
		swaps: [],
		repairedMoves: [],
		expansions,
		expansionsUsed: expansions,
		reason: budgetHit ? 'repair_budget_exhausted' : 'tables_occupied',
	}
}

export type ReflowDayInput = {
	config?: AssignTablesConfigSubset
	tables?: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	serviceTableModes?: readonly EngineServiceTableModeInput[]
	pacingRules?: readonly EnginePacingRuleInput[]
	bookings?: readonly AssignBookingRecord[]
	existingBookings?: readonly AssignBookingRecord[]
	holds?: readonly AssignHoldRecord[]
	existingHolds?: readonly AssignHoldRecord[]
	blocks?: readonly AssignBlockRecord[]
	tableBlocks?: readonly AssignBlockRecord[]
	nowMs?: number
	assignmentFreezeMin?: number
	minTurnMin?: number
	maxExpansions?: number
}

export type ReflowDayResult = {
	status: 'assigned' | 'no_fit'
	budgetExhausted: boolean
	assignments: Map<string, { tableIds: string[]; combinationId: string | null }>
	reassigned: TableSwap[]
	moves: TableSwap[]
	unresolvable: string[]
	unassignedIds: string[]
	conflicts: ConflictItem[]
	expansions: number
	expansionsUsed: number
}

/**
 * Re-assign soft bookings across a day after floor-plan, block, or service changes
 * (`architecture.md` §6.8, `VAL-FND-007`, `VAL-FND-009`).
 * Hard-locked bookings (`partially_arrived`, `arrived`, `partially_seated`, `seated`,
 * `finished`, `tableLocked`, or within `assignmentFreezeMin` of `nowMs`) keep their
 * existing tables.
 */
export function reflowDay(input: ReflowDayInput): ReflowDayResult {
	const tables = input.tables ?? input.config?.tables ?? []
	const areas = input.areas ?? input.config?.areas
	const combinations = input.combinations ?? input.config?.combinations
	const serviceTableModes =
		input.serviceTableModes ?? input.config?.serviceTableModes
	const pacingRules = input.pacingRules ?? input.config?.pacingRules
	const bookings = input.existingBookings ?? input.bookings ?? []
	const holds = input.existingHolds ?? input.holds
	const blocks = input.tableBlocks ?? input.blocks

	const nowMs = input.nowMs ?? 0
	const assignmentFreezeMin =
		input.assignmentFreezeMin ??
		input.config?.settings?.assignmentFreezeMin ??
		0
	const minTurnMin =
		input.minTurnMin ?? input.config?.settings?.defaultTurnMin ?? 60
	const maxExpansions = Math.min(
		MAX_REFLOW_EXPANSIONS,
		input.maxExpansions ?? MAX_REFLOW_EXPANSIONS,
	)

	const activeTableIds = new Set<string>()
	for (const t of tables) {
		if (t.active === false || t.active === 0) continue
		activeTableIds.add(t.id)
	}

	const activeBookings = bookings.filter((b) =>
		b.status ? ACTIVE_BOOKING_STATUSES.has(b.status) : true,
	)

	const hardBookings: AssignBookingRecord[] = []
	const softBookings: AssignBookingRecord[] = []

	for (const b of activeBookings) {
		const locked = isBookingHardLocked({
			status: b.status,
			tableLocked: b.tableLocked,
			startAt: b.startAt,
			nowMs,
			assignmentFreezeMin,
		})
		if (locked) {
			hardBookings.push(b)
		} else {
			softBookings.push(b)
		}
	}

	softBookings.sort((a, b) => {
		if (b.partySize !== a.partySize) return b.partySize - a.partySize
		if (a.startAt !== b.startAt) return a.startAt - b.startAt
		return a.id.localeCompare(b.id)
	})

	const placedBookings: AssignBookingRecord[] = [...hardBookings]
	const assignments = new Map<
		string,
		{ tableIds: string[]; combinationId: string | null }
	>()
	for (const hb of hardBookings) {
		assignments.set(hb.id, {
			tableIds: [...hb.tableIds],
			combinationId: hb.combinationId ?? null,
		})
	}

	const reassigned: TableSwap[] = []
	const unresolvable: string[] = []
	let totalExpansions = 0
	let budgetExhausted = false

	for (const sb of softBookings) {
		const remainingBudget = Math.max(0, maxExpansions - totalExpansions)
		if (remainingBudget === 0) {
			budgetExhausted = true
			break
		}

		const currentTablesActive =
			sb.tableIds.length > 0 &&
			sb.tableIds.every((id) => activeTableIds.has(id))

		const { occupancy: currentOcc } = buildOccupancyIndex({
			tables,
			bookings: placedBookings,
			holds,
			blocks,
			nowMs,
			assignmentFreezeMin,
		})

		const pool = buildCandidates({
			tables,
			areas,
			combinations,
			serviceTableModes,
			serviceId: sb.serviceId,
			channel: sb.channel ?? 'online',
		})

		const sortedSbTables = [...sb.tableIds].sort()
		const matchingCurrentCand = currentTablesActive
			? pool.find(
					(c) =>
						c.tableIds.length === sortedSbTables.length &&
						c.tableIds.every((id, idx) => id === sortedSbTables[idx]) &&
						sb.partySize >= c.minSeats &&
						sb.partySize <= c.maxSeats,
				)
			: undefined

		if (
			matchingCurrentCand &&
			currentOcc.areTablesFree(
				matchingCurrentCand.tableIds,
				sb.startAt,
				sb.endAt,
			)
		) {
			totalExpansions++
			placedBookings.push({
				...sb,
				tableIds: [...matchingCurrentCand.tableIds],
				combinationId:
					matchingCurrentCand.kind === 'combo' ? matchingCurrentCand.id : null,
			})
			assignments.set(sb.id, {
				tableIds: [...matchingCurrentCand.tableIds],
				combinationId:
					matchingCurrentCand.kind === 'combo' ? matchingCurrentCand.id : null,
			})
			continue
		}

		const res = assignTables({
			partySize: sb.partySize,
			startAt: sb.startAt,
			endAt: sb.endAt,
			channel: sb.channel ?? 'online',
			serviceId: sb.serviceId,
			areaId: sb.areaId,
			seatingPreference: sb.seatingPreference,
			tables,
			areas,
			combinations,
			serviceTableModes,
			bookings: placedBookings,
			holds,
			blocks,
			nowMs,
			assignmentFreezeMin,
			minTurnMin,
			maxExpansions: Math.min(MAX_REPAIR_EXPANSIONS, remainingBudget),
			allowRepair: true,
		})

		totalExpansions += Math.max(1, res.expansions)

		if (res.assigned) {
			for (const sw of res.swaps) {
				const idx = placedBookings.findIndex((p) => p.id === sw.bookingId)
				if (idx !== -1) {
					const prev = placedBookings[idx]!
					placedBookings[idx] = {
						...prev,
						tableIds: [...sw.toTableIds],
						combinationId: sw.toCombinationId,
					}
					assignments.set(sw.bookingId, {
						tableIds: [...sw.toTableIds],
						combinationId: sw.toCombinationId,
					})
					const existingReassignedIdx = reassigned.findIndex(
						(r) => r.bookingId === sw.bookingId,
					)
					if (existingReassignedIdx !== -1) {
						reassigned[existingReassignedIdx]!.toTableIds = [...sw.toTableIds]
						reassigned[existingReassignedIdx]!.toCombinationId =
							sw.toCombinationId
					} else {
						reassigned.push({
							bookingId: sw.bookingId,
							fromTableIds: [...sw.fromTableIds],
							toTableIds: [...sw.toTableIds],
							toCombinationId: sw.toCombinationId,
						})
					}
				}
			}

			placedBookings.push({
				...sb,
				tableIds: [...res.tableIds],
				combinationId: res.combinationId,
			})
			assignments.set(sb.id, {
				tableIds: [...res.tableIds],
				combinationId: res.combinationId,
			})

			const prevSorted = [...sb.tableIds].sort().join(',')
			const nextSorted = [...res.tableIds].sort().join(',')
			if (prevSorted !== nextSorted) {
				reassigned.push({
					bookingId: sb.id,
					fromTableIds: [...sb.tableIds],
					toTableIds: [...res.tableIds],
					toCombinationId: res.combinationId,
				})
			}
		} else {
			if (res.budgetExhausted && totalExpansions >= maxExpansions) {
				budgetExhausted = true
				break
			}
			unresolvable.push(sb.id)
			placedBookings.push({
				...sb,
				tableIds: [],
				combinationId: null,
			})
		}
	}

	// Never return partial reflow plans when the expansion budget is exhausted (`VAL-FND-009`).
	if (budgetExhausted) {
		const originalAssignments = new Map<
			string,
			{ tableIds: string[]; combinationId: string | null }
		>()
		for (const b of activeBookings) {
			originalAssignments.set(b.id, {
				tableIds: [...b.tableIds],
				combinationId: b.combinationId ?? null,
			})
		}
		const conflicts = detectConflicts({
			tables,
			areas,
			combinations,
			bookings: activeBookings,
			blocks,
			pacingRules,
		})
		const allSoftIds = softBookings.map((sb) => sb.id)
		return {
			status: 'no_fit',
			budgetExhausted: true,
			assignments: originalAssignments,
			reassigned: [],
			moves: [],
			unresolvable: allSoftIds,
			unassignedIds: allSoftIds,
			conflicts,
			expansions: totalExpansions,
			expansionsUsed: totalExpansions,
		}
	}

	const conflicts = detectConflicts({
		tables,
		areas,
		combinations,
		bookings: placedBookings,
		blocks,
		pacingRules,
	})

	return {
		status: unresolvable.length === 0 ? 'assigned' : 'no_fit',
		budgetExhausted: false,
		assignments,
		reassigned,
		moves: reassigned,
		unresolvable,
		unassignedIds: unresolvable,
		conflicts,
		expansions: totalExpansions,
		expansionsUsed: totalExpansions,
	}
}

export const planBooking = assignTables
export const tryRepair = assignTables
export const reflow = reflowDay
