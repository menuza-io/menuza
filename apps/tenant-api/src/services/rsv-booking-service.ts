import { randomBytes, randomUUID } from 'node:crypto'
import {
	assignTables,
	currentBusinessDate,
	instantToLocal,
	localToInstant,
	type AssignBlockRecord,
	type AssignBookingRecord,
	type AssignHoldRecord,
	type EngineAreaInput,
	type EngineCombinationInput,
	type EnginePacingRuleInput,
	type EngineServiceAvailabilityInput,
	type EngineTableInput,
} from '@repo/reservations'
import {
	getTenantDb,
	rsvAreas,
	rsvAuditLog,
	rsvBlocks,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvMessages,
	rsvPacingRules,
	rsvPayments,
	rsvReservationEvents,
	rsvReservations,
	rsvServiceAvailability,
	rsvServices,
	rsvTableComboMembers,
	rsvTableCombos,
	rsvTableOccupancies,
	rsvTables,
	rsvTags,
	rsvTurnTimes,
	type RSV_COURSE_STATUS_VALUES,
	type RSV_CONTACT_STATUS_VALUES,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, isNull, lte, gte, sql } from 'drizzle-orm'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import { enqueueReservationMessage } from './rsv-message-queue.ts'
import {
	hashIdempotencyPayload,
	withReservationWrite,
	type ReservationWriteTx,
} from '../lib/reservations-write.ts'
import {
	getOperatorAvailability,
	parseTimeToMinutes,
	serializeReservationsForBook,
	type SerializedBookReservation,
} from './rsv-day-feed-service.ts'
import { loadStaffDayState } from './rsv-special-days.ts'
import {
	getGuestSummary,
	resolveOrCreateGuestForBooking,
	type DbOrTx,
} from './rsv-guest-service.ts'
import { isLateCancellation } from './rsv-late-cancel.ts'

function createId(prefix: string): string {
	return `${prefix}_${randomUUID()}`
}

const CONFIRMATION_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export function generateConfirmationCode(length = 6): string {
	const bytes = randomBytes(length)
	let out = ''
	for (let i = 0; i < length; i++) {
		out += CONFIRMATION_ALPHABET[bytes[i]! % CONFIRMATION_ALPHABET.length]
	}
	return out
}

const SOFT_REFLOWABLE_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
])

const ACTIVE_OCCUPANCY_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
	'arrived',
	'seated',
])

export interface ReservationMoveReport {
	reservationId: string
	bookingId: string
	fromTableIds: string[]
	toTableIds: string[]
	toCombinationId: string | null
}

