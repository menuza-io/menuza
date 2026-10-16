import { canonicalCombinationSignature, INTERVAL_MIN_VALUES } from './index.ts'

export type ConfigValidationSeverity = 'error' | 'warning'

export type ConfigValidationIssueCode =
	| 'invalid_interval_min'
	| 'invalid_horizon_days'
	| 'invalid_party_bounds'
	| 'duplicate_table_label'
	| 'invalid_table_seats'
	| 'unseatable_party_size'
	| 'combination_too_few_members'
	| 'combination_invalid_seats'
	| 'combination_missing_table'
	| 'combination_archived_table'
	| 'combination_uncombinable_table'
	| 'combination_cross_area'
	| 'combination_duplicate_members'
	| 'service_invalid_window'
	| 'service_duration_exceeds_24h'
	| 'service_last_seating_after_end'
	| 'service_last_seating_before_start'
	| 'turn_time_bucket_invalid_range'
	| 'turn_time_bucket_overlap'
	| 'turn_time_bucket_gap'
	| 'pacing_cap_below_min_party'
	| 'policy_unknown_service'
	| 'policy_party_bounds_inverted'
	| 'policy_invalid_window'
	| 'block_invalid_window'
	| 'block_unknown_table'

export type ConfigValidationIssue = {
	code: ConfigValidationIssueCode
	severity: ConfigValidationSeverity
	field?: string
	entityId?: string
	partySize?: number
	serviceId?: string | null
	details?: Record<string, unknown>
}

export type ConfigIssue = ConfigValidationIssue

export type ValidateConfigInput = {
	settings: {
		minParty?: number
		min_party?: number
		maxOnlineParty?: number
		max_online_party?: number
		maxParty?: number
		max_party?: number
		intervalMin?: number
		interval_min?: number
		horizonDays?: number
		horizon_days?: number
		defaultTurnMin?: number
		default_turn_min?: number
	}
	areas?: ReadonlyArray<{
		id: string
		name: string
		active?: boolean | number
	}>
	tables: ReadonlyArray<{
		id: string
		areaId?: string
		area_id?: string
		label: string
		minSeats?: number
		min_seats?: number
		maxSeats?: number
		max_seats?: number
		onlineBookable?: boolean | number
		online_bookable?: boolean | number
		combinable?: boolean | number
		active?: boolean | number
	}>
	combinations?: ReadonlyArray<{
		id: string
		name?: string
		minSeats?: number
		min_seats?: number
		maxSeats?: number
		max_seats?: number
		onlineBookable?: boolean | number
		online_bookable?: boolean | number
		active?: boolean | number
		tableIds?: readonly string[]
		table_ids?: readonly string[]
	}>
	services?: ReadonlyArray<{
		id: string
		name?: string
		startMin?: number
		start_min?: number
		firstSeatingMin?: number
		first_seating_min?: number
		endMin?: number
		end_min?: number
		lastSeatingMin?: number
		last_seating_min?: number
		onlineBookable?: boolean | number
		online_bookable?: boolean | number
		active?: boolean | number
	}>
	turnTimeBuckets?: ReadonlyArray<{
		id: string
		serviceId?: string | null
		service_id?: string | null
		minParty?: number
		min_party?: number
		maxParty?: number
		max_party?: number
		durationMin?: number
		duration_min?: number
	}>
	pacingRules?: ReadonlyArray<{
		id: string
		serviceId?: string
		service_id?: string
		maxCoversPerSlot?: number | null
		max_covers_per_slot?: number | null
		maxPartiesPerSlot?: number | null
		max_parties_per_slot?: number | null
		maxOnlineCoversForService?: number | null
		max_online_covers_for_service?: number | null
	}>
	policies?: ReadonlyArray<{
		id: string
		mode?: string
		amountPerCoverMinor?: number
		currency?: string
		cancelCutoffMin?: number
		serviceId?: string | null
		service_id?: string | null
		minParty?: number
		min_party?: number
		maxParty?: number | null
		max_party?: number | null
		windowStartMin?: number | null
		window_start_min?: number | null
		windowEndMin?: number | null
		window_end_min?: number | null
		priority?: number
		active?: boolean | number
	}>
	blocks?: ReadonlyArray<{
		id: string
		businessDate?: string
		tableId?: string | null
		table_id?: string | null
		tableIds?: readonly string[]
		areaId?: string | null
		area_id?: string | null
		startMin?: number
		endMin?: number
		startAt?: number
		endAt?: number
		startAtMs?: number
		start_at?: number
		endAtMs?: number
		end_at?: number
		reason?: string | null
	}>
}

