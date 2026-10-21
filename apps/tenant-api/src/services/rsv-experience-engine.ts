import {
	addDays,
	assignTables,
	buildEffectiveDay,
	currentBusinessDate,
	daysBetween,
	experienceRemainingCovers,
	experienceSeatingsOn,
	formatHhmm,
	instantToLocal,
	instantInIntervals,
	isGuestChannel,
	localToInstant,
	resolveServices,
	type AssignBookingRecord,
	type BookingChannel,
	type ExistingOccupancyInput,
	type ExperienceScheduleInput,
} from '@repo/reservations'
import {
	rsvExperienceSchedules,
	rsvExperiences,
	rsvHolds,
	rsvReservations,
	type RsvExperienceRow,
	type RsvExperienceScheduleRow,
	type RsvReservationStatus,
} from '@repo/tenant-db'
import { and, asc, eq, gt, gte, inArray, lte } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { pickText, type LocaleOrg } from '../lib/reservations-i18n.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	CAPACITY_STATUSES,
	type PublicEngineState,
} from './rsv-public-engine.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * Experience availability and cover caps on top of the table engine
 * (`architecture.md` 1.2 I1(c), 6.3).
 *
 * Model:
 * - A seating is a virtual service on its date: it carries the schedule's
 *   `service_id` (or none) and its own turn time.
 * - Covers booked at a seating are the party sizes of live holds plus
 *   reservations in the capacity statuses the table engine already counts, both
 *   filtered by `experience_id`. Regular bookings never carry an experience id,
 *   so they never touch the cap, and experience rows enter the regular engine
 *   only as table blocks (never pacing), see `loadPublicEngineState`.
 * - `uses_tables = false` is a pure cover-capped pool: no table is read or
 *   written. `uses_tables = true` runs the normal table engine over only the
 *   schedule's areas (and combinations made entirely of those tables).
 * - Exclusive experiences close their window on the tables of their areas to
 *   the regular guest search through `exclusiveWindowBlocks`.
 * - The cap check and the insert run in the same `withReservationWrite`, so the
 *   caller's transaction is what stops two bookings overselling.
 */

/**
 * Compile-time guard: the shared capacity set must stay within the DB enum. It
 * is a type check only, because this module and `rsv-public-engine.ts` import
 * each other and a top-level read would run before that constant exists.
 */
type CapacityStatusesAreDbStatuses =
	(typeof CAPACITY_STATUSES)[number] extends RsvReservationStatus ? true : never
const capacityStatusGuard: CapacityStatusesAreDbStatuses = true
void capacityStatusGuard

export function toScheduleInput(
	row: RsvExperienceScheduleRow,
): ExperienceScheduleInput {
	return {
		id: row.id,
		fromDate: row.fromDate,
		toDate: row.toDate,
		daysMask: row.daysMask,
		seatingMins: row.seatingMins,
		startMin: row.startMin,
		endMin: row.endMin,
		intervalMin: row.intervalMin,
		turnMin: row.turnMin,
		coversCapPerSeating: row.coversCapPerSeating,
		coversCapPerDay: row.coversCapPerDay,
		areaIds: row.areaIds,
		serviceId: row.serviceId,
	}
}

export type LoadedExperience = {
	row: RsvExperienceRow
	schedules: RsvExperienceScheduleRow[]
}

export async function loadExperienceWithSchedules(
	db: DbOrTx,
	locationId: string,
	experienceId: string,
): Promise<LoadedExperience | null> {
	const row = await db
		.select()
		.from(rsvExperiences)
		.where(
			and(
				eq(rsvExperiences.id, experienceId),
				eq(rsvExperiences.locationId, locationId),
			),
		)
		.get()
	if (!row) return null
	const schedules = await db
		.select()
		.from(rsvExperienceSchedules)
		.where(eq(rsvExperienceSchedules.experienceId, row.id))
		.orderBy(
			asc(rsvExperienceSchedules.fromDate),
			asc(rsvExperienceSchedules.id),
		)
		.all()
	return { row, schedules }
}

