import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { z } from 'zod'

/**
 * The day of service as the host stand reads it: the parts of
 * `GET /operator/reservations/book/day` the till uses, parsed leniently (the
 * server sends more, and snake_case twins of most keys), plus the floor logic
 * that turns tables, bookings and blocks into what a host sees right now.
 *
 * The shapes are kept honest by `fixtures/*.json`, recorded from the real routes
 * (`apps/tenant-api/src/routes/pos-station-contract.test.ts`).
 */

const epoch = z.number().nullable().optional()

const guestSchema = z
	.object({
		id: z.string(),
		name: z.string().default(''),
		firstName: z.string().default(''),
		lastName: z.string().default(''),
		phone: z.string().nullable().optional(),
		email: z.string().nullable().optional(),
		/** Only with the guest-details grant (till managers). */
		allergyNotes: z.string().nullable().optional(),
		hasAllergy: z.boolean().default(false),
		visits: z.number().default(0),
		noShows: z.number().default(0),
		tags: z
			.array(z.object({ id: z.string(), name: z.string() }).passthrough())
			.default([]),
	})
	.passthrough()

export const reservationSchema = z
	.object({
		id: z.string(),
		version: z.number().int(),
		confirmationCode: z.string().default(''),
		status: z.string(),
		channel: z.string().default('operator'),
		partySize: z.number().int(),
		localStartMin: z.number().int(),
		time: z.string(),
		startAt: z.number(),
		endAt: z.number(),
		durationMin: z.number().int(),
		tableIds: z.array(z.string()).default([]),
		tableLabels: z.array(z.string()).default([]),
		runningLateMin: z.number().nullable().optional(),
		occasion: z.string().nullable().optional(),
		guestRequests: z.string().nullable().optional(),
		dietaryNotes: z.string().nullable().optional(),
		staffNotes: z.string().nullable().optional(),
		hasAllergy: z.boolean().default(false),
		arrivedAt: epoch,
		seatedAt: epoch,
		finishedAt: epoch,
		/**
		 * Whether this till may undo the recent no-show or clearing (its own
		 * person's change, or the system's). Absent from an older server: allowed.
		 */
		canUndo: z.boolean().optional(),
		guest: guestSchema.nullable().default(null),
	})
	.passthrough()

export type DayReservation = z.infer<typeof reservationSchema>

const tableSchema = z
	.object({
		id: z.string(),
		areaId: z.string(),
		label: z.string(),
		minCovers: z.number().int(),
		maxCovers: z.number().int(),
		shape: z.string().default('square'),
		x: z.number().default(0),
		y: z.number().default(0),
		w: z.number().default(60),
		h: z.number().default(60),
		rotation: z.number().default(0),
		archivedAt: epoch,
	})
	.passthrough()

export type DayTable = z.infer<typeof tableSchema>

const areaSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		sort: z.number().default(0),
		canvasW: z.number().default(1200),
		canvasH: z.number().default(800),
		archivedAt: epoch,
	})
	.passthrough()

export type DayArea = z.infer<typeof areaSchema>

const elementSchema = z
	.object({
		id: z.string(),
		areaId: z.string().nullable().optional(),
		kind: z.string(),
		label: z.string().nullable().optional(),
		x: z.number().default(0),
		y: z.number().default(0),
		w: z.number().default(60),
		h: z.number().default(20),
		rotation: z.number().default(0),
	})
	.passthrough()

export type DayElement = z.infer<typeof elementSchema>

const blockSchema = z
	.object({
		id: z.string(),
		tableId: z.string().nullable().optional(),
		areaId: z.string().nullable().optional(),
		startAt: z.number(),
		endAt: z.number(),
		reason: z.string().nullable().optional(),
	})
	.passthrough()

export const dayFeedSchema = z
	.object({
		locationId: z.string(),
		businessDate: z.string(),
		etag: z.string().optional(),
		dayState: z.string().default('open'),
		/** The location's own time zone: every time on the stand is shown in it. */
		settings: z
			.object({ timeZone: z.string().nullable().optional() })
			.passthrough()
			.nullable()
			.optional(),
		closedLabel: z.string().nullable().optional(),
		areas: z.array(areaSchema).default([]),
		tables: z.array(tableSchema).default([]),
		elements: z.array(elementSchema).default([]),
		blocks: z.array(blockSchema).default([]),
		reservations: z.array(reservationSchema).default([]),
	})
	.passthrough()

export type DayFeed = z.infer<typeof dayFeedSchema>

