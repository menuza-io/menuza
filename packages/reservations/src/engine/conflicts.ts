import { canonicalCombinationSignature } from '../config.ts'
import {
	type EngineAreaInput,
	type EngineCombinationInput,
	type EngineTableInput,
} from './day-state.ts'
import { type BookingChannel, isGuestChannel } from './day-state.ts'
import { intervalsOverlap } from './occupancy.ts'
import { type EnginePacingRuleInput } from './pacing.ts'

export type ConflictKind =
	| 'table_overlap'
	| 'blocked_table'
	| 'archived_table'
	| 'shrunk_capacity'
	| 'unassigned'
	| 'pacing_exceeded'
	| 'outside_service_hours'

export type ConflictItem = {
	kind: ConflictKind
	bookingId?: string
	otherBookingId?: string
	blockId?: string
	tableId?: string
	serviceId?: string | null
	slotMin?: number
	details?: Record<string, unknown>
}

export type ConflictBookingInput = {
	id: string
	status?: string
	channel?: string
	partySize: number
	localStartMin?: number
	/** Business date `localStartMin` is relative to (pacing scope). */
	businessDate?: string
	startAt: number
	endAt: number
	tableIds: readonly string[]
	combinationId?: string | null
	serviceId?: string | null
	areaId?: string | null
	overbook?: boolean | number
}

export type ConflictBlockInput = {
	id: string
	tableIds?: readonly string[]
	areaId?: string | null
	startAt: number
	endAt: number
}

export type ConflictServiceInput = {
	id: string
	name?: string
	startMin?: number
	start_min?: number
	endMin?: number
	end_min?: number
	lastSeatingMin?: number
	last_seating_min?: number
}

export type DetectConflictsInput = {
	tables: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	bookings: readonly ConflictBookingInput[]
	blocks?: readonly ConflictBlockInput[]
	services?: readonly ConflictServiceInput[]
	pacingRules?: readonly EnginePacingRuleInput[]
	/**
	 * Business date being checked. Pacing only counts bookings of this date,
	 * mirroring availability (`evaluatePacing`); physical checks see all.
	 */
	businessDate?: string
	dayClosed?: boolean
}

const CAPACITY_STATUSES = new Set([
	'booked',
	'confirmed',
	'arrived',
	'partially_arrived',
	'partially_seated',
	'seated',
	'pending_payment',
])

function toBool(v: boolean | number | undefined, fallback = true): boolean {
	if (v === undefined) return fallback
	return v === true || v === 1
}

/**
 * Pure conflict detector for a location's day state (`architecture.md` §6.8, `VAL-FND-007`).
 * Detects:
 *  - `table_overlap`: overlapping active bookings on the same table
 *  - `blocked_table`: booking overlapping a table/area block
 *  - `archived_table`: booking assigned to an inactive table or inactive area
 *  - `shrunk_capacity`: non-overbooked booking outside `[minSeats, maxSeats]` of its assigned table/combo
 *  - `unassigned`: active capacity-consuming booking with `tableIds.length === 0`
 *  - `pacing_exceeded`: slot or service exceeding pacing caps
 *  - `outside_service_hours`: booking outside resolved service windows or on a closed day
 */
