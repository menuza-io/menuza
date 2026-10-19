import { randomUUID } from 'node:crypto'
import { quoteWaitlistMin, type ReservationsContext } from '@repo/reservations'
import {
	getTenantDb,
	rsvAreas,
	rsvLocationSettings,
	rsvTurnTimes,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import {
	parseWaitlistTokenId,
	verifyWaitlistToken,
} from '../lib/reservations-public-auth.ts'
import {
	hashIdempotencyPayload,
	withReservationWrite,
} from '../lib/reservations-write.ts'
import {
	createWalkIn,
	loadLocationSchedulingState,
} from './rsv-booking-service.ts'
import { getLocationBusinessDate } from './rsv-business-date.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import { type ReservationMoveReport } from './rsv-booking-service.ts'
import { enqueueWaitlistMessage } from './rsv-message-queue.ts'
import { enqueueManagerAlert } from './rsv-outbox.ts'
import {
	waitlistOccupiedHandler,
	type WaitlistSeatResolution,
} from './rsv-waitlist-seat-resolution.ts'
import { normalizePublicPhone } from './rsv-public-booking-service.ts'

export type WaitlistEntryRow = typeof rsvWaitlistEntries.$inferSelect
export type WaitlistStatus = WaitlistEntryRow['status']

export const ACTIVE_WAITLIST_STATUSES = [
	'waiting',
	'notified',
	'on_the_way',
] as const satisfies readonly WaitlistStatus[]

const ACTIVE = new Set<string>(ACTIVE_WAITLIST_STATUSES)

export function isActiveWaitlistStatus(status: string): boolean {
	return ACTIVE.has(status)
}

const TRANSITIONS: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
	waiting: ['cancelled', 'left', 'no_response', 'on_the_way'],
	notified: ['cancelled', 'left', 'no_response', 'on_the_way', 'waiting'],
	on_the_way: ['cancelled', 'left', 'no_response', 'waiting'],
	// A host may bring back a party that answered late.
	no_response: ['waiting'],
	seated: [],
	cancelled: [],
	left: [],
}

const MINUTE = 60_000
const DEFAULT_TURN_MIN = 90

function invalidTransition(from: string, to: string) {
	return conflict(
		'invalid_status_transition',
		`Cannot move a waitlist entry from ${from} to ${to}`,
	)
}

function staleVersion(expected: number, found: number) {
	return conflict(
		'stale_version',
		`Expected version ${expected}, found ${found}`,
	)
}

const bump = () => sql`${rsvWaitlistEntries.version} + 1`

// ---------------------------------------------------------------------------
// Ordering, position and serialization
// ---------------------------------------------------------------------------

function compareEntries(a: WaitlistEntryRow, b: WaitlistEntryRow): number {
	return (
		a.sortKey - b.sortKey ||
		a.createdAt - b.createdAt ||
		a.id.localeCompare(b.id)
	)
}

export function orderEntries(rows: readonly WaitlistEntryRow[]) {
	const sorted = [...rows].sort(compareEntries)
	return [
		...sorted.filter((r) => ACTIVE.has(r.status)),
		...sorted.filter((r) => !ACTIVE.has(r.status)),
	]
}

async function loadDayEntries(
	db: DbOrTx,
	locationId: string,
	businessDate: string,
) {
	return db
		.select()
		.from(rsvWaitlistEntries)
		.where(
			and(
				eq(rsvWaitlistEntries.locationId, locationId),
				eq(rsvWaitlistEntries.businessDate, businessDate),
			),
		)
		.all()
}

function activeSorted(rows: readonly WaitlistEntryRow[]) {
	return rows.filter((r) => ACTIVE.has(r.status)).sort(compareEntries)
}