/**
 * The single seam the payment branch calls: the experience (and its schedules)
 * a booking is for, or a uniform 404 when it does not exist, belongs to another
 * location, or is not published. The booking path reads `row.policyId`,
 * `row.priceMinor`, `row.pricePerCover` and `row.currency` from the result.
 */
export async function getExperienceForBooking(
	db: DbOrTx,
	params: {
		locationId: string
		experienceId: string
		/** Guests may only book published experiences. */
		requirePublished?: boolean
	},
): Promise<LoadedExperience> {
	const loaded = await loadExperienceWithSchedules(
		db,
		params.locationId,
		params.experienceId,
	)
	if (
		!loaded ||
		loaded.row.status === 'archived' ||
		((params.requirePublished ?? true) && loaded.row.status !== 'published')
	) {
		throw new HttpError(404, 'not_found')
	}
	return loaded
}

// ---------------------------------------------------------------------------
// Booked covers
// ---------------------------------------------------------------------------

/** Covers at each seating start minute from live holds and capacity-status reservations. */
export async function loadBookedCoversBySeating(
	db: DbOrTx,
	params: {
		experienceId: string
		businessDate: string
		now: number
		excludeHoldIds?: ReadonlySet<string>
		excludeReservationIds?: ReadonlySet<string>
	},
): Promise<Map<number, number>> {
	const [reservations, holds] = await Promise.all([
		db
			.select({
				id: rsvReservations.id,
				localStartMin: rsvReservations.localStartMin,
				partySize: rsvReservations.partySize,
			})
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.experienceId, params.experienceId),
					eq(rsvReservations.businessDate, params.businessDate),
					inArray(rsvReservations.status, [...CAPACITY_STATUSES]),
				),
			)
			.all(),
		db
			.select({
				id: rsvHolds.id,
				localStartMin: rsvHolds.localStartMin,
				partySize: rsvHolds.partySize,
			})
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.experienceId, params.experienceId),
					eq(rsvHolds.businessDate, params.businessDate),
					eq(rsvHolds.status, 'active'),
					gt(rsvHolds.expiresAt, params.now),
				),
			)
			.all(),
	])
	const booked = new Map<number, number>()
	const add = (min: number, covers: number) =>
		booked.set(min, (booked.get(min) ?? 0) + covers)
	for (const r of reservations) {
		if (params.excludeReservationIds?.has(r.id)) continue
		add(r.localStartMin, r.partySize)
	}
	for (const h of holds) {
		if (params.excludeHoldIds?.has(h.id)) continue
		add(h.localStartMin, h.partySize)
	}
	return booked
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type ExperienceSlot = {
	slotMin: number
	slotHhmm: string
	startAt: number
	endAt: number
	turnMin: number
	serviceId: string | null
	serviceName: string | null
	areaId: string | null
	tableIds: string[]
	combinationId: string | null
	scheduleId: string
	/** Covers left at this seating; `null` when no cap binds. */
	remainingCovers: number | null
}

export type ExperienceDayStatus =
	| 'available'
	| 'full'
	| 'closed'
	| 'online_closed'
	| 'beyond_horizon'
	| 'party_out_of_bounds'
	| 'disabled'

export type ExperienceDayResult = {
	status: ExperienceDayStatus
	slots: ExperienceSlot[]
	/** Seating start minutes offered that day but unable to take this party. */
	soldOut: number[]
}

const NO_SLOTS = (status: ExperienceDayStatus): ExperienceDayResult => ({
	status,
	slots: [],
	soldOut: [],
})

export function toAssignRecords(
	occupancies: readonly ExistingOccupancyInput[],
): AssignBookingRecord[] {
	return occupancies.map((o) => ({
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
		expiresAt: o.expiresAt,
	}))
}

function seatingStartAt(
	businessDate: string,
	seatingMin: number,
	timeZone: string,
): number | null {
	const dayOffset = Math.floor(seatingMin / 1440)
	const clockMin = ((seatingMin % 1440) + 1440) % 1440
	const calendarDate =
		dayOffset === 0 ? businessDate : addDays(businessDate, dayOffset)
	const resolved = localToInstant(calendarDate, clockMin, timeZone, {
		gap: 'skip',
		overlap: 'earlier',
	})
	return resolved === null ? null : resolved.instantMs
}

