import { type SeatingPreference, type ServiceTableMode } from '../config.ts'

export type { ServiceTableMode }

export const BOOKING_CHANNELS = [
	'online',
	'native',
	'voice_agent',
	'phone',
	'host',
	'walk_in',
	'waitlist',
	'operator',
	'voice',
] as const

export type BookingChannel = (typeof BOOKING_CHANNELS)[number]

/**
 * Guest-facing channels (`online`, `native`, `voice_agent`, plus legacy `'voice'`)
 * enforce online party limits, horizon/cutoff/notice, online-bookable tables/services,
 * and hard pacing caps (`architecture.md` §6.3, `VAL-FND-006`).
 */
export function isGuestChannel(channel: BookingChannel): boolean {
	return (
		channel === 'online' ||
		channel === 'native' ||
		channel === 'voice_agent' ||
		channel === 'voice'
	)
}

export type CandidateAttributeTag =
	'accessible' | 'high_top' | 'window' | 'booth' | 'patio' | 'bar'

export type AssignCandidate = {
	id: string
	kind: 'single' | 'combo'
	areaId: string
	tableIds: readonly string[]
	minSeats: number
	maxSeats: number
	priority: number
	combinable: boolean
	onlineBookable: boolean
	isOutdoor: boolean
	isBar: boolean
	resetBufferMin?: number
	isAccessible?: boolean
	isHighTop?: boolean
	isWindow?: boolean
	isBooth?: boolean
	isPatio?: boolean
}

export type EngineTableInput = {
	id: string
	areaId?: string
	area_id?: string
	label?: string
	name?: string
	minSeats?: number
	min_seats?: number
	minCovers?: number
	min_covers?: number
	maxSeats?: number
	max_seats?: number
	maxCovers?: number
	max_covers?: number
	resetBufferMin?: number | null
	reset_buffer_min?: number | null
	onlineBookable?: boolean | number
	online_bookable?: boolean | number
	walkInOnly?: boolean | number
	walk_in_only?: boolean | number
	mode?: ServiceTableMode
	combinable?: boolean | number
	priority?: number
	isAccessible?: boolean | number
	is_accessible?: boolean | number
	isHighTop?: boolean | number
	is_high_top?: boolean | number
	isWindow?: boolean | number
	is_window?: boolean | number
	isBooth?: boolean | number
	is_booth?: boolean | number
	isPatio?: boolean | number
	is_patio?: boolean | number
	isBar?: boolean | number
	is_bar?: boolean | number
	active?: boolean | number
}

export type EngineAreaInput = {
	id: string
	name: string
	color?: string
	isOutdoor?: boolean | number
	is_outdoor?: boolean | number
	sortOrder?: number
	sort_order?: number
	active?: boolean | number
}

export type EngineCombinationInput = {
	id: string
	name?: string
	label?: string
	minSeats?: number
	min_seats?: number
	minCovers?: number
	min_covers?: number
	maxSeats?: number
	max_seats?: number
	maxCovers?: number
	max_covers?: number
	priority?: number
	onlineBookable?: boolean | number
	online_bookable?: boolean | number
	active?: boolean | number
	tableIds?: readonly string[]
	table_ids?: readonly string[]
}

export type EngineServiceTableModeInput = {
	id?: string
	serviceId?: string
	service_id?: string
	areaId?: string | null
	area_id?: string | null
	tableId?: string | null
	table_id?: string | null
	combinationId?: string | null
	combination_id?: string | null
	comboId?: string | null
	combo_id?: string | null
	fromMin?: number | null
	from_min?: number | null
	toMin?: number | null
	to_min?: number | null
	mode?: ServiceTableMode
	onlineCapPerInterval?: number | null
	online_cap_per_interval?: number | null
	concurrentCoversCap?: number | null
	concurrent_covers_cap?: number | null
}

export type EngineServiceAvailabilityInput = EngineServiceTableModeInput

function toBool(v: boolean | number | undefined, fallback = true): boolean {
	if (v === undefined) return fallback
	return v === true || v === 1
}

export function isModeAllowedForChannel(
	mode: ServiceTableMode,
	channel: BookingChannel,
): boolean {
	if (mode === 'unavailable') return false
	if (isGuestChannel(channel)) {
		return mode === 'online'
	}
	if (channel === 'walk_in' || channel === 'waitlist') {
		return mode === 'online' || mode === 'staff_only' || mode === 'walk_in_only'
	}
	// phone / host / operator
	return mode === 'online' || mode === 'staff_only'
}

const HARD_LOCKED_STATUSES = new Set([
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
	'finished',
])

/**
 * Determine whether a booking is immovable by repair or reflow (`architecture.md` §6.6 Invariant I5, `VAL-FND-007`):
 *  - `status` is `'partially_arrived' | 'arrived' | 'partially_seated' | 'seated' | 'finished'`
 *  - `tableLocked === true`
 *  - `startAt <= nowMs + assignmentFreezeMin * 60_000`
 */
