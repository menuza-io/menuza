import { createHash, randomUUID } from 'node:crypto'
import {
	buildEffectiveDay,
	describeLocationClosedReason,
	detectConflicts,
	evaluatePacing,
	extractDietaryCodes,
	instantInIntervals,
	localToInstant,
	resolveServices,
	type AvailableSlot,
	type ConflictBlockInput,
	type ConflictBookingInput,
	type EngineAreaInput,
	type EngineCombinationInput,
	type EnginePacingRuleInput,
	type EngineTableInput,
} from '@repo/reservations'
import { dayOfWeek } from '@repo/zoned-time'
import {
	rsvAreas,
	rsvAuditLog,
	rsvBlocks,
	rsvDayVersions,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvPacingRules,
	rsvReservationEvents,
	rsvReservationTags,
	rsvReservations,
	rsvSectionAssignments,
	rsvServiceAvailability,
	rsvServiceNotes,
	rsvServices,
	rsvSpecialDays,
	rsvTableOccupancies,
	rsvTables,
	rsvTags,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lte,
	sql,
} from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import {
	loadGuestTagsMap,
	loadPinnedNotesMap,
	serializeGuestRow,
	type DbOrTx,
	type SerializedGuestSummary,
} from './rsv-guest-service.ts'
import {
	getLocationSettingsWithContext,
	listAreasForLocation,
	listCombosForLocation,
	listFloorElementsForLocation,
	listSectionLayoutsForLocation,
	listServicesForLocation,
	listSpecialDaysForLocation,
	listTablesForLocation,
} from './rsv-setup-service.ts'
import {
	ACTIVE_OCCUPANCY_STATUSES,
	findOperatorPacingBreaches,
} from './rsv-operator-pacing.ts'
import { loadPublicEngineState, searchPublicDay } from './rsv-public-engine.ts'
import { getPaymentSummaryCounts } from './rsv-payment-summary.ts'
import { loadLocationHours } from './rsv-location-hours.ts'
import { loadStaffDayState, publicStaffDayState } from './rsv-special-days.ts'

function createId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

export function formatMinutesToHHMM(localMin: number): string {
	const normalized = ((Math.floor(localMin) % 1440) + 1440) % 1440
	const hh = Math.floor(normalized / 60)
	const mm = normalized % 60
	return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function parseTimeToMinutes(value: string | number): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.floor(value)
	}
	if (typeof value === 'string') {
		const trimmed = value.trim()
		if (/^\d+$/.test(trimmed)) {
			return Number.parseInt(trimmed, 10)
		}
		const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
		if (match) {
			const hh = Number.parseInt(match[1]!, 10)
			const mm = Number.parseInt(match[2]!, 10)
			if (hh >= 0 && hh <= 29 && mm >= 0 && mm < 60) {
				return hh * 60 + mm
			}
		}
	}
	throw badRequest('invalid_time', 'Invalid time value')
}

export async function getCurrentDayVersion(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
): Promise<number> {
	const row = await db
		.select()
		.from(rsvDayVersions)
		.where(
			and(
				eq(rsvDayVersions.locationId, locationId),
				eq(rsvDayVersions.businessDate, businessDate),
			),
		)
		.get()
	return row?.version ?? 0
}

export async function bumpDayVersionRow(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
): Promise<number> {
	const now = Date.now()
	await db
		.insert(rsvDayVersions)
		.values({
			locationId,
			businessDate,
			version: 1,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [rsvDayVersions.locationId, rsvDayVersions.businessDate],
			set: {
				version: sql`${rsvDayVersions.version} + 1`,
				updatedAt: now,
			},
		})
	return getCurrentDayVersion(db, locationId, businessDate)
}