/**
 * Seatings of one experience on one date that can take `partySize`.
 * `excludeHoldIds` lets a booking re-validate while its own hold is live.
 */
export async function searchExperienceDay(
	db: DbOrTx,
	state: PublicEngineState,
	loaded: LoadedExperience,
	params: {
		businessDate: string
		partySize: number
		now: number
		channel?: BookingChannel
		excludeHoldIds?: ReadonlySet<string>
		excludeReservationIds?: ReadonlySet<string>
	},
): Promise<ExperienceDayResult> {
	const { row, schedules } = loaded
	const { settings, config } = state
	const channel = params.channel ?? 'online'
	const guest = isGuestChannel(channel)
	const { businessDate, now, partySize } = params

	if (!settings.enabled || (guest && !settings.onlineEnabled)) {
		return NO_SLOTS('disabled')
	}
	if (row.status === 'archived' || (guest && row.status !== 'published')) {
		return NO_SLOTS('disabled')
	}
	if (partySize < row.partyMin || partySize > row.partyMax) {
		return NO_SLOTS('party_out_of_bounds')
	}

	const todayBusiness = currentBusinessDate(
		now,
		state.timeZone,
		settings.dayStartMin,
	)
	const nowLocal = instantToLocal(now, state.timeZone, settings.dayStartMin)
	const daysAhead = daysBetween(todayBusiness, businessDate)
	if (daysAhead < 0) return NO_SLOTS('closed')
	if (guest) {
		if (daysAhead > settings.horizonDays) return NO_SLOTS('beyond_horizon')
		if (
			daysAhead === settings.horizonDays &&
			nowLocal.clockMin < (settings.releaseLocalMin ?? 0)
		) {
			return NO_SLOTS('beyond_horizon')
		}
		if (
			daysAhead === 0 &&
			settings.sameDayCutoffMin !== null &&
			nowLocal.localStartMin >= settings.sameDayCutoffMin
		) {
			return NO_SLOTS('full')
		}
	}

	const resolvedDay = resolveServices(
		businessDate,
		config.services,
		config.specialDays,
	)
	if (resolvedDay.closed) return NO_SLOTS('closed')
	if (guest && resolvedDay.onlineClosed) return NO_SLOTS('online_closed')

	// Location hours are the single source of truth for when the venue is
	// open, exactly as for table availability: guests never see seatings on a
	// closed day or outside the open intervals.
	const effectiveDay = buildEffectiveDay({
		businessDate,
		hours: config.locationHours,
		dayStartMin: settings.dayStartMin,
		reservation: resolvedDay,
	})
	if (
		guest &&
		!effectiveDay.open &&
		effectiveDay.source === 'location_closed'
	) {
		return NO_SLOTS('closed')
	}

	const scheduleInputs = schedules.map(toScheduleInput)
	const seatings = experienceSeatingsOn(scheduleInputs, businessDate)
	if (seatings.length === 0) return NO_SLOTS('full')

	const booked = await loadBookedCoversBySeating(db, {
		experienceId: row.id,
		businessDate,
		now,
		excludeHoldIds: params.excludeHoldIds,
		excludeReservationIds: params.excludeReservationIds,
	})
	const earliestMs = now + (guest ? settings.minNoticeMin * 60_000 : 0)
	const bufferMin = config.settings.bufferMin

	// Tables the experience may use: its areas only, and combinations built
	// entirely from them. Occupancy of every table still counts as taken.
	const scopedTables = config.tables
	const scheduleById = new Map<string, ExperienceScheduleInput>(
		scheduleInputs.map((s) => [s.id, s]),
	)

	const occupancies = [
		...state.occupanciesFor(businessDate),
		...state
			.exclusiveBlocksFor(businessDate)
			.filter((b) => b.experienceId !== row.id),
	]
	const assignBookings = toAssignRecords(occupancies)

	const slots: ExperienceSlot[] = []
	const soldOut: number[] = []

	for (const seating of seatings) {
		const schedule = scheduleById.get(seating.scheduleId)!
		const remaining = experienceRemainingCovers({
			schedule,
			seatingMin: seating.seatingMin,
			bookedBySeating: booked,
		})

		let serviceName: string | null = null
		if (schedule.serviceId) {
			const service = resolvedDay.services.find(
				(s) => s.id === schedule.serviceId,
			)
			if (!service) continue
			const start = service.firstSeatingMin ?? service.startMin
			const end =
				service.endMin <= service.startMin
					? service.endMin + 1440
					: service.endMin
			if (seating.seatingMin < start || seating.seatingMin >= end) continue
			serviceName = service.name
		}

		const startAt = seatingStartAt(
			businessDate,
			seating.seatingMin,
			state.timeZone,
		)
		if (startAt === null || startAt < earliestMs) continue
		if (guest && !instantInIntervals(effectiveDay.intervals, startAt)) continue

		if (remaining < partySize) {
			soldOut.push(seating.seatingMin)
			continue
		}

		const endAt = startAt + (schedule.turnMin + bufferMin) * 60_000
		let tableIds: string[] = []
		let combinationId: string | null = null
		let areaId: string | null = null

		if (row.usesTables) {
			const areaScope =
				schedule.areaIds && schedule.areaIds.length > 0
					? new Set(schedule.areaIds)
					: null
			const tables = areaScope
				? scopedTables.filter((t) => areaScope.has(t.areaId ?? t.area_id ?? ''))
				: scopedTables
			const tableIdSet = new Set(tables.map((t) => t.id))
			const combinations = areaScope
				? config.combinations.filter((c) => {
						const members = c.tableIds ?? c.table_ids ?? []
						return (
							members.length > 0 && members.every((id) => tableIdSet.has(id))
						)
					})
				: config.combinations
			const assigned = assignTables({
				partySize,
				startAt,
				endAt,
				slotMin: seating.seatingMin,
				channel,
				serviceId: schedule.serviceId,
				areaId: null,
				tables,
				areas: areaScope
					? config.areas.filter((a) => areaScope.has(a.id))
					: config.areas,
				combinations,
				serviceTableModes:
					config.serviceAvailability ?? config.serviceTableModes,
				bookings: assignBookings,
				nowMs: now,
				assignmentFreezeMin: config.settings.assignmentFreezeMin,
				minTurnMin: schedule.turnMin,
				baseBufferMin: bufferMin,
				maxExpansions: 0,
				allowRepair: false,
				skipPacing: true,
			})
			if (!assigned.assigned) {
				soldOut.push(seating.seatingMin)
				continue
			}
			tableIds = assigned.tableIds
			combinationId = assigned.combinationId
			areaId = assigned.areaId
		}

		slots.push({
			slotMin: seating.seatingMin,
			slotHhmm: formatHhmm(seating.seatingMin),
			startAt,
			endAt: startAt + schedule.turnMin * 60_000,
			turnMin: schedule.turnMin,
			serviceId: schedule.serviceId,
			serviceName,
			areaId,
			tableIds,
			combinationId,
			scheduleId: schedule.id,
			remainingCovers: Number.isFinite(remaining) ? remaining : null,
		})
	}

	return {
		status: slots.length > 0 ? 'available' : 'full',
		slots,
		soldOut,
	}
}