export function serializeWaitlistEntry(
	row: WaitlistEntryRow,
	options: { position: number | null; canReadGuestSensitive?: boolean },
) {
	const notes = options.canReadGuestSensitive === false ? null : row.notes
	const nameParts = row.displayName.split(' ')
	return {
		id: row.id,
		locationId: row.locationId,
		location_id: row.locationId,
		businessDate: row.businessDate,
		business_date: row.businessDate,
		guestId: row.guestId,
		guest_id: row.guestId,
		displayName: row.displayName,
		display_name: row.displayName,
		firstName: nameParts[0] ?? row.displayName,
		lastName: nameParts.slice(1).join(' '),
		phone: row.phoneE164,
		phoneE164: row.phoneE164,
		phone_e164: row.phoneE164,
		email: row.emailNorm,
		emailNorm: row.emailNorm,
		email_norm: row.emailNorm,
		partySize: row.partySize,
		party_size: row.partySize,
		areaPrefId: row.areaPrefId,
		area_pref_id: row.areaPrefId,
		channel: row.channel,
		status: row.status,
		quotedMin: row.quotedMin,
		quotedWaitMin: row.quotedMin,
		quoted_min: row.quotedMin,
		quotedReadyAt: row.quotedReadyAt,
		quoted_ready_at: row.quotedReadyAt,
		notifiedAt: row.notifiedAt,
		notified_at: row.notifiedAt,
		responseDeadlineAt: row.responseDeadlineAt,
		response_deadline_at: row.responseDeadlineAt,
		reservationId: row.reservationId,
		reservation_id: row.reservationId,
		sortKey: row.sortKey,
		sort_key: row.sortKey,
		notes,
		smsOptIn: row.smsOptIn,
		sms_opt_in: row.smsOptIn,
		locale: row.locale,
		version: row.version,
		joinedAt: row.joinedAt,
		joined_at: row.joinedAt,
		createdAt: row.createdAt,
		created_at: row.createdAt,
		position: options.position,
	}
}

export type SerializedWaitlistEntry = ReturnType<typeof serializeWaitlistEntry>

function serializeDay(
	rows: readonly WaitlistEntryRow[],
	canReadGuestSensitive: boolean,
) {
	const ordered = orderEntries(rows)
	let position = 0
	return ordered.map((row) =>
		serializeWaitlistEntry(row, {
			position: ACTIVE.has(row.status) ? ++position : null,
			canReadGuestSensitive,
		}),
	)
}

export async function listWaitlistEntries(
	db: DbOrTx,
	input: {
		locationId: string
		businessDate: string
		canReadGuestSensitive: boolean
		now?: number
	},
) {
	const rows = await loadDayEntries(db, input.locationId, input.businessDate)
	const settings = await db
		.select({ waitlistResponseMin: rsvLocationSettings.waitlistResponseMin })
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, input.locationId))
		.get()
	const count = (status: WaitlistStatus) =>
		rows.filter((r) => r.status === status).length
	return {
		locationId: input.locationId,
		businessDate: input.businessDate,
		date: input.businessDate,
		now: input.now ?? Date.now(),
		waitlistResponseMin: settings?.waitlistResponseMin ?? 10,
		counts: {
			active: rows.filter((r) => ACTIVE.has(r.status)).length,
			waiting: count('waiting'),
			notified: count('notified'),
			onTheWay: count('on_the_way'),
		},
		entries: serializeDay(rows, input.canReadGuestSensitive),
	}
}

/** One entry as the operator sees it, with its place among the active entries of its day. */
export async function getSerializedEntry(
	db: DbOrTx,
	entryId: string,
	canReadGuestSensitive = true,
): Promise<SerializedWaitlistEntry> {
	const row = await db
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.id, entryId))
		.get()
	if (!row) throw notFound()
	const rows = await loadDayEntries(db, row.locationId, row.businessDate)
	const found = serializeDay(rows, canReadGuestSensitive).find(
		(e) => e.id === entryId,
	)
	if (!found) throw notFound()
	return found
}

export async function loadWaitlistEntry(
	orgId: string,
	entryId: string,
): Promise<WaitlistEntryRow> {
	const db = await getTenantDb(orgId)
	const row = await db
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.id, entryId))
		.get()
	if (!row) throw notFound()
	return row
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

function turnMinFor(
	turnTimes: ReadonlyArray<typeof rsvTurnTimes.$inferSelect>,
	partySize: number,
): number {
	const match = turnTimes.find(
		(t) =>
			t.serviceId === null &&
			t.partyMin <= partySize &&
			t.partyMax >= partySize,
	)
	return match?.minutes ?? DEFAULT_TURN_MIN
}

export type WaitlistQuote = {
	quotedMin: number | null
	quotedReadyAt: number | null
	positionInLine: number
}

/**
 * The single quote implementation: entry creation, the standalone quote route
 * and the guest status page all go through it, so they cannot drift apart.
 * A table that is free right now still quotes one minute: zero would read as
 * "seat them now" and the party is on a waitlist.
 */