export const availabilitySchema = z
	.object({
		businessDate: z.string(),
		closed: z.boolean().default(false),
		slots: z
			.array(
				z
					.object({
						localStartMin: z.number().int(),
						time: z.string(),
						available: z.boolean(),
						suggestedTableIds: z.array(z.string()).default([]),
					})
					.passthrough(),
			)
			.default([]),
	})
	.passthrough()

export type Availability = z.infer<typeof availabilitySchema>

// ---------------------------------------------------------------------------
// Where a party is in the service
// ---------------------------------------------------------------------------

/** Expected, not here yet, or here and waiting to be seated. */
const UPCOMING = new Set([
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
])
const ON_FLOOR = new Set(['seated', 'partially_seated'])

export const isUpcoming = (r: Pick<DayReservation, 'status'>) =>
	UPCOMING.has(r.status)
export const isOnFloor = (r: Pick<DayReservation, 'status'>) =>
	ON_FLOOR.has(r.status)
export const isWaitingAtStand = (r: Pick<DayReservation, 'status'>) =>
	r.status === 'arrived' || r.status === 'partially_arrived'

/**
 * Parties still to seat, in the order they are due. With `now`, a booking
 * whose whole slot has passed without the party turning up is left out: it
 * waits in `missedArrivals` for the host to mark it, not in the dock.
 */
export function arrivals(feed: Pick<DayFeed, 'reservations'>, now?: number) {
	return feed.reservations
		.filter(
			(r) =>
				isUpcoming(r) &&
				(now === undefined || isWaitingAtStand(r) || r.endAt > now),
		)
		.sort((a, b) => a.startAt - b.startAt || a.partySize - b.partySize)
}

/** Bookings whose slot is over and whose party never arrived, latest first. */
export function missedArrivals(
	feed: Pick<DayFeed, 'reservations'>,
	now: number,
) {
	return feed.reservations
		.filter((r) => isUpcoming(r) && !isWaitingAtStand(r) && r.endAt <= now)
		.sort((a, b) => b.startAt - a.startAt)
}

/** How long a till can still put right a no-show or a cleared table. */
export const UNDO_WINDOW_MS = 30 * 60_000

/**
 * Parties marked as no-shows in the last half hour, latest first: they leave
 * every lane, so a guest who walks in after all is found here to undo it.
 */
export function recentNoShows(
	feed: Pick<DayFeed, 'reservations'>,
	now: number,
) {
	const markedAt = (r: DayReservation) =>
		typeof r.noShowAt === 'number' ? r.noShowAt : null
	return feed.reservations
		.filter((r) => {
			const at = markedAt(r)
			return r.status === 'no_show' && at !== null && now - at <= UNDO_WINDOW_MS
		})
		.sort((a, b) => (markedAt(b) ?? 0) - (markedAt(a) ?? 0))
}

/** Minutes past the booked time (0 when not late yet). */
export const minutesLate = (r: Pick<DayReservation, 'startAt'>, now: number) =>
	Math.max(0, Math.floor((now - r.startAt) / 60_000))

/** A party is "due" from this many minutes before its time. */
export const DUE_SOON_MIN = 30

export type TableState =
	| { kind: 'open'; next: DayReservation | null }
	| { kind: 'soon'; next: DayReservation }
	| { kind: 'seated'; party: DayReservation; next: DayReservation | null }
	| { kind: 'blocked'; reason: string | null; next: DayReservation | null }

/**
 * What a table is doing at `now`: blocked, occupied, about to be (a party due
 * within half an hour is booked on it), or open. A party seated on several
 * tables occupies each of them.
 */
export function tableState(
	table: Pick<DayTable, 'id' | 'areaId'>,
	feed: Pick<DayFeed, 'reservations' | 'blocks'>,
	now: number,
): TableState {
	const mine = feed.reservations.filter((r) => r.tableIds.includes(table.id))
	const party = mine.find(isOnFloor)
	const next =
		mine
			.filter((r) => isUpcoming(r) && r.endAt > now)
			.sort((a, b) => a.startAt - b.startAt)[0] ?? null
	const block = feed.blocks.find(
		(b) =>
			b.startAt <= now &&
			b.endAt > now &&
			(b.tableId ? b.tableId === table.id : b.areaId === table.areaId),
	)
	if (party) return { kind: 'seated', party, next }
	if (block) return { kind: 'blocked', reason: block.reason ?? null, next }
	if (next && next.startAt - now <= DUE_SOON_MIN * 60_000)
		return { kind: 'soon', next }
	return { kind: 'open', next }
}

