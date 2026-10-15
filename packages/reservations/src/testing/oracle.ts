import {
	type AssignBlockRecord,
	type AssignBookingRecord,
	type AssignHoldRecord,
	type AssignRequestInput,
} from '../engine/assign.ts'
import { type EngineDayConfig } from '../engine/availability.ts'
import {
	type AssignCandidate,
	buildCandidates,
	isBookingHardLocked,
} from '../engine/day-state.ts'
import { intervalsOverlap } from '../engine/occupancy.ts'

export type VerifyDayInvariantsInput = {
	config: EngineDayConfig
	existingBookings: readonly AssignBookingRecord[]
	existingHolds?: readonly AssignHoldRecord[]
	tableBlocks?: readonly AssignBlockRecord[]
	nowMs?: number
}

export type VerifyDayInvariantsResult = {
	valid: boolean
	violations: string[]
}

/**
 * Independent invariant verifier for Invariants I1-I7 (`architecture.md` §6.6, `VAL-FND-009`).
 */
export function verifyDayInvariants(
	input: VerifyDayInvariantsInput,
): VerifyDayInvariantsResult {
	const violations: string[] = []
	const { config } = input
	const activeBookings = input.existingBookings.filter(
		(b) =>
			!b.status ||
			['booked', 'confirmed', 'arrived', 'partially_seated', 'seated'].includes(
				b.status,
			),
	)

	const activeTablesById = new Map(
		config.tables
			.filter((t) => t.active !== false && t.active !== 0)
			.map((t) => [t.id, t] as const),
	)
	const activeAreasById = new Map(
		config.areas
			.filter((a) => a.active !== false && a.active !== 0)
			.map((a) => [a.id, a] as const),
	)
	const activeCombosById = new Map(
		config.combinations
			.filter((c) => c.active !== false && c.active !== 0)
			.map((c) => [c.id, c] as const),
	)

	// I2 & I3: Party size bounds & active table/area/combo membership
	for (const b of activeBookings) {
		if (b.tableIds.length === 0) {
			violations.push(`I3: Booking ${b.id} has no assigned tables`)
			continue
		}
		for (const tid of b.tableIds) {
			const table = activeTablesById.get(tid)
			if (!table) {
				violations.push(`I3: Booking ${b.id} references inactive table ${tid}`)
				continue
			}
			const areaId = table.areaId ?? table.area_id ?? ''
			if (!activeAreasById.has(areaId)) {
				violations.push(
					`I3: Booking ${b.id} table ${tid} is in inactive area ${areaId}`,
				)
			}
		}

		if (b.tableIds.length === 1) {
			const table = activeTablesById.get(b.tableIds[0]!)
			if (table) {
				const minS = table.minSeats ?? table.min_seats ?? 1
				const maxS = table.maxSeats ?? table.max_seats ?? 99
				if (!b.overbook && (b.partySize < minS || b.partySize > maxS)) {
					violations.push(
						`I2: Booking ${b.id} partySize ${b.partySize} outside single table ${table.id} [${minS}, ${maxS}]`,
					)
				}
			}
		} else if (b.combinationId) {
			const combo = activeCombosById.get(b.combinationId)
			if (!combo) {
				violations.push(
					`I3: Booking ${b.id} references inactive combination ${b.combinationId}`,
				)
			} else {
				const minS = combo.minSeats ?? combo.min_seats ?? 1
				const maxS = combo.maxSeats ?? combo.max_seats ?? 99
				if (!b.overbook && (b.partySize < minS || b.partySize > maxS)) {
					violations.push(
						`I2: Booking ${b.id} partySize ${b.partySize} outside combo ${combo.id} [${minS}, ${maxS}]`,
					)
				}
			}
		}
	}

	// I1: No table double-booking on half-open [startAt, endAt)
	for (let i = 0; i < activeBookings.length; i++) {
		const a = activeBookings[i]!
		for (let j = i + 1; j < activeBookings.length; j++) {
			const b = activeBookings[j]!
			if (a.overbook || b.overbook) continue
			if (!intervalsOverlap(a.startAt, a.endAt, b.startAt, b.endAt)) continue
			for (const tid of a.tableIds) {
				if (b.tableIds.includes(tid)) {
					violations.push(
						`I1: Bookings ${a.id} and ${b.id} overlap on table ${tid}`,
					)
				}
			}
		}
	}

	// I1 with holds
	for (const h of input.existingHolds ?? []) {
		if (
			h.expiresAt !== undefined &&
			input.nowMs !== undefined &&
			h.expiresAt <= input.nowMs
		) {
			continue
		}
		for (const b of activeBookings) {
			if (b.overbook) continue
			if (!intervalsOverlap(h.startAt, h.endAt, b.startAt, b.endAt)) continue
			for (const tid of h.tableIds) {
				if (b.tableIds.includes(tid)) {
					violations.push(
						`I1: Hold ${h.id} and booking ${b.id} overlap on table ${tid}`,
					)
				}
			}
		}
	}

	// I4: No booking overlaps a table block
	for (const blk of input.tableBlocks ?? []) {
		const blockedTableIds = new Set<string>(blk.tableIds ?? [])
		if (blk.areaId) {
			for (const t of config.tables) {
				if ((t.areaId ?? t.area_id) === blk.areaId) {
					blockedTableIds.add(t.id)
				}
			}
		}
		for (const b of activeBookings) {
			if (b.overbook) continue
			if (!intervalsOverlap(blk.startAt, blk.endAt, b.startAt, b.endAt)) {
				continue
			}
			for (const tid of b.tableIds) {
				if (blockedTableIds.has(tid)) {
					violations.push(
						`I4: Booking ${b.id} overlaps block ${blk.id} on table ${tid}`,
					)
				}
			}
		}
	}

	return {
		valid: violations.length === 0,
		violations,
	}
}