export async function loadLocationSchedulingState(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
) {
	const [
		settingsRow,
		areas,
		tables,
		combos,
		services,
		turnTimes,
		dayResRows,
		dayBlocks,
		dayHolds,
		activeOccRows,
	] = await Promise.all([
		db
			.select()
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, locationId))
			.get(),
		db.select().from(rsvAreas).where(eq(rsvAreas.locationId, locationId)).all(),
		db
			.select()
			.from(rsvTables)
			.where(eq(rsvTables.locationId, locationId))
			.all(),
		db
			.select()
			.from(rsvTableCombos)
			.where(
				and(
					eq(rsvTableCombos.locationId, locationId),
					isNull(rsvTableCombos.archivedAt),
				),
			)
			.all(),
		db
			.select()
			.from(rsvServices)
			.where(
				and(
					eq(rsvServices.locationId, locationId),
					isNull(rsvServices.archivedAt),
				),
			)
			.orderBy(asc(rsvServices.sort))
			.all(),
		db
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.locationId, locationId))
			.all(),
		db
			.select()
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, locationId),
					eq(rsvReservations.businessDate, businessDate),
				),
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
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.locationId, locationId),
					eq(rsvTableOccupancies.active, true),
				),
			)
			.all(),
	])

	const comboIds = combos.map((c) => c.id)
	const comboMembers =
		comboIds.length > 0
			? await db
					.select()
					.from(rsvTableComboMembers)
					.where(inArray(rsvTableComboMembers.comboId, comboIds))
					.all()
			: []

	const svcIds = services.map((s) => s.id)
	const [pacingRules, serviceAvail] = await Promise.all([
		svcIds.length > 0
			? db
					.select()
					.from(rsvPacingRules)
					.where(inArray(rsvPacingRules.serviceId, svcIds))
					.all()
			: Promise.resolve([]),
		svcIds.length > 0
			? db
					.select()
					.from(rsvServiceAvailability)
					.where(inArray(rsvServiceAvailability.serviceId, svcIds))
					.all()
			: Promise.resolve([]),
	])

	const areaById = new Map(areas.map((a) => [a.id, a]))
	const tableById = new Map(tables.map((t) => [t.id, t]))

	const membersByCombo = new Map<string, string[]>()
	for (const m of comboMembers) {
		const list = membersByCombo.get(m.comboId) ?? []
		list.push(m.tableId)
		membersByCombo.set(m.comboId, list)
	}

	const engineAreas: EngineAreaInput[] = areas.map((a) => ({
		id: a.id,
		name: a.name,
		sortOrder: a.sort,
		active: a.archivedAt === null,
	}))

	const engineTables: EngineTableInput[] = tables.map((t) => {
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

	const engineCombos: EngineCombinationInput[] = combos.map((c) => ({
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
		tableIds: (membersByCombo.get(c.id) ?? []).slice().sort(),
	}))

	const engineServiceAvail: EngineServiceAvailabilityInput[] = serviceAvail.map(
		(sa) => ({
			id: sa.id,
			serviceId: sa.serviceId,
			areaId: sa.areaId,
			tableId: sa.tableId,
			combinationId: sa.comboId,
			fromMin: sa.fromMin,
			toMin: sa.toMin,
			mode: sa.mode as 'online' | 'staff_only' | 'walk_in_only' | 'unavailable',
		}),
	)

	const enginePacingRules: EnginePacingRuleInput[] = pacingRules.map((p) => ({
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

	const occsByResId = new Map<
		string,
		Array<typeof rsvTableOccupancies.$inferSelect>
	>()
	const occsByHoldId = new Map<
		string,
		Array<typeof rsvTableOccupancies.$inferSelect>
	>()
	for (const occ of activeOccRows) {
		if (occ.kind === 'reservation' && occ.reservationId) {
			const list = occsByResId.get(occ.reservationId) ?? []
			list.push(occ)
			occsByResId.set(occ.reservationId, list)
		} else if (occ.kind === 'hold' && occ.holdId) {
			const list = occsByHoldId.get(occ.holdId) ?? []
			list.push(occ)
			occsByHoldId.set(occ.holdId, list)
		}
	}

	const buildEngineBookings = (
		excludeReservationIds?: Set<string>,
	): AssignBookingRecord[] =>
		dayResRows
			.filter(
				(r) =>
					ACTIVE_OCCUPANCY_STATUSES.has(r.status) &&
					(!excludeReservationIds || !excludeReservationIds.has(r.id)),
			)
			.map((r) => ({
				id: r.id,
				partySize: r.partySize,
				localStartMin: r.localStartMin,
				startAt: r.startAt,
				endAt: r.endAt,
				tableIds: (occsByResId.get(r.id) ?? []).map((o) => o.tableId),
				combinationId: r.comboId,
				status: r.status,
				tableLocked:
					r.assignment === 'locked' || !SOFT_REFLOWABLE_STATUSES.has(r.status),
				overbook: r.overbooked,
				channel: r.channel === 'online' ? 'online' : 'host',
				serviceId: r.serviceId,
				areaId: r.areaPrefStrict ? r.areaPrefId : null,
			}))

	const engineHolds: AssignHoldRecord[] = dayHolds.map((h) => ({
		id: h.id,
		partySize: h.partySize,
		startAt: h.startAt,
		endAt: h.endAt,
		tableIds: (occsByHoldId.get(h.id) ?? []).map((o) => o.tableId),
		combinationId: h.comboId,
		expiresAt: h.expiresAt,
	}))

	const engineBlocks: AssignBlockRecord[] = dayBlocks.map((b) => ({
		id: b.id,
		tableIds: b.tableId ? [b.tableId] : [],
		areaId: b.areaId,
		startAt: b.startAt,
		endAt: b.endAt,
	}))

	return {
		settings: settingsRow,
		timeZone: settingsRow?.timeZone ?? 'UTC',
		freezeMin: settingsRow?.freezeMin ?? 30,
		areas,
		tables,
		tableById,
		combos,
		services,
		turnTimes,
		pacingRules,
		serviceAvail,
		dayResRows,
		dayBlocks,
		dayHolds,
		activeOccRows,
		occsByResId,
		engineAreas,
		engineTables,
		engineCombos,
		engineServiceAvail,
		enginePacingRules,
		buildEngineBookings,
		engineHolds,
		engineBlocks,
	}
}

function resolveTurnDurationMin(
	turnTimes: Array<typeof rsvTurnTimes.$inferSelect>,
	serviceId: string | null,
	partySize: number,
	explicitDurationMin?: number | null,
): number {
	if (explicitDurationMin && explicitDurationMin >= 15) {
		return explicitDurationMin
	}
	const serviceScoped = turnTimes.find(
		(tt) =>
			tt.serviceId === serviceId &&
			tt.partyMin <= partySize &&
			tt.partyMax >= partySize,
	)
	if (serviceScoped) return serviceScoped.minutes

	const locationDefault = turnTimes.find(
		(tt) =>
			tt.serviceId === null &&
			tt.partyMin <= partySize &&
			tt.partyMax >= partySize,
	)
	if (locationDefault) return locationDefault.minutes

	return 90
}

function resolveServiceForTime(
	services: Array<typeof rsvServices.$inferSelect>,
	localStartMin: number,
	explicitServiceId?: string | null,
): typeof rsvServices.$inferSelect | null {
	if (explicitServiceId) {
		const found = services.find((s) => s.id === explicitServiceId)
		if (found) return found
	}
	return (
		services.find(
			(s) =>
				localStartMin >= s.firstSeatingMin && localStartMin <= s.lastSeatingMin,
		) ??
		services[0] ??
		null
	)
}

function isInsideFreezeWindow(
	bookingStartAt: number,
	nowMs: number,
	freezeMin: number,
): boolean {
	return (
		bookingStartAt >= nowMs - 12 * 3600_000 &&
		bookingStartAt - nowMs <= freezeMin * 60_000
	)
}

function effectiveFreezeNow(bookingStartAt: number, nowMs: number): number {
	return bookingStartAt < nowMs - 24 * 3600_000
		? bookingStartAt - 24 * 3600_000
		: nowMs
}

async function resolveOccasionTagId(
	tx: DbOrTx,
	occasionOrTagId?: string | null,
): Promise<string | null> {
	if (!occasionOrTagId) return null
	const trimmed = occasionOrTagId.trim()
	if (!trimmed) return null

	const existing = await tx
		.select()
		.from(rsvTags)
		.where(
			sql`${rsvTags.id} = ${trimmed} OR lower(${rsvTags.name}) = ${trimmed.toLowerCase()}`,
		)
		.get()
	if (existing) return existing.id

	const tagId = /^[a-z0-9_-]+$/i.test(trimmed)
		? trimmed
		: `tag_occ_${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`

	await tx
		.insert(rsvTags)
		.values({
			id: tagId,
			scope: 'reservation',
			category: 'occasion',
			name: trimmed,
			colorToken: 'accent',
			sensitive: false,
			guestSelectable: true,
		})
		.onConflictDoNothing()

	return tagId
}

export interface CreateOperatorReservationInput {
	locationId: string
	date: string
	time?: string | number
	localStartMin?: number
	partySize: number
	durationMin?: number | null
	serviceId?: string | null
	diningAreaId?: string | null
	areaPrefId?: string | null
	areaPrefStrict?: boolean
	tableIds?: string[]
	comboId?: string | null
	lock?: boolean
	locked?: boolean
	tableLocked?: boolean
	lockTable?: boolean
	assignment?: 'soft' | 'locked'
	skipPayment?: boolean
	paymentPolicyMode?: string | null
	overbook?: boolean
	overbookReason?: string | null
	channel?: 'phone' | 'walk_in' | 'in_person' | 'online' | 'voice' | 'import'
	occasion?: string | null
	occasionTagId?: string | null
	guestRequests?: string | null
	dietaryNotes?: string | null
	internalNotes?: string | null
	staffNotes?: string | null
	guestId?: string | null
	guest?: {
		id?: string | null
		firstName?: string
		lastName?: string
		phone?: string | null
		phoneE164?: string | null
		email?: string | null
		emailNorm?: string | null
		locale?: string
		allergyNotes?: string | null
		tagIds?: string[]
	} | null
}

/** A rule the staff booking went past because the operator explicitly overrode it. */
export type BookingWarning = {
	code: 'closed_day' | 'pacing_exceeded' | 'pacing_parties_exceeded'
	message: string
}

export async function createOperatorReservation(params: {
	orgId: string
	locationId: string
	actorId: string
	idempotencyKey: string
	input: CreateOperatorReservationInput
}): Promise<{
	reservation: SerializedBookReservation
	moves: ReservationMoveReport[]
	warnings: BookingWarning[]
}> {
	const idempotencyKey = params.idempotencyKey?.trim()
	if (!idempotencyKey) {
		throw badRequest(
			'missing_idempotency_key',
			'Idempotency-Key header is required',
		)
	}

	const input = params.input
	const locationId = input.locationId || params.locationId
	const businessDate = input.date?.trim()
	if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
		throw badRequest('invalid_date', 'Valid YYYY-MM-DD date is required')
	}
	if (
		!Number.isInteger(input.partySize) ||
		input.partySize < 1 ||
		input.partySize > 99
	) {
		throw badRequest('invalid_party_size', 'partySize must be between 1 and 99')
	}

	const localStartMin =
		input.localStartMin !== undefined
			? input.localStartMin
			: input.time !== undefined
				? parseTimeToMinutes(input.time)
				: undefined
	if (localStartMin === undefined) {
		throw badRequest('missing_time', 'Reservation time is required')
	}

	return withReservationWrite<{
		reservation: SerializedBookReservation
		moves: ReservationMoveReport[]
		warnings: BookingWarning[]
	}>(
		{
			orgId: params.orgId,
			locationId,
			dates: businessDate,
			scope: 'POST /operator/reservations/book/reservations',
			idempotencyKey,
			requestHash: hashIdempotencyPayload(input),
		},
		async (tx, helpers) => {
			const now = Date.now()
			const state = await loadLocationSchedulingState(
				tx,
				locationId,
				businessDate,
			)
			const svc = resolveServiceForTime(
				state.services,
				localStartMin,
				input.serviceId,
			)
			const serviceId = svc?.id ?? input.serviceId ?? null
			const durationMin = resolveTurnDurationMin(
				state.turnTimes,
				serviceId,
				input.partySize,
				input.durationMin,
			)

			const resolvedInstant = localToInstant(
				businessDate,
				localStartMin,
				state.timeZone,
			)
			if (!resolvedInstant) {
				throw badRequest(
					'invalid_time',
					'Could not resolve reservation instant',
				)
			}
			const startAt = resolvedInstant.instantMs
			const endAt = startAt + durationMin * 60_000

			const areaPrefId = input.diningAreaId ?? input.areaPrefId ?? null
			const isOverbook = Boolean(input.overbook)
			if (isOverbook && !input.overbookReason?.trim()) {
				throw badRequest(
					'missing_overbook_reason',
					'overbookReason is required when overbook is true',
				)
			}

			const warnings: BookingWarning[] = []

			// `online_closed` only stops the guest channel, so staff may still book.
			const dayState = await loadStaffDayState(tx, locationId, businessDate)
			if (dayState.state === 'closed') {
				const message = dayState.name
					? `The location is closed on this date (${dayState.name}); overbook override required`
					: 'The location is closed on this date; overbook override required'
				if (!isOverbook) {
					throw conflict('closed_day', message, {
						specialDay: { name: dayState.name, note: dayState.note },
					})
				}
				warnings.push({ code: 'closed_day', message })
			}

			// Check pacing rules for this slot
			const activeDayRes = state.dayResRows.filter((r) =>
				ACTIVE_OCCUPANCY_STATUSES.has(r.status),
			)
			for (const pr of state.pacingRules) {
				if (serviceId && pr.serviceId !== serviceId) continue
				if (pr.fromMin !== null && localStartMin < pr.fromMin) continue
				if (pr.toMin !== null && localStartMin >= pr.toMin) continue
				const bucketMin = pr.bucketMin || 15
				const bucketStart = Math.floor(localStartMin / bucketMin) * bucketMin
				const bucketEnd = bucketStart + bucketMin
				const inBucket = activeDayRes.filter(
					(r) => r.localStartMin >= bucketStart && r.localStartMin < bucketEnd,
				)
				const bucketCovers = inBucket.reduce((s, r) => s + r.partySize, 0)
				if (
					pr.maxCovers !== null &&
					bucketCovers + input.partySize > pr.maxCovers
				) {
					const message =
						'Pacing limit exceeded for this interval; overbook override required'
					if (!isOverbook) throw conflict('pacing_exceeded', message)
					warnings.push({ code: 'pacing_exceeded', message })
				}
				if (pr.maxParties !== null && inBucket.length + 1 > pr.maxParties) {
					const message =
						'Max parties limit exceeded for this interval; overbook override required'
					if (!isOverbook) throw conflict('pacing_parties_exceeded', message)
					warnings.push({ code: 'pacing_parties_exceeded', message })
				}
			}

			let assignedTableIds: string[] = []
			let assignedComboId: string | null = input.comboId ?? null
			const moves: ReservationMoveReport[] = []

			const explicitTables =
				input.tableIds && input.tableIds.length > 0
					? [...new Set(input.tableIds)]
					: null

			if (explicitTables) {
				const overlappingResIds = new Set<string>()
				for (const tid of explicitTables) {
					const tbl = state.tableById.get(tid)
					if (!tbl || tbl.archivedAt !== null) {
						throw badRequest(
							'invalid_table',
							`Table ${tid} not found in location`,
						)
					}
					const resetMs = (tbl.resetBufferMin ?? 0) * 60_000
					const occEnd = endAt + resetMs
					const overlapping = state.activeOccRows.filter(
						(o) => o.tableId === tid && o.startAt < occEnd && o.endAt > startAt,
					)
					for (const occ of overlapping) {
						if (occ.kind === 'block' || occ.kind === 'hold') {
							if (!isOverbook) {
								throw conflict(
									'table_occupied',
									`Table ${tbl.label} is already occupied during this window`,
								)
							}
						} else if (occ.reservationId) {
							overlappingResIds.add(occ.reservationId)
						}
					}
				}
				if (overlappingResIds.size > 0 && !isOverbook) {
					for (const otherId of overlappingResIds) {
						const other = state.dayResRows.find((r) => r.id === otherId)
						if (!other) continue
						const isHardLocked =
							other.assignment === 'locked' ||
							!SOFT_REFLOWABLE_STATUSES.has(other.status) ||
							isInsideFreezeWindow(other.startAt, now, state.freezeMin)
						if (isHardLocked) {
							throw conflict(
								'table_occupied',
								`Cannot displace reservation ${other.confirmationCode} (locked, seated, or within freeze window)`,
							)
						}
						const otherOccs = state.occsByResId.get(other.id) ?? []
						const otherFromTables = otherOccs.map((o) => o.tableId)
						await tx
							.update(rsvTableOccupancies)
							.set({ active: false })
							.where(
								and(
									eq(rsvTableOccupancies.reservationId, other.id),
									eq(rsvTableOccupancies.active, true),
								),
							)
						const simulatedBookings: AssignBookingRecord[] = [
							...state.buildEngineBookings(new Set([other.id])),
							{
								id: 'new_explicit_booking',
								partySize: input.partySize,
								localStartMin,
								startAt,
								endAt,
								tableIds: explicitTables,
								combinationId: input.comboId ?? null,
								status: 'booked',
								tableLocked: true,
								overbook: false,
								channel: 'host',
								serviceId,
							},
						]
						const reflowAssign = assignTables({
							partySize: other.partySize,
							startAt: other.startAt,
							endAt: other.endAt,
							localStartMin: other.localStartMin,
							channel: other.channel === 'online' ? 'online' : 'host',
							serviceId: other.serviceId,
							areaId: other.areaPrefStrict ? other.areaPrefId : null,
							tables: state.engineTables,
							areas: state.engineAreas,
							combinations: state.engineCombos,
							serviceAvailability: state.engineServiceAvail,
							pacingRules: [],
							bookings: simulatedBookings,
							holds: state.engineHolds,
							blocks: state.engineBlocks,
							nowMs: effectiveFreezeNow(other.startAt, now),
							assignmentFreezeMin: state.freezeMin,
							skipPacing: true,
						})
						if (!reflowAssign.assigned) {
							throw conflict(
								'table_occupied',
								`Cannot reflow displaced reservation ${other.confirmationCode} to another table`,
							)
						}
						for (const tid of reflowAssign.tableIds) {
							const tbl = state.tableById.get(tid)
							const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
							await tx.insert(rsvTableOccupancies).values({
								id: createId('occ'),
								locationId,
								tableId: tid,
								kind: 'reservation',
								reservationId: other.id,
								startAt: other.startAt,
								endAt: other.endAt + resetMs,
								active: true,
								overbook: false,
								createdAt: now,
							})
						}
						await tx
							.update(rsvReservations)
							.set({
								comboId: reflowAssign.combinationId,
								scheduleVersion: other.scheduleVersion + 1,
								version: other.version + 1,
								updatedAt: now,
							})
							.where(eq(rsvReservations.id, other.id))
						await tx.insert(rsvReservationEvents).values({
							id: createId('rev'),
							reservationId: other.id,
							at: now,
							actorKind: 'operator',
							actorId: params.actorId,
							type: 'auto_reassigned',
							fromStatus: other.status,
							toStatus: other.status,
							data: {
								fromTableIds: otherFromTables,
								toTableIds: reflowAssign.tableIds,
								toCombinationId: reflowAssign.combinationId ?? null,
								reason: 'reflow',
							},
						})
						moves.push({
							reservationId: other.id,
							bookingId: other.id,
							fromTableIds: otherFromTables,
							toTableIds: [...reflowAssign.tableIds],
							toCombinationId: reflowAssign.combinationId,
						})
					}
				}
				assignedTableIds = explicitTables
			} else {
				const channelMode = input.channel === 'walk_in' ? 'walk_in' : 'host'
				// Filter out walk_in_only tables when booking advance reservations via phone/host
				const walkInOnlyIds = new Set(
					state.serviceAvail
						.filter(
							(sa) =>
								sa.mode === 'walk_in_only' &&
								sa.tableId &&
								(!serviceId || sa.serviceId === serviceId),
						)
						.map((sa) => sa.tableId!),
				)
				const tablesForEngine =
					channelMode === 'walk_in'
						? state.engineTables
						: state.engineTables.map((t) =>
								walkInOnlyIds.has(t.id) ? { ...t, active: false } : t,
							)

				let assignRes = assignTables({
					partySize: input.partySize,
					startAt,
					endAt,
					localStartMin,
					channel: channelMode,
					serviceId,
					areaId: input.areaPrefStrict ? areaPrefId : null,
					tables: tablesForEngine,
					areas: state.engineAreas,
					combinations: state.engineCombos,
					serviceAvailability: state.engineServiceAvail,
					pacingRules: state.enginePacingRules,
					bookings: state.buildEngineBookings(),
					holds: state.engineHolds,
					blocks: state.engineBlocks,
					nowMs: effectiveFreezeNow(startAt, now),
					assignmentFreezeMin: state.freezeMin,
					skipPacing: isOverbook,
				})

				if (!assignRes.assigned && isOverbook) {
					assignRes = assignTables({
						partySize: input.partySize,
						startAt,
						endAt,
						localStartMin,
						channel: channelMode,
						serviceId,
						areaId: null,
						tables: tablesForEngine,
						areas: state.engineAreas,
						combinations: state.engineCombos,
						serviceAvailability: state.engineServiceAvail,
						pacingRules: [],
						bookings: state.buildEngineBookings(),
						holds: state.engineHolds,
						blocks: state.engineBlocks,
						nowMs: effectiveFreezeNow(startAt, now),
						assignmentFreezeMin: state.freezeMin,
						skipPacing: true,
					})
				}

				if (assignRes.assigned) {
					assignedTableIds = [...assignRes.tableIds]
					assignedComboId = assignRes.combinationId

					// Apply any soft-booking swaps produced by the assignment engine
					for (const swap of assignRes.swaps) {
						await tx
							.update(rsvTableOccupancies)
							.set({ active: false })
							.where(
								and(
									eq(rsvTableOccupancies.reservationId, swap.bookingId),
									eq(rsvTableOccupancies.active, true),
								),
							)
						const swappedBooking = state.dayResRows.find(
							(r) => r.id === swap.bookingId,
						)
						if (swappedBooking) {
							for (const tid of swap.toTableIds) {
								const tbl = state.tableById.get(tid)
								const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
								await tx.insert(rsvTableOccupancies).values({
									id: createId('occ'),
									locationId,
									tableId: tid,
									kind: 'reservation',
									reservationId: swappedBooking.id,
									startAt: swappedBooking.startAt,
									endAt: swappedBooking.endAt + resetMs,
									active: true,
									overbook: false,
									createdAt: now,
								})
							}
							await tx
								.update(rsvReservations)
								.set({
									comboId: swap.toCombinationId,
									scheduleVersion: swappedBooking.scheduleVersion + 1,
									version: swappedBooking.version + 1,
									updatedAt: now,
								})
								.where(eq(rsvReservations.id, swappedBooking.id))
							await tx.insert(rsvReservationEvents).values({
								id: createId('rev'),
								reservationId: swappedBooking.id,
								at: now,
								actorKind: 'operator',
								actorId: params.actorId,
								type: 'auto_reassigned',
								fromStatus: swappedBooking.status,
								toStatus: swappedBooking.status,
								data: {
									fromTableIds: swap.fromTableIds,
									toTableIds: swap.toTableIds,
									toCombinationId: swap.toCombinationId ?? null,
									reason: 'reflow',
								},
							})
							moves.push({
								reservationId: swap.bookingId,
								bookingId: swap.bookingId,
								fromTableIds: swap.fromTableIds,
								toTableIds: swap.toTableIds,
								toCombinationId: swap.toCombinationId,
							})
						}
					}
				} else if (!isOverbook) {
					throw conflict(
						assignRes.reason ?? 'no_availability',
						'No available tables for this party size and time',
					)
				} else {
					// An explicit staff overbook outranks a guest's live hold: seat the
					// party on a held table so the guest's conversion sees it taken.
					const liveHoldIds = new Set(
						state.dayHolds
							.filter(
								(h) =>
									h.expiresAt > now && h.startAt < endAt && h.endAt > startAt,
							)
							.map((h) => h.id),
					)
					const heldTableId = state.activeOccRows
						.filter(
							(o) =>
								o.kind === 'hold' &&
								o.holdId !== null &&
								liveHoldIds.has(o.holdId) &&
								o.startAt < endAt &&
								o.endAt > startAt,
						)
						.map((o) => o.tableId)
						.find((tid) => {
							const tbl = state.tableById.get(tid)
							return (
								tbl !== undefined &&
								tbl.archivedAt === null &&
								tbl.minCovers <= input.partySize &&
								tbl.maxCovers >= input.partySize
							)
						})
					if (heldTableId) assignedTableIds = [heldTableId]
				}
			}

			const guest = await resolveOrCreateGuestForBooking(tx, {
				guestId: input.guestId,
				guest: input.guest,
				actorId: params.actorId,
			})

			const resId = createId('rsv')
			const confirmationCode = generateConfirmationCode()
			const isLocked = Boolean(
				input.lock ??
				input.locked ??
				input.tableLocked ??
				input.lockTable ??
				input.assignment === 'locked',
			)
			const assignmentMode: 'soft' | 'locked' = isLocked ? 'locked' : 'soft'

			const staffNotesVal = input.internalNotes ?? input.staffNotes ?? null
			const occasionVal = await resolveOccasionTagId(
				tx,
				input.occasion ?? input.occasionTagId ?? null,
			)

			await tx.insert(rsvReservations).values({
				id: resId,
				locationId,
				guestId: guest.id,
				confirmationCode,
				guestLocale: guest.locale || 'en',
				businessDate,
				localStartMin,
				timeZone: state.timeZone,
				startAt,
				endAt,
				durationMin,
				serviceId,
				partySize: input.partySize,
				status: 'booked',
				contactStatus: null,
				channel:
					input.channel === 'in_person' || input.channel === 'import'
						? 'host'
						: input.channel === 'voice'
							? 'voice_agent'
							: (input.channel ?? 'phone'),
				client: 'operator',
				assignment: assignmentMode,
				comboId: assignedComboId,
				overbooked: isOverbook,
				areaPrefId,
				areaPrefStrict: Boolean(input.areaPrefStrict),
				occasionTagId: occasionVal,
				guestRequests: input.guestRequests ?? null,
				dietaryNotes: input.dietaryNotes ?? null,
				staffNotes: staffNotesVal,
				paymentStatus: 'none',
				scheduleVersion: 1,
				version: 1,
				createdByKind: 'operator',
				createdById: params.actorId,
				createdAt: now,
				updatedAt: now,
			})

			for (const tid of assignedTableIds) {
				const tbl = state.tableById.get(tid)
				const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
				const occEnd = endAt + resetMs
				const hasOverlap = state.activeOccRows.some(
					(o) => o.tableId === tid && o.startAt < occEnd && o.endAt > startAt,
				)
				await tx.insert(rsvTableOccupancies).values({
					id: createId('occ'),
					locationId,
					tableId: tid,
					kind: 'reservation',
					reservationId: resId,
					startAt,
					endAt: occEnd,
					active: true,
					overbook: Boolean(isOverbook && hasOverlap),
					createdAt: now,
				})
			}

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: resId,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'created',
				fromStatus: null,
				toStatus: 'booked',
				data: {
					partySize: input.partySize,
					localStartMin,
					tableIds: assignedTableIds,
					overbook: isOverbook,
				},
			})

			if (isOverbook) {
				await tx.insert(rsvAuditLog).values({
					id: createId('aud'),
					at: now,
					actorKind: 'operator',
					actorId: params.actorId,
					locationId,
					action: 'reservation.overbook',
					entityType: 'reservation',
					entityId: resId,
					changes: {
						reason: input.overbookReason?.trim() ?? 'operator_override',
						partySize: input.partySize,
						localStartMin,
						tableIds: assignedTableIds,
					},
				})
			}

			await enqueueReservationMessage(
				tx,
				{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
				{ reservationId: resId, kind: 'confirmation' },
			)

			const createdRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, resId))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [createdRow!])

			return {
				reservation: serialized!,
				moves,
				warnings,
			}
		},
	)
}