export function matchesDayFeedEtag(
	ifNoneMatchHeader: string | undefined | null,
	etag: string,
	shortEtag: string,
): boolean {
	if (!ifNoneMatchHeader) return false
	const rawCandidates = ifNoneMatchHeader
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	if (rawCandidates.includes('*')) return true

	const stripWeakAndQuotes = (val: string) =>
		val.replace(/^W\//i, '').replace(/^"/, '').replace(/"$/, '')

	const targetFull = stripWeakAndQuotes(etag)
	const targetShort = stripWeakAndQuotes(shortEtag)

	for (const candidate of rawCandidates) {
		const norm = stripWeakAndQuotes(candidate)
		if (norm === targetFull || norm === targetShort) {
			return true
		}
	}
	return false
}

export interface SerializedBookReservation {
	id: string
	locationId: string
	location_id: string
	guestId: string | null
	guest_id: string | null
	confirmationCode: string
	confirmation_code: string
	businessDate: string
	business_date: string
	date: string
	localStartMin: number
	local_start_min: number
	time: string
	timeZone: string
	time_zone: string
	startAt: number
	start_at: number
	endAt: number
	end_at: number
	durationMin: number
	duration_min: number
	serviceId: string | null
	service_id: string | null
	experienceId: string | null
	experience_id: string | null
	partySize: number
	party_size: number
	arrivedCovers: number | null
	arrived_covers: number | null
	arrivedPartySize: number | null
	seatedCovers: number | null
	seated_covers: number | null
	seatedPartySize: number | null
	coversActual: number | null
	covers_actual: number | null
	status: string
	contactStatus: string
	contact_status: string
	runningLateMin: number | null
	running_late_min: number | null
	runningLateMinutes: number | null
	runningLateNote: string | null
	running_late_note: string | null
	courseStatus: string | null
	course_status: string | null
	channel: string
	/** The `X-Client` value recorded at booking (`web`, `ios`, `android`, `operator`, ...). */
	client: string | null
	assignment: 'soft' | 'locked' | 'unassigned'
	locked: boolean
	tableLocked: boolean
	table_locked: boolean
	comboId: string | null
	combo_id: string | null
	overbook: boolean
	overbooked: boolean
	areaPrefId: string | null
	area_pref_id: string | null
	diningAreaId: string | null
	areaPrefStrict: boolean
	area_pref_strict: boolean
	occasionTagId: string | null
	occasion_tag_id: string | null
	occasion: string | null
	guestRequests: string | null
	guest_requests: string | null
	dietaryNotes: string | null
	dietary_notes: string | null
	staffNotes: string | null
	staff_notes: string | null
	internalNotes: string | null
	hasAllergy: boolean
	has_allergy: boolean
	/** Same as `hasAllergy`: operational flag for every `read:reservation` token. */
	allergyFlag: boolean
	/** Coded dietary/allergen values only (never free text); safe without the guest grant. */
	dietaryCodes: string[]
	paymentStatus: string
	payment_status: string
	lateCancel: boolean
	late_cancel: boolean
	version: number
	scheduleVersion: number
	schedule_version: number
	arrivedAt: number | null
	arrived_at: number | null
	seatedAt: number | null
	seated_at: number | null
	finishedAt: number | null
	finished_at: number | null
	cancelledAt: number | null
	cancelled_at: number | null
	noShowAt: number | null
	no_show_at: number | null
	cancelReason: string | null
	cancel_reason: string | null
	createdAt: number
	created_at: number
	updatedAt: number
	updated_at: number
	tableIds: string[]
	table_ids: string[]
	tableLabels: string[]
	table_labels: string[]
	guest: SerializedGuestSummary | null
}

/**
 * The occasion code a client chooses (`anniversary`), as opposed to the tag id
 * that stores it (`tag_acme_anniversary`). Ad-hoc occasions have no system key,
 * so their id is the best remaining code.
 */
function bareOccasionValue(tagId: string, systemKey: string | null): string {
	return systemKey ?? tagId.replace(/^tag_occ_/, '')
}

export async function serializeReservationsForBook(
	db: DbOrTx,
	rows: Array<typeof rsvReservations.$inferSelect>,
	opts?: { canReadGuestSensitive?: boolean },
): Promise<SerializedBookReservation[]> {
	if (rows.length === 0) return []
	const canReadSensitive = opts?.canReadGuestSensitive === true

	const resIds = rows.map((r) => r.id)
	const occRows = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					inArray(rsvTableOccupancies.reservationId, chunk),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all(),
	)

	// For finished/cancelled/no_show reservations, fall back to their most recent inactive occupancy so historical table assignment is still visible
	const inactiveOccRows = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					inArray(rsvTableOccupancies.reservationId, chunk),
					eq(rsvTableOccupancies.active, false),
				),
			)
			.all(),
	)

	const activeTableIdsByRes = new Map<string, string[]>()
	for (const occ of occRows) {
		if (!occ.reservationId) continue
		const list = activeTableIdsByRes.get(occ.reservationId) ?? []
		if (!list.includes(occ.tableId)) list.push(occ.tableId)
		activeTableIdsByRes.set(occ.reservationId, list)
	}

	const inactiveTableIdsByRes = new Map<string, string[]>()
	for (const occ of inactiveOccRows) {
		if (!occ.reservationId) continue
		const list = inactiveTableIdsByRes.get(occ.reservationId) ?? []
		if (!list.includes(occ.tableId)) list.push(occ.tableId)
		inactiveTableIdsByRes.set(occ.reservationId, list)
	}

	const locationIds = [...new Set(rows.map((r) => r.locationId))]
	const tableRows = await queryInChunks(locationIds, (chunk) =>
		db
			.select()
			.from(rsvTables)
			.where(inArray(rsvTables.locationId, chunk))
			.all(),
	)
	const tableLabelById = new Map(tableRows.map((t) => [t.id, t.label]))

	const guestIds = [
		...new Set(
			rows.map((r) => r.guestId).filter((id): id is string => Boolean(id)),
		),
	]
	const guestRows = await queryInChunks(guestIds, (chunk) =>
		db.select().from(rsvGuests).where(inArray(rsvGuests.id, chunk)).all(),
	)
	const guestById = new Map(guestRows.map((g) => [g.id, g]))
	const pinnedNotesMap = await loadPinnedNotesMap(db, guestIds)
	const tagsMap = await loadGuestTagsMap(db, guestIds, {
		canReadSensitive,
	})

	const occasionTagIds = [
		...new Set(
			rows
				.map((r) => r.occasionTagId)
				.filter((id): id is string => Boolean(id)),
		),
	]
	const occasionTagRows = await queryInChunks(occasionTagIds, (chunk) =>
		db
			.select({ id: rsvTags.id, systemKey: rsvTags.systemKey })
			.from(rsvTags)
			.where(inArray(rsvTags.id, chunk))
			.all(),
	)
	const occasionByTagId = new Map(
		occasionTagRows.map((t) => [t.id, bareOccasionValue(t.id, t.systemKey)]),
	)

	const auxEvents = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvReservationEvents)
			.where(
				and(
					inArray(rsvReservationEvents.reservationId, chunk),
					inArray(rsvReservationEvents.type, [
						'running_late',
						'contact_status',
						'course',
					]),
				),
			)
			.orderBy(asc(rsvReservationEvents.at))
			.all(),
	)
	const runningLateNoteByRes = new Map<string, string>()
	const contactStatusByRes = new Map<string, string>()
	const courseStatusByRes = new Map<string, string>()
	for (const ev of auxEvents) {
		const data = ev.data as Record<string, unknown> | null
		if (!data) continue
		if (ev.type === 'running_late') {
			if (typeof data.runningLateNote === 'string') {
				runningLateNoteByRes.set(ev.reservationId, data.runningLateNote)
			} else if (typeof data.note === 'string') {
				runningLateNoteByRes.set(ev.reservationId, data.note)
			}
		} else if (ev.type === 'contact_status') {
			if (typeof data.contactStatus === 'string') {
				contactStatusByRes.set(ev.reservationId, data.contactStatus)
			}
		} else if (ev.type === 'course') {
			if (typeof data.courseStatus === 'string') {
				courseStatusByRes.set(ev.reservationId, data.courseStatus)
			}
		}
	}

	return rows.map((r) => {
		const activeTids = activeTableIdsByRes.get(r.id) ?? []
		const fallbackTids =
			r.status === 'finished' ? (inactiveTableIdsByRes.get(r.id) ?? []) : []
		const tableIds = activeTids.length > 0 ? activeTids : fallbackTids
		const tableLabels = tableIds.map((tid) => tableLabelById.get(tid) ?? tid)

		const guestRow = r.guestId ? guestById.get(r.guestId) : undefined
		const guestSummary = guestRow
			? {
					...serializeGuestRow(guestRow, tagsMap.get(guestRow.id) ?? [], {
						canReadSensitive,
					}),
					pinnedNotes: pinnedNotesMap.get(guestRow.id) ?? [],
				}
			: null

		const rawDietary = Boolean(
			r.dietaryNotes && r.dietaryNotes.trim().length > 0,
		)
		const hasAllergy = Boolean(guestSummary?.hasAllergy || rawDietary)
		const dietaryNotes = canReadSensitive ? r.dietaryNotes : null
		// Coded values only: free text stays behind the guest grant.
		const dietaryCodes: string[] = extractDietaryCodes(r.dietaryNotes)
		const runningLateNote =
			runningLateNoteByRes.get(r.id) ??
			(r.runningLateMin !== null
				? `Running ${r.runningLateMin} min late`
				: null)
		const resolvedContactStatus =
			contactStatusByRes.get(r.id) ?? r.contactStatus ?? 'none'
		const resolvedCourseStatus =
			r.courseStatus !== null
				? (courseStatusByRes.get(r.id) ?? r.courseStatus)
				: null

		return {
			id: r.id,
			locationId: r.locationId,
			location_id: r.locationId,
			guestId: r.guestId,
			guest_id: r.guestId,
			confirmationCode: r.confirmationCode,
			confirmation_code: r.confirmationCode,
			businessDate: r.businessDate,
			business_date: r.businessDate,
			date: r.businessDate,
			localStartMin: r.localStartMin,
			local_start_min: r.localStartMin,
			time: formatMinutesToHHMM(r.localStartMin),
			timeZone: r.timeZone,
			time_zone: r.timeZone,
			startAt: r.startAt,
			start_at: r.startAt,
			endAt: r.endAt,
			end_at: r.endAt,
			durationMin: r.durationMin,
			duration_min: r.durationMin,
			serviceId: r.serviceId,
			service_id: r.serviceId,
			experienceId: r.experienceId,
			experience_id: r.experienceId,
			partySize: r.partySize,
			party_size: r.partySize,
			arrivedCovers: r.arrivedCovers,
			arrived_covers: r.arrivedCovers,
			arrivedPartySize: r.arrivedCovers,
			seatedCovers: r.seatedCovers,
			seated_covers: r.seatedCovers,
			seatedPartySize: r.seatedCovers,
			coversActual: r.coversActual ?? r.seatedCovers,
			covers_actual: r.coversActual ?? r.seatedCovers,
			status: r.status,
			contactStatus: resolvedContactStatus,
			contact_status: resolvedContactStatus,
			runningLateMin: r.runningLateMin,
			running_late_min: r.runningLateMin,
			runningLateMinutes: r.runningLateMin,
			runningLateNote,
			running_late_note: runningLateNote,
			courseStatus: resolvedCourseStatus,
			course_status: resolvedCourseStatus,
			channel: r.channel,
			client: r.client ?? null,
			assignment: r.assignment,
			locked: r.assignment === 'locked',
			tableLocked: r.assignment === 'locked',
			table_locked: r.assignment === 'locked',
			comboId: r.comboId,
			combo_id: r.comboId,
			overbook: r.overbooked,
			overbooked: r.overbooked,
			areaPrefId: r.areaPrefId,
			area_pref_id: r.areaPrefId,
			diningAreaId: r.areaPrefId,
			areaPrefStrict: r.areaPrefStrict,
			area_pref_strict: r.areaPrefStrict,
			occasionTagId: r.occasionTagId,
			occasion_tag_id: r.occasionTagId,
			occasion: r.occasionTagId
				? (occasionByTagId.get(r.occasionTagId) ??
					bareOccasionValue(r.occasionTagId, null))
				: null,
			guestRequests: r.guestRequests,
			guest_requests: r.guestRequests,
			dietaryNotes,
			dietary_notes: dietaryNotes,
			staffNotes: r.staffNotes,
			staff_notes: r.staffNotes,
			internalNotes: r.staffNotes,
			hasAllergy,
			has_allergy: hasAllergy,
			allergyFlag: hasAllergy,
			dietaryCodes,
			paymentStatus: r.paymentStatus,
			payment_status: r.paymentStatus,
			lateCancel: r.lateCancel,
			late_cancel: r.lateCancel,
			version: r.version,
			scheduleVersion: r.scheduleVersion,
			schedule_version: r.scheduleVersion,
			arrivedAt: r.arrivedAt,
			arrived_at: r.arrivedAt,
			seatedAt: r.seatedAt,
			seated_at: r.seatedAt,
			finishedAt: r.finishedAt,
			finished_at: r.finishedAt,
			cancelledAt: r.cancelledAt,
			cancelled_at: r.cancelledAt,
			noShowAt: r.noShowAt,
			no_show_at: r.noShowAt,
			cancelReason: r.cancelReason,
			cancel_reason: r.cancelReason,
			createdAt: r.createdAt,
			created_at: r.createdAt,
			updatedAt: r.updatedAt,
			updated_at: r.updatedAt,
			tableIds,
			table_ids: tableIds,
			tableLabels,
			table_labels: tableLabels,
			guest: guestSummary,
		}
	})
}

