import {
	type AssignBlockRecord,
	type AssignBookingRecord,
	type AssignHoldRecord,
	type AssignRequestInput,
	type TableSwap,
} from '../engine/assign.ts'
import { type EngineDayConfig } from '../engine/availability.ts'
import {
	type AssignCandidate,
	type BookingChannel,
	type ServiceTableMode,
	buildCandidates,
	isBookingHardLocked,
	isGuestChannel,
	isModeAllowedForChannel,
} from '../engine/day-state.ts'
import { intervalsOverlap } from '../engine/occupancy.ts'
import { evaluatePacing } from '../engine/pacing.ts'

export type VerifyDayInvariantsInput = {
	config: EngineDayConfig
	existingBookings: readonly AssignBookingRecord[]
	previousBookings?: readonly AssignBookingRecord[]
	reassignedMoves?: readonly TableSwap[]
	existingHolds?: readonly AssignHoldRecord[]
	tableBlocks?: readonly AssignBlockRecord[]
	nowMs?: number
	/** Optional I1/I7 check: slots returned by searchAvailability */
	searchedSlots?: ReadonlyArray<{
		slotMin: number
		startAt: number
		endAt: number
		serviceId: string
		areaId: string | null
		tableIds: readonly string[]
		combinationId: string | null
	}>
	/** Optional I6 check: snapshot before and after a failed modify */
	failedModifyCheck?: {
		before: readonly AssignBookingRecord[]
		after: readonly AssignBookingRecord[]
	}
	/** Optional I7 check: whether every searched slot could be immediately held */
	searchHoldCheck?: {
		failedSlots: readonly number[]
	}
	/** Optional I8 check: available slot minutes before and after a release (cancel/finish/expire/shrink) */
	releaseMonotonicityCheck?: {
		slotsBefore: readonly number[]
		slotsAfter: readonly number[]
	}
}

export type VerifyDayInvariantsResult = {
	valid: boolean
	violations: string[]
}

const ACTIVE_INVARIANT_STATUSES = new Set([
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
])

/**
 * Independent invariant verifier for canonical Invariants I1-I8 (`architecture.md` §1.2, `VAL-FND-009`):
 * - I1: Seating witness (single table or declared combination, capacity, mode/channel, area, service window)
 * - I2: No double booking on half-open [startAt, endAt) (including table blocks and valid interval bounds)
 * - I3: Online/guest never borrows capacity from staff overbook (and pacing caps include overbooks)
 * - I4: Live holds (expiresAt > nowMs) reserve tables like bookings; expired holds (expiresAt <= nowMs) do not
 * - I5: Hard-locked reservations (tableLocked, arrived/seated/finished, or within assignmentFreezeMin) never move
 * - I6: Failed modify leaves existing reservation and occupancies untouched
 * - I7: Any slot returned by searchAvailability can be held immediately against the same state and clock
 * - I8: Cancel, finish early, hold expiry, or party-size shrink never removes availability
 */