export function isBookingHardLocked(input: {
	status?: string
	tableLocked?: boolean | number
	startAt: number
	nowMs: number
	assignmentFreezeMin: number
}): boolean {
	if (input.status && HARD_LOCKED_STATUSES.has(input.status)) {
		return true
	}
	if (toBool(input.tableLocked, false)) {
		return true
	}
	const freezeHorizonMs = input.nowMs + input.assignmentFreezeMin * 60_000
	return input.startAt <= freezeHorizonMs
}

/**
 * Build the list of valid single-table and combination candidates for a location
 * (Invariant I1/I2/I3: active tables, active areas, same area for combos, service modes).
 */
export function buildCandidates(input: {
	tables: readonly EngineTableInput[]
	areas?: readonly EngineAreaInput[]
	combinations?: readonly EngineCombinationInput[]
	serviceTableModes?: readonly EngineServiceTableModeInput[]
	serviceAvailability?: readonly EngineServiceAvailabilityInput[]
	serviceId?: string | null
	slotMin?: number | null
	channel?: BookingChannel
}): AssignCandidate[] {
	const channel: BookingChannel = input.channel ?? 'online'
	const activeAreas = new Map<string, { id: string; isOutdoor: boolean }>()
	if (input.areas && input.areas.length > 0) {
		for (const area of input.areas) {
			if (!toBool(area.active, true)) continue
			activeAreas.set(area.id, {
				id: area.id,
				isOutdoor: toBool(area.isOutdoor ?? area.is_outdoor, false),
			})
		}
	}

	const areaModeMap = new Map<string, ServiceTableMode>()
	const tableModeMap = new Map<string, ServiceTableMode>()
	const comboModeMap = new Map<string, ServiceTableMode>()
	const modeRules = input.serviceTableModes ?? input.serviceAvailability
	if (input.serviceId && modeRules) {
		for (const rule of modeRules) {
			const sId = rule.serviceId ?? rule.service_id
			if (sId !== input.serviceId) continue
			if (input.slotMin !== undefined && input.slotMin !== null) {
				const fromMin = rule.fromMin ?? rule.from_min ?? null
				const toMin = rule.toMin ?? rule.to_min ?? null
				if (fromMin !== null && input.slotMin < fromMin) continue
				if (toMin !== null && input.slotMin >= toMin) continue
			}
			const rMode = rule.mode
			if (!rMode) continue
			const aId = rule.areaId ?? rule.area_id ?? null
			const tId = rule.tableId ?? rule.table_id ?? null
			const cId =
				rule.combinationId ??
				rule.combination_id ??
				rule.comboId ??
				rule.combo_id ??
				null
			if (aId) areaModeMap.set(aId, rMode)
			if (tId) tableModeMap.set(tId, rMode)
			if (cId) comboModeMap.set(cId, rMode)
		}
	}

	// Track which tables belong to at least one active combination so single-table
	// scoring knows whether occupying a table breaks a combination.
	const tablesInActiveCombo = new Set<string>()
	for (const combo of input.combinations ?? []) {
		if (!toBool(combo.active, true)) continue
		const ids = combo.tableIds ?? combo.table_ids ?? []
		for (const id of ids) tablesInActiveCombo.add(id)
	}

	const activeTablesById = new Map<
		string,
		{
			id: string
			areaId: string
			minSeats: number
			maxSeats: number
			priority: number
			combinable: boolean
			onlineBookable: boolean
			isOutdoor: boolean
			isBar: boolean
			resetBufferMin: number
			isAccessible: boolean
			isHighTop: boolean
			isWindow: boolean
			isBooth: boolean
			isPatio: boolean
			mode: ServiceTableMode
		}
	>()

	const candidates: AssignCandidate[] = []

	for (const raw of input.tables) {
		if (!toBool(raw.active, true)) continue
		const areaId = raw.areaId ?? raw.area_id ?? 'default'
		if (input.areas && input.areas.length > 0 && !activeAreas.has(areaId)) {
			continue
		}
		const areaInfo = activeAreas.get(areaId)
		const minSeats =
			raw.minSeats ?? raw.min_seats ?? raw.minCovers ?? raw.min_covers ?? 1
		const maxSeats =
			raw.maxSeats ?? raw.max_seats ?? raw.maxCovers ?? raw.max_covers ?? 1
		if (minSeats > maxSeats) continue

		const onlineBookable = toBool(
			raw.onlineBookable ?? raw.online_bookable,
			true,
		)
		const combinable =
			toBool(raw.combinable, false) || tablesInActiveCombo.has(raw.id)
		const priority = raw.priority ?? 0
		const resetBufferMin = Math.max(
			0,
			raw.resetBufferMin ?? raw.reset_buffer_min ?? 0,
		)
		const isPatio = toBool(raw.isPatio ?? raw.is_patio, false)
		const isOutdoor = (areaInfo?.isOutdoor ?? false) || isPatio
		const isBar = toBool(raw.isBar ?? raw.is_bar, false)
		const isAccessible = toBool(raw.isAccessible ?? raw.is_accessible, false)
		const isHighTop = toBool(raw.isHighTop ?? raw.is_high_top, false)
		const isWindow = toBool(raw.isWindow ?? raw.is_window, false)
		const isBooth = toBool(raw.isBooth ?? raw.is_booth, false)

		const walkInOnly = toBool(raw.walkInOnly ?? raw.walk_in_only, false)
		const defaultMode: ServiceTableMode =
			raw.mode ??
			(walkInOnly ? 'walk_in_only' : onlineBookable ? 'online' : 'staff_only')
		const mode =
			tableModeMap.get(raw.id) ?? areaModeMap.get(areaId) ?? defaultMode

		activeTablesById.set(raw.id, {
			id: raw.id,
			areaId,
			minSeats,
			maxSeats,
			priority,
			combinable,
			onlineBookable,
			isOutdoor,
			isBar,
			resetBufferMin,
			isAccessible,
			isHighTop,
			isWindow,
			isBooth,
			isPatio,
			mode,
		})

		if (!isModeAllowedForChannel(mode, channel)) continue
		if (isGuestChannel(channel) && !onlineBookable) {
			continue
		}

		candidates.push({
			id: raw.id,
			kind: 'single',
			areaId,
			tableIds: [raw.id],
			minSeats,
			maxSeats,
			priority,
			combinable,
			onlineBookable,
			isOutdoor,
			isBar,
			resetBufferMin,
			isAccessible,
			isHighTop,
			isWindow,
			isBooth,
			isPatio,
		})
	}

	for (const rawCombo of input.combinations ?? []) {
		if (!toBool(rawCombo.active, true)) continue
		const tableIds = rawCombo.tableIds ?? rawCombo.table_ids ?? []
		if (tableIds.length < 2) continue
		const minSeats =
			rawCombo.minSeats ??
			rawCombo.min_seats ??
			rawCombo.minCovers ??
			rawCombo.min_covers ??
			1
		const maxSeats =
			rawCombo.maxSeats ??
			rawCombo.max_seats ??
			rawCombo.maxCovers ??
			rawCombo.max_covers ??
			1
		if (minSeats > maxSeats) continue

		const comboOnline = toBool(
			rawCombo.onlineBookable ?? rawCombo.online_bookable,
			true,
		)
		const defaultComboMode: ServiceTableMode = comboOnline
			? 'online'
			: 'staff_only'

		let areaId: string | null = null
		let allMembersValid = true
		let allOnlineBookable = comboOnline
		let isOutdoor = false
		let isBar = false
		let isAccessible = true
		let comboResetBufferMin = 0

		for (const tableId of tableIds) {
			const member = activeTablesById.get(tableId)
			if (!member) {
				allMembersValid = false
				break
			}
			if (areaId === null) {
				areaId = member.areaId
			} else if (member.areaId !== areaId) {
				allMembersValid = false
				break
			}
			if (!isModeAllowedForChannel(member.mode, channel)) {
				allMembersValid = false
				break
			}
			if (isGuestChannel(channel) && !member.onlineBookable) {
				allMembersValid = false
				break
			}
			allOnlineBookable = allOnlineBookable && member.onlineBookable
			isOutdoor = isOutdoor || member.isOutdoor
			isBar = isBar || member.isBar
			isAccessible = isAccessible && member.isAccessible
			if (member.resetBufferMin > comboResetBufferMin) {
				comboResetBufferMin = member.resetBufferMin
			}
		}

		if (!allMembersValid || !areaId) continue

		const comboMode =
			comboModeMap.get(rawCombo.id) ??
			areaModeMap.get(areaId) ??
			defaultComboMode
		if (!isModeAllowedForChannel(comboMode, channel)) continue
		if (isGuestChannel(channel) && !comboOnline) {
			continue
		}

		candidates.push({
			id: rawCombo.id,
			kind: 'combo',
			areaId,
			tableIds: [...tableIds].sort(),
			minSeats,
			maxSeats,
			priority: rawCombo.priority ?? 0,
			combinable: true,
			onlineBookable: allOnlineBookable,
			isOutdoor,
			isBar,
			resetBufferMin: comboResetBufferMin,
			isAccessible,
		})
	}

	return candidates
}

export function candidateMatchesPreference(
	candidate: AssignCandidate,
	preference: SeatingPreference | undefined | null,
): boolean {
	if (!preference || preference === 'any') return true
	if (preference === 'outdoor') return candidate.isOutdoor
	if (preference === 'bar') return candidate.isBar
	// 'indoor'
	return !candidate.isOutdoor && !candidate.isBar
}

export const buildDayState = buildCandidates