export type WalkInOccupiedInfo = {
	locationId: string
	businessDate: string
	partySize: number
	startAt: number
	endAt: number
	tableIds: string[]
	/** Active occupancies (reservations, holds, blocks) overlapping the tables. */
	occupancies: Array<typeof rsvTableOccupancies.$inferSelect>
}

export async function createWalkIn(params: {
	orgId: string
	locationId: string
	actorId: string
	idempotencyKey: string
	/** Seating from the waitlist records this channel on the new reservation. */
	channel?: 'walk_in' | 'waitlist'
	/**
	 * Runs in the same transaction when explicit tables are taken and the seat
	 * is not an overbook. Free the tables or throw; without it the walk-in is
	 * refused with `table_occupied`.
	 */
	onOccupied?: (
		tx: ReservationWriteTx,
		info: WalkInOccupiedInfo,
	) => Promise<void>
	/** Runs inside the same transaction, once the reservation row exists. */
	afterCreate?: (
		tx: ReservationWriteTx,
		created: { reservationId: string; guestId: string },
	) => Promise<void>
	input: {
		locationId?: string
		date?: string
		time?: string | number
		localStartMin?: number
		partySize: number
		durationMin?: number | null
		serviceId?: string | null
		tableIds?: string[]
		overbook?: boolean
		overbookReason?: string | null
		dietaryNotes?: string | null
		internalNotes?: string | null
		staffNotes?: string | null
		guestId?: string | null
		guest?: {
			id?: string | null
			firstName?: string
			lastName?: string
			phone?: string | null
			email?: string | null
			allergyNotes?: string | null
		} | null
	}
}): Promise<{
	reservation: SerializedBookReservation
	moves: ReservationMoveReport[]
}> {
	const idempotencyKey = params.idempotencyKey?.trim()
	if (!idempotencyKey) {
		throw badRequest(
			'missing_idempotency_key',
			'Idempotency-Key header is required',
		)
	}

	const input = params.input
	const locationId = input.locationId || params.locationId
	if (
		!Number.isInteger(input.partySize) ||
		input.partySize < 1 ||
		input.partySize > 99
	) {
		throw badRequest('invalid_party_size', 'partySize must be between 1 and 99')
	}

	const db = await getTenantDb(params.orgId)
	const settingsRow = await db
		.select()
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	const timeZone = settingsRow?.timeZone ?? 'UTC'
	const dayStartMin = settingsRow?.dayStartMin ?? 240
	const now = Date.now()

	const businessDate =
		input.date?.trim() || currentBusinessDate(now, timeZone, dayStartMin)
	const localStartMin =
		input.localStartMin !== undefined
			? input.localStartMin
			: input.time !== undefined
				? parseTimeToMinutes(input.time)
				: instantToLocal(now, timeZone).localStartMin

	return withReservationWrite<{
		reservation: SerializedBookReservation
		moves: ReservationMoveReport[]
	}>(
		{
			orgId: params.orgId,
			locationId,
			dates: businessDate,
			scope: 'POST /operator/reservations/book/walk-ins',
			idempotencyKey,
			requestHash: hashIdempotencyPayload(input),
		},
		async (tx) => {
			const txNow = Date.now()
			const state = await loadLocationSchedulingState(
				tx,
				locationId,
				businessDate,
			)
			const svc = resolveServiceForTime(
				state.services,
				localStartMin,
				input.serviceId,
			)
			const serviceId = svc?.id ?? input.serviceId ?? null
			const durationMin = resolveTurnDurationMin(
				state.turnTimes,
				serviceId,
				input.partySize,
				input.durationMin,
			)

			const resolvedInstant = localToInstant(
				businessDate,
				localStartMin,
				state.timeZone,
			)
			const startAt = resolvedInstant ? resolvedInstant.instantMs : txNow
			const endAt = startAt + durationMin * 60_000

			const isOverbook = Boolean(input.overbook)
			if (isOverbook && !input.overbookReason?.trim()) {
				throw badRequest(
					'missing_overbook_reason',
					'overbookReason is required when overbook is true',
				)
			}

			let assignedTableIds: string[] = []
			let assignedComboId: string | null = null
			const moves: ReservationMoveReport[] = []

			const explicitTables =
				input.tableIds && input.tableIds.length > 0
					? [...new Set(input.tableIds)]
					: null

			if (explicitTables) {
				const occupied: Array<typeof rsvTableOccupancies.$inferSelect> = []
				let firstOccupiedLabel: string | null = null
				for (const tid of explicitTables) {
					const tbl = state.tableById.get(tid)
					if (!tbl || tbl.archivedAt !== null) {
						throw badRequest(
							'invalid_table',
							`Table ${tid} not found in location`,
						)
					}
					const resetMs = (tbl.resetBufferMin ?? 0) * 60_000
					const occEnd = endAt + resetMs
					const overlapping = state.activeOccRows.filter(
						(o) => o.tableId === tid && o.startAt < occEnd && o.endAt > startAt,
					)
					if (overlapping.length > 0) {
						firstOccupiedLabel ??= tbl.label
						occupied.push(...overlapping)
					}
				}
				if (occupied.length > 0 && !isOverbook) {
					if (!params.onOccupied) {
						throw conflict(
							'table_occupied',
							`Table ${firstOccupiedLabel} is currently occupied`,
						)
					}
					await params.onOccupied(tx, {
						locationId,
						businessDate,
						partySize: input.partySize,
						startAt,
						endAt,
						tableIds: explicitTables,
						occupancies: occupied,
					})
				}
				assignedTableIds = explicitTables
			} else {
				const assignRes = assignTables({
					partySize: input.partySize,
					startAt,
					endAt,
					localStartMin,
					channel: 'walk_in',
					serviceId,
					tables: state.engineTables,
					areas: state.engineAreas,
					combinations: state.engineCombos,
					serviceAvailability: state.engineServiceAvail,
					pacingRules: [],
					bookings: state.buildEngineBookings(),
					holds: state.engineHolds,
					blocks: state.engineBlocks,
					nowMs: txNow,
					assignmentFreezeMin: state.freezeMin,
					skipPacing: true,
				})

				if (assignRes.assigned) {
					assignedTableIds = [...assignRes.tableIds]
					assignedComboId = assignRes.combinationId
				} else if (!isOverbook) {
					throw conflict(
						assignRes.reason ?? 'no_availability',
						'No available tables for walk-in party',
					)
				}
			}

			const guest = await resolveOrCreateGuestForBooking(tx, {
				guestId: input.guestId,
				guest: input.guest ?? {
					firstName: 'Walk-in',
					lastName: 'Guest',
				},
				actorId: params.actorId,
			})

			const resId = createId('rsv')
			const confirmationCode = generateConfirmationCode()

			await tx.insert(rsvReservations).values({
				id: resId,
				locationId,
				guestId: guest.id,
				confirmationCode,
				guestLocale: guest.locale || 'en',
				businessDate,
				localStartMin,
				timeZone: state.timeZone,
				startAt,
				endAt,
				durationMin,
				serviceId,
				partySize: input.partySize,
				arrivedCovers: input.partySize,
				seatedCovers: input.partySize,
				coversActual: input.partySize,
				status: 'seated',
				contactStatus: null,
				channel: params.channel ?? 'walk_in',
				client: 'operator',
				assignment: 'locked',
				comboId: assignedComboId,
				overbooked: isOverbook,
				dietaryNotes: input.dietaryNotes ?? null,
				staffNotes: input.internalNotes ?? input.staffNotes ?? null,
				paymentStatus: 'none',
				scheduleVersion: 1,
				version: 1,
				arrivedAt: txNow,
				seatedAt: txNow,
				createdByKind: 'operator',
				createdById: params.actorId,
				createdAt: txNow,
				updatedAt: txNow,
			})

			for (const tid of assignedTableIds) {
				const tbl = state.tableById.get(tid)
				const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
				const occEnd = endAt + resetMs
				const hasOverlap = state.activeOccRows.some(
					(o) => o.tableId === tid && o.startAt < occEnd && o.endAt > startAt,
				)
				await tx.insert(rsvTableOccupancies).values({
					id: createId('occ'),
					locationId,
					tableId: tid,
					kind: 'reservation',
					reservationId: resId,
					startAt,
					endAt: occEnd,
					active: true,
					overbook: Boolean(isOverbook && hasOverlap),
					createdAt: txNow,
				})
			}

			await tx.insert(rsvReservationEvents).values([
				{
					id: createId('rev'),
					reservationId: resId,
					at: txNow,
					actorKind: 'operator',
					actorId: params.actorId,
					type: 'created',
					fromStatus: null,
					toStatus: 'seated',
					data: {
						channel: 'walk_in',
						partySize: input.partySize,
						tableIds: assignedTableIds,
					},
				},
				{
					id: createId('rev'),
					reservationId: resId,
					at: txNow,
					actorKind: 'operator',
					actorId: params.actorId,
					type: 'seated',
					fromStatus: 'booked',
					toStatus: 'seated',
					data: {
						seatedPartySize: input.partySize,
						tableIds: assignedTableIds,
					},
				},
			])

			if (isOverbook) {
				await tx.insert(rsvAuditLog).values({
					id: createId('aud'),
					at: txNow,
					actorKind: 'operator',
					actorId: params.actorId,
					locationId,
					action: 'reservation.overbook',
					entityType: 'reservation',
					entityId: resId,
					changes: {
						reason: input.overbookReason?.trim() ?? 'operator_override',
						tableIds: assignedTableIds,
						channel: params.channel ?? 'walk_in',
					},
				})
			}

			if (params.afterCreate) {
				await params.afterCreate(tx, {
					reservationId: resId,
					guestId: guest.id,
				})
			}

			const createdRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, resId))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [createdRow!])

			return {
				reservation: serialized!,
				moves,
			}
		},
	)
}