export type ValidateConfigReport = {
	valid: boolean
	issues: ConfigValidationIssue[]
	errors: ConfigValidationIssue[]
	warnings: ConfigValidationIssue[]
}

export type ValidateConfigResult = ConfigIssue[] & ValidateConfigReport

function isTruthyActive(value: boolean | number | undefined): boolean {
	if (value === undefined) return true
	return value === true || value === 1
}

/**
 * Pure configuration validator for a location's reservations setup (`VAL-FND-004`).
 * Returns `ConfigIssue[]` directly (with `.valid`, `.issues`, `.errors`, and `.warnings`
 * attached as non-enumerable convenience properties on the returned array).
 */
export function validateConfig(
	input: ValidateConfigInput,
): ValidateConfigResult {
	const issues: ConfigValidationIssue[] = []

	const minParty = input.settings.minParty ?? input.settings.min_party ?? 1
	const maxOnlineParty =
		input.settings.maxOnlineParty ?? input.settings.max_online_party ?? 8
	const maxParty = input.settings.maxParty ?? input.settings.max_party ?? 16
	const intervalMin =
		input.settings.intervalMin ?? input.settings.interval_min ?? 15
	const horizonDays =
		input.settings.horizonDays ?? input.settings.horizon_days ?? 60

	if (!(INTERVAL_MIN_VALUES as readonly number[]).includes(intervalMin)) {
		issues.push({
			code: 'invalid_interval_min',
			severity: 'error',
			field: 'settings.intervalMin',
			details: { intervalMin },
		})
	}
	if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 365) {
		issues.push({
			code: 'invalid_horizon_days',
			severity: 'error',
			field: 'settings.horizonDays',
			details: { horizonDays },
		})
	}
	if (minParty < 1 || minParty > maxOnlineParty || maxOnlineParty > maxParty) {
		issues.push({
			code: 'invalid_party_bounds',
			severity: 'error',
			field: 'settings.minParty',
			details: { minParty, maxOnlineParty, maxParty },
		})
	}

	const tableById = new Map<
		string,
		{
			id: string
			areaId: string
			label: string
			minSeats: number
			maxSeats: number
			onlineBookable: boolean
			combinable: boolean
			active: boolean
		}
	>()
	const activeLabelMap = new Map<string, string>()

	for (const rawTable of input.tables) {
		const areaId = rawTable.areaId ?? rawTable.area_id ?? ''
		const minSeats = rawTable.minSeats ?? rawTable.min_seats ?? 1
		const maxSeats = rawTable.maxSeats ?? rawTable.max_seats ?? 1
		const onlineBookable = isTruthyActive(
			rawTable.onlineBookable ?? rawTable.online_bookable,
		)
		const combinable = isTruthyActive(rawTable.combinable)
		const active = isTruthyActive(rawTable.active)

		tableById.set(rawTable.id, {
			id: rawTable.id,
			areaId,
			label: rawTable.label,
			minSeats,
			maxSeats,
			onlineBookable,
			combinable,
			active,
		})

		if (minSeats > maxSeats || minSeats < 1) {
			issues.push({
				code: 'invalid_table_seats',
				severity: 'error',
				field: 'tables.minSeats',
				entityId: rawTable.id,
			})
		}

		if (active) {
			const normLabel = rawTable.label.trim().toLowerCase()
			const existingId = activeLabelMap.get(normLabel)
			if (existingId && existingId !== rawTable.id) {
				issues.push({
					code: 'duplicate_table_label',
					severity: 'error',
					field: 'tables.label',
					entityId: rawTable.id,
					details: { conflictingTableId: existingId },
				})
			} else {
				activeLabelMap.set(normLabel, rawTable.id)
			}
		}
	}

	const validActiveCombos: Array<{
		id: string
		minSeats: number
		maxSeats: number
		onlineBookable: boolean
	}> = []
	const seenComboSignatures = new Map<string, string>()

	for (const rawCombo of input.combinations ?? []) {
		const active = isTruthyActive(rawCombo.active)
		const minSeats = rawCombo.minSeats ?? rawCombo.min_seats ?? 1
		const maxSeats = rawCombo.maxSeats ?? rawCombo.max_seats ?? 1
		const onlineBookable = isTruthyActive(
			rawCombo.onlineBookable ?? rawCombo.online_bookable,
		)
		const tableIds = rawCombo.tableIds ?? rawCombo.table_ids ?? []

		if (minSeats > maxSeats || minSeats < 1) {
			issues.push({
				code: 'combination_invalid_seats',
				severity: 'error',
				field: 'combinations.minSeats',
				entityId: rawCombo.id,
			})
		}

		const distinctIds = [...new Set(tableIds)]
		if (distinctIds.length < 2 || distinctIds.length !== tableIds.length) {
			issues.push({
				code: 'combination_too_few_members',
				severity: 'error',
				field: 'combinations.tableIds',
				entityId: rawCombo.id,
			})
			continue
		}

		let membersValid = true
		let areaId: string | null = null
		for (const tableId of distinctIds) {
			const table = tableById.get(tableId)
			if (!table) {
				issues.push({
					code: 'combination_missing_table',
					severity: 'error',
					field: 'combinations.tableIds',
					entityId: rawCombo.id,
					details: { tableId },
				})
				membersValid = false
				continue
			}
			if (!table.active) {
				issues.push({
					code: 'combination_archived_table',
					severity: 'error',
					field: 'combinations.tableIds',
					entityId: rawCombo.id,
					details: { tableId },
				})
				membersValid = false
			}
			if (!table.combinable) {
				issues.push({
					code: 'combination_uncombinable_table',
					severity: 'warning',
					field: 'combinations.tableIds',
					entityId: rawCombo.id,
					details: { tableId },
				})
			}
			if (areaId === null) {
				areaId = table.areaId
			} else if (table.areaId !== areaId) {
				issues.push({
					code: 'combination_cross_area',
					severity: 'error',
					field: 'combinations.tableIds',
					entityId: rawCombo.id,
					details: { areaIds: [areaId, table.areaId] },
				})
				membersValid = false
			}
		}

		if (active) {
			const sig = canonicalCombinationSignature(distinctIds)
			const prevId = seenComboSignatures.get(sig)
			if (prevId && prevId !== rawCombo.id) {
				issues.push({
					code: 'combination_duplicate_members',
					severity: 'error',
					field: 'combinations.tableIds',
					entityId: rawCombo.id,
					details: { conflictingCombinationId: prevId, signature: sig },
				})
				membersValid = false
			} else {
				seenComboSignatures.set(sig, rawCombo.id)
			}
		}

		if (active && membersValid) {
			validActiveCombos.push({
				id: rawCombo.id,
				minSeats,
				maxSeats,
				onlineBookable,
			})
		}
	}

	// Check party sizes in minParty..maxOnlineParty for online seatability
	if (minParty >= 1 && maxOnlineParty >= minParty) {
		const activeOnlineTables = [...tableById.values()].filter(
			(t) => t.active && t.onlineBookable && t.minSeats <= t.maxSeats,
		)
		const activeOnlineCombos = validActiveCombos.filter(
			(c) => c.onlineBookable && c.minSeats <= c.maxSeats,
		)
		for (let party = minParty; party <= maxOnlineParty; party++) {
			const fitsSingle = activeOnlineTables.some(
				(t) => party >= t.minSeats && party <= t.maxSeats,
			)
			const fitsCombo = activeOnlineCombos.some(
				(c) => party >= c.minSeats && party <= c.maxSeats,
			)
			if (!fitsSingle && !fitsCombo) {
				issues.push({
					code: 'unseatable_party_size',
					severity: 'warning',
					field: 'tables',
					partySize: party,
					details: { partySize: party },
				})
			}
		}
	}

	const activeServiceIds = new Set<string>()

	// Validate services
	for (const rawService of input.services ?? []) {
		if (!isTruthyActive(rawService.active)) continue
		activeServiceIds.add(rawService.id)
		const startMin = rawService.startMin ?? rawService.start_min ?? 0
		const firstSeatingMin =
			rawService.firstSeatingMin ?? rawService.first_seating_min ?? startMin
		const endMin = rawService.endMin ?? rawService.end_min ?? 0
		const lastSeatingMin =
			rawService.lastSeatingMin ?? rawService.last_seating_min ?? endMin

		if (endMin <= startMin) {
			issues.push({
				code: 'service_invalid_window',
				severity: 'error',
				field: 'services.endMin',
				entityId: rawService.id,
				serviceId: rawService.id,
				details: { startMin, endMin },
			})
		} else if (endMin - firstSeatingMin > 1440 || endMin - startMin > 1440) {
			issues.push({
				code: 'service_duration_exceeds_24h',
				severity: 'error',
				field: 'services.endMin',
				entityId: rawService.id,
				serviceId: rawService.id,
				details: { startMin, firstSeatingMin, endMin },
			})
		}
		if (lastSeatingMin > endMin) {
			issues.push({
				code: 'service_last_seating_after_end',
				severity: 'error',
				field: 'services.lastSeatingMin',
				entityId: rawService.id,
				serviceId: rawService.id,
				details: { lastSeatingMin, endMin },
			})
		} else if (lastSeatingMin < firstSeatingMin || lastSeatingMin < startMin) {
			issues.push({
				code: 'service_last_seating_before_start',
				severity: 'error',
				field: 'services.lastSeatingMin',
				entityId: rawService.id,
				serviceId: rawService.id,
				details: { lastSeatingMin, startMin, firstSeatingMin },
			})
		}
	}

	// Validate turn-time buckets grouped by serviceId (including null default group)
	const bucketsByService = new Map<
		string | null,
		Array<{
			id: string
			serviceId: string | null
			minParty: number
			maxParty: number
			durationMin: number
		}>
	>()

	for (const rawBucket of input.turnTimeBuckets ?? []) {
		const serviceId = rawBucket.serviceId ?? rawBucket.service_id ?? null
		const bMin = rawBucket.minParty ?? rawBucket.min_party ?? 1
		const bMax = rawBucket.maxParty ?? rawBucket.max_party ?? 1
		const durationMin = rawBucket.durationMin ?? rawBucket.duration_min ?? 0

		if (bMin > bMax || bMin < 1 || durationMin <= 0) {
			issues.push({
				code: 'turn_time_bucket_invalid_range',
				severity: 'error',
				field: 'turnTimeBuckets',
				entityId: rawBucket.id,
				serviceId,
			})
			continue
		}

		const list = bucketsByService.get(serviceId) ?? []
		list.push({
			id: rawBucket.id,
			serviceId,
			minParty: bMin,
			maxParty: bMax,
			durationMin,
		})
		bucketsByService.set(serviceId, list)
	}

	for (const [serviceId, buckets] of bucketsByService.entries()) {
		const sorted = [...buckets].sort(
			(a, b) => a.minParty - b.minParty || a.maxParty - b.maxParty,
		)
		const first = sorted[0]
		if (first && first.minParty > 1) {
			issues.push({
				code: 'turn_time_bucket_gap',
				severity: 'warning',
				field: 'turnTimeBuckets',
				entityId: first.id,
				serviceId,
				details: {
					gapStart: 1,
					gapEnd: first.minParty - 1,
				},
			})
		}
		let maxCovered = first ? first.maxParty : 0
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1]!
			const curr = sorted[i]!
			if (curr.minParty <= prev.maxParty) {
				issues.push({
					code: 'turn_time_bucket_overlap',
					severity: 'error',
					field: 'turnTimeBuckets',
					entityId: curr.id,
					serviceId,
					details: {
						previousBucketId: prev.id,
						currentBucketId: curr.id,
						overlapStart: curr.minParty,
						overlapEnd: Math.min(prev.maxParty, curr.maxParty),
					},
				})
			} else if (curr.minParty > prev.maxParty + 1) {
				issues.push({
					code: 'turn_time_bucket_gap',
					severity: 'warning',
					field: 'turnTimeBuckets',
					entityId: curr.id,
					serviceId,
					details: {
						gapStart: prev.maxParty + 1,
						gapEnd: curr.minParty - 1,
					},
				})
			}
			if (curr.maxParty > maxCovered) {
				maxCovered = curr.maxParty
			}
		}
		const last = sorted[sorted.length - 1]
		if (last && maxCovered < maxParty) {
			issues.push({
				code: 'turn_time_bucket_gap',
				severity: 'warning',
				field: 'turnTimeBuckets',
				entityId: last.id,
				serviceId,
				details: {
					gapStart: maxCovered + 1,
					gapEnd: maxParty,
				},
			})
		}
	}

	// Validate pacing rules against minParty
	for (const rawRule of input.pacingRules ?? []) {
		const serviceId = rawRule.serviceId ?? rawRule.service_id
		const maxCoversPerSlot =
			rawRule.maxCoversPerSlot ?? rawRule.max_covers_per_slot ?? null
		const maxOnlineCovers =
			rawRule.maxOnlineCoversForService ??
			rawRule.max_online_covers_for_service ??
			null

		if (maxCoversPerSlot !== null && maxCoversPerSlot < minParty) {
			issues.push({
				code: 'pacing_cap_below_min_party',
				severity: 'warning',
				field: 'pacingRules.maxCoversPerSlot',
				entityId: rawRule.id,
				serviceId,
				details: { maxCoversPerSlot, minParty },
			})
		}
		if (maxOnlineCovers !== null && maxOnlineCovers < minParty) {
			issues.push({
				code: 'pacing_cap_below_min_party',
				severity: 'warning',
				field: 'pacingRules.maxOnlineCoversForService',
				entityId: rawRule.id,
				serviceId,
				details: { maxOnlineCoversForService: maxOnlineCovers, minParty },
			})
		}
	}

	// Validate policy rules
	for (const rawPolicy of input.policies ?? []) {
		if (!isTruthyActive(rawPolicy.active)) continue
		const serviceId = rawPolicy.serviceId ?? rawPolicy.service_id ?? null
		const pMinParty = rawPolicy.minParty ?? rawPolicy.min_party ?? 1
		const pMaxParty = rawPolicy.maxParty ?? rawPolicy.max_party ?? null
		const windowStartMin =
			rawPolicy.windowStartMin ?? rawPolicy.window_start_min ?? null
		const windowEndMin =
			rawPolicy.windowEndMin ?? rawPolicy.window_end_min ?? null

		if (serviceId !== null && !activeServiceIds.has(serviceId)) {
			issues.push({
				code: 'policy_unknown_service',
				severity: 'error',
				field: 'policies.serviceId',
				entityId: rawPolicy.id,
				serviceId,
				details: { serviceId },
			})
		}
		if (pMaxParty !== null && pMinParty > pMaxParty) {
			issues.push({
				code: 'policy_party_bounds_inverted',
				severity: 'error',
				field: 'policies.minParty',
				entityId: rawPolicy.id,
				serviceId,
				details: { minParty: pMinParty, maxParty: pMaxParty },
			})
		}
		if (
			windowStartMin !== null &&
			windowEndMin !== null &&
			windowEndMin <= windowStartMin
		) {
			issues.push({
				code: 'policy_invalid_window',
				severity: 'error',
				field: 'policies.windowEndMin',
				entityId: rawPolicy.id,
				serviceId,
				details: { windowStartMin, windowEndMin },
			})
		}
	}

	// Validate blocks
	for (const rawBlock of input.blocks ?? []) {
		const tableId = rawBlock.tableId ?? rawBlock.table_id ?? null
		const startAtMs = rawBlock.startAtMs ?? rawBlock.start_at ?? 0
		const endAtMs = rawBlock.endAtMs ?? rawBlock.end_at ?? 0

		if (endAtMs <= startAtMs) {
			issues.push({
				code: 'block_invalid_window',
				severity: 'error',
				field: 'blocks.endAtMs',
				entityId: rawBlock.id,
				details: { startAtMs, endAtMs },
			})
		}
		if (tableId !== null && !tableById.has(tableId)) {
			issues.push({
				code: 'block_unknown_table',
				severity: 'error',
				field: 'blocks.tableId',
				entityId: rawBlock.id,
				details: { tableId },
			})
		}
	}

	const errors = issues.filter((i) => i.severity === 'error')
	const warnings = issues.filter((i) => i.severity === 'warning')
	const result = issues as ValidateConfigResult
	Object.defineProperties(result, {
		valid: {
			value: errors.length === 0,
			enumerable: false,
			configurable: true,
		},
		issues: {
			value: issues,
			enumerable: false,
			configurable: true,
		},
		errors: {
			value: errors,
			enumerable: false,
			configurable: true,
		},
		warnings: {
			value: warnings,
			enumerable: false,
			configurable: true,
		},
	})
	return result
}
