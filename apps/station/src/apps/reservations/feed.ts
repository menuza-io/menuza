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

const guestTagSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		/** `first_visit`, `vip` and the like: the system's own tags. */
		systemKey: z.string().nullable().optional(),
		category: z.string().nullable().optional(),
		sensitive: z.boolean().optional(),
	})
	.loose()

export type GuestTag = z.infer<typeof guestTagSchema>

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
		tags: z.array(guestTagSchema).default([]),
		/** Bookings cancelled too late to rebook the table. */
		lateCancels: z.number().default(0),
		lastVisitAt: epoch,
		locale: z.string().nullable().optional(),
		/**
		 * The restaurant's pinned notes about the guest: only with the
		 * guest-details grant (the server sends an empty list without it).
		 */
		pinnedNotes: z
			.array(z.object({ id: z.string(), body: z.string() }).loose())
			.default([]),
	})
	.loose()

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
		/**
		 * Coded dietary values and allergens (`shellfish_allergy`, `vegan`): the
		 * server sends these to every host, with or without the guest grant, so
		 * an allergy can be said without free text.
		 */
		dietaryCodes: z.array(z.string()).default([]),
		/** `web`, `ios`, `android`, or the till's own (`operator`): how it was made. */
		client: z.string().nullable().optional(),
		/** When the booking was made (epoch ms). */
		createdAt: epoch,
		/** `none`, `pending` (deposit awaited), `paid`, `guaranteed` (card held), and refunds. */
		paymentStatus: z.string().default('none'),
		contactStatus: z.string().nullable().optional(),
		overbooked: z.boolean().default(false),
		locked: z.boolean().default(false),
		serviceId: z.string().nullable().optional(),
		/** A booked experience (a tasting menu): its price is a manager's to change. */
		experienceId: z.string().nullable().optional(),
		/** The defined combination of tables the party sits at, if it is one. */
		comboId: z.string().nullable().optional(),
		/** How many of a partly arrived party are at the door (null: all, or not said). */
		arrivedCovers: z.number().int().nullish(),
		/** How many of a partly seated party are at their table. */
		seatedCovers: z.number().int().nullish(),
		arrivedAt: epoch,
		seatedAt: epoch,
		finishedAt: epoch,
		noShowAt: epoch,
		/**
		 * Whether this till may undo the recent no-show or clearing (its own
		 * person's change, or the system's). Absent from an older server: allowed.
		 */
		canUndo: z.boolean().optional(),
		guest: guestSchema.nullable().default(null),
	})
	.loose()

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
		/** The manager marked it as one that joins others for a large party. */
		combinable: z.boolean().default(false),
		/**
		 * Minutes the server keeps a table after a party's booked end before it
		 * counts the table free again (its conflict checks add it). Zero when the
		 * table has none, or an older server does not say.
		 */
		resetBufferMin: z
			.number()
			.nullish()
			.transform((minutes) => Math.max(0, Math.round(minutes ?? 0))),
		archivedAt: epoch,
	})
	.loose()

export type DayTable = z.infer<typeof tableSchema>

/** A defined combination of tables ("Tables 6 + 7") that seats a large party together. */
const comboSchema = z
	.object({
		id: z.string(),
		label: z.string().default(''),
		minCovers: z.number().int().default(1),
		maxCovers: z.number().int(),
		tableIds: z.array(z.string()).default([]),
		archivedAt: epoch,
	})
	.loose()

export type DayCombo = z.infer<typeof comboSchema>

const areaSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		sort: z.number().default(0),
		canvasW: z.number().default(1200),
		canvasH: z.number().default(800),
		archivedAt: epoch,
	})
	.loose()

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
	.loose()

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
	.loose()

/** A service of the day (Lunch, Dinner): when it seats and when it ends, in minutes after local midnight. */
const serviceSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		firstSeatingMin: z.number().int(),
		lastSeatingMin: z.number().int(),
		endMin: z.number().int(),
		sort: z.number().default(0),
		archivedAt: epoch,
		/** The sections the floor is split into for this service, by default. */
		sectionLayoutId: z.string().nullable().optional(),
	})
	.loose()

export type DayService = z.infer<typeof serviceSchema>

/** A way of splitting the floor between servers (drawn by a manager in the App). */
const sectionLayoutSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		sections: z
			.array(
				z
					.object({
						id: z.string(),
						name: z.string(),
						/** A palette token (`blue`, `2`) or a hex colour. */
						colorToken: z.string().nullable().optional(),
						sort: z.number().default(0),
						tableIds: z.array(z.string()).default([]),
					})
					.loose(),
			)
			.default([]),
	})
	.loose()

