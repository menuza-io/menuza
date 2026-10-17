import {
	addDays,
	daysBetween,
	resolveServices,
	searchAvailability,
	suggestAlternatives,
	type AvailableSlot,
	type BookingChannel,
	type EngineDayConfig,
	type EngineSettingsInput,
	type ExistingOccupancyInput,
	type SearchAvailabilityResult,
	type SpecialDayRuleInput,
	type WeeklyServiceTemplateInput,
} from '@repo/reservations'
import {
	rsvBlocks,
	rsvDayVersions,
	rsvHolds,
	rsvReservations,
	rsvSpecialDays,
} from '@repo/tenant-db'
import { and, eq, gt, gte, inArray, lte } from 'drizzle-orm'
import { loadLocationSchedulingState } from './rsv-booking-service.ts'
import { type DbOrTx } from './rsv-guest-service.ts'

/** Reservation states that occupy tables and count against capacity. */
export const CAPACITY_STATUSES = [
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'partially_seated',
	'seated',
] as const

export type LocationSettingsRow = NonNullable<
	Awaited<ReturnType<typeof loadLocationSchedulingState>>['settings']
>

export type PublicEngineState = {
	locationId: string
	settings: LocationSettingsRow
	config: EngineDayConfig
	timeZone: string
	specialDays: Array<typeof rsvSpecialDays.$inferSelect>
	tableById: Map<
		string,
		Awaited<ReturnType<typeof loadLocationSchedulingState>>['tables'][number]
	>
	/** Areas a guest may choose; a slot in any other area carries no area. */
	selectableAreas: Map<
		string,
		{ name: string; nameI18n: Record<string, string> | null }
	>
	occupanciesFor: (businessDate: string) => ExistingOccupancyInput[]
}

export function pickI18n(
	map: Record<string, string> | null | undefined,
	locale?: string | null,
	/** Names have a canonical column to fall back to, so they must not borrow another locale's text. */
	fallbackToAnyLocale = true,
): string | null {
	if (!map) return null
	const exact = locale ? map[locale] : undefined
	if (exact) return exact
	const base = locale?.split('-')[0]
	if (base && map[base]) return map[base]!
	if (map.en) return map.en
	return fallbackToAnyLocale ? (Object.values(map).find(Boolean) ?? null) : null
}

export function toEngineSettings(
	settings: LocationSettingsRow,
): EngineSettingsInput {
	return {
		enabled: settings.enabled,
		onlineEnabled: settings.onlineEnabled,
		dayStartMin: settings.dayStartMin,
		intervalMin: (settings.intervalMin === 30 ? 30 : 15) as 15 | 30,
		horizonDays: settings.horizonDays,
		releaseLocalMin: settings.releaseLocalMin ?? 0,
		minNoticeMin: settings.minNoticeMin,
		sameDayCutoffMin: settings.sameDayCutoffMin,
		minParty: settings.onlinePartyMin,
		maxOnlineParty: settings.onlinePartyMax,
		maxParty: settings.partyMax,
		largePartyMode:
			settings.largePartyMode === 'contact'
				? 'call_only'
				: settings.largePartyMode,
		seatingPreferenceMode: 'none',
		defaultTurnMin: 90,
		bufferMin: 0,
		holdTtlSec: settings.holdMinutes * 60,
		assignmentFreezeMin: settings.freezeMin,
		graceMin: settings.lateGraceMin,
		autoNoShowMin: settings.autoNoShowAfterMin,
		maxActivePerPhone: settings.maxActivePerPhone,
		modifyCutoffMin: settings.guestModifyCutoffMin,
		waitlistEnabled: settings.waitlistEnabled,
		notifyMeEnabled: settings.notifyMeEnabled,
	}
}