export async function getReservationDetail(
	db: DbOrTx,
	reservationId: string,
	opts?: { canReadGuestSensitive?: boolean },
) {
	const row = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!row) throw notFound('Reservation not found')

	const canReadSensitive = opts?.canReadGuestSensitive ?? true
	const [serialized] = await serializeReservationsForBook(db, [row], {
		canReadGuestSensitive: canReadSensitive,
	})

	const [events, paymentIntents, messages] = await Promise.all([
		db
			.select()
			.from(rsvReservationEvents)
			.where(eq(rsvReservationEvents.reservationId, reservationId))
			.orderBy(asc(rsvReservationEvents.at))
			.all(),
		db
			.select()
			.from(rsvPayments)
			.where(eq(rsvPayments.reservationId, reservationId))
			.orderBy(desc(rsvPayments.createdAt))
			.all(),
		db
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.reservationId, reservationId))
			.orderBy(desc(rsvMessages.createdAt))
			.all(),
	])

	const guestDetail = row.guestId
		? await getGuestSummary(db, row.guestId, { canReadSensitive }).catch(
				() => null,
			)
		: null

	return {
		reservation: serialized!,
		events,
		guestDetail,
		paymentIntents,
		messages,
	}
}

export async function assignReservationTables(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		tableIds?: string[]
		comboId?: string | null
		lock?: boolean
		locked?: boolean
		tableLocked?: boolean
		unlock?: boolean
		swap?: boolean
		swapWithReservationId?: string | null
		overbook?: boolean
		overbookReason?: string | null
		expectedVersion?: number
		nowMs?: number
	}
}): Promise<{
	reservation: SerializedBookReservation
	moves: ReservationMoveReport[]
}> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
		moves: ReservationMoveReport[]
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = params.input.nowMs ?? Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			const state = await loadLocationSchedulingState(
				tx,
				current.locationId,
				current.businessDate,
			)
			const currentOccs = state.occsByResId.get(current.id) ?? []
			const currentTableIds = currentOccs.map((o) => o.tableId)
			const moves: ReservationMoveReport[] = []

			// Handle explicit unlock without changing tables
			if (
				params.input.unlock &&
				(!params.input.tableIds || params.input.tableIds.length === 0)
			) {
				await tx
					.update(rsvReservations)
					.set({
						assignment: 'soft',
						version: current.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, current.id))

				await tx.insert(rsvReservationEvents).values({
					id: createId('rev'),
					reservationId: current.id,
					at: now,
					actorKind: 'operator',
					actorId: params.actorId,
					type: 'unlocked',
					fromStatus: current.status,
					toStatus: current.status,
					data: { tableIds: currentTableIds },
				})

				const updatedRow = await tx
					.select()
					.from(rsvReservations)
					.where(eq(rsvReservations.id, current.id))
					.get()
				const [serialized] = await serializeReservationsForBook(tx, [
					updatedRow!,
				])
				return { reservation: serialized!, moves }
			}

			let targetTableIds = [...new Set(params.input.tableIds ?? [])]
			if (targetTableIds.length === 0 && params.input.swapWithReservationId) {
				const swapOccs =
					state.occsByResId.get(params.input.swapWithReservationId) ?? []
				targetTableIds = swapOccs.map((o) => o.tableId)
			}
			const isOverbook = Boolean(params.input.overbook)
			if (isOverbook && !params.input.overbookReason?.trim()) {
				throw badRequest(
					'missing_overbook_reason',
					'overbookReason is required when overbook is true',
				)
			}

			for (const tid of targetTableIds) {
				const tbl = state.tableById.get(tid)
				if (!tbl || tbl.archivedAt !== null) {
					throw badRequest(
						'invalid_table',
						`Table ${tid} not found in location`,
					)
				}
			}

			// Find any other active reservations overlapping targetTableIds
			const overlappingResIds = new Set<string>()
			for (const tid of targetTableIds) {
				const tbl = state.tableById.get(tid)!
				const resetMs = (tbl.resetBufferMin ?? 0) * 60_000
				const targetOccEnd = current.endAt + resetMs
				for (const occ of state.activeOccRows) {
					if (
						occ.tableId === tid &&
						occ.reservationId !== current.id &&
						occ.startAt < targetOccEnd &&
						occ.endAt > current.startAt
					) {
						if (occ.kind === 'reservation' && occ.reservationId) {
							overlappingResIds.add(occ.reservationId)
						} else if (!isOverbook) {
							throw conflict(
								'table_blocked',
								`Table ${tbl.label} is blocked or held during this window`,
							)
						}
					}
				}
			}

			// Deactivate current reservation's occupancies first so triggers allow swaps/reassignments
			if (currentOccs.length > 0) {
				await tx
					.update(rsvTableOccupancies)
					.set({ active: false })
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, current.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
			}

			if (overlappingResIds.size > 0) {
				const overlappingReservations = state.dayResRows.filter((r) =>
					overlappingResIds.has(r.id),
				)

				// Case A: Explicit atomic swap
				if (params.input.swap || params.input.swapWithReservationId) {
					const swapTargetId =
						params.input.swapWithReservationId ?? overlappingReservations[0]?.id
					const swapTarget = state.dayResRows.find((r) => r.id === swapTargetId)
					if (!swapTarget) {
						throw conflict(
							'swap_target_not_found',
							'No overlapping reservation found to swap with',
						)
					}
					if (
						swapTarget.status === 'arrived' ||
						swapTarget.status === 'seated'
					) {
						throw conflict(
							'swap_target_seated',
							'Cannot swap with an arrived or seated party',
						)
					}
					const swapTargetOccs = state.occsByResId.get(swapTarget.id) ?? []
					const swapTargetFromTables = swapTargetOccs.map((o) => o.tableId)

					// Deactivate swapTarget occupancies first
					if (swapTargetOccs.length > 0) {
						await tx
							.update(rsvTableOccupancies)
							.set({ active: false })
							.where(
								and(
									eq(rsvTableOccupancies.reservationId, swapTarget.id),
									eq(rsvTableOccupancies.active, true),
								),
							)
					}

					// Move swapTarget onto currentTableIds
					for (const tid of currentTableIds) {
						const tbl = state.tableById.get(tid)
						const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
						await tx.insert(rsvTableOccupancies).values({
							id: createId('occ'),
							locationId: current.locationId,
							tableId: tid,
							kind: 'reservation',
							reservationId: swapTarget.id,
							startAt: swapTarget.startAt,
							endAt: swapTarget.endAt + resetMs,
							active: true,
							overbook: false,
							createdAt: now,
						})
					}

					await tx
						.update(rsvReservations)
						.set({
							comboId: current.comboId,
							scheduleVersion: swapTarget.scheduleVersion + 1,
							version: swapTarget.version + 1,
							updatedAt: now,
						})
						.where(eq(rsvReservations.id, swapTarget.id))

					await tx.insert(rsvReservationEvents).values({
						id: createId('rev'),
						reservationId: swapTarget.id,
						at: now,
						actorKind: 'operator',
						actorId: params.actorId,
						type: 'table_changed',
						fromStatus: swapTarget.status,
						toStatus: swapTarget.status,
						data: {
							fromTableIds: swapTargetFromTables,
							toTableIds: currentTableIds,
							swappedWith: current.id,
						},
					})

					moves.push({
						reservationId: swapTarget.id,
						bookingId: swapTarget.id,
						fromTableIds: swapTargetFromTables,
						toTableIds: currentTableIds,
						toCombinationId: current.comboId,
					})
				} else if (!isOverbook) {
					// Case B: Soft-booking reflow (only allowed if occupying booking is soft, not arrived/seated, and outside freeze_min)
					for (const other of overlappingReservations) {
						const isHardLocked =
							other.assignment === 'locked' ||
							!SOFT_REFLOWABLE_STATUSES.has(other.status) ||
							isInsideFreezeWindow(other.startAt, now, state.freezeMin)

						if (isHardLocked) {
							throw conflict(
								'locked_table_conflict',
								`Cannot displace reservation ${other.confirmationCode} (locked, seated, or within freeze window)`,
							)
						}

						const otherOccs = state.occsByResId.get(other.id) ?? []
						const otherFromTables = otherOccs.map((o) => o.tableId)

						// Deactivate `other` occupancies before searching for its replacement table
						await tx
							.update(rsvTableOccupancies)
							.set({ active: false })
							.where(
								and(
									eq(rsvTableOccupancies.reservationId, other.id),
									eq(rsvTableOccupancies.active, true),
								),
							)

						// Exclude both `current` and `other` from existingBookings, and mark `targetTableIds` as occupied by `current`
						const simulatedBookings: AssignBookingRecord[] = [
							...state.buildEngineBookings(new Set([current.id, other.id])),
							{
								id: current.id,
								partySize: current.partySize,
								localStartMin: current.localStartMin,
								startAt: current.startAt,
								endAt: current.endAt,
								tableIds: targetTableIds,
								combinationId: params.input.comboId ?? null,
								status: current.status,
								tableLocked: true,
								overbook: false,
								channel: 'host',
								serviceId: current.serviceId,
							},
						]

						const reflowAssign = assignTables({
							partySize: other.partySize,
							startAt: other.startAt,
							endAt: other.endAt,
							localStartMin: other.localStartMin,
							channel: other.channel === 'online' ? 'online' : 'host',
							serviceId: other.serviceId,
							areaId: other.areaPrefStrict ? other.areaPrefId : null,
							tables: state.engineTables,
							areas: state.engineAreas,
							combinations: state.engineCombos,
							serviceAvailability: state.engineServiceAvail,
							pacingRules: [],
							bookings: simulatedBookings,
							holds: state.engineHolds,
							blocks: state.engineBlocks,
							nowMs: effectiveFreezeNow(other.startAt, now),
							assignmentFreezeMin: state.freezeMin,
							skipPacing: true,
						})

						if (!reflowAssign.assigned) {
							throw conflict(
								'reflow_failed',
								`Cannot reflow displaced reservation ${other.confirmationCode} to another table`,
							)
						}

						for (const tid of reflowAssign.tableIds) {
							const tbl = state.tableById.get(tid)
							const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
							await tx.insert(rsvTableOccupancies).values({
								id: createId('occ'),
								locationId: current.locationId,
								tableId: tid,
								kind: 'reservation',
								reservationId: other.id,
								startAt: other.startAt,
								endAt: other.endAt + resetMs,
								active: true,
								overbook: false,
								createdAt: now,
							})
						}

						await tx
							.update(rsvReservations)
							.set({
								comboId: reflowAssign.combinationId,
								scheduleVersion: other.scheduleVersion + 1,
								version: other.version + 1,
								updatedAt: now,
							})
							.where(eq(rsvReservations.id, other.id))

						await tx.insert(rsvReservationEvents).values({
							id: createId('rev'),
							reservationId: other.id,
							at: now,
							actorKind: 'operator',
							actorId: params.actorId,
							type: 'auto_reassigned',
							fromStatus: other.status,
							toStatus: other.status,
							data: {
								fromTableIds: otherFromTables,
								toTableIds: reflowAssign.tableIds,
								toCombinationId: reflowAssign.combinationId ?? null,
								reason: 'reflow',
							},
						})

						moves.push({
							reservationId: other.id,
							bookingId: other.id,
							fromTableIds: otherFromTables,
							toTableIds: [...reflowAssign.tableIds],
							toCombinationId: reflowAssign.combinationId,
						})
					}
				}
			}

			// Insert new occupancies for `current`
			for (const tid of targetTableIds) {
				const tbl = state.tableById.get(tid)
				const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
				const occEnd = current.endAt + resetMs
				await tx.insert(rsvTableOccupancies).values({
					id: createId('occ'),
					locationId: current.locationId,
					tableId: tid,
					kind: 'reservation',
					reservationId: current.id,
					startAt: current.startAt,
					endAt: occEnd,
					active: true,
					overbook: isOverbook,
					createdAt: now,
				})
			}

			const wantLock = Boolean(
				params.input.lock ??
				params.input.locked ??
				params.input.tableLocked ??
				(params.input.unlock ? false : current.assignment === 'locked'),
			)
			const nextAssignment: 'soft' | 'locked' =
				targetTableIds.length === 0 ? 'soft' : wantLock ? 'locked' : 'soft'

			await tx
				.update(rsvReservations)
				.set({
					assignment: nextAssignment,
					comboId: params.input.comboId ?? null,
					overbooked: current.overbooked || isOverbook,
					scheduleVersion: current.scheduleVersion + 1,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			const eventType =
				nextAssignment === 'locked' && current.assignment !== 'locked'
					? 'locked'
					: nextAssignment === 'soft' && current.assignment === 'locked'
						? 'unlocked'
						: 'table_changed'

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: eventType,
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					fromTableIds: currentTableIds,
					toTableIds: targetTableIds,
					assignment: nextAssignment,
					overbook: isOverbook,
				},
			})

			if (isOverbook) {
				await tx.insert(rsvAuditLog).values({
					id: createId('aud'),
					at: now,
					actorKind: 'operator',
					actorId: params.actorId,
					locationId: current.locationId,
					action: 'reservation.overbook',
					entityType: 'reservation',
					entityId: current.id,
					changes: {
						reason: params.input.overbookReason?.trim() ?? 'operator_override',
						tableIds: targetTableIds,
					},
				})
			}

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return {
				reservation: serialized!,
				moves,
			}
		},
	)
}