export type DaySectionLayout = z.infer<typeof sectionLayoutSchema>

/** Who works a section in one service of the day: a person on the staff, or a typed name. */
const sectionAssignmentSchema = z
	.object({
		serviceId: z.string(),
		sectionId: z.string(),
		staffId: z.string().nullable().optional(),
		serverLabel: z.string().nullable().optional(),
	})
	.loose()

export type DaySectionAssignment = z.infer<typeof sectionAssignmentSchema>

/** One slot of the day's pacing: covers booked against what the slot can take. */
const pacingSchema = z
	.object({
		localMin: z.number().int(),
		serviceId: z.string().nullable().optional(),
		bookedCovers: z.number().default(0),
		partyCount: z.number().default(0),
		maxCovers: z.number().nullable().optional(),
		/** Set by a server that marks a cap as its own default (none does yet). */
		maxCoversIsDefault: z.boolean().nullable().optional(),
	})
	.loose()

export type DayPacing = z.infer<typeof pacingSchema>

export const dayFeedSchema = z
	.object({
		locationId: z.string(),
		businessDate: z.string(),
		etag: z.string().optional(),
		dayState: z.string().default('open'),
		/** The location's own time zone: every time on the stand is shown in it. */
		settings: z
			.object({ timeZone: z.string().nullable().optional() })
			.loose()
			.nullable()
			.optional(),
		closedLabel: z.string().nullable().optional(),
		areas: z.array(areaSchema).default([]),
		tables: z.array(tableSchema).default([]),
		/** Defined combinations of tables: absent from an older server. */
		combos: z.array(comboSchema).default([]),
		elements: z.array(elementSchema).default([]),
		blocks: z.array(blockSchema).default([]),
		/** Absent from an older server: the stand then has one "All day". */
		services: z.array(serviceSchema).default([]),
		pacing: z.array(pacingSchema).default([]),
		reservations: z.array(reservationSchema).default([]),
		/** Absent from an older server, or empty where nobody drew sections. */
		sectionLayouts: z
			.array(sectionLayoutSchema)
			.nullish()
			.transform((layouts) => layouts ?? []),
		sectionAssignments: z
			.array(sectionAssignmentSchema)
			.nullish()
			.transform((rows) => rows ?? []),
	})
	.loose()

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
					.loose(),
			)
			.default([]),
	})
	.loose()

export type Availability = z.infer<typeof availabilitySchema>

/**
 * The open slot that starts at a minute. Slots are told apart by `localStartMin`,
 * which runs past 1440 after midnight; their `time` string wraps (01:30 for
 * minute 1530) and would match the wrong end of the day.
 */
export function openSlotAt(
	slots: Availability['slots'],
	startMin: number | null,
) {
	if (startMin === null) return undefined
	return slots.find((slot) => slot.available && slot.localStartMin === startMin)
}

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

/**
 * When a seated party's table should clear: the booking's own end, or the
 * stay it was booked for counted from when they actually sat, whichever is
 * later. A party booked at 7:00 for 90 minutes and seated at 7:50 is not over
 * their time at 8:30 (the booking's end): they have only just begun.
 */