async function applyDayFeedFilters(
	db: DbOrTx,
	reservations: SerializedBookReservation[],
	input: {
		filters: DayFeedFilters
		tables: Array<{ id: string; areaId: string }>
		services: Array<{ id: string; firstSeatingMin: number; endMin: number }>
	},
): Promise<SerializedBookReservation[]> {
	const { filters } = input
	if (Object.keys(filters).length === 0) return reservations
	let result = reservations

	if (filters.serviceId) {
		const svc = input.services.find((x) => x.id === filters.serviceId)
		result = result.filter((r) => {
			if (r.serviceId) return r.serviceId === filters.serviceId
			return (
				svc !== undefined &&
				r.localStartMin >= svc.firstSeatingMin &&
				r.localStartMin < svc.endMin
			)
		})
	}

	if (filters.areaId) {
		const areaByTable = new Map(input.tables.map((t) => [t.id, t.areaId]))
		result = result.filter((r) =>
			r.tableIds.length > 0
				? r.tableIds.some((tid) => areaByTable.get(tid) === filters.areaId)
				: r.areaPrefId === filters.areaId,
		)
	}

	if (filters.source) {
		const sources = new Set(
			filters.source
				.split(',')
				.map((v) => v.trim().toLowerCase())
				.filter(Boolean),
		)
		result = result.filter((r) => sources.has(r.channel.toLowerCase()))
	}

	if (filters.tag && result.length > 0) {
		const wanted = filters.tag.toLowerCase()
		const matches = (tag: { id: string; name: string }) =>
			tag.id === filters.tag || tag.name.toLowerCase() === wanted
		const reservationTagRows = await queryInChunks(
			result.map((r) => r.id),
			(chunk) =>
				db
					.select({
						reservationId: rsvReservationTags.reservationId,
						id: rsvTags.id,
						name: rsvTags.name,
					})
					.from(rsvReservationTags)
					.innerJoin(rsvTags, eq(rsvReservationTags.tagId, rsvTags.id))
					.where(inArray(rsvReservationTags.reservationId, chunk))
					.all(),
		)
		const taggedReservationIds = new Set(
			reservationTagRows.filter(matches).map((row) => row.reservationId),
		)
		result = result.filter(
			(r) =>
				taggedReservationIds.has(r.id) ||
				(r.guest?.tags ?? []).some((tag) => matches(tag)),
		)
	}

	return result
}

async function loadMoveNotices(
	db: DbOrTx,
	reservations: SerializedBookReservation[],
	tables: Array<{ id: string; label: string }>,
) {
	if (reservations.length === 0) return []
	const byId = new Map(reservations.map((r) => [r.id, r]))
	const labelById = new Map(tables.map((t) => [t.id, t.label]))
	const events = (
		await queryInChunks([...byId.keys()], (chunk) =>
			db
				.select()
				.from(rsvReservationEvents)
				.where(
					and(
						inArray(rsvReservationEvents.reservationId, chunk),
						eq(rsvReservationEvents.type, 'auto_reassigned'),
					),
				)
				.orderBy(desc(rsvReservationEvents.at))
				.limit(50)
				.all(),
		)
	)
		.sort((a, b) => b.at - a.at)
		.slice(0, 50)

	const toIds = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
	const notices = []
	for (const ev of events) {
		const r = byId.get(ev.reservationId)
		if (!r) continue
		const data = (ev.data ?? {}) as Record<string, unknown>
		const fromTableIds = toIds(data.fromTableIds)
		const toTableIds = toIds(data.toTableIds)
		notices.push({
			reservationId: r.id,
			confirmationCode: r.confirmationCode,
			guestName: r.guest?.name ?? '',
			partySize: r.partySize,
			localStartMin: r.localStartMin,
			hhmm: r.time,
			fromTableIds,
			fromTableLabels: fromTableIds.map((id) => labelById.get(id) ?? id),
			toTableIds,
			toTableLabels: toTableIds.map((id) => labelById.get(id) ?? id),
			reason: typeof data.reason === 'string' ? data.reason : 'reflow',
			at: ev.at,
		})
	}
	return notices
}

/**
 * Bookings sitting on a table that a block covers (locked bookings are never
 * moved by a block) and bookings that share a table in overlapping windows.
 */
function detectDayFeedConflicts(
	reservations: SerializedBookReservation[],
	blocks: Array<{
		id: string
		tableId: string | null
		areaId: string | null
		startAt: number
		endAt: number
		reason: string | null
	}>,
	tables: Array<{ id: string; label: string; areaId: string }>,
) {
	const labelById = new Map(tables.map((t) => [t.id, t.label]))
	const active = reservations.filter(
		(r) =>
			r.status !== 'cancelled' &&
			r.status !== 'no_show' &&
			r.status !== 'finished' &&
			r.tableIds.length > 0,
	)
	const base = (r: SerializedBookReservation) => ({
		reservationId: r.id,
		bookingId: r.id,
		confirmationCode: r.confirmationCode,
		guestName: r.guest?.name ?? '',
		partySize: r.partySize,
		localStartMin: r.localStartMin,
		hhmm: r.time,
		suggestedTableIds: [] as string[],
		suggestedTableLabels: [] as string[],
	})
	const conflicts: Array<
		ReturnType<typeof base> & {
			kind: 'blocked_table' | 'table_overlap'
			reason: 'table_blocked' | 'table_overlap'
			tableIds: string[]
			blockId?: string
			message: string
		}
	> = []

	for (const blk of blocks) {
		const blockedTableIds = new Set<string>()
		if (blk.tableId) blockedTableIds.add(blk.tableId)
		if (blk.areaId) {
			for (const t of tables)
				if (t.areaId === blk.areaId) blockedTableIds.add(t.id)
		}
		for (const r of active) {
			if (r.startAt >= blk.endAt || r.endAt <= blk.startAt) continue
			const hit = r.tableIds.filter((tid) => blockedTableIds.has(tid))
			if (hit.length === 0) continue
			conflicts.push({
				...base(r),
				kind: 'blocked_table',
				reason: 'table_blocked',
				tableIds: hit,
				blockId: blk.id,
				message: `Table ${hit.map((tid) => labelById.get(tid) ?? tid).join(', ')} is blocked during this booking`,
			})
		}
	}

	for (let i = 0; i < active.length; i++) {
		for (let j = i + 1; j < active.length; j++) {
			const a = active[i]!
			const b = active[j]!
			if (a.startAt >= b.endAt || a.endAt <= b.startAt) continue
			const shared = a.tableIds.filter((tid) => b.tableIds.includes(tid))
			if (shared.length === 0) continue
			conflicts.push({
				...base(b),
				kind: 'table_overlap',
				reason: 'table_overlap',
				tableIds: shared,
				message: `Overlaps with ${a.confirmationCode} on ${shared.map((tid) => labelById.get(tid) ?? tid).join(', ')}`,
			})
		}
	}
	return conflicts
}

export type DayFeedFilters = {
	serviceId?: string
	areaId?: string
	/** Booking channel (`phone`, `walk_in`, ...); comma-separated for several. */
	source?: string
	/** Tag id or name, matched against the guest's and the reservation's tags. */
	tag?: string
}

type DayFeedOptions = {
	canReadGuestSensitive?: boolean
	filters?: DayFeedFilters
}

function normalizeDayFeedFilters(
	filters: DayFeedFilters | undefined,
): DayFeedFilters {
	const out: DayFeedFilters = {}
	for (const key of ['serviceId', 'areaId', 'source', 'tag'] as const) {
		const value = filters?.[key]?.trim()
		if (value) out[key] = value
	}
	return out
}

function filtersEtagSuffix(filters: DayFeedFilters): string {
	const keys = Object.keys(filters)
	if (keys.length === 0) return ''
	const digest = createHash('sha1')
		.update(JSON.stringify(filters, Object.keys(filters).sort()))
		.digest('hex')
		.slice(0, 10)
	return `.f${digest}`
}

