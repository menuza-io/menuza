import { addDays, daysBetween } from '@repo/zoned-time'
import { type LargePartyMode, type SeatingPreference } from '../config.ts'
import {
	type SpecialDayRuleInput,
	type WeeklyServiceTemplateInput,
	resolveServices,
} from '../services.ts'
import {
	type EffectiveDay,
	type LocationHours,
	buildEffectiveDay,
	instantInIntervals,
} from '../rules/location-hours.ts'
import {
	currentBusinessDate,
	formatHhmm,
	instantToLocal,
	localToInstant,
	resolveServiceWindow,
} from '../time.ts'
import {
	MAX_BOOK_EXPANSIONS,
	MAX_SEARCH_SLOT_EXPANSIONS,
	assignTables,
	buildOccupancyIndex,
} from './assign.ts'
import {
	type AssignCandidate,
	type BookingChannel,
	type CandidateAttributeTag,
	type EngineAreaInput,
	type EngineCombinationInput,
	type EngineServiceAvailabilityInput,
	type EngineServiceTableModeInput,
	type EngineTableInput,
	isGuestChannel,
} from './day-state.ts'
import { type EnginePacingRuleInput, evaluatePacing } from './pacing.ts'

export {
	searchExperienceAvailability,
	type ExperienceAvailabilityItem,
	type ExperienceDefinitionInput,
	type ExperienceScheduleConfig,
	type ExperienceSeatingAvailability,
	type SearchExperienceAvailabilityInput,
} from './experiences.ts'

export const ALTERNATIVE_DELTAS_MIN = [
	-15, 15, -30, 30, -45, 45, -60, 60, -90, 90, -120, 120,
] as const

export const MAX_ALTERNATIVES = 6
export const MAX_CALENDAR_EXPANSIONS = 5_000

export type EngineSettingsInput = {
	enabled: boolean
	onlineEnabled: boolean
	dayStartMin: number
	intervalMin: 15 | 30
	horizonDays: number
	releaseLocalMin: number
	minNoticeMin: number
	sameDayCutoffMin: number | null
	minParty: number
	maxOnlineParty: number
	maxParty: number
	largePartyMode: LargePartyMode
	seatingPreferenceMode: 'none' | 'indoor_outdoor' | 'area' | 'any'
	defaultTurnMin: number
	bufferMin: number
	holdTtlSec: number
	assignmentFreezeMin: number
	graceMin: number
	autoNoShowMin: number | null
	maxActivePerPhone: number
	modifyCutoffMin: number
	waitlistEnabled: boolean
	notifyMeEnabled: boolean
}

export type EngineTurnTimeBucketInput = {
	id: string
	serviceId?: string | null
	service_id?: string | null
	minParty?: number
	min_party?: number
	maxParty?: number
	max_party?: number
	durationMin?: number
	duration_min?: number
}

export type EngineDayConfig = {
	timeZone: string
	settings: EngineSettingsInput
	areas: EngineAreaInput[]
	tables: EngineTableInput[]
	combinations: EngineCombinationInput[]
	services: WeeklyServiceTemplateInput[]
	turnTimeBuckets: EngineTurnTimeBucketInput[]
	pacingRules: EnginePacingRuleInput[]
	serviceTableModes: EngineServiceTableModeInput[]
	serviceAvailability?: EngineServiceAvailabilityInput[]
	specialDays: SpecialDayRuleInput[]
	/**
	 * Location hours (single source of truth for "when are we open"). Services
	 * only operate inside them. `null`/absent: unknown, fail open.
	 */
	locationHours?: LocationHours | null
}

export type ExistingOccupancyInput = {
	id: string
	kind?: 'reservation' | 'hold' | 'block'
	status?: string
	channel?: BookingChannel
	serviceId?: string | null
	areaId?: string | null
	experienceId?: string | null
	partySize?: number
	localStartMin?: number
	/**
	 * Business date `localStartMin` is relative to. Occupancies of adjacent
	 * days still block tables physically but only count toward pacing when
	 * this equals the requested business date.
	 */
	businessDate?: string
	startAt: number
	endAt: number
	tableIds?: readonly string[]
	combinationId?: string | null
	tableLocked?: boolean | number
	overbook?: boolean | number
	expiresAt?: number
}