/**
 * The seating a hold or booking asks for, re-checked against live caps and
 * tables inside the caller's write transaction. Refusals use the same codes as
 * the regular path.
 */
export async function matchExperienceSeating(
	db: DbOrTx,
	state: PublicEngineState,
	params: {
		locationId: string
		experienceId: string
		businessDate: string
		localMin: number
		partySize: number
		now: number
		channel: BookingChannel
		excludeHoldIds?: ReadonlySet<string>
	},
): Promise<ExperienceSlot> {
	const loaded = await getExperienceForBooking(db, {
		locationId: params.locationId,
		experienceId: params.experienceId,
		requirePublished: isGuestChannel(params.channel),
	}).catch((error: unknown) => {
		// A hold on an experience that was unpublished meanwhile is just sold out.
		if (error instanceof HttpError && error.status === 404) return null
		throw error
	})
	if (!loaded) throw new HttpError(409, 'slot_unavailable')
	const result = await searchExperienceDay(db, state, loaded, {
		businessDate: params.businessDate,
		partySize: params.partySize,
		now: params.now,
		channel: params.channel,
		excludeHoldIds: params.excludeHoldIds,
	})
	if (result.status === 'disabled') throw new HttpError(404, 'not_found')
	if (result.status === 'party_out_of_bounds') {
		throw new HttpError(400, 'party_size_invalid')
	}
	const match = result.slots.find((s) => s.slotMin === params.localMin)
	if (!match) throw new HttpError(409, 'slot_unavailable')
	return match
}