export async function getDayFeed(
	db: TenantDatabase,
	orgIdOrLocationId: string,
	locationIdOrDate: string,
	businessDateOrOpts?: string | DayFeedOptions,
	maybeOpts?: DayFeedOptions,
) {
	const hasExplicitOrgId = typeof businessDateOrOpts === 'string'
	const orgId = hasExplicitOrgId ? orgIdOrLocationId : ''
	const locationId = hasExplicitOrgId ? locationIdOrDate : orgIdOrLocationId
	const businessDate = hasExplicitOrgId ? businessDateOrOpts : locationIdOrDate
	const opts = hasExplicitOrgId ? maybeOpts : businessDateOrOpts

	const canReadGuestSensitive = opts?.canReadGuestSensitive === true
	const settings = await getLocationSettingsWithContext(db, orgId, locationId)
	const dayVersion = await getCurrentDayVersion(db, locationId, businessDate)
	const settingsVersion = settings.version ?? 1
	const floorPlanVersion = settings.floorPlanVersion ?? 1

	// The location hours live in the control plane, so a closure does not bump
	// the day version: fold the effective state into the ETag.
	const staffDay = await loadStaffDayState(db, locationId, businessDate)
	const staffDayView = publicStaffDayState(staffDay)
	const filters = normalizeDayFeedFilters(opts?.filters)
	const stateSuffix =
		staffDayView.state === 'open'
			? ''
			: `.${staffDayView.state === 'closed' ? 'c' : 'o'}${staffDayView.closedSource === 'location_hours' ? 'l' : 'r'}`
	const etagSuffix = `${filtersEtagSuffix(filters)}${stateSuffix}`
	const etag = `"${locationId}:${businessDate}:${dayVersion}:${settingsVersion}:${floorPlanVersion}${etagSuffix}"`
	const shortEtag = `"${dayVersion}.${settingsVersion}.${floorPlanVersion}${etagSuffix}"`

	const [
		areas,
		tables,
		combos,
		elements,
		services,
		specialDays,
		sectionLayouts,
		resRows,
		blockRows,
		holdRows,
		waitlistRows,
		sectionAssignRows,
		serviceNoteRows,
		allTags,
	] = await Promise.all([
		listAreasForLocation(db, locationId),
		listTablesForLocation(db, locationId),
		listCombosForLocation(db, locationId),
		listFloorElementsForLocation(db, locationId),
		listServicesForLocation(db, locationId),
		listSpecialDaysForLocation(db, locationId),
		listSectionLayoutsForLocation(db, locationId),
		db
			.select()
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, locationId),
					eq(rsvReservations.businessDate, businessDate),
				),
			)
			.orderBy(
				asc(rsvReservations.localStartMin),
				asc(rsvReservations.createdAt),
			)
			.all(),
		db
			.select()
			.from(rsvBlocks)
			.where(
				and(
					eq(rsvBlocks.locationId, locationId),
					eq(rsvBlocks.businessDate, businessDate),
				),
			)
			.orderBy(asc(rsvBlocks.startAt))
			.all(),
		db
			.select()
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.locationId, locationId),
					eq(rsvHolds.businessDate, businessDate),
					eq(rsvHolds.status, 'active'),
				),
			)
			.all(),
		db
			.select()
			.from(rsvWaitlistEntries)
			.where(
				and(
					eq(rsvWaitlistEntries.locationId, locationId),
					eq(rsvWaitlistEntries.businessDate, businessDate),
				),
			)
			.orderBy(
				asc(rsvWaitlistEntries.sortKey),
				asc(rsvWaitlistEntries.createdAt),
			)
			.all(),
		db
			.select()
			.from(rsvSectionAssignments)
			.where(
				and(
					eq(rsvSectionAssignments.locationId, locationId),
					eq(rsvSectionAssignments.businessDate, businessDate),
				),
			)
			.all(),
		db
			.select()
			.from(rsvServiceNotes)
			.where(
				and(
					eq(rsvServiceNotes.locationId, locationId),
					eq(rsvServiceNotes.businessDate, businessDate),
				),
			)
			.all(),
		db.select().from(rsvTags).orderBy(asc(rsvTags.name)).all(),
	])

	const allReservations = await serializeReservationsForBook(db, resRows, {
		canReadGuestSensitive,
	})
	const reservations = await applyDayFeedFilters(db, allReservations, {
		filters,
		tables,
		services,
	})
	const counterReservations = reservations.filter(
		(r) => r.status !== 'cancelled' && r.status !== 'no_show',
	)
	const counters = {
		parties: counterReservations.length,
		covers: counterReservations.reduce((sum, r) => sum + r.partySize, 0),
	}

	const moveNotices = await loadMoveNotices(db, allReservations, tables)
	const dayConflicts = detectDayFeedConflicts(
		allReservations,
		blockRows,
		tables,
	)

	// Pacing buckets (15-min intervals across active services)
	const svcIds = services.map((s) => s.id)
	const pacingRules = await queryInChunks(svcIds, (chunk) =>
		db
			.select()
			.from(rsvPacingRules)
			.where(inArray(rsvPacingRules.serviceId, chunk))
			.all(),
	)

	const defaultMaxCoversPerBucket = Math.max(
		tables.reduce((sum, t) => sum + (t.maxCovers ?? 0), 0),
		10,
	)

	const activeReservations = reservations.filter(
		(r) => r.status !== 'cancelled' && r.status !== 'no_show',
	)

	const pacingBuckets: Array<{
		localMin: number
		time: string
		serviceId: string | null
		bookedCovers: number
		seatedCovers: number
		arrivedCovers: number
		partyCount: number
		maxCovers: number
		utilizationPct: number
	}> = []

	const minStart =
		services.length > 0
			? Math.min(...services.map((s) => s.firstSeatingMin))
			: 11 * 60
	const maxEnd =
		services.length > 0 ? Math.max(...services.map((s) => s.endMin)) : 23 * 60

	for (let m = minStart; m < maxEnd; m += 15) {
		const svc =
			services.find((s) => m >= s.firstSeatingMin && m < s.endMin) ?? null
		const rule = svc
			? pacingRules.find(
					(pr) =>
						pr.serviceId === svc.id &&
						(pr.fromMin === null || m >= pr.fromMin) &&
						(pr.toMin === null || m < pr.toMin),
				)
			: undefined
		const maxCovers = rule?.maxCovers ?? defaultMaxCoversPerBucket

		const inBucket = activeReservations.filter(
			(r) => r.localStartMin >= m && r.localStartMin < m + 15,
		)
		const bookedCovers = inBucket.reduce((sum, r) => sum + r.partySize, 0)
		const seatedCovers = inBucket
			.filter((r) => r.status === 'seated' || r.status === 'finished')
			.reduce((sum, r) => sum + (r.seatedCovers ?? r.partySize), 0)
		const arrivedCovers = inBucket
			.filter((r) => r.status === 'arrived')
			.reduce((sum, r) => sum + (r.arrivedCovers ?? r.partySize), 0)

		pacingBuckets.push({
			localMin: m,
			time: formatMinutesToHHMM(m),
			serviceId: svc?.id ?? null,
			bookedCovers,
			seatedCovers,
			arrivedCovers,
			partyCount: inBucket.length,
			maxCovers,
			utilizationPct:
				maxCovers > 0
					? Math.min(100, Math.round((bookedCovers / maxCovers) * 100))
					: 0,
		})
	}

	const stats = {
		totalReservations: activeReservations.length,
		totalCovers: activeReservations.reduce((s, r) => s + r.partySize, 0),
		bookedCovers: activeReservations
			.filter((r) => r.status === 'booked' || r.status === 'confirmed')
			.reduce((s, r) => s + r.partySize, 0),
		arrivedCovers: activeReservations
			.filter((r) => r.status === 'arrived')
			.reduce((s, r) => s + (r.arrivedCovers ?? r.partySize), 0),
		seatedCovers: activeReservations
			.filter((r) => r.status === 'seated')
			.reduce((s, r) => s + (r.seatedCovers ?? r.partySize), 0),
		finishedCovers: activeReservations
			.filter((r) => r.status === 'finished')
			.reduce((s, r) => s + (r.seatedCovers ?? r.partySize), 0),
		noShowCount: reservations.filter((r) => r.status === 'no_show').length,
		cancelledCount: reservations.filter((r) => r.status === 'cancelled').length,
		unassignedCount: activeReservations.filter(
			(r) => r.assignment === 'unassigned' || r.tableIds.length === 0,
		).length,
		waitlistWaitingCount: waitlistRows.filter(
			(w) =>
				w.status === 'waiting' ||
				w.status === 'notified' ||
				w.status === 'on_the_way',
		).length,
	}

	return {
		locationId,
		businessDate,
		date: businessDate,
		dayVersion,
		settingsVersion,
		floorPlanVersion,
		etag,
		shortEtag,
		/** Effective day: `open` | `closed` | `online_closed`, with who closed it (`closedSource`) and a ready label. */
		dayState: staffDayView.state,
		closedSource:
			'closedSource' in staffDayView ? staffDayView.closedSource : null,
		closedReason:
			'closedReason' in staffDayView ? staffDayView.closedReason : null,
		closedLabel:
			'closedLabel' in staffDayView ? staffDayView.closedLabel : null,
		settings,
		areas,
		tables,
		combos,
		elements,
		services,
		specialDays,
		sectionLayouts,
		sectionAssignments: sectionAssignRows.map((a) => ({
			id: a.id,
			locationId: a.locationId,
			businessDate: a.businessDate,
			serviceId: a.serviceId,
			sectionId: a.sectionId,
			staffId: a.staffId,
			staff_id: a.staffId,
			serverLabel: a.serverLabel,
			server_label: a.serverLabel,
			version: a.version,
		})),
		serviceNotes: serviceNoteRows.map((n) => ({
			id: n.id,
			locationId: n.locationId,
			businessDate: n.businessDate,
			serviceId: n.serviceId,
			note: n.body,
			body: n.body,
			updatedBy: n.updatedBy,
			updatedAt: n.updatedAt,
			version: n.version,
		})),
		reservations,
		counters,
		filters,
		moveNotices,
		conflicts: dayConflicts,
		blocks: blockRows.map((b) => ({
			id: b.id,
			locationId: b.locationId,
			areaId: b.areaId,
			tableId: b.tableId,
			businessDate: b.businessDate,
			startAt: b.startAt,
			endAt: b.endAt,
			reason: b.reason,
			note: b.note,
			createdBy: b.createdBy,
			createdAt: b.createdAt,
		})),
		holds: holdRows.map((h) => ({
			id: h.id,
			locationId: h.locationId,
			businessDate: h.businessDate,
			localStartMin: h.localStartMin,
			partySize: h.partySize,
			startAt: h.startAt,
			endAt: h.endAt,
			expiresAt: h.expiresAt,
			status: h.status,
		})),
		waitlist: waitlistRows.map((w, idx) => ({
			id: w.id,
			locationId: w.locationId,
			businessDate: w.businessDate,
			serviceId: null,
			guestId: w.guestId,
			displayName: w.displayName,
			firstName: w.displayName.split(' ')[0] ?? w.displayName,
			lastName: w.displayName.split(' ').slice(1).join(' '),
			phoneE164: w.phoneE164,
			email: w.emailNorm,
			emailNorm: w.emailNorm,
			partySize: w.partySize,
			quotedWaitMin: w.quotedMin,
			quotedMin: w.quotedMin,
			position: idx + 1,
			sortKey: w.sortKey,
			status: w.status,
			notes: canReadGuestSensitive ? w.notes : null,
			createdAt: w.createdAt,
		})),
		tags: allTags.filter((t) => canReadGuestSensitive || !t.sensitive),
		pacing: pacingBuckets,
		stats,
	}
}