export async function computeWaitlistQuote(
	db: DbOrTx,
	input: {
		locationId: string
		businessDate: string
		partySize: number
		areaId?: string | null
		now: number
		ahead: readonly WaitlistEntryRow[]
	},
): Promise<WaitlistQuote> {
	const state = await loadLocationSchedulingState(
		db,
		input.locationId,
		input.businessDate,
	)
	const result = quoteWaitlistMin({
		partySize: input.partySize,
		nowMs: input.now,
		tables: state.engineTables,
		areas: state.engineAreas,
		combinations: state.engineCombos,
		occupancies: state.activeOccRows
			.filter((o) => o.endAt > input.now)
			.map((o) => ({
				id: o.id,
				tableIds: [o.tableId],
				startAt: o.startAt,
				endAt: o.endAt,
			})),
		// The estimator sorts by createdAt; the index carries the queue order.
		entriesAhead: input.ahead.map((entry, index) => ({
			id: entry.id,
			partySize: entry.partySize,
			status: entry.status === 'notified' ? 'notified' : 'waiting',
			createdAt: index,
			turnMin: turnMinFor(state.turnTimes, entry.partySize),
			areaId: entry.areaPrefId,
		})),
		defaultTurnMin: turnMinFor(state.turnTimes, input.partySize),
		areaId: input.areaId ?? null,
	})
	const quotedMin =
		result.quotedWaitMin === null ? null : Math.max(1, result.quotedWaitMin)
	return {
		quotedMin,
		quotedReadyAt: quotedMin === null ? null : input.now + quotedMin * MINUTE,
		positionInLine: result.positionInLine,
	}
}

export async function getOperatorWaitlistQuote(
	db: TenantDatabase,
	input: {
		locationId: string
		partySize: number
		areaId?: string | null
		now?: number
	},
) {
	const now = input.now ?? Date.now()
	const businessDate = await getLocationBusinessDate(db, input.locationId, now)
	await assertAreaInLocation(db, input.locationId, input.areaId ?? null)
	const rows = await loadDayEntries(db, input.locationId, businessDate)
	const quote = await computeWaitlistQuote(db, {
		locationId: input.locationId,
		businessDate,
		partySize: input.partySize,
		areaId: input.areaId ?? null,
		now,
		ahead: activeSorted(rows),
	})
	return {
		locationId: input.locationId,
		businessDate,
		partySize: input.partySize,
		quotedMin: quote.quotedMin,
		quotedWaitMin: quote.quotedMin,
		quoted_min: quote.quotedMin,
		quotedReadyAt: quote.quotedReadyAt,
		quoted_ready_at: quote.quotedReadyAt,
		position: quote.positionInLine,
		now,
	}
}

async function assertAreaInLocation(
	db: DbOrTx,
	locationId: string,
	areaId: string | null,
) {
	if (!areaId) return
	const area = await db
		.select({ id: rsvAreas.id })
		.from(rsvAreas)
		.where(
			and(
				eq(rsvAreas.id, areaId),
				eq(rsvAreas.locationId, locationId),
				sql`${rsvAreas.archivedAt} IS NULL`,
			),
		)
		.get()
	if (!area) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'areaPrefId', code: 'invalid' }],
		})
	}
}

// ---------------------------------------------------------------------------
// Create (operator walk-in and remote join share one path)
// ---------------------------------------------------------------------------

export type WaitlistGuestInput = {
	displayName: string
	partySize: number
	phone?: string | null
	email?: string | null
	smsOptIn?: boolean
	areaPrefId?: string | null
	notes?: string | null
	locale?: string
}

function cleanContact(input: { phone?: string | null; email?: string | null }) {
	const rawPhone = input.phone?.trim() || null
	const phone = rawPhone ? normalizePublicPhone(rawPhone) : null
	if (rawPhone && !phone) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'phone', code: 'invalid' }],
		})
	}
	const email = input.email?.trim().toLowerCase() || null
	return { phone, email }
}

async function findActiveByPhone(
	tx: DbOrTx,
	locationId: string,
	businessDate: string,
	phone: string,
	exceptId?: string,
) {
	return tx
		.select({ id: rsvWaitlistEntries.id })
		.from(rsvWaitlistEntries)
		.where(
			and(
				eq(rsvWaitlistEntries.locationId, locationId),
				eq(rsvWaitlistEntries.businessDate, businessDate),
				eq(rsvWaitlistEntries.phoneE164, phone),
				inArray(rsvWaitlistEntries.status, [...ACTIVE_WAITLIST_STATUSES]),
				...(exceptId ? [ne(rsvWaitlistEntries.id, exceptId)] : []),
			),
		)
		.get()
}