export async function updateReservation(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		date?: string
		time?: string | number
		localStartMin?: number
		durationMin?: number
		partySize?: number
		serviceId?: string | null
		diningAreaId?: string | null
		areaPrefId?: string | null
		areaPrefStrict?: boolean
		occasion?: string | null
		occasionTagId?: string | null
		guestRequests?: string | null
		dietaryNotes?: string | null
		internalNotes?: string | null
		staffNotes?: string | null
		tableIds?: string[]
		lock?: boolean
		locked?: boolean
		lockTable?: boolean
		unlock?: boolean
		assignment?: 'soft' | 'locked'
		reflowLaterParties?: boolean
		overbook?: boolean
		overbookReason?: string | null
		expectedVersion?: number
		nowMs?: number
	}
}): Promise<{
	reservation: SerializedBookReservation
	moves: ReservationMoveReport[]
}> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	const targetBusinessDate = params.input.date?.trim() || existing.businessDate

	return withReservationWrite<{
		reservation: SerializedBookReservation
		moves: ReservationMoveReport[]
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: targetBusinessDate,
		},
		async (tx, helpers) => {
			const now = params.input.nowMs ?? Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			if (targetBusinessDate !== current.businessDate) {
				helpers.markAffectedDate(current.locationId, current.businessDate)
			}

			const state = await loadLocationSchedulingState(
				tx,
				current.locationId,
				targetBusinessDate,
			)

			const nextPartySize = params.input.partySize ?? current.partySize
			const nextLocalStartMin =
				params.input.localStartMin !== undefined
					? params.input.localStartMin
					: params.input.time !== undefined
						? parseTimeToMinutes(params.input.time)
						: current.localStartMin

			const svc = resolveServiceForTime(
				state.services,
				nextLocalStartMin,
				params.input.serviceId !== undefined
					? params.input.serviceId
					: current.serviceId,
			)
			const nextServiceId = svc?.id ?? current.serviceId

			const nextDurationMin =
				params.input.durationMin ??
				(params.input.partySize !== undefined &&
				params.input.partySize !== current.partySize
					? resolveTurnDurationMin(
							state.turnTimes,
							nextServiceId,
							nextPartySize,
						)
					: current.durationMin)

			const resolvedInstant = localToInstant(
				targetBusinessDate,
				nextLocalStartMin,
				state.timeZone,
			)
			if (!resolvedInstant) {
				throw badRequest(
					'invalid_time',
					'Could not resolve reservation instant',
				)
			}
			const nextStartAt = resolvedInstant.instantMs
			const nextEndAt = nextStartAt + nextDurationMin * 60_000

			const scheduleChanged =
				targetBusinessDate !== current.businessDate ||
				nextLocalStartMin !== current.localStartMin ||
				nextDurationMin !== current.durationMin ||
				nextPartySize !== current.partySize ||
				params.input.tableIds !== undefined

			const currentOccs = await tx
				.select()
				.from(rsvTableOccupancies)
				.where(
					and(
						eq(rsvTableOccupancies.reservationId, current.id),
						eq(rsvTableOccupancies.active, true),
					),
				)
				.all()
			const currentTableIds = currentOccs.map((o) => o.tableId)
			let nextTableIds = params.input.tableIds
				? [...new Set(params.input.tableIds)]
				: currentTableIds
			let nextComboId = current.comboId
			const moves: ReservationMoveReport[] = []
			const isOverbook = Boolean(params.input.overbook)

			if (scheduleChanged && ACTIVE_OCCUPANCY_STATUSES.has(current.status)) {
				// Deactivate current occupancies first
				if (currentOccs.length > 0) {
					await tx
						.update(rsvTableOccupancies)
						.set({ active: false })
						.where(
							and(
								eq(rsvTableOccupancies.reservationId, current.id),
								eq(rsvTableOccupancies.active, true),
							),
						)
				}

				// Check if nextTableIds fit partySize and are free (or can reflow soft overlapping bookings)
				const capacityFits =
					nextTableIds.length > 0 &&
					nextTableIds.reduce(
						(sum, tid) => sum + (state.tableById.get(tid)?.maxCovers ?? 0),
						0,
					) >= nextPartySize &&
					(nextTableIds.length > 1 ||
						(state.tableById.get(nextTableIds[0]!)?.minCovers ?? 1) <=
							nextPartySize)

				if (!capacityFits && !params.input.tableIds && !isOverbook) {
					const assignRes = assignTables({
						partySize: nextPartySize,
						startAt: nextStartAt,
						endAt: nextEndAt,
						localStartMin: nextLocalStartMin,
						channel: 'host',
						serviceId: nextServiceId,
						tables: state.engineTables,
						areas: state.engineAreas,
						combinations: state.engineCombos,
						serviceAvailability: state.engineServiceAvail,
						pacingRules: [],
						bookings: state.buildEngineBookings(new Set([current.id])),
						holds: state.engineHolds,
						blocks: state.engineBlocks,
						nowMs: now,
						assignmentFreezeMin: state.freezeMin,
						skipPacing: true,
					})
					if (!assignRes.assigned) {
						throw conflict(
							'no_availability',
							'No fitting table available for updated party size / time',
						)
					}
					nextTableIds = [...assignRes.tableIds]
					nextComboId = assignRes.combinationId
				} else {
					// Check for overlapping reservations on nextTableIds
					const overlappingResIds = new Set<string>()
					for (const tid of nextTableIds) {
						const tbl = state.tableById.get(tid)
						const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
						const occEnd = nextEndAt + resetMs
						for (const occ of state.activeOccRows) {
							if (
								occ.tableId === tid &&
								occ.reservationId !== current.id &&
								occ.startAt < occEnd &&
								occ.endAt > nextStartAt
							) {
								if (occ.kind === 'reservation' && occ.reservationId) {
									overlappingResIds.add(occ.reservationId)
								} else if (!isOverbook) {
									throw conflict(
										'table_blocked',
										'Target window overlaps an active block or hold',
									)
								}
							}
						}
					}

					if (overlappingResIds.size > 0 && !isOverbook) {
						if (params.input.reflowLaterParties === false) {
							throw conflict(
								'table_occupied',
								'Target window overlaps another reservation',
							)
						}
						for (const otherId of overlappingResIds) {
							const other = state.dayResRows.find((r) => r.id === otherId)
							if (!other) continue
							const isHardLocked =
								other.assignment === 'locked' ||
								!SOFT_REFLOWABLE_STATUSES.has(other.status) ||
								isInsideFreezeWindow(other.startAt, now, state.freezeMin)

							if (isHardLocked) {
								throw conflict(
									'locked_table_conflict',
									`Cannot displace reservation ${other.confirmationCode} (locked, seated, or within freeze window)`,
								)
							}

							const otherOccs = state.occsByResId.get(other.id) ?? []
							const otherFromTables = otherOccs.map((o) => o.tableId)
							await tx
								.update(rsvTableOccupancies)
								.set({ active: false })
								.where(
									and(
										eq(rsvTableOccupancies.reservationId, other.id),
										eq(rsvTableOccupancies.active, true),
									),
								)

							const simulatedBookings: AssignBookingRecord[] = [
								...state.buildEngineBookings(new Set([current.id, other.id])),
								{
									id: current.id,
									partySize: nextPartySize,
									localStartMin: nextLocalStartMin,
									startAt: nextStartAt,
									endAt: nextEndAt,
									tableIds: nextTableIds,
									combinationId: nextComboId,
									status: current.status,
									tableLocked: true,
									overbook: false,
									channel: 'host',
									serviceId: nextServiceId,
								},
							]

							const reflowAssign = assignTables({
								partySize: other.partySize,
								startAt: other.startAt,
								endAt: other.endAt,
								localStartMin: other.localStartMin,
								channel: other.channel === 'online' ? 'online' : 'host',
								serviceId: other.serviceId,
								tables: state.engineTables,
								areas: state.engineAreas,
								combinations: state.engineCombos,
								serviceAvailability: state.engineServiceAvail,
								pacingRules: [],
								bookings: simulatedBookings,
								holds: state.engineHolds,
								blocks: state.engineBlocks,
								nowMs: effectiveFreezeNow(other.startAt, now),
								assignmentFreezeMin: state.freezeMin,
								skipPacing: true,
							})

							if (!reflowAssign.assigned) {
								throw conflict(
									'reflow_failed',
									`Cannot reflow displaced reservation ${other.confirmationCode}`,
								)
							}

							for (const tid of reflowAssign.tableIds) {
								const tbl = state.tableById.get(tid)
								const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
								await tx.insert(rsvTableOccupancies).values({
									id: createId('occ'),
									locationId: current.locationId,
									tableId: tid,
									kind: 'reservation',
									reservationId: other.id,
									startAt: other.startAt,
									endAt: other.endAt + resetMs,
									active: true,
									overbook: false,
									createdAt: now,
								})
							}

							await tx
								.update(rsvReservations)
								.set({
									comboId: reflowAssign.combinationId,
									scheduleVersion: other.scheduleVersion + 1,
									version: other.version + 1,
									updatedAt: now,
								})
								.where(eq(rsvReservations.id, other.id))

							await tx.insert(rsvReservationEvents).values({
								id: createId('rev'),
								reservationId: other.id,
								at: now,
								actorKind: 'operator',
								actorId: params.actorId,
								type: 'auto_reassigned',
								fromStatus: other.status,
								toStatus: other.status,
								data: {
									fromTableIds: otherFromTables,
									toTableIds: reflowAssign.tableIds,
									toCombinationId: reflowAssign.combinationId ?? null,
									reason: 'reflow',
								},
							})

							moves.push({
								reservationId: other.id,
								bookingId: other.id,
								fromTableIds: otherFromTables,
								toTableIds: [...reflowAssign.tableIds],
								toCombinationId: reflowAssign.combinationId,
							})
						}
					}
				}

				for (const tid of nextTableIds) {
					const tbl = state.tableById.get(tid)
					const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
					await tx.insert(rsvTableOccupancies).values({
						id: createId('occ'),
						locationId: current.locationId,
						tableId: tid,
						kind: 'reservation',
						reservationId: current.id,
						startAt: nextStartAt,
						endAt: nextEndAt + resetMs,
						active: true,
						overbook: isOverbook,
						createdAt: now,
					})
				}
			}

			const nextAreaPrefId =
				params.input.diningAreaId !== undefined
					? params.input.diningAreaId
					: params.input.areaPrefId !== undefined
						? params.input.areaPrefId
						: current.areaPrefId
			const nextOccasionRaw =
				params.input.occasion !== undefined
					? params.input.occasion
					: params.input.occasionTagId !== undefined
						? params.input.occasionTagId
						: current.occasionTagId
			const nextOccasion = await resolveOccasionTagId(tx, nextOccasionRaw)
			const nextStaffNotes =
				params.input.internalNotes !== undefined
					? params.input.internalNotes
					: params.input.staffNotes !== undefined
						? params.input.staffNotes
						: current.staffNotes

			const nextAssignment =
				params.input.unlock === true || params.input.assignment === 'soft'
					? 'soft'
					: params.input.lock === true ||
						  params.input.locked === true ||
						  params.input.lockTable === true ||
						  params.input.assignment === 'locked'
						? 'locked'
						: current.assignment

			await tx
				.update(rsvReservations)
				.set({
					businessDate: targetBusinessDate,
					localStartMin: nextLocalStartMin,
					startAt: nextStartAt,
					endAt: nextEndAt,
					durationMin: nextDurationMin,
					partySize: nextPartySize,
					serviceId: nextServiceId,
					comboId: nextComboId,
					assignment: nextAssignment,
					areaPrefId: nextAreaPrefId,
					...(params.input.areaPrefStrict !== undefined
						? { areaPrefStrict: params.input.areaPrefStrict }
						: {}),
					occasionTagId: nextOccasion,
					...(params.input.guestRequests !== undefined
						? { guestRequests: params.input.guestRequests }
						: {}),
					...(params.input.dietaryNotes !== undefined
						? { dietaryNotes: params.input.dietaryNotes }
						: {}),
					staffNotes: nextStaffNotes,
					scheduleVersion: scheduleChanged
						? current.scheduleVersion + 1
						: current.scheduleVersion,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'modified',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					businessDate: targetBusinessDate,
					localStartMin: nextLocalStartMin,
					durationMin: nextDurationMin,
					partySize: nextPartySize,
					tableIds: nextTableIds,
				},
			})

			const guestVisibleChange =
				targetBusinessDate !== current.businessDate ||
				nextLocalStartMin !== current.localStartMin ||
				nextPartySize !== current.partySize
			if (scheduleChanged && guestVisibleChange) {
				await enqueueReservationMessage(
					tx,
					{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
					{ reservationId: current.id, kind: 'modification' },
				)
			}

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return {
				reservation: serialized!,
				moves,
			}
		},
	)
}