export async function getDayChanges(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
	sinceVersion?: number | null,
) {
	const dayVersion = await getCurrentDayVersion(db, locationId, businessDate)
	const changed =
		sinceVersion === undefined || sinceVersion === null
			? true
			: dayVersion !== sinceVersion
	return {
		locationId,
		businessDate,
		date: businessDate,
		dayVersion,
		changed,
	}
}

export async function getMonthCalendarSummary(
	db: TenantDatabase,
	orgOrLocationId: string,
	locationIdOrMonth: string,
	maybeMonth?: string,
) {
	const locationId =
		maybeMonth !== undefined ? locationIdOrMonth : orgOrLocationId
	const month = maybeMonth !== undefined ? maybeMonth : locationIdOrMonth
	const match = /^(\d{4})-(\d{2})$/.exec(month.trim())
	if (!match) {
		throw badRequest('invalid_month', 'month must be YYYY-MM')
	}
	const year = Number.parseInt(match[1]!, 10)
	const monthNum = Number.parseInt(match[2]!, 10)
	if (monthNum < 1 || monthNum > 12) {
		throw badRequest('invalid_month', 'month must be between 01 and 12')
	}

	const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate()
	const fromDate = `${month}-01`
	const toDate = `${month}-${String(daysInMonth).padStart(2, '0')}`

	const [locationHours, locationSettings] = await Promise.all([
		loadLocationHours(db, locationId),
		db
			.select({ dayStartMin: rsvLocationSettings.dayStartMin })
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, locationId))
			.get(),
	])
	const [services, tables, specialDays, monthReservations] = await Promise.all([
		listServicesForLocation(db, locationId),
		listTablesForLocation(db, locationId),
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
					gte(rsvReservations.businessDate, fromDate),
					lte(rsvReservations.businessDate, toDate),
				),
			)
			.all(),
	])

	const totalTableSeats = Math.max(
		tables.reduce((sum, t) => sum + (t.maxCovers ?? 0), 0),
		10,
	)

	const resByDate = new Map<
		string,
		Array<typeof rsvReservations.$inferSelect>
	>()
	for (const r of monthReservations) {
		const list = resByDate.get(r.businessDate) ?? []
		list.push(r)
		resByDate.set(r.businessDate, list)
	}

	const daysByDate: Record<
		string,
		{
			date: string
			partyCount: number
			reservationCount: number
			bookedCovers: number
			seatedCovers: number
			capacityCovers: number
			pacingPct: number
			closed: boolean
			/** Who closed the day; absent when open. */
			closedSource?: 'location_hours' | 'reservation_special_day'
			closedReason?: string
			specialDay: {
				id: string
				kind: string
				name: string | null
			} | null
		}
	> = {}
	const daysList: Array<(typeof daysByDate)[string]> = []

	for (let d = 1; d <= daysInMonth; d++) {
		const dateStr = `${month}-${String(d).padStart(2, '0')}`
		const dow = dayOfWeek(dateStr)
		const dowBit = 1 << dow

		const sp =
			specialDays.find((s) => s.fromDate <= dateStr && s.toDate >= dateStr) ??
			null
		const effective = buildEffectiveDay({
			businessDate: dateStr,
			hours: locationHours,
			dayStartMin: locationSettings?.dayStartMin ?? 240,
			reservation: {
				closed: sp?.kind === 'closed',
				onlineClosed: sp?.kind === 'online_closed',
				specialDay: sp ? { type: sp.kind, name: sp.name } : null,
			},
		})
		const closed = !effective.open
		const closedSource =
			closed && effective.source === 'location_closed'
				? ('location_hours' as const)
				: closed
					? ('reservation_special_day' as const)
					: undefined

		const dayServices = services.filter((s) => (s.daysMask & dowBit) !== 0)
		const turnsEstimate = Math.max(dayServices.length * 2, 1)
		const capacityCovers = closed ? 0 : totalTableSeats * turnsEstimate

		const dayRes = (resByDate.get(dateStr) ?? []).filter(
			(r) => r.status !== 'cancelled' && r.status !== 'no_show',
		)
		const bookedCovers = dayRes.reduce((sum, r) => sum + r.partySize, 0)
		const seatedCovers = dayRes
			.filter((r) => r.status === 'seated' || r.status === 'finished')
			.reduce((sum, r) => sum + (r.seatedCovers ?? r.partySize), 0)

		const pacingPct =
			capacityCovers > 0
				? Math.min(100, Math.round((bookedCovers / capacityCovers) * 100))
				: 0

		const summary = {
			date: dateStr,
			partyCount: dayRes.length,
			reservationCount: dayRes.length,
			totalBookings: dayRes.length,
			bookedCovers,
			totalCovers: bookedCovers,
			seatedCovers,
			capacityCovers,
			pacingPct,
			closed,
			...(closedSource
				? {
						closedSource,
						closedReason:
							closedSource === 'location_hours'
								? describeLocationClosedReason(
										effective.closedReason,
										effective.note,
									)
								: (effective.name ?? 'Reservations closed'),
					}
				: {}),
			specialDay: sp
				? {
						id: sp.id,
						kind: sp.kind,
						name: sp.name,
					}
				: null,
		}
		daysByDate[dateStr] = summary
		daysList.push(summary)
	}

	return {
		locationId,
		month,
		days: daysList,
		daysList,
		daysByDate,
	}
}

export async function getMonthCalendar(
	db: TenantDatabase,
	locationId: string,
	month: string,
) {
	return getMonthCalendarSummary(db, '', locationId, month)
}