export async function createWaitlistEntry(params: {
	orgId: string
	locationId: string
	idempotencyKey: string
	channel: 'walk_in' | 'remote'
	input: WaitlistGuestInput
	ipHash?: string | null
	/** Code answered when this phone is already waiting today. */
	duplicateCode: string
	/** Remote joins honour `waitlist_max_parties` and alert the managers. */
	remote?: boolean
}): Promise<{ entryId: string }> {
	const contact = cleanContact(params.input)
	const db = await getTenantDb(params.orgId)
	const now = Date.now()
	const businessDate = await getLocationBusinessDate(db, params.locationId, now)
	const scope = params.remote ? 'waitlist_join' : 'waitlist_add'
	return withReservationWrite<{ entryId: string }>(
		{
			orgId: params.orgId,
			locationId: params.locationId,
			dates: businessDate,
			now,
			scope,
			idempotencyKey: params.idempotencyKey,
			requestHash: hashIdempotencyPayload({
				locationId: params.locationId,
				channel: params.channel,
				...params.input,
				phone: contact.phone,
				email: contact.email,
			}),
		},
		async (tx, helpers) => {
			await assertAreaInLocation(
				tx,
				params.locationId,
				params.input.areaPrefId ?? null,
			)
			if (contact.phone) {
				const duplicate = await findActiveByPhone(
					tx,
					params.locationId,
					businessDate,
					contact.phone,
				)
				if (duplicate) throw conflict(params.duplicateCode)
			}

			const dayRows = await loadDayEntries(tx, params.locationId, businessDate)
			if (params.remote) {
				const settings = await tx
					.select({ max: rsvLocationSettings.waitlistMaxParties })
					.from(rsvLocationSettings)
					.where(eq(rsvLocationSettings.locationId, params.locationId))
					.get()
				if (
					settings?.max !== null &&
					settings?.max !== undefined &&
					activeSorted(dayRows).length >= settings.max
				) {
					throw conflict('waitlist_full')
				}
			}

			const quote = await computeWaitlistQuote(tx, {
				locationId: params.locationId,
				businessDate,
				partySize: params.input.partySize,
				areaId: params.input.areaPrefId ?? null,
				now: helpers.now,
				ahead: activeSorted(dayRows),
			})

			const entryId = `wle_${randomUUID()}`
			const sortKey =
				dayRows.reduce((max, r) => Math.max(max, r.sortKey), 0) + 1
			await tx.insert(rsvWaitlistEntries).values({
				id: entryId,
				locationId: params.locationId,
				businessDate,
				displayName: params.input.displayName.trim(),
				phoneE164: contact.phone,
				emailNorm: contact.email,
				partySize: params.input.partySize,
				areaPrefId: params.input.areaPrefId ?? null,
				channel: params.channel,
				joinedAt: helpers.now,
				quotedMin: quote.quotedMin,
				quotedReadyAt: quote.quotedReadyAt,
				status: 'waiting',
				sortKey,
				notes: params.input.notes?.trim() || null,
				smsOptIn: Boolean(params.input.smsOptIn && contact.phone),
				locale: params.input.locale ?? '',
				ipHash: params.ipHash ?? null,
				createdAt: helpers.now,
			})

			const queueCtx = {
				orgId: params.orgId,
				now: helpers.now,
				afterCommit: helpers.afterCommit,
			}
			await enqueueWaitlistMessage(tx, queueCtx, {
				entryId,
				kind: 'waitlist_joined',
			})
			if (params.remote) {
				await enqueueManagerAlert(tx, {
					orgId: params.orgId,
					kind: 'waitlist_remote_join',
					locationId: params.locationId,
					dedupeKey: `waitlist_remote_join:${entryId}`,
					now: helpers.now,
				})
			}
			return { entryId }
		},
	)
}

// ---------------------------------------------------------------------------
// Operator mutations
// ---------------------------------------------------------------------------

type Authorize = (locationId: string) => void

/** Loads the entry, runs the caller's location check, and hands back the row. */
export async function loadAuthorizedEntry(
	orgId: string,
	entryId: string,
	authorize: Authorize,
) {
	const row = await loadWaitlistEntry(orgId, entryId)
	authorize(row.locationId)
	return row
}