export function detectConflicts(input: DetectConflictsInput): ConflictItem[] {
	const conflicts: ConflictItem[] = []

	const areaActive = new Map<string, boolean>()
	for (const area of input.areas ?? []) {
		areaActive.set(area.id, toBool(area.active, true))
	}

	const tableMap = new Map<
		string,
		{
			id: string
			areaId: string
			minSeats: number
			maxSeats: number
			active: boolean
		}
	>()
	for (const t of input.tables) {
		const areaId = t.areaId ?? t.area_id ?? 'default'
		const isAreaActive = areaActive.get(areaId) ?? true
		tableMap.set(t.id, {
			id: t.id,
			areaId,
			minSeats: t.minSeats ?? t.min_seats ?? 1,
			maxSeats: t.maxSeats ?? t.max_seats ?? 1,
			active: toBool(t.active, true) && isAreaActive,
		})
	}

	const comboBySig = new Map<
		string,
		{ id: string; minSeats: number; maxSeats: number; active: boolean }
	>()
	const comboById = new Map<
		string,
		{ id: string; minSeats: number; maxSeats: number; active: boolean }
	>()
	for (const c of input.combinations ?? []) {
		const entry = {
			id: c.id,
			minSeats: c.minSeats ?? c.min_seats ?? 1,
			maxSeats: c.maxSeats ?? c.max_seats ?? 1,
			active: toBool(c.active, true),
		}
		comboById.set(c.id, entry)
		const ids = c.tableIds ?? c.table_ids ?? []
		if (ids.length >= 2) {
			comboBySig.set(canonicalCombinationSignature(ids), entry)
		}
	}

	const activeBookings = input.bookings.filter((b) =>
		b.status ? CAPACITY_STATUSES.has(b.status) : true,
	)

	// Expand area blocks into tableIds
	const expandedBlocks: Array<{
		id: string
		tableIds: string[]
		startAt: number
		endAt: number
	}> = []
	for (const blk of input.blocks ?? []) {
		const tids = blk.tableIds ? [...blk.tableIds] : []
		if (blk.areaId) {
			for (const t of tableMap.values()) {
				if (t.areaId === blk.areaId && !tids.includes(t.id)) {
					tids.push(t.id)
				}
			}
		}
		expandedBlocks.push({
			id: blk.id,
			tableIds: tids,
			startAt: blk.startAt,
			endAt: blk.endAt,
		})
	}

	const serviceById = new Map<
		string,
		{ startMin: number; endMin: number; lastSeatingMin: number }
	>()
	for (const s of input.services ?? []) {
		const startMin = s.startMin ?? s.start_min ?? 0
		const rawEnd = s.endMin ?? s.end_min ?? 1440
		const endMin = rawEnd <= startMin ? rawEnd + 1440 : rawEnd
		const lastSeatingMin = s.lastSeatingMin ?? s.last_seating_min ?? endMin
		serviceById.set(s.id, { startMin, endMin, lastSeatingMin })
	}

	// Per-booking checks: unassigned, archived_table, shrunk_capacity, blocked_table, outside_service_hours
	for (const b of activeBookings) {
		const isOverbook = toBool(b.overbook, false)

		if (b.tableIds.length === 0) {
			conflicts.push({
				kind: 'unassigned',
				bookingId: b.id,
				serviceId: b.serviceId ?? null,
			})
		} else {
			let anyArchived = false
			for (const tid of b.tableIds) {
				const t = tableMap.get(tid)
				if (!t || !t.active) {
					anyArchived = true
					conflicts.push({
						kind: 'archived_table',
						bookingId: b.id,
						tableId: tid,
						serviceId: b.serviceId ?? null,
					})
				}
			}

			if (!anyArchived && !isOverbook) {
				if (b.tableIds.length === 1) {
					const t = tableMap.get(b.tableIds[0]!)
					if (t && (b.partySize < t.minSeats || b.partySize > t.maxSeats)) {
						conflicts.push({
							kind: 'shrunk_capacity',
							bookingId: b.id,
							tableId: t.id,
							details: {
								partySize: b.partySize,
								minSeats: t.minSeats,
								maxSeats: t.maxSeats,
							},
						})
					}
				} else {
					const sig = canonicalCombinationSignature(b.tableIds)
					const combo =
						(b.combinationId ? comboById.get(b.combinationId) : undefined) ??
						comboBySig.get(sig)
					if (!combo || !combo.active) {
						const sumMax = b.tableIds.reduce(
							(acc, id) => acc + (tableMap.get(id)?.maxSeats ?? 0),
							0,
						)
						if (b.partySize > sumMax) {
							conflicts.push({
								kind: 'shrunk_capacity',
								bookingId: b.id,
								details: { partySize: b.partySize, maxSeats: sumMax },
							})
						}
					} else if (
						b.partySize < combo.minSeats ||
						b.partySize > combo.maxSeats
					) {
						conflicts.push({
							kind: 'shrunk_capacity',
							bookingId: b.id,
							details: {
								partySize: b.partySize,
								minSeats: combo.minSeats,
								maxSeats: combo.maxSeats,
							},
						})
					}
				}
			}

			// Check blocks
			for (const blk of expandedBlocks) {
				if (!intervalsOverlap(b.startAt, b.endAt, blk.startAt, blk.endAt)) {
					continue
				}
				for (const tid of b.tableIds) {
					if (blk.tableIds.includes(tid)) {
						conflicts.push({
							kind: 'blocked_table',
							bookingId: b.id,
							blockId: blk.id,
							tableId: tid,
						})
					}
				}
			}
		}

		// Check service hours
		if (input.dayClosed) {
			conflicts.push({
				kind: 'outside_service_hours',
				bookingId: b.id,
				serviceId: b.serviceId ?? null,
			})
		} else if (
			b.localStartMin !== undefined &&
			input.services &&
			input.services.length > 0
		) {
			if (b.serviceId && serviceById.has(b.serviceId)) {
				const srv = serviceById.get(b.serviceId)!
				if (b.localStartMin < srv.startMin || b.localStartMin >= srv.endMin) {
					conflicts.push({
						kind: 'outside_service_hours',
						bookingId: b.id,
						serviceId: b.serviceId,
						slotMin: b.localStartMin,
					})
				}
			} else {
				const fitsAny = [...serviceById.values()].some(
					(srv) =>
						b.localStartMin! >= srv.startMin && b.localStartMin! < srv.endMin,
				)
				if (!fitsAny) {
					conflicts.push({
						kind: 'outside_service_hours',
						bookingId: b.id,
						slotMin: b.localStartMin,
					})
				}
			}
		}
	}

	// Check pairwise table overlaps
	for (let i = 0; i < activeBookings.length; i++) {
		const a = activeBookings[i]!
		for (let j = i + 1; j < activeBookings.length; j++) {
			const b = activeBookings[j]!
			if (!intervalsOverlap(a.startAt, a.endAt, b.startAt, b.endAt)) continue
			for (const tid of a.tableIds) {
				if (b.tableIds.includes(tid)) {
					conflicts.push({
						kind: 'table_overlap',
						bookingId: a.id,
						otherBookingId: b.id,
						tableId: tid,
					})
				}
			}
		}
	}

	// Check pacing rules
	for (const rule of input.pacingRules ?? []) {
		const sId = rule.serviceId ?? rule.service_id ?? null
		const rArea = rule.areaId ?? rule.area_id ?? null
		const wStart = rule.windowStartMin ?? rule.window_start_min ?? null
		const wEnd = rule.windowEndMin ?? rule.window_end_min ?? null
		const maxCoversSlot =
			rule.maxCoversPerSlot ?? rule.max_covers_per_slot ?? null
		const maxPartiesSlot =
			rule.maxPartiesPerSlot ?? rule.max_parties_per_slot ?? null
		const maxOnlineService =
			rule.maxOnlineCoversForService ??
			rule.max_online_covers_for_service ??
			null

		const inService = activeBookings.filter((b) => {
			if (
				input.businessDate !== undefined &&
				b.businessDate !== undefined &&
				b.businessDate !== input.businessDate
			) {
				return false
			}
			if (sId && b.serviceId && b.serviceId !== sId) return false
			if (rArea && b.areaId && b.areaId !== rArea) return false
			return true
		})

		if (maxOnlineService !== null) {
			const onlineCovers = inService
				.filter((b) =>
					isGuestChannel((b.channel ?? 'online') as BookingChannel),
				)
				.reduce((acc, b) => acc + b.partySize, 0)
			if (onlineCovers > maxOnlineService) {
				conflicts.push({
					kind: 'pacing_exceeded',
					serviceId: sId,
					details: {
						metric: 'online_covers_for_service',
						actual: onlineCovers,
						limit: maxOnlineService,
					},
				})
			}
		}

		if (maxCoversSlot !== null || maxPartiesSlot !== null) {
			const bySlot = new Map<number, ConflictBookingInput[]>()
			for (const b of inService) {
				if (b.localStartMin === undefined) continue
				if (wStart !== null && b.localStartMin < wStart) continue
				if (wEnd !== null && b.localStartMin >= wEnd) continue
				const list = bySlot.get(b.localStartMin) ?? []
				list.push(b)
				bySlot.set(b.localStartMin, list)
			}
			for (const [slotMin, list] of bySlot.entries()) {
				const covers = list.reduce((acc, b) => acc + b.partySize, 0)
				const parties = list.length
				if (
					(maxCoversSlot !== null && covers > maxCoversSlot) ||
					(maxPartiesSlot !== null && parties > maxPartiesSlot)
				) {
					conflicts.push({
						kind: 'pacing_exceeded',
						serviceId: sId,
						slotMin,
						details: {
							covers,
							maxCoversPerSlot: maxCoversSlot,
							parties,
							maxPartiesPerSlot: maxPartiesSlot,
						},
					})
				}
			}
		}
	}

	return conflicts
}