const VALID_STATUS_TRANSITIONS: Record<string, Set<string>> = {
	pending_payment: new Set(['booked', 'confirmed', 'cancelled']),
	pending_approval: new Set(['booked', 'confirmed', 'cancelled']),
	booked: new Set(['confirmed', 'arrived', 'seated', 'cancelled', 'no_show']),
	confirmed: new Set(['arrived', 'seated', 'cancelled', 'no_show']),
	arrived: new Set(['seated', 'cancelled', 'no_show']),
	seated: new Set(['finished']),
	finished: new Set([]),
	cancelled: new Set([]),
	no_show: new Set([]),
}

export async function transitionReservationStatus(params: {
	orgId: string
	reservationId: string
	actorId: string
	/** The tick acts as `system` (no operator id on the event). */
	actorKind?: 'operator' | 'system'
	input: {
		status: string
		covers?: number | null
		coversActual?: number | null
		seatedPartySize?: number | null
		seatedCovers?: number | null
		arrivedPartySize?: number | null
		arrivedCovers?: number | null
		cancelReason?: string | null
		reason?: string | null
		tableIds?: string[]
		comboId?: string | null
		overbook?: boolean
		overbookReason?: string | null
		expectedVersion?: number
		nowMs?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx, helpers) => {
			const now = params.input.nowMs ?? Date.now()
			let current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			const targetStatus = params.input.status
			const allowedSet = VALID_STATUS_TRANSITIONS[current.status]
			if (!allowedSet || !allowedSet.has(targetStatus)) {
				throw conflict(
					'invalid_status_transition',
					`Cannot transition reservation from ${current.status} to ${targetStatus}`,
				)
			}

			const requestedTableIds = [...new Set(params.input.tableIds ?? [])]
			if (targetStatus === 'seated' && requestedTableIds.length > 0) {
				const activeOccs = await tx
					.select()
					.from(rsvTableOccupancies)
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, current.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
					.all()
				const activeTableIds = new Set(activeOccs.map((o) => o.tableId))
				const unchanged =
					activeTableIds.size === requestedTableIds.length &&
					requestedTableIds.every((id) => activeTableIds.has(id))
				if (!unchanged) {
					// Re-enters this transaction, so a refused assignment (409) rolls the
					// whole seat transition back.
					await assignReservationTables({
						orgId: params.orgId,
						reservationId: current.id,
						actorId: params.actorId,
						input: {
							tableIds: requestedTableIds,
							comboId: params.input.comboId ?? null,
							overbook: params.input.overbook,
							overbookReason: params.input.overbookReason,
							nowMs: now,
						},
					})
					const reloaded = await tx
						.select()
						.from(rsvReservations)
						.where(eq(rsvReservations.id, current.id))
						.get()
					if (!reloaded) throw notFound('Reservation not found')
					current = reloaded
				}
			}

			const explicitCovers =
				params.input.coversActual ??
				params.input.covers ??
				params.input.seatedPartySize ??
				params.input.seatedCovers ??
				undefined

			const arrivedCovers =
				params.input.arrivedPartySize ??
				params.input.arrivedCovers ??
				(targetStatus === 'arrived'
					? (params.input.covers ?? current.arrivedCovers ?? current.partySize)
					: targetStatus === 'seated'
						? (current.arrivedCovers ?? explicitCovers ?? current.partySize)
						: current.arrivedCovers)
			const seatedCovers =
				explicitCovers ??
				(targetStatus === 'seated'
					? (current.seatedCovers ?? arrivedCovers ?? current.partySize)
					: current.seatedCovers)
			const coversActual =
				params.input.coversActual ??
				(targetStatus === 'seated' || targetStatus === 'finished'
					? (explicitCovers ?? current.coversActual ?? seatedCovers)
					: (current.coversActual ?? explicitCovers ?? null))

			const patch: Partial<typeof rsvReservations.$inferInsert> = {
				status: targetStatus as typeof current.status,
				arrivedCovers,
				seatedCovers,
				coversActual,
				version: current.version + 1,
				updatedAt: now,
			}

			if (targetStatus === 'arrived') {
				patch.arrivedAt = now
			} else if (targetStatus === 'seated') {
				patch.arrivedAt = current.arrivedAt ?? now
				patch.seatedAt = now
			} else if (targetStatus === 'finished') {
				patch.finishedAt = now
				// Release active table occupancies and record actual end timestamp
				const activeOccs = await tx
					.select()
					.from(rsvTableOccupancies)
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, current.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
					.all()
				for (const occ of activeOccs) {
					const shortenedEnd = Math.max(occ.startAt + 1, now)
					await tx
						.update(rsvTableOccupancies)
						.set({
							active: false,
							endAt: shortenedEnd,
						})
						.where(eq(rsvTableOccupancies.id, occ.id))
				}

				if (current.guestId) {
					const coversCount = coversActual ?? seatedCovers ?? current.partySize
					await tx
						.update(rsvGuests)
						.set({
							visits: sql`${rsvGuests.visits} + 1`,
							covers: sql`${rsvGuests.covers} + ${coversCount}`,
							firstVisitAt: sql` COALESCE(${rsvGuests.firstVisitAt}, ${now})`,
							lastVisitAt: now,
							updatedAt: now,
						})
						.where(eq(rsvGuests.id, current.guestId))
				}
			} else if (targetStatus === 'cancelled') {
				patch.cancelledAt = now
				patch.cancelledBy = 'restaurant'
				patch.cancelReason =
					params.input.cancelReason ?? params.input.reason ?? null
				await tx
					.update(rsvTableOccupancies)
					.set({ active: false })
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, current.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
				const late = await isLateCancellation(tx, current, now)
				patch.lateCancel = late
				if (current.guestId) {
					await tx
						.update(rsvGuests)
						.set({
							cancels: sql`${rsvGuests.cancels} + 1`,
							...(late
								? { lateCancels: sql`${rsvGuests.lateCancels} + 1` }
								: {}),
							updatedAt: now,
						})
						.where(eq(rsvGuests.id, current.guestId))
				}
			} else if (targetStatus === 'no_show') {
				patch.noShowAt = now
				await tx
					.update(rsvTableOccupancies)
					.set({ active: false })
					.where(
						and(
							eq(rsvTableOccupancies.reservationId, current.id),
							eq(rsvTableOccupancies.active, true),
						),
					)
				if (current.guestId) {
					await tx
						.update(rsvGuests)
						.set({
							noShows: sql`${rsvGuests.noShows} + 1`,
							updatedAt: now,
						})
						.where(eq(rsvGuests.id, current.guestId))
				}
			}

			await tx
				.update(rsvReservations)
				.set(patch)
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: params.actorKind ?? 'operator',
				actorId: params.actorKind === 'system' ? null : params.actorId,
				type: targetStatus as
					| 'confirmed'
					| 'arrived'
					| 'seated'
					| 'finished'
					| 'cancelled'
					| 'no_show',
				fromStatus: current.status,
				toStatus: targetStatus as typeof current.status,
				data: {
					seatedCovers,
					arrivedCovers,
					cancelReason: params.input.cancelReason ?? null,
					...(params.actorKind === 'system' && params.input.reason
						? { reason: params.input.reason }
						: {}),
				},
			})

			if (targetStatus === 'cancelled') {
				await enqueueReservationMessage(
					tx,
					{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
					{ reservationId: current.id, kind: 'cancellation_restaurant' },
				)
			}

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return { reservation: serialized! }
		},
	)
}