export async function updateWaitlistEntry(params: {
	orgId: string
	entry: WaitlistEntryRow
	input: {
		expectedVersion?: number
		partySize?: number
		notes?: string | null
		displayName?: string
		phone?: string | null
		email?: string | null
		smsOptIn?: boolean
		areaPrefId?: string | null
	}
}) {
	const { entry, input } = params
	const contact = cleanContact({
		phone: input.phone === undefined ? undefined : input.phone,
		email: input.email === undefined ? undefined : input.email,
	})
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: entry.locationId,
			dates: entry.businessDate,
		},
		async (tx, helpers) => {
			const current = await tx
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, entry.id))
				.get()
			if (!current) throw notFound()
			if (
				input.expectedVersion !== undefined &&
				input.expectedVersion !== current.version
			) {
				throw staleVersion(input.expectedVersion, current.version)
			}
			if (!ACTIVE.has(current.status)) {
				throw invalidTransition(current.status, current.status)
			}

			const nextArea =
				input.areaPrefId === undefined ? current.areaPrefId : input.areaPrefId
			if (input.areaPrefId !== undefined) {
				await assertAreaInLocation(tx, current.locationId, input.areaPrefId)
			}
			const nextPhone =
				input.phone === undefined ? current.phoneE164 : contact.phone
			if (input.phone !== undefined && nextPhone) {
				const duplicate = await findActiveByPhone(
					tx,
					current.locationId,
					current.businessDate,
					nextPhone,
					current.id,
				)
				if (duplicate) throw conflict('duplicate_active_entry')
			}

			const nextParty = input.partySize ?? current.partySize
			const requote =
				nextParty !== current.partySize || nextArea !== current.areaPrefId
			let quoteSet: { quotedMin: number | null; quotedReadyAt: number | null } =
				{
					quotedMin: current.quotedMin,
					quotedReadyAt: current.quotedReadyAt,
				}
			if (requote && current.status !== 'notified') {
				const dayRows = await loadDayEntries(
					tx,
					current.locationId,
					current.businessDate,
				)
				const ordered = activeSorted(dayRows)
				const index = ordered.findIndex((r) => r.id === current.id)
				quoteSet = await computeWaitlistQuote(tx, {
					locationId: current.locationId,
					businessDate: current.businessDate,
					partySize: nextParty,
					areaId: nextArea,
					now: helpers.now,
					ahead: index < 0 ? ordered : ordered.slice(0, index),
				})
			}

			await tx
				.update(rsvWaitlistEntries)
				.set({
					partySize: nextParty,
					areaPrefId: nextArea,
					displayName:
						input.displayName !== undefined
							? input.displayName.trim()
							: current.displayName,
					notes:
						input.notes !== undefined
							? input.notes?.trim() || null
							: current.notes,
					phoneE164: nextPhone,
					emailNorm:
						input.email === undefined ? current.emailNorm : contact.email,
					smsOptIn: Boolean((input.smsOptIn ?? current.smsOptIn) && nextPhone),
					quotedMin: quoteSet.quotedMin,
					quotedReadyAt: quoteSet.quotedReadyAt,
					version: bump(),
				})
				.where(eq(rsvWaitlistEntries.id, current.id))
			return { entryId: current.id }
		},
	)
}

export async function notifyWaitlistEntry(params: {
	orgId: string
	entry: WaitlistEntryRow
	expectedVersion?: number
}) {
	const { entry } = params
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: entry.locationId,
			dates: entry.businessDate,
		},
		async (tx, helpers) => {
			const current = await tx
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, entry.id))
				.get()
			if (!current) throw notFound()
			if (
				params.expectedVersion !== undefined &&
				params.expectedVersion !== current.version
			) {
				throw staleVersion(params.expectedVersion, current.version)
			}
			// Repeating Notify must not restart the clock or send a second message.
			if (current.status === 'notified') {
				return { entryId: current.id, changed: false }
			}
			if (current.status !== 'waiting' && current.status !== 'on_the_way') {
				throw invalidTransition(current.status, 'notified')
			}
			const settings = await tx
				.select({ min: rsvLocationSettings.waitlistResponseMin })
				.from(rsvLocationSettings)
				.where(eq(rsvLocationSettings.locationId, current.locationId))
				.get()
			const responseMin = settings?.min ?? 10
			await tx
				.update(rsvWaitlistEntries)
				.set({
					status: 'notified',
					notifiedAt: helpers.now,
					responseDeadlineAt: helpers.now + responseMin * MINUTE,
					version: bump(),
				})
				.where(eq(rsvWaitlistEntries.id, current.id))
			// The version before this bump names the transition, so a party that is
			// revived and notified again is told again.
			await enqueueWaitlistMessage(
				tx,
				{
					orgId: params.orgId,
					now: helpers.now,
					afterCommit: helpers.afterCommit,
				},
				{
					entryId: current.id,
					kind: 'waitlist_ready',
					milestone: `v${current.version}`,
				},
			)
			return { entryId: current.id, changed: true }
		},
	)
}