export type AvailableSlot = {
	slotMin: number
	slotHhmm: string
	startAt: number
	endAt: number
	turnMin: number
	serviceId: string
	serviceName: string
	areaId: string
	tableIds: string[]
	combinationId: string | null
	repaired: boolean
	warnings?: string[]
	status?: 'available'
}

export type AvailabilityDayStatus =
	| 'available'
	| 'full'
	| 'closed'
	| 'online_closed'
	| 'beyond_horizon'
	| 'large_party'
	| 'party_out_of_bounds'
	| 'disabled'

export type SearchAvailabilityInput = {
	config: EngineDayConfig
	businessDate: string
	partySize: number
	preferredSlotMin?: number | null
	seatingPreference?: SeatingPreference | null
	requestedAttributes?: readonly CandidateAttributeTag[]
	areaId?: string | null
	serviceId?: string | null
	nowMs: number
	channel?: BookingChannel
	occupancies?: readonly ExistingOccupancyInput[]
	existingBookings?: readonly ExistingOccupancyInput[]
	existingHolds?: readonly ExistingOccupancyInput[]
	tableBlocks?: readonly ExistingOccupancyInput[]
	allowRepair?: boolean
	maxExpansions?: number
}

export type AvailableSlotWithStatus = AvailableSlot & {
	status: 'available'
}

export type SearchAvailabilityResult = {
	businessDate: string
	status: AvailabilityDayStatus
	largePartyMode?: LargePartyMode
	slots: AvailableSlot[]
	alternatives: AvailableSlot[]
	warnings?: string[]
	expansionsUsed: number
	/** Why a `closed` day is closed, when known. */
	closed?: {
		source: EffectiveDay['source']
		reason: EffectiveDay['closedReason']
		name: string | null
		note: string | null
	}
	/** Effective day (location hours merged with the reservation special day). */
	effectiveDay?: EffectiveDay
}

/**
 * Resolve turn duration (in minutes, excluding buffer) for `(serviceId, partySize)`:
 *   1. Bucket matching `serviceId` and `minParty <= partySize <= maxParty`
 *   2. Fallback bucket (`serviceId === null`) matching `minParty <= partySize <= maxParty`
 *   3. `config.settings.defaultTurnMin`
 */
export function resolveTurnTimeMin(
	config: Pick<EngineDayConfig, 'turnTimeBuckets' | 'settings'>,
	serviceId: string | null | undefined,
	partySize: number,
): number {
	if (serviceId) {
		for (const b of config.turnTimeBuckets) {
			const sId = b.serviceId ?? b.service_id ?? null
			if (sId !== serviceId) continue
			const minP = b.minParty ?? b.min_party ?? 1
			const maxP = b.maxParty ?? b.max_party ?? 99
			if (partySize >= minP && partySize <= maxP) {
				return b.durationMin ?? b.duration_min ?? config.settings.defaultTurnMin
			}
		}
	}

	for (const b of config.turnTimeBuckets) {
		const sId = b.serviceId ?? b.service_id ?? null
		if (sId !== null) continue
		const minP = b.minParty ?? b.min_party ?? 1
		const maxP = b.maxParty ?? b.max_party ?? 99
		if (partySize >= minP && partySize <= maxP) {
			return b.durationMin ?? b.duration_min ?? config.settings.defaultTurnMin
		}
	}

	return config.settings.defaultTurnMin
}

/**
 * Suggest up to `MAX_ALTERNATIVES` (6) available slots closest to `preferredSlotMin`
 * using the canonical delta sequence `[-15, +15, -30, +30, -45, +45, -60, +60, -90, +90, -120, +120]`.
 */
export function suggestAlternatives(
	slots: readonly AvailableSlot[],
	preferredSlotMin: number,
): AvailableSlot[] {
	const bySlotMin = new Map<number, AvailableSlot>()
	for (const s of slots) {
		if (!bySlotMin.has(s.slotMin)) {
			bySlotMin.set(s.slotMin, s)
		}
	}

	const out: AvailableSlot[] = []
	const seen = new Set<number>()

	// First check exact delta steps in canonical order
	for (const delta of ALTERNATIVE_DELTAS_MIN) {
		if (out.length >= MAX_ALTERNATIVES) break
		const target = preferredSlotMin + delta
		const match = bySlotMin.get(target)
		if (match && !seen.has(match.slotMin)) {
			out.push(match)
			seen.add(match.slotMin)
		}
	}

	// Also include any other available slots within ±120 min sorted by |delta|, earlier first
	if (out.length < MAX_ALTERNATIVES) {
		const remaining = slots
			.filter(
				(s) =>
					!seen.has(s.slotMin) &&
					s.slotMin !== preferredSlotMin &&
					Math.abs(s.slotMin - preferredSlotMin) <= 120,
			)
			.sort((a, b) => {
				const da = Math.abs(a.slotMin - preferredSlotMin)
				const db = Math.abs(b.slotMin - preferredSlotMin)
				if (da !== db) return da - db
				return a.slotMin - b.slotMin
			})
		for (const s of remaining) {
			if (out.length >= MAX_ALTERNATIVES) break
			out.push(s)
			seen.add(s.slotMin)
		}
	}

	return out
}