const UNDO_FINISHED_WINDOW_MS = 30 * 60_000

export async function undoReservationTransition(params: {
	orgId: string
	reservationId: string
	actorId: string
	input?: {
		expectedVersion?: number
		nowMs?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = params.input?.nowMs ?? Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input?.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			// Find the latest status-transition event for this reservation
			const events = await tx
				.select()
				.from(rsvReservationEvents)
				.where(eq(rsvReservationEvents.reservationId, current.id))
				.orderBy(desc(rsvReservationEvents.at), desc(rsvReservationEvents.id))
				.all()

			const lastStatusEvent = events.find(
				(e) =>
					e.fromStatus !== null &&
					e.toStatus === current.status &&
					e.fromStatus !== e.toStatus,
			)
			const previousStatus =
				lastStatusEvent?.fromStatus ??
				(current.status === 'finished'
					? 'seated'
					: current.status === 'seated'
						? 'arrived'
						: current.status === 'arrived'
							? 'confirmed'
							: null)

			if (!previousStatus) {
				throw conflict(
					'cannot_undo',
					`No undoable status transition found for status ${current.status}`,
				)
			}

			if (current.status === 'finished') {
				const finishedAt = current.finishedAt ?? lastStatusEvent?.at ?? 0
				if (now - finishedAt > UNDO_FINISHED_WINDOW_MS) {
					throw conflict(
						'undo_window_expired',
						'Cannot undo finished status more than 30 minutes after completion',
					)
				}

				// Re-check table occupancy and reactivate
				const prevOccs = await tx
					.select()
					.from(rsvTableOccupancies)
					.where(eq(rsvTableOccupancies.reservationId, current.id))
					.all()

				const tables = await tx
					.select()
					.from(rsvTables)
					.where(eq(rsvTables.locationId, current.locationId))
					.all()
				const tableById = new Map(tables.map((t) => [t.id, t]))

				for (const occ of prevOccs) {
					const tbl = tableById.get(occ.tableId)
					const resetMs = (tbl?.resetBufferMin ?? 0) * 60_000
					const restoredEndAt = Math.max(
						current.endAt + resetMs,
						now + 15 * 60_000,
					)

					const conflictingOcc = await tx
						.select()
						.from(rsvTableOccupancies)
						.where(
							and(
								eq(rsvTableOccupancies.tableId, occ.tableId),
								eq(rsvTableOccupancies.active, true),
								lte(rsvTableOccupancies.startAt, restoredEndAt - 1),
								gte(rsvTableOccupancies.endAt, current.startAt + 1),
							),
						)
						.get()
					if (conflictingOcc && conflictingOcc.reservationId !== current.id) {
						throw conflict(
							'table_occupied',
							'Cannot undo finished status because the table has been reassigned',
						)
					}

					await tx
						.update(rsvTableOccupancies)
						.set({
							active: true,
							endAt: restoredEndAt,
						})
						.where(eq(rsvTableOccupancies.id, occ.id))
				}

				if (current.guestId) {
					const coversCount =
						current.coversActual ?? current.seatedCovers ?? current.partySize
					await tx
						.update(rsvGuests)
						.set({
							visits: sql`MAX(0, ${rsvGuests.visits} - 1)`,
							covers: sql`MAX(0, ${rsvGuests.covers} - ${coversCount})`,
							updatedAt: now,
						})
						.where(eq(rsvGuests.id, current.guestId))
				}
			} else if (
				current.status === 'cancelled' ||
				current.status === 'no_show'
			) {
				// Reactivate occupancies if still free
				const prevOccs = await tx
					.select()
					.from(rsvTableOccupancies)
					.where(eq(rsvTableOccupancies.reservationId, current.id))
					.all()
				for (const occ of prevOccs) {
					const conflictingOcc = await tx
						.select()
						.from(rsvTableOccupancies)
						.where(
							and(
								eq(rsvTableOccupancies.tableId, occ.tableId),
								eq(rsvTableOccupancies.active, true),
								lte(rsvTableOccupancies.startAt, occ.endAt - 1),
								gte(rsvTableOccupancies.endAt, occ.startAt + 1),
							),
						)
						.get()
					if (conflictingOcc && conflictingOcc.reservationId !== current.id) {
						throw conflict(
							'table_occupied',
							'Cannot undo because the table is now occupied',
						)
					}
					await tx
						.update(rsvTableOccupancies)
						.set({ active: true })
						.where(eq(rsvTableOccupancies.id, occ.id))
				}

				if (current.guestId) {
					if (current.status === 'cancelled') {
						await tx
							.update(rsvGuests)
							.set({
								cancels: sql`MAX(0, ${rsvGuests.cancels} - 1)`,
								...(current.lateCancel
									? { lateCancels: sql`MAX(0, ${rsvGuests.lateCancels} - 1)` }
									: {}),
								updatedAt: now,
							})
							.where(eq(rsvGuests.id, current.guestId))
					} else {
						await tx
							.update(rsvGuests)
							.set({
								noShows: sql`MAX(0, ${rsvGuests.noShows} - 1)`,
								updatedAt: now,
							})
							.where(eq(rsvGuests.id, current.guestId))
					}
				}
			}

			await tx
				.update(rsvReservations)
				.set({
					status: previousStatus,
					...(current.status === 'finished' ? { finishedAt: null } : {}),
					...(current.status === 'seated'
						? { seatedAt: null, courseStatus: null }
						: {}),
					...(current.status === 'arrived' ? { arrivedAt: null } : {}),
					...(current.status === 'cancelled'
						? { cancelledAt: null, cancelReason: null, lateCancel: false }
						: {}),
					...(current.status === 'no_show' ? { noShowAt: null } : {}),
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'status_undo',
				fromStatus: current.status,
				toStatus: previousStatus,
				data: {
					undoneFrom: current.status,
					restoredTo: previousStatus,
				},
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return { reservation: serialized! }
		},
	)
}

const PRE_ARRIVAL_STATUSES = new Set([
	'pending_payment',
	'pending_approval',
	'booked',
	'confirmed',
])

const CONTACT_STATUS_MAP: Record<
	string,
	(typeof RSV_CONTACT_STATUS_VALUES)[number] | null
> = {
	none: null,
	not_contacted: 'not_contacted',
	left_message: 'left_message',
	no_answer: 'no_answer',
	confirmed_by_phone: 'confirmed_by_phone',
	confirmed_phone: 'confirmed_phone',
	confirmed_sms: 'confirmed_sms',
	wrong_number: 'wrong_number',
}

export async function updateReservationContactStatus(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		contactStatus: string
		expectedVersion?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			if (!PRE_ARRIVAL_STATUSES.has(current.status)) {
				throw conflict(
					'invalid_state_for_contact_status',
					'Contact status can only be updated before arrival',
				)
			}

			const locSettings = await tx
				.select()
				.from(rsvLocationSettings)
				.where(eq(rsvLocationSettings.locationId, current.locationId))
				.get()
			if (locSettings && !locSettings.contactStatusesEnabled) {
				throw conflict(
					'contact_statuses_disabled',
					'Contact statuses are disabled for this location',
				)
			}

			const dbContactStatus =
				params.input.contactStatus in CONTACT_STATUS_MAP
					? CONTACT_STATUS_MAP[params.input.contactStatus]!
					: 'left_message'

			await tx
				.update(rsvReservations)
				.set({
					contactStatus: dbContactStatus,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'contact_status',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					contactStatus: params.input.contactStatus,
					dbContactStatus,
				},
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			// Preserve caller's contactStatus alias if e.g. 'confirmed_by_phone'
			serialized!.contactStatus = params.input.contactStatus
			serialized!.contact_status = params.input.contactStatus
			return { reservation: serialized! }
		},
	)
}

const RESENDABLE_STATUSES = new Set(['booked', 'confirmed'])

/**
 * Operator "resend confirmation". With `rotate`, the manage link version is
 * bumped first, so the link in every earlier email stops working and the new
 * message carries a fresh one.
 */
export async function resendReservationConfirmation(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: { rotate?: boolean }
}): Promise<{
	queued: number
	rotated: boolean
	reservation: SerializedBookReservation
}> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx, helpers) => {
			const now = Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')
			if (!RESENDABLE_STATUSES.has(current.status)) {
				throw conflict(
					'invalid_state_for_resend',
					'Only an upcoming booking can be re-sent',
				)
			}

			const rotate = params.input.rotate === true
			if (rotate) {
				await tx
					.update(rsvReservations)
					.set({
						manageTokenVersion: current.manageTokenVersion + 1,
						version: current.version + 1,
						updatedAt: now,
					})
					.where(eq(rsvReservations.id, current.id))
			}

			const ids = await enqueueReservationMessage(
				tx,
				{ orgId: params.orgId, now, afterCommit: helpers.afterCommit },
				{
					reservationId: current.id,
					kind: 'confirmation',
					variant: `r${now}-${randomUUID().slice(0, 8)}`,
					force: true,
				},
			)
			if (ids.length === 0) {
				throw conflict('no_destination', 'The guest has no contact to send to')
			}

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'confirmation_resent',
				fromStatus: current.status,
				toStatus: current.status,
				data: { rotated: rotate, messages: ids.length },
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return { queued: ids.length, rotated: rotate, reservation: serialized! }
		},
	)
}