export async function setWaitlistEntryStatus(params: {
	orgId: string
	entry: WaitlistEntryRow
	status: 'cancelled' | 'left' | 'no_response' | 'waiting' | 'on_the_way'
	expectedVersion?: number
}) {
	const { entry } = params
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: entry.locationId,
			dates: entry.businessDate,
		},
		async (tx) => {
			const current = await tx
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, entry.id))
				.get()
			if (!current) throw notFound()
			if (
				params.expectedVersion !== undefined &&
				params.expectedVersion !== current.version
			) {
				throw staleVersion(params.expectedVersion, current.version)
			}
			if (current.status === params.status) {
				return { entryId: current.id, changed: false }
			}
			if (!TRANSITIONS[current.status].includes(params.status)) {
				throw invalidTransition(current.status, params.status)
			}
			await tx
				.update(rsvWaitlistEntries)
				.set({
					status: params.status,
					...(params.status === 'waiting'
						? { notifiedAt: null, responseDeadlineAt: null }
						: {}),
					version: bump(),
				})
				.where(eq(rsvWaitlistEntries.id, current.id))
			return { entryId: current.id, changed: true }
		},
	)
}

export async function reorderWaitlist(params: {
	orgId: string
	locationId: string
	businessDate: string
	ids: readonly string[]
}) {
	if (new Set(params.ids).size !== params.ids.length) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'ids', code: 'duplicate' }],
		})
	}
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: params.locationId,
			dates: params.businessDate,
		},
		async (tx) => {
			const rows = await loadDayEntries(
				tx,
				params.locationId,
				params.businessDate,
			)
			const byId = new Map(rows.map((r) => [r.id, r]))
			for (const id of params.ids) {
				if (!byId.has(id)) throw notFound()
			}
			// The listed entries trade places among themselves; everyone else keeps
			// their position in the line.
			const ordered = [...rows].sort(compareEntries)
			const slots = ordered
				.map((row, index) => (params.ids.includes(row.id) ? index : -1))
				.filter((index) => index >= 0)
			const next = [...ordered]
			slots.forEach((slot, i) => {
				next[slot] = byId.get(params.ids[i]!)!
			})
			for (const [index, row] of next.entries()) {
				const sortKey = index + 1
				if (row.sortKey === sortKey) continue
				await tx
					.update(rsvWaitlistEntries)
					.set({ sortKey, version: bump() })
					.where(eq(rsvWaitlistEntries.id, row.id))
			}
			return {
				locationId: params.locationId,
				businessDate: params.businessDate,
			}
		},
	)
}