export function verifyDayInvariants(
	input: VerifyDayInvariantsInput,
): VerifyDayInvariantsResult {
	const violations: string[] = []
	const { config } = input
	const nowMs = input.nowMs ?? 0
	const activeBookings = input.existingBookings.filter(
		(b) => !b.status || ACTIVE_INVARIANT_STATUSES.has(b.status),
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
	const servicesById = new Map(config.services.map((s) => [s.id, s] as const))
	const serviceModes = config.serviceAvailability ?? config.serviceTableModes

	// I1 & I2 (bounds): Seating witness (valid single table or declared combination, party size bounds, active area, mode/channel, service window)
	for (const b of activeBookings) {
		if (b.startAt >= b.endAt) {
			violations.push(
				`I2: Booking ${b.id} has invalid interval [${b.startAt}, ${b.endAt})`,
			)
		}

		if (b.tableIds.length === 0) {
			violations.push(`I1: Booking ${b.id} has no assigned tables`)
			continue
		}
		const memberAreas = new Set<string>()
		for (const tid of b.tableIds) {
			const table = activeTablesById.get(tid)
			if (!table) {
				violations.push(`I1: Booking ${b.id} references inactive table ${tid}`)
				continue
			}
			const areaId = table.areaId ?? table.area_id ?? ''
			memberAreas.add(areaId)
			if (!activeAreasById.has(areaId)) {
				violations.push(
					`I1: Booking ${b.id} table ${tid} is in inactive area ${areaId}`,
				)
			}
		}
		if (memberAreas.size > 1) {
			violations.push(
				`I1: Booking ${b.id} spans tables across multiple areas (${[...memberAreas].join(', ')})`,
			)
		}

		const channel: BookingChannel = b.channel ?? 'online'

		if (b.tableIds.length === 1) {
			const table = activeTablesById.get(b.tableIds[0]!)
			if (table) {
				const minS =
					table.minCovers ??
					table.min_covers ??
					table.minSeats ??
					table.min_seats ??
					1
				const maxS =
					table.maxCovers ??
					table.max_covers ??
					table.maxSeats ??
					table.max_seats ??
					99
				if (!b.overbook && (b.partySize < minS || b.partySize > maxS)) {
					violations.push(
						`I1: Booking ${b.id} partySize ${b.partySize} outside single table ${table.id} [${minS}, ${maxS}]`,
					)
				}
				if (!b.overbook) {
					const onlineBookable =
						(table.onlineBookable ?? table.online_bookable ?? true) !== false &&
						(table.onlineBookable ?? table.online_bookable ?? 1) !== 0
					const areaId = table.areaId ?? table.area_id ?? ''
					const modeRule =
						serviceModes.find(
							(m) =>
								(m.serviceId ?? m.service_id) === b.serviceId &&
								(m.tableId ?? m.table_id) === table.id,
						) ??
						serviceModes.find(
							(m) =>
								(m.serviceId ?? m.service_id) === b.serviceId &&
								(m.areaId ?? m.area_id) === areaId &&
								!(m.tableId ?? m.table_id) &&
								!(
									m.combinationId ??
									m.combination_id ??
									m.comboId ??
									m.combo_id
								),
						)
					const mode: ServiceTableMode =
						modeRule?.mode ?? (onlineBookable ? 'online' : 'staff_only')
					if (
						!isModeAllowedForChannel(mode, channel) ||
						(isGuestChannel(channel) && !onlineBookable)
					) {
						violations.push(
							`I1: Booking ${b.id} on table ${table.id} (mode=${mode}) is not allowed for channel ${channel}`,
						)
					}
				}
			}
		} else if (b.combinationId) {
			const combo = activeCombosById.get(b.combinationId)
			if (!combo) {
				violations.push(
					`I1: Booking ${b.id} references inactive combination ${b.combinationId}`,
				)
			} else {
				const minS =
					combo.minCovers ??
					combo.min_covers ??
					combo.minSeats ??
					combo.min_seats ??
					1
				const maxS =
					combo.maxCovers ??
					combo.max_covers ??
					combo.maxSeats ??
					combo.max_seats ??
					99
				if (!b.overbook && (b.partySize < minS || b.partySize > maxS)) {
					violations.push(
						`I1: Booking ${b.id} partySize ${b.partySize} outside combo ${combo.id} [${minS}, ${maxS}]`,
					)
				}
				if (!b.overbook) {
					const onlineBookable =
						(combo.onlineBookable ?? combo.online_bookable ?? true) !== false &&
						(combo.onlineBookable ?? combo.online_bookable ?? 1) !== 0
					const modeRule = serviceModes.find(
						(m) =>
							(m.serviceId ?? m.service_id) === b.serviceId &&
							(m.combinationId ??
								m.combination_id ??
								m.comboId ??
								m.combo_id) === combo.id,
					)
					const mode: ServiceTableMode =
						modeRule?.mode ?? (onlineBookable ? 'online' : 'staff_only')
					if (
						!isModeAllowedForChannel(mode, channel) ||
						(isGuestChannel(channel) && !onlineBookable)
					) {
						violations.push(
							`I1: Booking ${b.id} on combo ${combo.id} (mode=${mode}) is not allowed for channel ${channel}`,
						)
					}
				}
			}
		} else if (!b.overbook) {
			violations.push(
				`I1: Multi-table booking ${b.id} has no declared combinationId`,
			)
		}

		// I1: Service window check for guest bookings with localStartMin
		if (!b.overbook && b.serviceId && b.localStartMin !== undefined) {
			const svc = servicesById.get(b.serviceId)
			if (svc && isGuestChannel(channel)) {
				const startMin = svc.startMin ?? svc.start_min ?? 0
				const firstMin =
					svc.firstSeatingMin ?? svc.first_seating_min ?? startMin
				const rawLastMin =
					svc.lastSeatingMin ??
					svc.last_seating_min ??
					svc.endMin ??
					svc.end_min ??
					1440
				const lastMin = rawLastMin < startMin ? rawLastMin + 1440 : rawLastMin
				if (b.localStartMin < firstMin || b.localStartMin > lastMin) {
					violations.push(
						`I1: Booking ${b.id} localStartMin ${b.localStartMin} outside service ${svc.id} seating window [${firstMin}, ${lastMin}]`,
					)
				}
			}
		}
	}

	// I1: Searched slots must also have explicit seating witnesses
	for (const slot of input.searchedSlots ?? []) {
		if (!slot.tableIds || slot.tableIds.length === 0) {
			violations.push(
				`I1: Searched slot ${slot.slotMin} has no seating witness tableIds`,
			)
		}
	}

	// I2 & I3: No table double-booking on half-open [startAt, endAt), and online never borrows capacity from staff overbook
	for (let i = 0; i < activeBookings.length; i++) {
		const a = activeBookings[i]!
		for (let j = i + 1; j < activeBookings.length; j++) {
			const b = activeBookings[j]!
			if (!intervalsOverlap(a.startAt, a.endAt, b.startAt, b.endAt)) continue
			for (const tid of a.tableIds) {
				if (!b.tableIds.includes(tid)) continue
				if (!a.overbook && !b.overbook) {
					violations.push(
						`I2: Bookings ${a.id} and ${b.id} overlap on table ${tid}`,
					)
				} else {
					const aGuest = !a.overbook && isGuestChannel(a.channel ?? 'online')
					const bGuest = !b.overbook && isGuestChannel(b.channel ?? 'online')
					if (aGuest || bGuest) {
						violations.push(
							`I3: Guest booking overlaps staff overbook (${a.id} vs ${b.id}) on table ${tid}`,
						)
					}
				}
			}
		}
	}

	// I2: No non-overbook booking overlaps a table block
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
						`I2: Booking ${b.id} overlaps block ${blk.id} on table ${tid}`,
					)
				}
			}
		}
	}

	// I3: Pacing caps respected for guest bookings (counting prior bookings including overbooks)
	if (config.pacingRules.length > 0 || serviceModes.length > 0) {
		for (let i = 0; i < activeBookings.length; i++) {
			const b = activeBookings[i]!
			if (b.overbook) continue
			const channel: BookingChannel = b.channel ?? 'online'
			if (!isGuestChannel(channel)) continue
			if (!b.serviceId || b.localStartMin === undefined) continue
			const prior = activeBookings.slice(0, i).map((p) => ({
				id: p.id,
				serviceId: p.serviceId,
				areaId: p.areaId,
				channel: p.channel ?? 'online',
				partySize: p.partySize,
				localStartMin: p.localStartMin,
				startAt: p.startAt,
				endAt: p.endAt,
				status: p.status,
			}))
			const pace = evaluatePacing({
				serviceId: b.serviceId,
				slotMin: b.localStartMin,
				startAt: b.startAt,
				endAt: b.endAt,
				partySize: b.partySize,
				channel,
				areaId: b.areaId ?? null,
				rules: config.pacingRules,
				serviceAvailability: serviceModes,
				existing: prior,
			})
			if (!pace.allowed) {
				violations.push(
					`I3: Booking ${b.id} violates guest pacing (${pace.reason ?? 'pacing_exceeded'})`,
				)
			}
		}
	}

	// I4: Live holds (expiresAt > nowMs) reserve tables like confirmed reservations; expired holds do not
	const liveHolds = (input.existingHolds ?? []).filter(
		(h) =>
			h.expiresAt === undefined ||
			input.nowMs === undefined ||
			h.expiresAt > input.nowMs,
	)
	for (let i = 0; i < liveHolds.length; i++) {
		const h = liveHolds[i]!
		for (const b of activeBookings) {
			if (b.overbook) continue
			if (!intervalsOverlap(h.startAt, h.endAt, b.startAt, b.endAt)) continue
			for (const tid of h.tableIds) {
				if (b.tableIds.includes(tid)) {
					violations.push(
						`I4: Live hold ${h.id} and booking ${b.id} overlap on table ${tid}`,
					)
				}
			}
		}
		for (let j = i + 1; j < liveHolds.length; j++) {
			const h2 = liveHolds[j]!
			if (!intervalsOverlap(h.startAt, h.endAt, h2.startAt, h2.endAt)) continue
			for (const tid of h.tableIds) {
				if (h2.tableIds.includes(tid)) {
					violations.push(
						`I4: Live holds ${h.id} and ${h2.id} overlap on table ${tid}`,
					)
				}
			}
		}
	}

	// I5: Hard-locked bookings never change tables across transitions/repairs/reflows
	if (input.previousBookings) {
		const currentById = new Map(
			input.existingBookings.map((b) => [b.id, b] as const),
		)
		for (const prev of input.previousBookings) {
			if (prev.status && !ACTIVE_INVARIANT_STATUSES.has(prev.status)) continue
			const hardLocked = isBookingHardLocked({
				status: prev.status,
				tableLocked: prev.tableLocked,
				startAt: prev.startAt,
				nowMs,
				assignmentFreezeMin: config.settings.assignmentFreezeMin,
			})
			if (!hardLocked) continue
			const curr = currentById.get(prev.id)
			if (!curr) continue
			const prevTables = [...prev.tableIds].sort().join(',')
			const currTables = [...curr.tableIds].sort().join(',')
			if (prevTables !== currTables) {
				violations.push(
					`I5: Hard-locked booking ${prev.id} moved from [${prevTables}] to [${currTables}]`,
				)
			}
		}
	}

	// I6: Failed modify leaves existing reservation and occupancies untouched
	if (input.failedModifyCheck) {
		const { before, after } = input.failedModifyCheck
		if (before.length !== after.length) {
			violations.push(
				`I6: Failed modify changed booking count from ${before.length} to ${after.length}`,
			)
		} else {
			for (let i = 0; i < before.length; i++) {
				const b0 = before[i]!
				const b1 = after[i]!
				const t0 = [...b0.tableIds].sort().join(',')
				const t1 = [...b1.tableIds].sort().join(',')
				if (
					b0.id !== b1.id ||
					b0.startAt !== b1.startAt ||
					b0.endAt !== b1.endAt ||
					b0.partySize !== b1.partySize ||
					t0 !== t1
				) {
					violations.push(
						`I6: Failed modify mutated booking ${b0.id} (${t0}@${b0.startAt} -> ${t1}@${b1.startAt})`,
					)
				}
			}
		}
	}

	// I7: Search -> hold consistency
	if (input.searchHoldCheck && input.searchHoldCheck.failedSlots.length > 0) {
		violations.push(
			`I7: Searched slots could not be held immediately: ${input.searchHoldCheck.failedSlots.join(', ')}`,
		)
	}

	// I8: Monotonicity under release (cancel, finish, hold expiry, shrink)
	if (input.releaseMonotonicityCheck) {
		const afterSet = new Set(input.releaseMonotonicityCheck.slotsAfter)
		for (const s of input.releaseMonotonicityCheck.slotsBefore) {
			if (!afterSet.has(s)) {
				violations.push(
					`I8: Previously available slot ${s} became unavailable after release`,
				)
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
		(b) => !b.status || ACTIVE_INVARIANT_STATUSES.has(b.status),
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