export async function getOperatorAvailability(
	db: TenantDatabase,
	locationIdOrInput:
		| string
		| {
				locationId: string
				date: string
				partySize: number
				serviceId?: string | null
				areaId?: string | null
				durationMin?: number | null
		  },
	maybeInput?: {
		date: string
		partySize: number
		serviceId?: string | null
		areaId?: string | null
		durationMin?: number | null
	},
) {
	const locationId =
		typeof locationIdOrInput === 'string'
			? locationIdOrInput
			: locationIdOrInput.locationId
	const input =
		typeof locationIdOrInput === 'string' ? maybeInput! : locationIdOrInput

	const [dayState, services, tables, serviceAvail, pacingRules, dayResRows] =
		await Promise.all([
			loadStaffDayState(db, locationId, input.date),
			listServicesForLocation(db, locationId),
			listTablesForLocation(db, locationId),
			db.select().from(rsvServiceAvailability).all(),
			db.select().from(rsvPacingRules).all(),
			db
				.select()
				.from(rsvReservations)
				.where(
					and(
						eq(rsvReservations.locationId, locationId),
						eq(rsvReservations.businessDate, input.date),
					),
				)
				.all(),
		])

	const activeRes = dayResRows.filter(
		(r) => r.status !== 'cancelled' && r.status !== 'no_show',
	)

	const resIds = activeRes.map((r) => r.id)
	const occRows = await queryInChunks(resIds, (chunk) =>
		db
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					inArray(rsvTableOccupancies.reservationId, chunk),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all(),
	)

	const liveHolds = await db
		.select()
		.from(rsvHolds)
		.where(
			and(
				eq(rsvHolds.locationId, locationId),
				eq(rsvHolds.businessDate, input.date),
				eq(rsvHolds.status, 'active'),
				gt(rsvHolds.expiresAt, Date.now()),
			),
		)
		.all()
	const holdOccRows = await queryInChunks(
		liveHolds.map((h) => h.id),
		(chunk) =>
			db
				.select()
				.from(rsvTableOccupancies)
				.where(
					and(
						inArray(rsvTableOccupancies.holdId, chunk),
						eq(rsvTableOccupancies.active, true),
					),
				)
				.all(),
	)

	// A reservations closure offers no services; a location closure still lists
	// them so the host can overbook, with `outside_location_hours` flagged.
	const targetServices =
		dayState.state === 'closed' && dayState.reservationClosed
			? []
			: input.serviceId
				? services.filter((s) => s.id === input.serviceId)
				: services

	const walkInOnlyTableIds = new Set(
		serviceAvail
			.filter((sa) => sa.mode === 'walk_in_only' && sa.tableId)
			.map((sa) => sa.tableId!),
	)
	const unavailableTableIds = new Set(
		serviceAvail
			.filter((sa) => sa.mode === 'unavailable' && sa.tableId)
			.map((sa) => sa.tableId!),
	)

	const eligibleTables = tables.filter(
		(t) =>
			t.archivedAt === null &&
			!walkInOnlyTableIds.has(t.id) &&
			!unavailableTableIds.has(t.id) &&
			(!input.areaId || t.areaId === input.areaId) &&
			t.minCovers <= input.partySize &&
			t.maxCovers >= input.partySize,
	)

	const slots: Array<{
		localStartMin: number
		slotLocal: string
		time: string
		serviceId: string
		available: boolean
		pacingWarning: boolean
		overbookAvailable: boolean
		held: boolean
		heldTableIds: string[]
		suggestedTableIds: string[]
		/** `outside_location_hours`: staff may still book (explicit override). */
		warnings?: string[]
	}> = []

	const pacedRes = dayResRows.filter((r) =>
		ACTIVE_OCCUPANCY_STATUSES.has(r.status),
	)
	const pacingExisting = pacedRes.map((r) => ({
		id: r.id,
		serviceId: r.serviceId,
		channel: r.channel,
		partySize: r.partySize,
		localStartMin: r.localStartMin,
		startAt: r.startAt,
		endAt: r.endAt,
		status: r.status,
	}))

	const engineSlots = new Map<string, AvailableSlot>()
	const engineState =
		targetServices.length > 0
			? await loadPublicEngineState(db, {
					locationId,
					fromDate: input.date,
					toDate: input.date,
					now: Date.now(),
				})
			: null
	if (engineState) {
		const found = searchPublicDay(engineState, {
			businessDate: input.date,
			partySize: input.partySize,
			now: Date.now(),
			channel: 'host',
			areaId: input.areaId ?? null,
		})
		for (const slot of found.slots) {
			if (slot.tableIds.length === 0) continue
			const key = `${slot.serviceId}:${slot.slotMin}`
			if (!engineSlots.has(key)) engineSlots.set(key, slot)
		}
	}

	for (const svc of targetServices) {
		const interval = svc.intervalMin ?? 15
		const svcPacingRules = pacingRules.filter((pr) => pr.serviceId === svc.id)
		const engineSvcPacingRules: EnginePacingRuleInput[] = svcPacingRules.map(
			(p) => ({
				id: p.id,
				serviceId: p.serviceId,
				windowMinutes: p.bucketMin,
				fromMin: p.fromMin,
				toMin: p.toMin,
				maxCoversPerSlot: p.maxCovers,
				maxPartiesPerSlot: p.maxParties,
				rollingMin: p.rollingMin,
				rollingMaxCovers: p.rollingMaxCovers,
				channelScope: p.channel as 'all' | 'online',
			}),
		)
		for (let m = svc.firstSeatingMin; m <= svc.lastSeatingMin; m += interval) {
			const durationMin = input.durationMin ?? 90
			const overlappingRes = activeRes.filter(
				(r) =>
					r.localStartMin < m + durationMin &&
					r.localStartMin + r.durationMin > m,
			)
			const occupiedTids = new Set(
				occRows
					.filter((o) => overlappingRes.some((r) => r.id === o.reservationId))
					.map((o) => o.tableId),
			)
			const heldTids = new Set<string>()
			for (const hold of liveHolds) {
				const holdDurMin = Math.max(
					1,
					Math.round((hold.endAt - hold.startAt) / 60_000),
				)
				if (
					hold.localStartMin < m + durationMin &&
					hold.localStartMin + holdDurMin > m
				) {
					for (const o of holdOccRows) {
						if (o.holdId === hold.id) heldTids.add(o.tableId)
					}
				}
			}
			const heldEligibleIds = eligibleTables
				.filter((t) => heldTids.has(t.id) && !occupiedTids.has(t.id))
				.map((t) => t.id)
			// The public engine decides which tables are free: it sees blocks,
			// area-wide blocks, service table modes and pacing the same way for
			// every channel. Only the host channel's looser notice rules differ.
			const engineSlot = engineSlots.get(`${svc.id}:${m}`)
			const outsideLocationHours =
				(engineSlot?.warnings ?? []).includes('outside_location_hours') ||
				(engineState !== null &&
					!instantInIntervals(
						dayState.effectiveDay.intervals,
						localToInstant(input.date, m, engineState.timeZone).instantMs,
					))
			const pacingWarning =
				(engineSlot?.warnings ?? []).some(
					(w) => w !== 'outside_location_hours',
				) ||
				findOperatorPacingBreaches({
					rules: svcPacingRules,
					serviceId: svc.id,
					localStartMin: m,
					partySize: input.partySize,
					activeReservations: pacedRes,
				}).length > 0 ||
				!evaluatePacing({
					serviceId: svc.id,
					slotMin: m,
					startAt: m * 60_000,
					durationMin,
					intervalMin: interval,
					partySize: input.partySize,
					channel: 'host',
					rules: engineSvcPacingRules,
					existing: pacingExisting,
				}).allowed
			const hhmm = formatMinutesToHHMM(m)

			slots.push({
				localStartMin: m,
				slotLocal: hhmm,
				time: hhmm,
				serviceId: svc.id,
				available: Boolean(engineSlot) && !pacingWarning,
				pacingWarning,
				overbookAvailable: true,
				held: heldEligibleIds.length > 0,
				heldTableIds: heldEligibleIds,
				suggestedTableIds: engineSlot ? [engineSlot.tableIds[0]!] : [],
				...(outsideLocationHours
					? { warnings: ['outside_location_hours'] }
					: {}),
			})
		}
	}

	return {
		locationId,
		businessDate: input.date,
		date: input.date,
		partySize: input.partySize,
		closed: dayState.state === 'closed',
		onlineClosed: dayState.state === 'online_closed',
		dayState: publicStaffDayState(dayState),
		slots,
	}
}

export async function getPreServiceOverview(
	db: TenantDatabase,
	orgIdOrLocationId: string,
	locationIdOrDate: string,
	businessDateOrOpts?:
		string | { serviceId?: string | null; canReadGuestSensitive?: boolean },
	serviceIdOrOpts?: string | null | { canReadGuestSensitive?: boolean },
	maybeOpts?: { canReadGuestSensitive?: boolean },
) {
	const hasExplicitOrgId = typeof businessDateOrOpts === 'string'
	const orgId = hasExplicitOrgId ? orgIdOrLocationId : ''
	const locationId = hasExplicitOrgId ? locationIdOrDate : orgIdOrLocationId
	const businessDate = hasExplicitOrgId ? businessDateOrOpts : locationIdOrDate
	const serviceId = hasExplicitOrgId
		? typeof serviceIdOrOpts === 'string'
			? serviceIdOrOpts
			: null
		: typeof businessDateOrOpts === 'object' && businessDateOrOpts !== null
			? (businessDateOrOpts.serviceId ?? null)
			: null
	const opts = hasExplicitOrgId
		? typeof serviceIdOrOpts === 'object' && serviceIdOrOpts !== null
			? serviceIdOrOpts
			: maybeOpts
		: typeof businessDateOrOpts === 'object' && businessDateOrOpts !== null
			? businessDateOrOpts
			: undefined

	const canReadGuestSensitive = opts?.canReadGuestSensitive === true
	const feed = await getDayFeed(db, orgId, locationId, businessDate, {
		canReadGuestSensitive,
	})

	const activeParties = feed.reservations.filter(
		(r) =>
			r.status !== 'cancelled' &&
			r.status !== 'no_show' &&
			(!serviceId || r.serviceId === serviceId),
	)

	const vips = activeParties.filter((r) =>
		r.guest?.tags.some(
			(t) => t.category === 'vip' || t.name.toLowerCase().includes('vip'),
		),
	)
	const allergies = activeParties
		.filter((r) => r.hasAllergy)
		.map((r) => ({
			...r,
			dietaryNotes: canReadGuestSensitive ? r.dietaryNotes : null,
			allergyNotes: canReadGuestSensitive
				? (r.guest?.allergyNotes ?? null)
				: null,
		}))
	const occasions = activeParties.filter(
		(r) =>
			Boolean(r.occasionTagId) ||
			r.guest?.tags.some((t) => t.category === 'occasion'),
	)
	const largeParties = activeParties.filter((r) => r.partySize >= 6)
	const firstTimers = activeParties.filter((r) => (r.guest?.visits ?? 0) === 0)

	const notesForService = serviceId
		? feed.serviceNotes.filter(
				(n) => n.serviceId === serviceId || n.serviceId === null,
			)
		: feed.serviceNotes

	return {
		locationId,
		businessDate,
		date: businessDate,
		serviceId: serviceId ?? null,
		stats: {
			partyCount: activeParties.length,
			expectedCovers: activeParties.reduce((s, r) => s + r.partySize, 0),
			vipsCount: vips.length,
			allergiesCount: allergies.length,
			occasionsCount: occasions.length,
			largePartiesCount: largeParties.length,
			firstTimersCount: firstTimers.length,
		},
		vips,
		vipList: vips,
		allergies,
		allergyList: allergies,
		occasions,
		occasionsList: occasions,
		largeParties,
		firstTimers,
		parties: activeParties,
		serviceNotes: notesForService,
		sectionAssignments: serviceId
			? feed.sectionAssignments.filter((a) => a.serviceId === serviceId)
			: feed.sectionAssignments,
	}
}

export async function getServiceNotes(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
	serviceId?: string | null,
) {
	const rows = await db
		.select()
		.from(rsvServiceNotes)
		.where(
			and(
				eq(rsvServiceNotes.locationId, locationId),
				eq(rsvServiceNotes.businessDate, businessDate),
			),
		)
		.all()

	const matched = serviceId
		? (rows.find((r) => r.serviceId === serviceId) ?? rows[0] ?? null)
		: (rows[0] ?? null)

	const mappedNotes = rows.map((r) => ({
		id: r.id,
		locationId: r.locationId,
		businessDate: r.businessDate,
		date: r.businessDate,
		serviceId: r.serviceId,
		notes: r.body,
		note: r.body,
		body: r.body,
		version: r.version,
		updatedAt: r.updatedAt,
		updatedBy: r.updatedBy,
	}))

	return {
		locationId,
		businessDate,
		date: businessDate,
		serviceId: serviceId ?? matched?.serviceId ?? null,
		notes: matched?.body ?? '',
		note: matched?.body ?? '',
		body: matched?.body ?? '',
		version: matched?.version ?? 0,
		updatedAt: matched?.updatedAt ?? null,
		updatedBy: matched?.updatedBy ?? null,
		serviceNotes: mappedNotes,
	}
}