function specialDayRules(
	rows: Array<typeof rsvSpecialDays.$inferSelect>,
	fromDate: string,
	toDate: string,
): SpecialDayRuleInput[] {
	const out: SpecialDayRuleInput[] = []
	for (const row of rows) {
		const start = row.fromDate > fromDate ? row.fromDate : fromDate
		const end = row.toDate < toDate ? row.toDate : toDate
		const patch = row.patch as Record<string, unknown> | null
		const custom = Array.isArray(patch?.customServices)
			? (patch.customServices as SpecialDayRuleInput['customServices'])
			: Array.isArray(patch)
				? (patch as SpecialDayRuleInput['customServices'])
				: []
		const note = pickI18n(row.publicNoteI18n)
		const span = daysBetween(start, end)
		for (let i = 0; i <= span; i++) {
			out.push({
				id: row.id,
				businessDate: addDays(start, i),
				type: row.kind,
				name: row.name,
				note,
				customServices: custom,
			})
		}
	}
	return out
}

export async function loadPublicEngineState(
	db: DbOrTx,
	params: {
		locationId: string
		fromDate: string
		toDate: string
		now: number
		excludeReservationIds?: ReadonlySet<string>
		excludeHoldIds?: ReadonlySet<string>
	},
): Promise<PublicEngineState | null> {
	const { locationId, fromDate, toDate, now } = params
	const sched = await loadLocationSchedulingState(db, locationId, fromDate)
	const settings = sched.settings
	if (!settings) return null

	const windowFrom = addDays(fromDate, -1)
	const windowTo = addDays(toDate, 1)

	const [specialDayRows, reservationRows, holdRows, blockRows] =
		await Promise.all([
			db
				.select()
				.from(rsvSpecialDays)
				.where(
					and(
						eq(rsvSpecialDays.locationId, locationId),
						lte(rsvSpecialDays.fromDate, toDate),
						gte(rsvSpecialDays.toDate, fromDate),
					),
				)
				.all(),
			db
				.select()
				.from(rsvReservations)
				.where(
					and(
						eq(rsvReservations.locationId, locationId),
						gte(rsvReservations.businessDate, windowFrom),
						lte(rsvReservations.businessDate, windowTo),
						inArray(rsvReservations.status, [...CAPACITY_STATUSES]),
					),
				)
				.all(),
			db
				.select()
				.from(rsvHolds)
				.where(
					and(
						eq(rsvHolds.locationId, locationId),
						gte(rsvHolds.businessDate, windowFrom),
						lte(rsvHolds.businessDate, windowTo),
						eq(rsvHolds.status, 'active'),
						gt(rsvHolds.expiresAt, now),
					),
				)
				.all(),
			db
				.select()
				.from(rsvBlocks)
				.where(
					and(
						eq(rsvBlocks.locationId, locationId),
						gte(rsvBlocks.businessDate, windowFrom),
						lte(rsvBlocks.businessDate, windowTo),
					),
				)
				.all(),
		])

	const tablesByOwner = new Map<string, string[]>()
	for (const occ of sched.activeOccRows) {
		const owner = occ.reservationId ?? occ.holdId ?? occ.blockId
		if (!owner) continue
		const list = tablesByOwner.get(owner) ?? []
		list.push(occ.tableId)
		tablesByOwner.set(owner, list)
	}

	const byDate = new Map<string, ExistingOccupancyInput[]>()
	const push = (date: string, item: ExistingOccupancyInput) => {
		const list = byDate.get(date) ?? []
		list.push(item)
		byDate.set(date, list)
	}

	for (const r of reservationRows) {
		if (params.excludeReservationIds?.has(r.id)) continue
		push(r.businessDate, {
			id: r.id,
			kind: 'reservation',
			status: r.status,
			channel: r.channel as BookingChannel,
			serviceId: r.serviceId,
			areaId: r.areaPrefStrict ? r.areaPrefId : null,
			partySize: r.partySize,
			localStartMin: r.localStartMin,
			startAt: r.startAt,
			endAt: r.endAt,
			tableIds: tablesByOwner.get(r.id) ?? [],
			combinationId: r.comboId,
			tableLocked: r.assignment === 'locked',
			overbook: r.overbooked,
		})
	}
	for (const h of holdRows) {
		if (params.excludeHoldIds?.has(h.id)) continue
		push(h.businessDate, {
			id: h.id,
			kind: 'hold',
			serviceId: h.serviceId,
			partySize: h.partySize,
			localStartMin: h.localStartMin,
			startAt: h.startAt,
			endAt: h.endAt,
			tableIds: tablesByOwner.get(h.id) ?? [],
			combinationId: h.comboId,
			expiresAt: h.expiresAt,
		})
	}
	for (const b of blockRows) {
		const tableIds = b.tableId
			? [b.tableId]
			: sched.tables.filter((t) => t.areaId === b.areaId).map((t) => t.id)
		push(b.businessDate, {
			id: b.id,
			kind: 'block',
			startAt: b.startAt,
			endAt: b.endAt,
			tableIds,
		})
	}

	const services: WeeklyServiceTemplateInput[] = sched.services.map((s) => ({
		id: s.id,
		name: s.name,
		slug: s.id,
		daysMask: s.daysMask,
		effectiveFrom: s.effectiveFrom,
		effectiveTo: s.effectiveTo,
		specialDayId: s.specialDayId,
		startMin: s.firstSeatingMin,
		firstSeatingMin: s.firstSeatingMin,
		lastSeatingMin: s.lastSeatingMin,
		endMin: s.endMin,
		intervalMin: s.intervalMin,
		onlineBookable: s.onlineEnabled,
		onlineFromMin: s.onlineFromMin,
		onlineToMin: s.onlineToMin,
		maxParty: s.maxParty,
		onlinePartyMax: s.onlinePartyMax,
		onlineCapPerInterval: s.onlineCapPerInterval,
		concurrentCoversCap: s.concurrentCoversCap,
		priority: s.priority,
		sortOrder: s.sort,
		active: s.archivedAt === null,
	}))

	const config: EngineDayConfig = {
		timeZone: sched.timeZone,
		settings: toEngineSettings(settings),
		areas: sched.engineAreas,
		tables: sched.engineTables,
		combinations: sched.engineCombos,
		services,
		turnTimeBuckets: sched.turnTimes.map((t) => ({
			id: t.id,
			serviceId: t.serviceId,
			minParty: t.partyMin,
			maxParty: t.partyMax,
			durationMin: t.minutes,
		})),
		pacingRules: sched.enginePacingRules,
		serviceTableModes: sched.engineServiceAvail,
		serviceAvailability: sched.engineServiceAvail,
		specialDays: specialDayRules(specialDayRows, fromDate, toDate),
	}

	return {
		locationId,
		settings,
		config,
		timeZone: sched.timeZone,
		specialDays: specialDayRows,
		tableById: sched.tableById,
		selectableAreas: new Map(
			sched.areas
				.filter(
					(a) => a.guestSelectable && a.onlineBookable && a.archivedAt === null,
				)
				.map((a) => [a.id, { name: a.name, nameI18n: a.nameI18n }]),
		),
		occupanciesFor: (businessDate) => [
			...(byDate.get(addDays(businessDate, -1)) ?? []),
			...(byDate.get(businessDate) ?? []),
			...(byDate.get(addDays(businessDate, 1)) ?? []),
		],
	}
}