export async function updateReservationRunningLate(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		runningLateMin?: number | null
		runningLateMinutes?: number | null
		minutes?: number | null
		runningLateNote?: string | null
		note?: string | null
		expectedVersion?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			if (!PRE_ARRIVAL_STATUSES.has(current.status)) {
				throw conflict(
					'invalid_state_for_running_late',
					'Running late can only be updated before arrival',
				)
			}

			const noteText = params.input.runningLateNote ?? params.input.note ?? null
			let lateMin =
				params.input.runningLateMin ??
				params.input.runningLateMinutes ??
				params.input.minutes ??
				null
			if (lateMin === null && noteText) {
				const m = /(\d+)\s*m/i.exec(noteText)
				lateMin = m ? Number.parseInt(m[1]!, 10) : 15
			}

			await tx
				.update(rsvReservations)
				.set({
					runningLateMin: lateMin,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'running_late',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					runningLateMin: lateMin,
					runningLateNote: noteText,
				},
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return { reservation: serialized! }
		},
	)
}

const COURSE_STATUS_MAP: Record<
	string,
	(typeof RSV_COURSE_STATUS_VALUES)[number]
> = {
	ordered: 'ordered',
	appetizer: 'appetizer',
	apps: 'apps',
	starters: 'starters',
	entree: 'entree',
	mains: 'mains',
	dessert: 'dessert',
	check_dropped: 'check_dropped',
	check: 'check',
	paid: 'paid',
	bussing: 'bussing',
}

export async function updateReservationCourseStatus(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		courseStatus: string | null
		expectedVersion?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			if (current.status !== 'seated') {
				throw conflict(
					'invalid_state_for_course_status',
					'Course status can only be updated while the party is seated',
				)
			}

			const locSettings = await tx
				.select()
				.from(rsvLocationSettings)
				.where(eq(rsvLocationSettings.locationId, current.locationId))
				.get()
			if (locSettings && !locSettings.courseStatusesEnabled) {
				throw conflict(
					'course_statuses_disabled',
					'Course statuses are disabled for this location',
				)
			}

			const rawCourse = params.input.courseStatus
			const dbCourseStatus = rawCourse
				? (COURSE_STATUS_MAP[rawCourse] ?? 'entree')
				: null

			await tx
				.update(rsvReservations)
				.set({
					courseStatus: dbCourseStatus,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'course',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					courseStatus: rawCourse,
					dbCourseStatus,
				},
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			if (rawCourse) {
				serialized!.courseStatus = rawCourse
				serialized!.course_status = rawCourse
			}
			return { reservation: serialized! }
		},
	)
}

export async function updateReservationNotes(params: {
	orgId: string
	reservationId: string
	actorId: string
	input: {
		internalNotes?: string | null
		staffNotes?: string | null
		dietaryNotes?: string | null
		guestRequests?: string | null
		expectedVersion?: number
	}
}): Promise<{ reservation: SerializedBookReservation }> {
	const db = await getTenantDb(params.orgId)
	const existing = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!existing) throw notFound('Reservation not found')

	return withReservationWrite<{
		reservation: SerializedBookReservation
	}>(
		{
			orgId: params.orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
		},
		async (tx) => {
			const now = Date.now()
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, params.reservationId))
				.get()
			if (!current) throw notFound('Reservation not found')

			if (
				params.input.expectedVersion !== undefined &&
				current.version !== params.input.expectedVersion
			) {
				throw conflict(
					'stale_version',
					`Expected version ${params.input.expectedVersion}, found ${current.version}`,
				)
			}

			const nextStaffNotes =
				params.input.internalNotes !== undefined
					? params.input.internalNotes
					: params.input.staffNotes !== undefined
						? params.input.staffNotes
						: current.staffNotes

			await tx
				.update(rsvReservations)
				.set({
					staffNotes: nextStaffNotes,
					...(params.input.dietaryNotes !== undefined
						? { dietaryNotes: params.input.dietaryNotes }
						: {}),
					...(params.input.guestRequests !== undefined
						? { guestRequests: params.input.guestRequests }
						: {}),
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))

			await tx.insert(rsvReservationEvents).values({
				id: createId('rev'),
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'note',
				fromStatus: current.status,
				toStatus: current.status,
				data: {
					staffNotes: nextStaffNotes,
					dietaryNotes:
						params.input.dietaryNotes !== undefined
							? params.input.dietaryNotes
							: current.dietaryNotes,
				},
			})

			const updatedRow = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, current.id))
				.get()
			const [serialized] = await serializeReservationsForBook(tx, [updatedRow!])
			return { reservation: serialized! }
		},
	)
}

export { getOperatorAvailability }