export async function upsertServiceNotes(
	db: DbOrTx,
	input: {
		locationId: string
		businessDate?: string
		date?: string
		serviceId?: string | null
		notes?: string
		note?: string
		body?: string
		actorId?: string | null
		expectedVersion?: number
	},
) {
	return withSetupWrite(db, async (tx) => {
		const businessDate = input.businessDate ?? input.date ?? ''
		const bodyText = (input.notes ?? input.note ?? input.body ?? '').trim()
		const serviceId = input.serviceId ?? null
		const actorId = input.actorId ?? null
		const now = Date.now()

		const existingRows = await tx
			.select()
			.from(rsvServiceNotes)
			.where(
				and(
					eq(rsvServiceNotes.locationId, input.locationId),
					eq(rsvServiceNotes.businessDate, businessDate),
				),
			)
			.all()
		const existing = existingRows.find((r) => r.serviceId === serviceId)

		if (input.expectedVersion !== undefined) {
			const currentVersion = existing?.version ?? 0
			if (currentVersion !== input.expectedVersion) {
				throw conflict(
					'stale_version',
					'Service notes were modified by another user',
				)
			}
		}

		let noteId: string
		let nextVersion = 1
		if (existing) {
			noteId = existing.id
			nextVersion = existing.version + 1
			await tx
				.update(rsvServiceNotes)
				.set({
					body: bodyText,
					updatedBy: actorId,
					updatedAt: now,
					version: nextVersion,
				})
				.where(eq(rsvServiceNotes.id, existing.id))
		} else {
			noteId = createId('snote')
			await tx.insert(rsvServiceNotes).values({
				id: noteId,
				locationId: input.locationId,
				businessDate,
				serviceId,
				body: bodyText,
				updatedBy: actorId,
				updatedAt: now,
				version: 1,
			})
		}

		await bumpDayVersionRow(tx, input.locationId, businessDate)

		const record = {
			id: noteId,
			locationId: input.locationId,
			businessDate,
			date: businessDate,
			serviceId,
			notes: bodyText,
			note: bodyText,
			body: bodyText,
			version: nextVersion,
			updatedAt: now,
			updatedBy: actorId,
		}
		return {
			...record,
			serviceNote: record,
		}
	})
}

export async function getSectionAssignments(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
	serviceId?: string | null,
) {
	const rows = await db
		.select()
		.from(rsvSectionAssignments)
		.where(
			and(
				eq(rsvSectionAssignments.locationId, locationId),
				eq(rsvSectionAssignments.businessDate, businessDate),
				...(serviceId ? [eq(rsvSectionAssignments.serviceId, serviceId)] : []),
			),
		)
		.all()

	return {
		locationId,
		businessDate,
		date: businessDate,
		serviceId: serviceId ?? null,
		assignments: rows.map((a) => ({
			id: a.id,
			locationId: a.locationId,
			businessDate: a.businessDate,
			serviceId: a.serviceId,
			sectionId: a.sectionId,
			staffId: a.staffId,
			staff_id: a.staffId,
			serverLabel: a.serverLabel,
			server_label: a.serverLabel,
			version: a.version,
		})),
	}
}

export async function putSectionAssignments(
	db: DbOrTx,
	input: {
		locationId: string
		businessDate: string
		serviceId: string
		actorId?: string | null
		assignments: Array<{
			sectionId: string
			staffId?: string | null
			serverLabel?: string | null
		}>
	},
) {
	if (!input.serviceId) {
		throw badRequest('invalid_service', 'serviceId is required')
	}

	return withSetupWrite(db, async (tx) => {
		await tx
			.delete(rsvSectionAssignments)
			.where(
				and(
					eq(rsvSectionAssignments.locationId, input.locationId),
					eq(rsvSectionAssignments.businessDate, input.businessDate),
					eq(rsvSectionAssignments.serviceId, input.serviceId),
				),
			)

		for (const item of input.assignments ?? []) {
			if (!item.sectionId) continue
			await tx.insert(rsvSectionAssignments).values({
				id: createId('sassign'),
				locationId: input.locationId,
				businessDate: input.businessDate,
				serviceId: input.serviceId,
				sectionId: item.sectionId,
				staffId: item.staffId ?? null,
				serverLabel: item.serverLabel?.trim() || null,
				version: 1,
			})
		}

		await bumpDayVersionRow(tx, input.locationId, input.businessDate)

		const now = Date.now()
		await tx.insert(rsvAuditLog).values({
			id: createId('aud'),
			at: now,
			actorKind: 'operator',
			actorId: input.actorId ?? null,
			locationId: input.locationId,
			action: 'section_assignment.put',
			entityType: 'section_assignment',
			entityId: `${input.businessDate}:${input.serviceId}`,
			changes: {
				businessDate: input.businessDate,
				serviceId: input.serviceId,
				count: (input.assignments ?? []).length,
			},
		})

		return getSectionAssignments(
			tx,
			input.locationId,
			input.businessDate,
			input.serviceId,
		)
	})
}

export async function getBookConflicts(
	db: TenantDatabase,
	orgIdOrLocationId: string,
	locationIdOrDate: string,
	businessDateOrOpts?: string | { canReadGuestSensitive?: boolean },
	maybeOpts?: { canReadGuestSensitive?: boolean },
) {
	const hasExplicitOrgId = typeof businessDateOrOpts === 'string'
	const orgId = hasExplicitOrgId ? orgIdOrLocationId : ''
	const locationId = hasExplicitOrgId ? locationIdOrDate : orgIdOrLocationId
	const businessDate = hasExplicitOrgId ? businessDateOrOpts : locationIdOrDate
	const opts = hasExplicitOrgId ? maybeOpts : businessDateOrOpts
	const canReadGuestSensitive = opts?.canReadGuestSensitive === true

	const [feed, allAreas, allTables, allServices, allSpecialDays] =
		await Promise.all([
			getDayFeed(db, orgId, locationId, businessDate, {
				canReadGuestSensitive,
			}),
			db
				.select()
				.from(rsvAreas)
				.where(eq(rsvAreas.locationId, locationId))
				.all(),
			db
				.select()
				.from(rsvTables)
				.where(eq(rsvTables.locationId, locationId))
				.all(),
			db
				.select()
				.from(rsvServices)
				.where(eq(rsvServices.locationId, locationId))
				.all(),
			db
				.select()
				.from(rsvSpecialDays)
				.where(eq(rsvSpecialDays.locationId, locationId))
				.all(),
		])

	const areaById = new Map(allAreas.map((a) => [a.id, a]))
	const engineAreas: EngineAreaInput[] = allAreas.map((a) => ({
		id: a.id,
		name: a.name,
		sortOrder: a.sort,
		active: a.archivedAt === null,
	}))
	const engineTables: EngineTableInput[] = allTables.map((t) => {
		const area = areaById.get(t.areaId)
		const areaActive = area ? area.archivedAt === null : true
		const areaOnline = area ? area.onlineBookable : true
		return {
			id: t.id,
			areaId: t.areaId,
			label: t.label,
			minSeats: t.minCovers,
			maxSeats: t.maxCovers,
			minCovers: t.minCovers,
			maxCovers: t.maxCovers,
			onlineBookable: t.onlineBookable && areaOnline,
			combinable: t.combinable,
			priority: t.priority,
			resetBufferMin: t.resetBufferMin,
			active: t.archivedAt === null && areaActive,
		}
	})
	const engineCombos: EngineCombinationInput[] = feed.combos.map((c) => ({
		id: c.id,
		name: c.label,
		label: c.label,
		minSeats: c.minCovers,
		maxSeats: c.maxCovers,
		minCovers: c.minCovers,
		maxCovers: c.maxCovers,
		onlineBookable: c.onlineBookable,
		priority: c.priority,
		active: c.archivedAt === null,
		tableIds: c.tableIds,
	}))

	const svcIds = allServices
		.filter((s) => s.archivedAt === null)
		.map((s) => s.id)
	const allPacing = await queryInChunks(svcIds, (chunk) =>
		db
			.select()
			.from(rsvPacingRules)
			.where(inArray(rsvPacingRules.serviceId, chunk))
			.all(),
	)
	const enginePacingRules: EnginePacingRuleInput[] = allPacing.map((p) => ({
		id: p.id,
		serviceId: p.serviceId,
		windowMinutes: p.bucketMin,
		fromMin: p.fromMin,
		toMin: p.toMin,
		maxCoversPerSlot: p.maxCovers,
		maxPartiesPerSlot: p.maxParties,
		rollingMin: p.rollingMin,
		rollingMaxCovers: p.rollingMaxCovers,
		channelScope: p.channel as 'all' | 'online',
	}))

	const matchingSpecialDays = allSpecialDays
		.filter((sd) => sd.fromDate <= businessDate && businessDate <= sd.toDate)
		.map((sd) => ({
			id: sd.id,
			businessDate,
			type: sd.kind as 'closed' | 'online_closed' | 'modified' | 'replace',
			name: sd.name,
		}))

	const resolvedServices = resolveServices(
		businessDate,
		allServices.map((s) => ({
			id: s.id,
			name: s.name,
			slug: s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
			daysMask: s.daysMask,
			effectiveFrom: s.effectiveFrom,
			effectiveTo: s.effectiveTo,
			specialDayId: s.specialDayId,
			firstSeatingMin: s.firstSeatingMin,
			startMin: s.firstSeatingMin,
			lastSeatingMin: s.lastSeatingMin,
			endMin: s.endMin,
			intervalMin: s.intervalMin,
			onlineEnabled: s.onlineEnabled,
			active: s.archivedAt === null,
		})),
		matchingSpecialDays,
	)

	const bookings: ConflictBookingInput[] = feed.reservations.map((r) => ({
		id: r.id,
		status: r.status,
		channel: r.channel === 'online' ? 'online' : 'host',
		partySize: r.partySize,
		localStartMin: r.localStartMin,
		startAt: r.startAt,
		endAt: r.endAt,
		tableIds: r.tableIds,
		combinationId: r.comboId,
		serviceId: r.serviceId,
		areaId: r.areaPrefStrict ? r.areaPrefId : null,
		overbook: r.overbooked,
	}))

	const blocks: ConflictBlockInput[] = feed.blocks.map((b) => ({
		id: b.id,
		tableIds: b.tableId ? [b.tableId] : [],
		areaId: b.areaId,
		startAt: b.startAt,
		endAt: b.endAt,
	}))

	const rawConflicts = detectConflicts({
		tables: engineTables,
		areas: engineAreas,
		combinations: engineCombos,
		bookings,
		blocks,
		services: resolvedServices.services,
		pacingRules: enginePacingRules,
		// A day closed by a reservations special day or by the location hours
		// (special hours, inactive, closed weekday) makes every booking on it a conflict.
		dayClosed:
			resolvedServices.closed ||
			(await loadStaffDayState(db, locationId, businessDate)).state ===
				'closed',
	})

	const conflicts = rawConflicts.map((c) => ({
		...c,
		reservationId: c.bookingId ?? null,
		details: { ...c.details, businessDate },
	}))

	const unassigned = feed.reservations.filter(
		(r) =>
			r.status !== 'cancelled' &&
			r.status !== 'no_show' &&
			r.status !== 'finished' &&
			(r.assignment === 'unassigned' || r.tableIds.length === 0),
	)

	return {
		locationId,
		businessDate,
		date: businessDate,
		unassigned,
		unassignedReservations: unassigned,
		conflicts,
		items: conflicts,
	}
}