/** A table seats a party when the party is within its covers (a host may still seat a small party at a big table). */
export const fits = (table: Pick<DayTable, 'maxCovers'>, partySize: number) =>
	partySize <= table.maxCovers

/** How long a party without a booking is expected to stay. */
export const DEFAULT_TURN_MIN = 90

/**
 * Whether a party being placed can sit at this table now: it is free, big
 * enough, and nobody else is booked on it before the party would be done. The
 * party's own booking on the table does not count against it.
 */
export function takesParty(
	table: Pick<DayTable, 'maxCovers'>,
	state: TableState,
	party: { partySize: number; durationMin: number; reservationId?: string },
	now: number,
): boolean {
	if (state.kind === 'seated' || state.kind === 'blocked') return false
	if (!fits(table, party.partySize)) return false
	const next = state.next
	if (!next || next.id === party.reservationId) return true
	return next.startAt - now >= party.durationMin * 60_000
}

// ---------------------------------------------------------------------------
// Floor layout
// ---------------------------------------------------------------------------

export type PlacedTable = {
	table: DayTable
	/** Fractions of the room (0..1), so the plan scales with the screen. */
	left: number
	top: number
	width: number
	height: number
}

/**
 * Whether a manager has placed this room's tables. A room nobody has drawn yet
 * (every table at the origin) is laid out as a tidy grid instead of a pile. A
 * single table counts as drawn wherever it is.
 */
export function isDrawn(tables: Pick<DayTable, 'x' | 'y' | 'archivedAt'>[]) {
	const live = tables.filter((t) => !t.archivedAt)
	if (live.length === 0) return false
	if (live.length === 1) return live[0]!.x !== 0 || live[0]!.y !== 0
	return new Set(live.map((t) => `${t.x}:${t.y}`)).size > 1
}

/** The tables of one room, as fractions of the room. */
export function placeTables(
	area: Pick<DayArea, 'canvasW' | 'canvasH'>,
	tables: DayTable[],
): PlacedTable[] {
	const live = tables.filter((t) => !t.archivedAt)
	if (live.length === 0) return []
	if (!isDrawn(live)) return gridLayout(live)
	const width = Math.max(area.canvasW, ...live.map((t) => t.x + t.w), 1)
	const height = Math.max(area.canvasH, ...live.map((t) => t.y + t.h), 1)
	return live.map((table) => ({
		table,
		left: table.x / width,
		top: table.y / height,
		width: table.w / width,
		height: table.h / height,
	}))
}

function gridLayout(tables: DayTable[]): PlacedTable[] {
	const sorted = [...tables].sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { numeric: true }),
	)
	const columns = Math.min(
		6,
		Math.max(2, Math.ceil(Math.sqrt(sorted.length * 1.6))),
	)
	const rows = Math.ceil(sorted.length / columns)
	const cellW = 1 / columns
	const cellH = 1 / Math.max(rows, 2)
	return sorted.map((table, index) => {
		// Bigger tables take more of their cell.
		const grow = Math.min(1, 0.55 + table.maxCovers * 0.05)
		const width = cellW * 0.7 * grow
		const height = cellH * 0.62 * grow
		const col = index % columns
		const row = Math.floor(index / columns)
		return {
			table,
			left: col * cellW + (cellW - width) / 2,
			top: row * cellH + (cellH - height) / 2,
			width,
			height,
		}
	})
}

/** Rooms in their configured order, without archived ones or empty ones. */
export function rooms(feed: Pick<DayFeed, 'areas' | 'tables'>): DayArea[] {
	const used = new Set(
		feed.tables.filter((t) => !t.archivedAt).map((t) => t.areaId),
	)
	return feed.areas
		.filter((a) => !a.archivedAt && used.has(a.id))
		.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
}

/** Occasions a booking can carry, as the stand says them (an unknown one shows as itself). */
export const OCCASION_LABEL: Record<string, MessageDescriptor> = {
	birthday: msg`Birthday`,
	anniversary: msg`Anniversary`,
	date_night: msg`Date night`,
	business: msg`Business`,
	celebration: msg`Celebration`,
	other: msg`Occasion`,
}

/** "Maya H." for the dock and the floor; the full name stays in the details. */
export function shortName(r: Pick<DayReservation, 'guest'>, fallback: string) {
	const first = r.guest?.firstName?.trim() ?? ''
	const last = r.guest?.lastName?.trim() ?? ''
	if (!first) return r.guest?.name?.trim() || fallback
	return last ? `${first} ${last.slice(0, 1).toUpperCase()}.` : first
}