/**
 * Evaluate available reservation slots on `businessDate` (`architecture.md` §6.3, §6.6, `VAL-FND-006`).
 */
export function searchAvailability(
	input: SearchAvailabilityInput,
): SearchAvailabilityResult {
	const { config, businessDate, partySize, nowMs } = input
	const channel: BookingChannel = input.channel ?? 'online'
	const isOnlineLike = isGuestChannel(channel)
	const { settings } = config

	if (!settings.enabled || (isOnlineLike && !settings.onlineEnabled)) {
		return {
			businessDate,
			status: 'disabled',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	if (partySize < settings.minParty || partySize > settings.maxParty) {
		return {
			businessDate,
			status: 'party_out_of_bounds',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	if (isOnlineLike && partySize > settings.maxOnlineParty) {
		return {
			businessDate,
			status: 'large_party',
			largePartyMode: settings.largePartyMode,
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	// Check booking horizon & releaseLocalMin for online/voice channels
	const nowBusinessDate = currentBusinessDate(
		nowMs,
		config.timeZone,
		settings.dayStartMin,
	)
	const nowLocal = instantToLocal(nowMs, config.timeZone, settings.dayStartMin)
	const daysAhead = daysBetween(nowBusinessDate, businessDate)

	if (daysAhead < 0) {
		return {
			businessDate,
			status: 'closed',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	if (isOnlineLike) {
		if (daysAhead > settings.horizonDays) {
			return {
				businessDate,
				status: 'beyond_horizon',
				slots: [],
				alternatives: [],
				expansionsUsed: 0,
			}
		}
		if (
			daysAhead === settings.horizonDays &&
			nowLocal.clockMin < settings.releaseLocalMin
		) {
			return {
				businessDate,
				status: 'beyond_horizon',
				slots: [],
				alternatives: [],
				expansionsUsed: 0,
			}
		}
	}

	// Resolve services for businessDate
	const resolvedDay = resolveServices(
		businessDate,
		config.services,
		config.specialDays,
	)

	const effectiveDay = buildEffectiveDay({
		businessDate,
		hours: config.locationHours,
		dayStartMin: settings.dayStartMin,
		reservation: resolvedDay,
	})
	const locationClosedDay =
		!effectiveDay.open && effectiveDay.source === 'location_closed'

	if (resolvedDay.closed || (locationClosedDay && isOnlineLike)) {
		return {
			businessDate,
			status: 'closed',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
			closed: {
				source: effectiveDay.source,
				reason: effectiveDay.closedReason,
				name: effectiveDay.name ?? null,
				note: effectiveDay.note ?? null,
			},
			effectiveDay,
		}
	}

	if (isOnlineLike && resolvedDay.onlineClosed) {
		return {
			businessDate,
			status: 'online_closed',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	// Same-day cutoff check for online channels
	if (
		isOnlineLike &&
		daysAhead === 0 &&
		settings.sameDayCutoffMin !== null &&
		nowLocal.localStartMin >= settings.sameDayCutoffMin
	) {
		return {
			businessDate,
			status: 'full',
			slots: [],
			alternatives: [],
			expansionsUsed: 0,
		}
	}

	const minNoticeMs = isOnlineLike ? settings.minNoticeMin * 60_000 : 0
	const earliestAllowedMs = nowMs + minNoticeMs

	const occupancies: ExistingOccupancyInput[] = [
		...(input.occupancies ?? []).filter(
			(o) =>
				o.kind !== 'hold' || o.expiresAt === undefined || o.expiresAt > nowMs,
		),
		...(input.existingBookings ?? []),
		...(input.existingHolds ?? [])
			.filter((h) => h.expiresAt === undefined || h.expiresAt > nowMs)
			.map((h) => ({
				...h,
				kind: 'hold' as const,
			})),
		...(input.tableBlocks ?? []).map((b) => ({
			...b,
			kind: 'block' as const,
		})),
	]
	const assignBookings = occupancies.map((o) => ({
		id: o.id,
		kind: o.kind ?? 'reservation',
		partySize: o.partySize ?? 1,
		localStartMin: o.localStartMin,
		startAt: o.startAt,
		endAt: o.endAt,
		tableIds: o.tableIds ?? [],
		combinationId: o.combinationId ?? null,
		status: o.status,
		tableLocked: o.tableLocked,
		overbook: o.overbook,
		channel: o.channel,
		serviceId: o.serviceId,
		areaId: o.areaId,
	}))

	const pacingExisting = occupancies.map((o) => ({
		id: o.id,
		kind: o.kind ?? 'reservation',
		serviceId: o.serviceId,
		areaId: o.areaId,
		channel: o.channel ?? 'online',
		partySize: o.partySize ?? 0,
		localStartMin: o.localStartMin,
		businessDate: o.businessDate,
		startAt: o.startAt,
		endAt: o.endAt,
		status: o.status,
	}))

	const slots: AvailableSlot[] = []
	const dayWarningsSet = new Set<string>()
	let expansionsUsed = 0

	// Prebuild occupancy index and candidate pool cache once for the entire day
	const prebuiltOccupancy = buildOccupancyIndex({
		tables: config.tables,
		bookings: assignBookings,
		nowMs,
		assignmentFreezeMin: settings.assignmentFreezeMin,
	})
	const candidatePoolCache = new Map<string, AssignCandidate[]>()
	const existingCandidatesCache = new Map<
		string,
		Array<{ candidate: AssignCandidate; score: number }>
	>()
	const serviceModes = config.serviceAvailability ?? config.serviceTableModes

	for (const service of resolvedDay.services) {
		if (input.serviceId && service.id !== input.serviceId) continue
		if (isOnlineLike && !service.onlineBookable) continue
		if (
			service.maxParty !== null &&
			service.maxParty !== undefined &&
			partySize > service.maxParty
		) {
			continue
		}
		if (
			isOnlineLike &&
			service.onlinePartyMax !== null &&
			service.onlinePartyMax !== undefined &&
			partySize > service.onlinePartyMax
		) {
			continue
		}

		const turnMin = resolveTurnTimeMin(config, service.id, partySize)
		const occupyMin = turnMin + settings.bufferMin

		const windowStartMin = service.firstSeatingMin ?? service.startMin
		const windowEndMin =
			service.endMin <= service.startMin
				? service.endMin + 1440
				: service.endMin
		const windowLastSeatingMin =
			service.lastSeatingMin < service.startMin &&
			windowEndMin > service.startMin
				? service.lastSeatingMin + 1440
				: service.lastSeatingMin

		const window = resolveServiceWindow(
			businessDate,
			service.startMin,
			windowEndMin,
			config.timeZone,
		)
		const isLinearWindow =
			window.endMs - window.startMs ===
			(windowEndMin - service.startMin) * 60_000

		// Candidate slots step by intervalMin from firstSeatingMin through min(lastSeatingMin, endMin - turnMin)
		const maxSlotMin = Math.min(windowLastSeatingMin, windowEndMin - turnMin)
		const stepMin = service.slotIntervalMin ?? settings.intervalMin

		for (
			let slotMin = windowStartMin;
			slotMin <= maxSlotMin;
			slotMin += stepMin
		) {
			if (isOnlineLike) {
				if (
					service.onlineFromMin !== null &&
					service.onlineFromMin !== undefined &&
					slotMin < service.onlineFromMin
				) {
					continue
				}
				if (
					service.onlineToMin !== null &&
					service.onlineToMin !== undefined &&
					slotMin > service.onlineToMin
				) {
					continue
				}
			}

			let startAt: number
			if (isLinearWindow) {
				startAt = window.startMs + (slotMin - service.startMin) * 60_000
			} else {
				const dayOffset = Math.floor(slotMin / 1440)
				const clockMin = ((slotMin % 1440) + 1440) % 1440
				const calendarDate =
					dayOffset === 0 ? businessDate : addDays(businessDate, dayOffset)
				const resolvedSlot = localToInstant(
					calendarDate,
					clockMin,
					config.timeZone,
					{ gap: 'skip', overlap: 'earlier' },
				)
				if (resolvedSlot === null) {
					continue
				}
				startAt = resolvedSlot.instantMs
			}
			const endAt = startAt + occupyMin * 60_000

			if (startAt < earliestAllowedMs) {
				continue
			}

			const slotWarnings: string[] = []

			// Services operate only inside the location's open hours (slot start).
			if (!instantInIntervals(effectiveDay.intervals, startAt)) {
				if (isOnlineLike) continue
				slotWarnings.push('outside_location_hours')
				dayWarningsSet.add('outside_location_hours')
			}

			// Evaluate location-wide pacing first
			const globalPacing = evaluatePacing({
				serviceId: service.id,
				slotMin,
				businessDate,
				startAt,
				endAt,
				durationMin: turnMin,
				intervalMin: stepMin,
				partySize,
				channel,
				areaId: input.areaId ?? null,
				rules: config.pacingRules,
				serviceAvailability: serviceModes,
				serviceOnlineCapPerInterval: service.onlineCapPerInterval,
				serviceConcurrentCoversCap: service.concurrentCoversCap,
				existing: pacingExisting,
			})
			if (!globalPacing.allowed) {
				if (isOnlineLike) {
					continue
				}
				const codes =
					globalPacing.warnings.length > 0
						? globalPacing.warnings
						: [globalPacing.reason ?? 'pacing_exceeded']
				for (const code of codes) {
					if (!slotWarnings.includes(code)) slotWarnings.push(code)
					dayWarningsSet.add(code)
				}
			}

			const dayCap = input.maxExpansions ?? MAX_BOOK_EXPANSIONS
			const remainingRepairBudget = Math.max(0, dayCap - expansionsUsed)
			const slotRepairBudget = Math.min(
				MAX_SEARCH_SLOT_EXPANSIONS,
				remainingRepairBudget,
			)
			const allowSlotRepair =
				(input.allowRepair ?? true) && slotRepairBudget > 0

			const assignRes = assignTables({
				partySize,
				startAt,
				endAt,
				slotMin,
				channel,
				serviceId: service.id,
				areaId: input.areaId ?? null,
				seatingPreference: input.seatingPreference,
				requestedAttributes: input.requestedAttributes,
				tables: config.tables,
				areas: config.areas,
				combinations: config.combinations,
				serviceTableModes: serviceModes,
				bookings: assignBookings,
				nowMs,
				assignmentFreezeMin: settings.assignmentFreezeMin,
				minTurnMin: turnMin,
				baseBufferMin: settings.bufferMin,
				serviceStartAt: window.startMs,
				serviceEndAt: window.endMs,
				maxExpansions: slotRepairBudget,
				allowRepair: allowSlotRepair,
				skipPacing: true,
				prebuiltOccupancy,
				candidatePoolCache,
				existingCandidatesCache,
			})

			expansionsUsed = Math.min(
				dayCap,
				expansionsUsed + assignRes.expansionsUsed,
			)

			if (!assignRes.assigned) {
				continue
			}

			// Also verify area-specific pacing if an area was selected by assignTables
			if (!input.areaId && assignRes.areaId) {
				const areaPacing = evaluatePacing({
					serviceId: service.id,
					slotMin,
					businessDate,
					startAt,
					endAt,
					durationMin: turnMin,
					intervalMin: stepMin,
					partySize,
					channel,
					areaId: assignRes.areaId,
					rules: config.pacingRules,
					serviceAvailability: serviceModes,
					serviceOnlineCapPerInterval: service.onlineCapPerInterval,
					serviceConcurrentCoversCap: service.concurrentCoversCap,
					existing: pacingExisting,
				})
				if (!areaPacing.allowed) {
					if (isOnlineLike) {
						continue
					}
					const codes =
						areaPacing.warnings.length > 0
							? areaPacing.warnings
							: [areaPacing.reason ?? 'pacing_exceeded']
					for (const code of codes) {
						if (!slotWarnings.includes(code)) slotWarnings.push(code)
						dayWarningsSet.add(code)
					}
				}
			}

			slots.push({
				slotMin,
				slotHhmm: formatHhmm(slotMin),
				startAt,
				endAt,
				turnMin,
				serviceId: service.id,
				serviceName: service.name,
				areaId: assignRes.areaId,
				tableIds: assignRes.tableIds,
				combinationId: assignRes.combinationId,
				repaired: assignRes.repaired,
				...(slotWarnings.length > 0 ? { warnings: slotWarnings } : {}),
				status: 'available',
			})
		}
	}

	let alternatives: AvailableSlot[] = []
	if (
		input.preferredSlotMin !== undefined &&
		input.preferredSlotMin !== null &&
		!slots.some((s) => s.slotMin === input.preferredSlotMin)
	) {
		alternatives = suggestAlternatives(slots, input.preferredSlotMin)
	}

	return {
		businessDate,
		status: slots.length > 0 ? 'available' : 'full',
		slots,
		alternatives,
		...(dayWarningsSet.size > 0 ? { warnings: [...dayWarningsSet] } : {}),
		expansionsUsed,
		effectiveDay,
	}
}

export type CalendarDaySummary = {
	businessDate: string
	status: AvailabilityDayStatus
	availableSlotCount: number
	/** Present for closed days: who closed it. */
	closedSource?: EffectiveDay['source']
	closedReason?: EffectiveDay['closedReason']
}

export type CalendarSummaryInput = {
	config: EngineDayConfig
	fromDate: string
	toDate: string
	partySize: number
	nowMs: number
	channel?: BookingChannel
	occupanciesByDate?: Readonly<
		Record<string, readonly ExistingOccupancyInput[]>
	>
	bookingsByDate?: Readonly<Record<string, readonly ExistingOccupancyInput[]>>
	maxExpansions?: number
}

export type CalendarSummaryResult = {
	days: CalendarDaySummary[]
	expansionsUsed: number
}

/**
 * Compute date-picker calendar availability summary across `[fromDate, toDate]`
 * within `MAX_CALENDAR_EXPANSIONS = 5_000` (`architecture.md` §6.8, `VAL-FND-006`).
 */
export function calendarSummary(
	input: CalendarSummaryInput,
): CalendarSummaryResult {
	const maxExpansions = Math.min(
		MAX_CALENDAR_EXPANSIONS,
		input.maxExpansions ?? MAX_CALENDAR_EXPANSIONS,
	)
	const totalDays = Math.max(
		0,
		Math.min(62, daysBetween(input.fromDate, input.toDate) + 1),
	)
	const mapByDate = input.occupanciesByDate ?? input.bookingsByDate

	const days: CalendarDaySummary[] = []
	let expansionsUsed = 0

	for (let i = 0; i < totalDays; i++) {
		const businessDate = addDays(input.fromDate, i)
		const dayOccupancies = mapByDate?.[businessDate] ?? []

		// Use direct-fit (no expensive multi-step repair) once budget gets tight
		const allowRepair = expansionsUsed < maxExpansions / 2

		const dayRes = searchAvailability({
			config: input.config,
			businessDate,
			partySize: input.partySize,
			nowMs: input.nowMs,
			channel: input.channel ?? 'online',
			occupancies: dayOccupancies,
			allowRepair,
		})

		expansionsUsed = Math.min(
			maxExpansions,
			expansionsUsed + dayRes.expansionsUsed,
		)

		days.push({
			businessDate,
			status: dayRes.status,
			availableSlotCount: dayRes.slots.length,
			...(dayRes.closed
				? {
						closedSource: dayRes.closed.source,
						...(dayRes.closed.reason
							? { closedReason: dayRes.closed.reason }
							: {}),
					}
				: {}),
		})
	}

	return {
		days,
		expansionsUsed,
	}
}

export const calendarAvailabilitySummary = calendarSummary

export type AlternativeOtherDate = {
	date: string
	firstLocalMin: number
	firstSlotHhmm: string
}

export type AlternativesResult = {
	sameDay: AvailableSlot[]
	otherDates: AlternativeOtherDate[]
}

export type AlternativesOtherDayInput = {
	date?: string
	businessDate?: string
	firstLocalMin?: number
	slots?: readonly AvailableSlot[]
}

export type AlternativesInput = {
	slots?: readonly AvailableSlot[]
	preferredSlotMin?: number | null
	otherDays?: readonly AlternativesOtherDayInput[]
	config?: EngineDayConfig
	businessDate?: string
	partySize?: number
	nowMs?: number
	channel?: BookingChannel
	areaId?: string | null
	serviceId?: string | null
	seatingPreference?: SeatingPreference | null
	requestedAttributes?: readonly CandidateAttributeTag[]
	occupanciesByDate?: Readonly<
		Record<string, readonly ExistingOccupancyInput[]>
	>
	bookingsByDate?: Readonly<Record<string, readonly ExistingOccupancyInput[]>>
	dayOffsets?: readonly number[]
}

/**
 * Compute same-day nearby alternatives (`±15..120` min, up to 6) and nearby
 * alternative dates (`{ date, firstLocalMin }`) (`architecture.md` §6.2, `VAL-FND-006`).
 */
export function alternatives(
	inputOrSlots: AlternativesInput | readonly AvailableSlot[],
	preferredSlotMinArg?: number,
	otherDaysArg?: readonly AlternativesOtherDayInput[],
): AlternativesResult {
	if (Array.isArray(inputOrSlots)) {
		const slots = inputOrSlots as readonly AvailableSlot[]
		const preferredSlotMin = preferredSlotMinArg ?? 0
		const sameDay = suggestAlternatives(slots, preferredSlotMin)
		const otherDates: AlternativeOtherDate[] = []
		for (const od of otherDaysArg ?? []) {
			const date = od.date ?? od.businessDate
			if (!date) continue
			const firstMin = od.firstLocalMin ?? od.slots?.[0]?.slotMin
			if (firstMin === undefined) continue
			otherDates.push({
				date,
				firstLocalMin: firstMin,
				firstSlotHhmm: formatHhmm(firstMin),
			})
		}
		return { sameDay, otherDates }
	}

	const input = inputOrSlots as AlternativesInput
	const preferredMin = input.preferredSlotMin ?? 0
	let daySlots = input.slots
	if (
		!daySlots &&
		input.config &&
		input.businessDate &&
		input.partySize !== undefined &&
		input.nowMs !== undefined
	) {
		const mapByDate = input.occupanciesByDate ?? input.bookingsByDate
		const dayRes = searchAvailability({
			config: input.config,
			businessDate: input.businessDate,
			partySize: input.partySize,
			preferredSlotMin: preferredMin,
			seatingPreference: input.seatingPreference,
			requestedAttributes: input.requestedAttributes,
			areaId: input.areaId,
			serviceId: input.serviceId,
			nowMs: input.nowMs,
			channel: input.channel,
			occupancies: mapByDate?.[input.businessDate] ?? [],
		})
		daySlots = dayRes.slots
	}

	const sameDay = daySlots ? suggestAlternatives(daySlots, preferredMin) : []
	const otherDates: AlternativeOtherDate[] = []

	if (input.otherDays && input.otherDays.length > 0) {
		for (const od of input.otherDays) {
			const date = od.date ?? od.businessDate
			if (!date) continue
			const firstMin = od.firstLocalMin ?? od.slots?.[0]?.slotMin
			if (firstMin === undefined) continue
			otherDates.push({
				date,
				firstLocalMin: firstMin,
				firstSlotHhmm: formatHhmm(firstMin),
			})
		}
	} else if (
		input.config &&
		input.businessDate &&
		input.partySize !== undefined &&
		input.nowMs !== undefined
	) {
		const mapByDate = input.occupanciesByDate ?? input.bookingsByDate
		const offsets = input.dayOffsets ?? [-1, 1, -2, 2, 3, -3]
		for (const offset of offsets) {
			if (offset === 0) continue
			if (otherDates.length >= MAX_ALTERNATIVES) break
			const candidateDate = addDays(input.businessDate, offset)
			const dayRes = searchAvailability({
				config: input.config,
				businessDate: candidateDate,
				partySize: input.partySize,
				seatingPreference: input.seatingPreference,
				requestedAttributes: input.requestedAttributes,
				areaId: input.areaId,
				serviceId: input.serviceId,
				nowMs: input.nowMs,
				channel: input.channel,
				occupancies: mapByDate?.[candidateDate] ?? [],
				allowRepair: false,
			})
			if (dayRes.slots.length > 0) {
				let bestSlot = dayRes.slots[0]!
				if (
					input.preferredSlotMin !== undefined &&
					input.preferredSlotMin !== null
				) {
					for (const s of dayRes.slots) {
						if (
							Math.abs(s.slotMin - input.preferredSlotMin) <
							Math.abs(bestSlot.slotMin - input.preferredSlotMin)
						) {
							bestSlot = s
						}
					}
				}
				otherDates.push({
					date: candidateDate,
					firstLocalMin: bestSlot.slotMin,
					firstSlotHhmm: bestSlot.slotHhmm,
				})
			}
		}
	}

	return {
		sameDay,
		otherDates,
	}
}