export async function getReservationEvents(db: DbOrTx, reservationId: string) {
	const res = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!res) {
		throw notFound('not_found', 'Reservation not found')
	}

	const rows = await db
		.select()
		.from(rsvReservationEvents)
		.where(eq(rsvReservationEvents.reservationId, reservationId))
		.orderBy(asc(rsvReservationEvents.at), asc(rsvReservationEvents.id))
		.all()

	return {
		reservationId: res.id,
		locationId: res.locationId,
		events: rows.map((e) => ({
			id: e.id,
			reservationId: e.reservationId,
			reservation_id: e.reservationId,
			at: e.at,
			createdAt: e.at,
			created_at: e.at,
			actorKind: e.actorKind,
			actor_kind: e.actorKind,
			actorId: e.actorId,
			actor_id: e.actorId,
			type: e.type,
			data: e.data ?? {},
		})),
	}
}

export async function getRegionalReservationSummary(
	db: DbOrTx,
	locationIdsOrOpts?:
		| string[]
		| {
				locationId?: string | null
				locationIds?: string[] | null
				date?: string | null
		  },
) {
	const now = Date.now()
	const locIds = Array.isArray(locationIdsOrOpts)
		? locationIdsOrOpts
		: locationIdsOrOpts?.locationIds
			? locationIdsOrOpts.locationIds
			: locationIdsOrOpts?.locationId
				? [locationIdsOrOpts.locationId]
				: undefined
	const locFilter = locIds && locIds.length > 0 ? locIds : undefined

	const settingsRows = await db
		.select()
		.from(rsvLocationSettings)
		.where(
			locFilter
				? inArray(rsvLocationSettings.locationId, locFilter)
				: undefined,
		)
		.all()

	const areaRows = await db
		.select()
		.from(rsvAreas)
		.where(
			and(
				isNull(rsvAreas.archivedAt),
				...(locFilter ? [inArray(rsvAreas.locationId, locFilter)] : []),
			),
		)
		.all()

	const tableRows = await db
		.select()
		.from(rsvTables)
		.where(
			and(
				isNull(rsvTables.archivedAt),
				...(locFilter ? [inArray(rsvTables.locationId, locFilter)] : []),
			),
		)
		.all()

	const upcomingResRows = await db
		.select()
		.from(rsvReservations)
		.where(
			and(
				inArray(rsvReservations.status, [
					'pending_payment',
					'pending_approval',
					'booked',
					'confirmed',
					'arrived',
					'seated',
				]),
				gte(rsvReservations.endAt, now - 12 * 3600_000),
				...(locFilter ? [inArray(rsvReservations.locationId, locFilter)] : []),
			),
		)
		.all()

	const [allResCountRow, guestsCountRow, auditCountRow] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)` })
			.from(rsvReservations)
			.where(
				locFilter ? inArray(rsvReservations.locationId, locFilter) : undefined,
			)
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(rsvGuests)
			.where(isNull(rsvGuests.erasedAt))
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(rsvAuditLog)
			.where(locFilter ? inArray(rsvAuditLog.locationId, locFilter) : undefined)
			.get(),
	])

	const activeWaitlistRows = await db
		.select()
		.from(rsvWaitlistEntries)
		.where(
			and(
				inArray(rsvWaitlistEntries.status, [
					'waiting',
					'notified',
					'on_the_way',
				]),
				...(locFilter
					? [inArray(rsvWaitlistEntries.locationId, locFilter)]
					: []),
			),
		)
		.all()

	const activeHoldRows = await db
		.select()
		.from(rsvHolds)
		.where(
			and(
				eq(rsvHolds.status, 'active'),
				gte(rsvHolds.expiresAt, now),
				...(locFilter ? [inArray(rsvHolds.locationId, locFilter)] : []),
			),
		)
		.all()

	const allKnownLocIds = new Set<string>([
		...(locFilter ?? []),
		...settingsRows.map((s) => s.locationId),
		...areaRows.map((a) => a.locationId),
		...tableRows.map((t) => t.locationId),
		...upcomingResRows.map((r) => r.locationId),
		...activeWaitlistRows.map((w) => w.locationId),
		...activeHoldRows.map((h) => h.locationId),
	])

	const byLocation: Record<
		string,
		{
			upcomingReservations: number
			activeWaitlist: number
			activeHolds: number
			tables: number
			hasSetup: boolean
		}
	> = {}

	for (const locId of allKnownLocIds) {
		const hasAreas = areaRows.some((a) => a.locationId === locId)
		const hasSettings = settingsRows.some((s) => s.locationId === locId)
		const locTables = tableRows.filter((t) => t.locationId === locId).length
		byLocation[locId] = {
			upcomingReservations: upcomingResRows.filter(
				(r) => r.locationId === locId,
			).length,
			activeWaitlist: activeWaitlistRows.filter((w) => w.locationId === locId)
				.length,
			activeHolds: activeHoldRows.filter((h) => h.locationId === locId).length,
			tables: locTables,
			hasSetup: hasAreas || hasSettings || locTables > 0,
		}
	}

	const paymentCounts = await getPaymentSummaryCounts(db, locFilter, now)
	const activeLocations = Object.values(byLocation).filter(
		(l) => l.hasSetup || l.upcomingReservations > 0 || l.activeWaitlist > 0,
	).length
	const totalReservations = Number(allResCountRow?.count ?? 0)
	const guests = Number(guestsCountRow?.count ?? 0)
	const auditEntries = Number(auditCountRow?.count ?? 0)

	const primaryLocationId =
		locFilter && locFilter.length === 1 ? locFilter[0]! : undefined
	const futureReservations = upcomingResRows.length
	const canDelete =
		futureReservations === 0 &&
		activeWaitlistRows.length === 0 &&
		activeHoldRows.length === 0

	return {
		...(primaryLocationId ? { locationId: primaryLocationId } : {}),
		activeLocations,
		reservations: totalReservations,
		totalReservations,
		upcomingReservations: futureReservations,
		futureReservations,
		activeFutureReservations: futureReservations,
		activeReservations: futureReservations,
		guests,
		tables: tableRows.length,
		auditEntries,
		activeWaitlist: activeWaitlistRows.length,
		waitlistEntries: activeWaitlistRows.length,
		activeHolds: activeHoldRows.length,
		holds: activeHoldRows.length,
		payments: paymentCounts.payments,
		unsettledPayments: paymentCounts.unsettledPayments,
		experiences: paymentCounts.experiences,
		canDelete,
		byLocation,
	}
}