export async function seatWaitlistEntry(params: {
	orgId: string
	actorId: string
	entry: WaitlistEntryRow
	idempotencyKey?: string | null
	input: {
		tableIds?: string[]
		partySize?: number
		expectedVersion?: number
		overbook?: boolean
		overbookReason?: string | null
		/** What to do when the table is taken; without one the seat is refused. */
		resolution?: WaitlistSeatResolution
		/** With `move`: the table the occupant goes to (default: the best free one). */
		moveToTableIds?: string[]
	}
	canReadGuest?: boolean
}) {
	const { entry, input } = params
	if (!ACTIVE.has(entry.status)) {
		throw invalidTransition(entry.status, 'seated')
	}
	if (
		input.expectedVersion !== undefined &&
		input.expectedVersion !== entry.version
	) {
		throw staleVersion(input.expectedVersion, entry.version)
	}
	const partySize = input.partySize ?? entry.partySize
	const nameParts = entry.displayName.trim().split(/\s+/)
	const overbook = input.overbook || input.resolution === 'overbook'
	const overbookReason =
		input.overbookReason?.trim() ||
		(input.resolution === 'overbook' ? 'Waitlist overbook' : null)
	const occupantMoves: ReservationMoveReport[] = []
	const created = await createWalkIn({
		orgId: params.orgId,
		locationId: entry.locationId,
		actorId: params.actorId,
		idempotencyKey: params.idempotencyKey
			? `wl-seat:${params.idempotencyKey}`
			: `wl-seat:${entry.id}:${entry.version}`,
		channel: 'waitlist',
		onOccupied: waitlistOccupiedHandler({
			orgId: params.orgId,
			actorId: params.actorId,
			resolution:
				input.resolution === 'overbook' ? undefined : input.resolution,
			moveToTableIds: input.moveToTableIds,
			canReadGuest: params.canReadGuest ?? false,
			moves: occupantMoves,
		}),
		input: {
			locationId: entry.locationId,
			partySize,
			tableIds: input.tableIds,
			overbook,
			overbookReason,
			staffNotes: entry.notes,
			guest: {
				firstName: nameParts[0] || entry.displayName,
				lastName: nameParts.slice(1).join(' '),
				phone: entry.phoneE164,
				email: entry.emailNorm,
			},
		},
		afterCreate: async (tx, result) => {
			// Runs in the walk-in's own transaction: either the party is seated and
			// the entry says so, or neither happened.
			const current = await tx
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, entry.id))
				.get()
			if (!current) throw notFound()
			if (!ACTIVE.has(current.status)) {
				throw invalidTransition(current.status, 'seated')
			}
			if (current.version !== entry.version) {
				throw staleVersion(entry.version, current.version)
			}
			await tx
				.update(rsvWaitlistEntries)
				.set({
					status: 'seated',
					reservationId: result.reservationId,
					guestId: result.guestId,
					partySize,
					version: bump(),
				})
				.where(eq(rsvWaitlistEntries.id, entry.id))
		},
	})
	return { ...created, moves: [...created.moves, ...occupantMoves] }
}

// ---------------------------------------------------------------------------
// Guest status page (capability token)
// ---------------------------------------------------------------------------

/** Resolves a status token to its entry; every failure is the same `null`. */
export async function findWaitlistEntryByToken(
	orgId: string,
	token: string | null,
): Promise<WaitlistEntryRow | null> {
	const id = parseWaitlistTokenId(token)
	if (!token || !id) return null
	const db = await getTenantDb(orgId)
	const row = await db
		.select()
		.from(rsvWaitlistEntries)
		.where(eq(rsvWaitlistEntries.id, id))
		.get()
	if (!row) return null
	return verifyWaitlistToken(orgId, row.id, row.statusTokenVersion, token)
		? row
		: null
}

const iso = (ms: number | null) =>
	ms === null ? null : new Date(ms).toISOString()

/** What the guest may see: no phone, no email, no one else's details. */
export async function buildPublicWaitlistStatus(
	db: DbOrTx,
	context: ReservationsContext,
	entry: WaitlistEntryRow,
	now: number,
) {
	const rows = await loadDayEntries(db, entry.locationId, entry.businessDate)
	const active = activeSorted(rows)
	const index = active.findIndex((r) => r.id === entry.id)
	let quotedMin: number | null = null
	let quotedReadyAt: number | null = null
	if (entry.status === 'waiting' || entry.status === 'on_the_way') {
		// Parties ahead seat and leave, so the number is recomputed on every read.
		const quote = await computeWaitlistQuote(db, {
			locationId: entry.locationId,
			businessDate: entry.businessDate,
			partySize: entry.partySize,
			areaId: entry.areaPrefId,
			now,
			ahead: index < 0 ? active : active.slice(0, index),
		})
		quotedMin = quote.quotedMin
		quotedReadyAt = quote.quotedReadyAt
	} else if (entry.status === 'notified') {
		quotedMin = entry.quotedMin
		quotedReadyAt = entry.quotedReadyAt
	}
	const location = context.locations.find((l) => l.id === entry.locationId)
	return {
		status: entry.status,
		position: index >= 0 ? index + 1 : null,
		partySize: entry.partySize,
		quotedMin,
		quotedReadyAt: iso(quotedReadyAt),
		locationName: location?.name ?? null,
		notifiedAt: iso(entry.notifiedAt),
		responseDeadlineAt: iso(entry.responseDeadlineAt),
		canLeave: ACTIVE.has(entry.status),
		canOnMyWay: entry.status === 'waiting' || entry.status === 'notified',
		now: new Date(now).toISOString(),
	}
}