// ---------------------------------------------------------------------------
// Exclusive windows
// ---------------------------------------------------------------------------

/**
 * Table blocks that close exclusive experience windows to the regular guest
 * search. One block per seating and table, over the schedule's areas (every
 * table when the schedule names none). Each block carries its `experienceId`
 * so the experience's own search can ignore it.
 */
export async function loadExclusiveWindowBlocks(
	db: DbOrTx,
	params: {
		locationId: string
		fromDate: string
		toDate: string
		timeZone: string
		tables: ReadonlyArray<{ id: string; areaId: string }>
	},
): Promise<Map<string, ExistingOccupancyInput[]>> {
	const byDate = new Map<string, ExistingOccupancyInput[]>()
	const experiences = await db
		.select()
		.from(rsvExperiences)
		.where(
			and(
				eq(rsvExperiences.locationId, params.locationId),
				eq(rsvExperiences.status, 'published'),
				eq(rsvExperiences.exclusive, true),
			),
		)
		.all()
	if (experiences.length === 0) return byDate
	const schedules = await db
		.select()
		.from(rsvExperienceSchedules)
		.where(
			and(
				inJsonList(
					rsvExperienceSchedules.experienceId,
					experiences.map((e) => e.id),
				),
				lte(rsvExperienceSchedules.fromDate, params.toDate),
				gte(rsvExperienceSchedules.toDate, params.fromDate),
			),
		)
		.all()
	const span = daysBetween(params.fromDate, params.toDate)
	for (const exp of experiences) {
		const own = schedules
			.filter((s) => s.experienceId === exp.id)
			.map(toScheduleInput)
		for (let i = 0; i <= span; i++) {
			const date = addDays(params.fromDate, i)
			for (const seating of experienceSeatingsOn(own, date)) {
				const schedule = own.find((s) => s.id === seating.scheduleId)!
				const startAt = seatingStartAt(
					date,
					seating.seatingMin,
					params.timeZone,
				)
				if (startAt === null) continue
				const areaScope =
					schedule.areaIds && schedule.areaIds.length > 0
						? new Set(schedule.areaIds)
						: null
				const tableIds = params.tables
					.filter((t) => !areaScope || areaScope.has(t.areaId))
					.map((t) => t.id)
				if (tableIds.length === 0) continue
				const list = byDate.get(date) ?? []
				list.push({
					id: `xw_${exp.id}_${seating.seatingMin}`,
					kind: 'block',
					experienceId: exp.id,
					startAt,
					endAt: startAt + schedule.turnMin * 60_000,
					localStartMin: seating.seatingMin,
					tableIds,
				})
				byDate.set(date, list)
			}
		}
	}
	return byDate
}

// ---------------------------------------------------------------------------
// Manage view
// ---------------------------------------------------------------------------

/** The experience label of a booking for the guest's manage view (catalog data, no PII). */
export async function loadManageExperience(
	db: DbOrTx,
	experienceId: string,
	locale: string | null,
	org: LocaleOrg,
): Promise<{ id: string; slug: string; name: string } | null> {
	const row = await db
		.select()
		.from(rsvExperiences)
		.where(eq(rsvExperiences.id, experienceId))
		.get()
	if (!row) return null
	const name = pickText(row.nameI18n, locale, org) ?? row.slug
	return { id: row.id, slug: row.slug, name }
}