export function clearAtOf(
	r: Pick<DayReservation, 'endAt' | 'seatedAt' | 'durationMin' | 'status'> & {
		startAt?: number
	},
): number {
	const fromSeating =
		typeof r.seatedAt === 'number'
			? r.seatedAt + r.durationMin * 60_000
			: r.endAt
	return Math.max(r.endAt, fromSeating)
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
	 * A party finished here a moment ago and the table keeps its reset buffer
	 * (it is being cleared and laid): ready again at `readyAt`.
	 */
	| {
			kind: 'resetting'
			party: DayReservation
			readyAt: number
			next: DayReservation | null
	  }

/** What a table is doing: the kind of `TableState`. */
export type TableKind = TableState['kind']

/** A table the host may seat someone at without being asked first. */
export const isFreeKind = (kind: TableKind) =>
	kind === 'open' || kind === 'soon'

/**
 * What a table is doing at `now`: blocked, occupied, being reset after a party
 * left, about to be (a party due within half an hour is booked on it), or
 * open. A party seated on several tables occupies each of them.
 */
export function tableState(
	table: Pick<DayTable, 'id' | 'areaId'> & { resetBufferMin?: number },
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
	const resetMs = (table.resetBufferMin ?? 0) * 60_000
	if (resetMs > 0) {
		const left = mine
			.filter(
				(r) =>
					r.status === 'finished' &&
					typeof r.finishedAt === 'number' &&
					r.finishedAt <= now &&
					r.finishedAt + resetMs > now,
			)
			.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
		if (left)
			return {
				kind: 'resetting',
				party: left,
				readyAt: (left.finishedAt ?? 0) + resetMs,
				next,
			}
	}
	if (next && next.startAt - now <= DUE_SOON_MIN * 60_000)
		return { kind: 'soon', next }
	return { kind: 'open', next }
}

/** A table seats a party when the party is within its covers (a host may still seat a small party at a big table). */
export const fits = (table: Pick<DayTable, 'maxCovers'>, partySize: number) =>
	partySize <= table.maxCovers

/** How long a party without a booking is expected to stay. */
export const DEFAULT_TURN_MIN = 90

export type PartyToPlace = {
	partySize: number
	durationMin: number
	reservationId?: string
	/**
	 * The booking's own window, when the party is a booking being seated: the
	 * server checks a seating against `startAt .. endAt` (plus the table's reset
	 * buffer), not against "now plus a turn". Absent for a party seated now.
	 */
	startAt?: number
	endAt?: number
	/**
	 * The party is given a table for its own time, not seated now: a table that
	 * is taken or being reset at the moment is judged by the window like any
	 * other (it may be free again by then).
	 */
	future?: boolean
}

/** Why a table cannot take the party being placed (or that it can). */
export type FitVerdict =
	| { fits: true }
	/** Someone is seated there, or it is taped off. */
	| { fits: false; why: 'taken' }
	/** A party just left and the table is being reset: ready again at `until`. */
	| { fits: false; why: 'resetting'; until: number }
	| { fits: false; why: 'small' }
	/** Free now, but booked at `at` (an epoch), before the party would be done. */
	| { fits: false; why: 'booked'; at: number }
	/** Free now, but taped off from `at` (an epoch), inside the party's stay: the server refuses it. */
	| { fits: false; why: 'blocked'; at: number }

/** What a table's other bookings and blocks are, for the window a party would hold it. */
export type Occupancy = Pick<DayFeed, 'reservations' | 'blocks'>

/** Statuses of a booking that holds its tables on the server (its occupancy is active). */
const HOLDS_TABLE = new Set([
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
])

/**
 * The window a party would hold a table: its own booked window, or now to the
 * end of its stay, plus the table's reset buffer (the server's conflict checks
 * add it to the end).
 */
export function windowOf(
	party: PartyToPlace,
	resetBufferMin: number,
	now: number,
): { start: number; end: number } {
	const start = party.startAt ?? now
	const end = party.endAt ?? start + party.durationMin * 60_000
	return { start, end: end + resetBufferMin * 60_000 }
}

/**
 * Whether a party being placed can sit at this table now, as the server
 * judges it: nobody is on it, it is big enough, and no other booking or block
 * overlaps the window the party would hold it. The party's own booking does
 * not count against it. When it cannot, the verdict says why, in the order a
 * host would check: taken, too small, booked, taped off.
 *
 * With `occupancy` (the day's bookings and blocks) the check is the server's
 * own: every booking and block that overlaps the party's window counts, a late
 * one (booked earlier, never arrived) and a block that starts inside the stay
 * included. Without it, the table's next booking (`state.next`) stands in.
 *
 * One judgement goes past the server's: for a booking given a table for its
 * own time (`future`), a party sitting there counts until they are expected to
 * clear, not until their booked end (the server holds the booked end). The
 * table is then "taken" for it, though a tap still sends it, as the host's call.
 */
export function fitVerdict(
	table: Pick<DayTable, 'maxCovers'> & {
		resetBufferMin?: number
		id?: string
		areaId?: string
	},
	state: TableState,
	party: PartyToPlace,
	now: number,
	occupancy?: Occupancy,
): FitVerdict {
	const byWindow = party.future === true && occupancy !== undefined
	if (!byWindow && (state.kind === 'seated' || state.kind === 'blocked'))
		return { fits: false, why: 'taken' }
	if (!byWindow && state.kind === 'resetting')
		return { fits: false, why: 'resetting', until: state.readyAt }
	if (!fits(table, party.partySize)) return { fits: false, why: 'small' }
	const reset = table.resetBufferMin ?? 0
	const window = windowOf(party, reset, now)
	if (occupancy && table.id !== undefined) {
		const resetMs = reset * 60_000
		/**
		 * Until when another booking keeps the table: its booked end, as the
		 * server holds it. A party on the floor for a later booking's window
		 * keeps it until they are expected to clear (seated late, they have their
		 * whole stay; over their time, they are still there now): the server
		 * would take the booking, but the table would not be free for it.
		 */
		const heldUntil = (r: DayReservation) =>
			byWindow && isOnFloor(r) ? Math.max(clearAtOf(r), now) : r.endAt
		// Another booking whose own stay (and reset) overlaps the party's window.
		const clash = occupancy.reservations
			.filter(
				(r) =>
					r.id !== party.reservationId &&
					HOLDS_TABLE.has(r.status) &&
					r.tableIds.includes(table.id!) &&
					r.startAt < window.end &&
					heldUntil(r) + resetMs > window.start,
			)
			.sort((a, b) => a.startAt - b.startAt)[0]
		// Someone sitting there who will still be there: the table is taken, not booked at a time already past.
		if (clash && byWindow && isOnFloor(clash))
			return { fits: false, why: 'taken' }
		if (clash) return { fits: false, why: 'booked', at: clash.startAt }
		const block = occupancy.blocks
			.filter(
				(b) =>
					(b.tableId
						? b.tableId === table.id
						: b.areaId === table.areaId && table.areaId !== undefined) &&
					b.startAt < window.end &&
					b.endAt > window.start,
			)
			.sort((a, b) => a.startAt - b.startAt)[0]
		if (block)
			return { fits: false, why: 'blocked', at: Math.max(block.startAt, now) }
		return { fits: true }
	}
	const next = state.next
	if (!next || next.id === party.reservationId) return { fits: true }
	// The server keeps a table through its reset buffer after the stay, so the
	// party's window is its stay plus that buffer: a booking that starts inside
	// it is a clash (the server refuses it as `table_occupied`).
	return next.startAt < window.end
		? { fits: false, why: 'booked', at: next.startAt }
		: { fits: true }
}

export const takesParty = (
	table: Pick<DayTable, 'maxCovers'> & {
		resetBufferMin?: number
		id?: string
		areaId?: string
	},
	state: TableState,
	party: PartyToPlace,
	now: number,
	occupancy?: Occupancy,
): boolean => fitVerdict(table, state, party, now, occupancy).fits

/**
 * The table to suggest for a party: of the tables that take it, the smallest
 * (so big tables stay free for big parties), then the section whose turn it is
 * (`rank`), the lowest number on a tie.
 */
export function bestFit(
	candidates: Array<{ table: DayTable; state: TableState }>,
	party: PartyToPlace,
	now: number,
	occupancy?: Occupancy,
	/** Among tables of one size, the lower first: the server section that is up next. */
	rank: (tableId: string) => number = () => 0,
): string | null {
	const best = candidates
		.filter((c) => takesParty(c.table, c.state, party, now, occupancy))
		.sort(
			(a, b) =>
				a.table.maxCovers - b.table.maxCovers ||
				rank(a.table.id) - rank(b.table.id) ||
				a.table.label.localeCompare(b.table.label, undefined, {
					numeric: true,
				}),
		)[0]
	return best?.table.id ?? null
}

/** How far ahead "free till" is worth saying: past this, a table is simply open. */
export const FREE_UNTIL_HORIZON_MS = 3 * 60 * 60_000

/**
 * When an open table is next booked, if that is within the horizon: "free
 * till 2:00 PM". Null for a table that is not open, or open for the long run.
 */
export function freeUntil(
	state: TableState,
	now: number,
	horizonMs = FREE_UNTIL_HORIZON_MS,
): { until: number; next: DayReservation } | null {
	if (state.kind !== 'open' || !state.next) return null
	return state.next.startAt - now <= horizonMs
		? { until: state.next.startAt, next: state.next }
		: null
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

/** A guest the restaurant tagged as a VIP (the tag's own name, in any case). */
export const isVip = (r: Pick<DayReservation, 'guest'>) =>
	(r.guest?.tags ?? []).some((tag) => /\bvip\b/i.test(tag.name))

/** Notes the host should know about before seating (the guest's requests, dietary, staff). */
export const hasNotes = (
	r: Pick<
		DayReservation,
		'guestRequests' | 'dietaryNotes' | 'staffNotes' | 'hasAllergy'
	>,
) =>
	Boolean(
		r.guestRequests?.trim() ||
		r.staffNotes?.trim() ||
		// An allergy already has its own mark.
		(!r.hasAllergy && r.dietaryNotes?.trim()),
	)

/** "Maya H." for the list and the floor; the full name stays in the details. */
export function shortName(r: Pick<DayReservation, 'guest'>, fallback: string) {
	const first = r.guest?.firstName?.trim() ?? ''
	const last = r.guest?.lastName?.trim() ?? ''
	if (!first) return r.guest?.name?.trim() || fallback
	return last ? `${first} ${last.slice(0, 1).toUpperCase()}.` : first
}