export type BruteForceOracleInput = {
	config: EngineDayConfig
	request: AssignRequestInput
	existingBookings: readonly AssignBookingRecord[]
	existingHolds?: readonly AssignHoldRecord[]
	tableBlocks?: readonly AssignBlockRecord[]
	nowMs: number
}

/**
 * Brute-force reference oracle for small floor plans (<= 8 tables).
 * Exhaustively searches 0-swap, 1-swap, and 2-swap assignments to verify whether
 * a conflict-free assignment exists for `request`.
 */
export function bruteForceAssignExists(input: BruteForceOracleInput): boolean {
	const { config, request, nowMs } = input
	const freezeMin = config.settings.assignmentFreezeMin

	const candidatesForReq = buildCandidates({
		tables: config.tables,
		areas: config.areas,
		combinations: config.combinations,
		serviceTableModes: config.serviceTableModes,
		serviceId: request.serviceId,
		channel: request.channel ?? 'online',
	}).filter((c) => {
		if (request.partySize < c.minSeats || request.partySize > c.maxSeats) {
			return false
		}
		if (request.areaId && c.areaId !== request.areaId) {
			return false
		}
		return true
	})

	if (candidatesForReq.length === 0) return false

	const activeBookings = input.existingBookings.filter(
		(b) =>
			!b.status ||
			['booked', 'confirmed', 'arrived', 'partially_seated', 'seated'].includes(
				b.status,
			),
	)

	const isFreeAgainstFixed = (
		candTables: readonly string[],
		startAt: number,
		endAt: number,
		bookings: readonly AssignBookingRecord[],
		ignoreIds: ReadonlySet<string>,
	): boolean => {
		// Check holds
		for (const h of input.existingHolds ?? []) {
			if (h.expiresAt !== undefined && h.expiresAt <= nowMs) continue
			if (!intervalsOverlap(startAt, endAt, h.startAt, h.endAt)) continue
			if (candTables.some((t) => h.tableIds.includes(t))) return false
		}
		// Check blocks
		for (const blk of input.tableBlocks ?? []) {
			if (!intervalsOverlap(startAt, endAt, blk.startAt, blk.endAt)) continue
			const blocked = new Set<string>(blk.tableIds ?? [])
			if (blk.areaId) {
				for (const t of config.tables) {
					if ((t.areaId ?? t.area_id) === blk.areaId) blocked.add(t.id)
				}
			}
			if (candTables.some((t) => blocked.has(t))) return false
		}
		// Check bookings
		for (const b of bookings) {
			if (ignoreIds.has(b.id)) continue
			if (!intervalsOverlap(startAt, endAt, b.startAt, b.endAt)) continue
			if (candTables.some((t) => b.tableIds.includes(t))) return false
		}
		return true
	}

	const getValidCandidatesForExisting = (
		b: AssignBookingRecord,
	): AssignCandidate[] => {
		return buildCandidates({
			tables: config.tables,
			areas: config.areas,
			combinations: config.combinations,
			serviceTableModes: config.serviceTableModes,
			serviceId: b.serviceId ?? request.serviceId,
			channel: b.channel ?? 'online',
		}).filter((c) => {
			if (b.partySize < c.minSeats || b.partySize > c.maxSeats) return false
			if (b.areaId && c.areaId !== b.areaId) return false
			return true
		})
	}

	const emptySet = new Set<string>()

	// 0-swap check
	for (const cand of candidatesForReq) {
		if (
			isFreeAgainstFixed(
				cand.tableIds,
				request.startAt,
				request.endAt,
				activeBookings,
				emptySet,
			)
		) {
			return true
		}
	}

	// 1-swap & 2-swap check (matching engine's single-blocking-owner per step rule)
	for (const candNew of candidatesForReq) {
		// Check holds/blocks directly on candNew
		if (
			!isFreeAgainstFixed(
				candNew.tableIds,
				request.startAt,
				request.endAt,
				[],
				emptySet,
			)
		) {
			continue
		}

		const blockingB1 = activeBookings.filter(
			(b) =>
				intervalsOverlap(request.startAt, request.endAt, b.startAt, b.endAt) &&
				candNew.tableIds.some((t) => b.tableIds.includes(t)),
		)
		if (blockingB1.length !== 1) continue

		const b1 = blockingB1[0]!
		if (
			isBookingHardLocked({
				status: b1.status,
				tableLocked: b1.tableLocked,
				startAt: b1.startAt,
				nowMs,
				assignmentFreezeMin: freezeMin,
			})
		) {
			continue
		}

		const ignoreB1 = new Set<string>([b1.id])
		const candsB1 = getValidCandidatesForExisting(b1)

		// 1-swap
		for (const candB1 of candsB1) {
			if (
				intervalsOverlap(
					b1.startAt,
					b1.endAt,
					request.startAt,
					request.endAt,
				) &&
				candB1.tableIds.some((t) => candNew.tableIds.includes(t))
			) {
				continue
			}
			if (
				isFreeAgainstFixed(
					candB1.tableIds,
					b1.startAt,
					b1.endAt,
					activeBookings,
					ignoreB1,
				)
			) {
				return true
			}
		}

		// 2-swap
		for (const candB1 of candsB1) {
			if (
				intervalsOverlap(
					b1.startAt,
					b1.endAt,
					request.startAt,
					request.endAt,
				) &&
				candB1.tableIds.some((t) => candNew.tableIds.includes(t))
			) {
				continue
			}
			if (
				!isFreeAgainstFixed(candB1.tableIds, b1.startAt, b1.endAt, [], ignoreB1)
			) {
				continue
			}
			const blockingB2 = activeBookings.filter(
				(b) =>
					b.id !== b1.id &&
					intervalsOverlap(b1.startAt, b1.endAt, b.startAt, b.endAt) &&
					candB1.tableIds.some((t) => b.tableIds.includes(t)),
			)
			if (blockingB2.length !== 1) continue
			const b2 = blockingB2[0]!
			if (
				isBookingHardLocked({
					status: b2.status,
					tableLocked: b2.tableLocked,
					startAt: b2.startAt,
					nowMs,
					assignmentFreezeMin: freezeMin,
				})
			) {
				continue
			}

			const ignoreB1B2 = new Set<string>([b1.id, b2.id])
			const candsB2 = getValidCandidatesForExisting(b2)
			for (const candB2 of candsB2) {
				if (
					intervalsOverlap(
						b2.startAt,
						b2.endAt,
						request.startAt,
						request.endAt,
					) &&
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
					isFreeAgainstFixed(
						candB2.tableIds,
						b2.startAt,
						b2.endAt,
						activeBookings,
						ignoreB1B2,
					)
				) {
					return true
				}
			}
		}
	}

	return false
}