export function searchPublicDay(
	state: PublicEngineState,
	params: {
		businessDate: string
		partySize: number
		now: number
		preferredSlotMin?: number | null
		channel?: BookingChannel
	},
): SearchAvailabilityResult {
	return searchAvailability({
		config: state.config,
		businessDate: params.businessDate,
		partySize: params.partySize,
		preferredSlotMin: params.preferredSlotMin ?? null,
		nowMs: params.now,
		channel: params.channel ?? 'online',
		occupancies: state.occupanciesFor(params.businessDate),
		allowRepair: false,
	})
}

export type PublicSlot = {
	localMin: number
	time: string
	serviceId: string
	serviceName: string
	/** Set only when the slot sits in a guest-selectable seating area. */
	areaId: string | null
	areaLabel: string | null
}

/** Maps engine slots to the public shape, naming the seating area when a guest may choose it. */
export function publicSlotMapper(
	state: Pick<PublicEngineState, 'selectableAreas'>,
	locale?: string | null,
): (slot: AvailableSlot) => PublicSlot {
	return (slot) => {
		const area = state.selectableAreas.get(slot.areaId)
		return {
			localMin: slot.slotMin,
			time: slot.slotHhmm,
			serviceId: slot.serviceId,
			serviceName: slot.serviceName,
			areaId: area ? slot.areaId : null,
			areaLabel: area
				? (pickI18n(area.nameI18n, locale, false) ?? area.name)
				: null,
		}
	}
}

export function uniqueSlotsByTime(
	slots: readonly AvailableSlot[],
): AvailableSlot[] {
	const seen = new Set<number>()
	const out: AvailableSlot[] = []
	for (const slot of [...slots].sort((a, b) => a.slotMin - b.slotMin)) {
		if (seen.has(slot.slotMin)) continue
		seen.add(slot.slotMin)
		out.push(slot)
	}
	return out
}

/** Same-day alternatives: the engine's nearby set first, then the next closest by distance. */
export function sameDayAlternatives(
	slots: readonly AvailableSlot[],
	preferredSlotMin: number,
	limit = 6,
): AvailableSlot[] {
	const near = suggestAlternatives(slots, preferredSlotMin)
	if (near.length >= limit) return near.slice(0, limit)
	const seen = new Set(near.map((s) => s.slotMin))
	const rest = slots
		.filter((s) => !seen.has(s.slotMin) && s.slotMin !== preferredSlotMin)
		.sort(
			(a, b) =>
				Math.abs(a.slotMin - preferredSlotMin) -
					Math.abs(b.slotMin - preferredSlotMin) || a.slotMin - b.slotMin,
		)
	return [...near, ...rest].slice(0, limit)
}

const OTHER_DATE_OFFSETS = [1, -1, 2, -2, 3, -3, 4, 5, 6, 7] as const

export const OTHER_DATE_LOOKAHEAD_DAYS = 7
export const OTHER_DATE_LOOKBEHIND_DAYS = 3

export function otherDateAlternatives(
	state: PublicEngineState,
	params: {
		businessDate: string
		partySize: number
		now: number
		preferredSlotMin: number | null
		limit?: number
	},
): Array<{ date: string; firstLocalMin: number }> {
	const out: Array<{ date: string; firstLocalMin: number }> = []
	for (const offset of OTHER_DATE_OFFSETS) {
		if (out.length >= (params.limit ?? 6)) break
		const date = addDays(params.businessDate, offset)
		const result = searchPublicDay(state, {
			businessDate: date,
			partySize: params.partySize,
			now: params.now,
		})
		if (result.slots.length === 0) continue
		const slots = uniqueSlotsByTime(result.slots)
		const pick =
			params.preferredSlotMin === null
				? slots[0]!
				: slots.reduce((best, s) =>
						Math.abs(s.slotMin - params.preferredSlotMin!) <
						Math.abs(best.slotMin - params.preferredSlotMin!)
							? s
							: best,
					)
		out.push({ date, firstLocalMin: pick.slotMin })
	}
	return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** Special-day or past-date detail for a `closed` day. */
export function describeClosedDay(
	state: PublicEngineState,
	businessDate: string,
): {
	reason: 'special_day' | 'past' | 'closed'
	note: string | null
	name: string | null
} {
	const resolved = resolveServices(
		businessDate,
		state.config.services,
		state.config.specialDays,
	)
	if (resolved.closed) {
		return {
			reason: 'special_day',
			note: resolved.specialDay?.note ?? null,
			name: resolved.specialDay?.name ?? null,
		}
	}
	return { reason: 'past', note: null, name: null }
}

export async function readDayVersion(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
): Promise<number> {
	const row = await db
		.select({ version: rsvDayVersions.version })
		.from(rsvDayVersions)
		.where(
			and(
				eq(rsvDayVersions.locationId, locationId),
				eq(rsvDayVersions.businessDate, businessDate),
			),
		)
		.get()
	return row?.version ?? 1
}
