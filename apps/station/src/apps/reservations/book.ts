import { type WaitlistEntry } from '@repo/reservations'
import {
	arrivals,
	isOnFloor,
	isUpcoming,
	isWaitingAtStand,
	minutesLate,
	missedArrivals,
	recentNoShows,
	type DayFeed,
	type DayReservation,
	type DayService,
} from './feed.ts'
import { isGuestChannel } from './guest.ts'
import { foldDigits, nationalDigits, phoneDigits } from './phone.ts'

/**
 * What the host stand's list and header say about the day: which parties are
 * still to seat, which are on the floor, who is late, and what a search or a
 * service ("Lunch") narrows it to. Pure, so the rules are tested apart from
 * the screen.
 */

/** Bookings that count toward the day's parties and covers (not cancelled, not no-shows). */
const COUNTED = new Set([
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
	'partially_seated',
	'seated',
	'finished',
])

export const isCounted = (r: Pick<DayReservation, 'status'>) =>
	COUNTED.has(r.status)

// ---------------------------------------------------------------------------
// Services (Lunch, Dinner)
// ---------------------------------------------------------------------------

/** The day's services in the order they seat, without archived ones. */
export function liveServices(feed: Pick<DayFeed, 'services'>): DayService[] {
	return feed.services
		.filter((s) => !s.archivedAt)
		.sort((a, b) => a.firstSeatingMin - b.firstSeatingMin || a.sort - b.sort)
}

/** The service a booking belongs to: the one it names, else the one its time falls in. */
export function serviceOf(
	feed: Pick<DayFeed, 'services'>,
	r: Pick<DayReservation, 'serviceId' | 'localStartMin'>,
): DayService | null {
	const services = liveServices(feed)
	const named = r.serviceId
		? services.find((s) => s.id === r.serviceId)
		: undefined
	if (named) return named
	return (
		services.find(
			(s) => r.localStartMin >= s.firstSeatingMin && r.localStartMin < s.endMin,
		) ?? null
	)
}

/** Whether a booking falls in the chosen service (null: all day). */
export function inService(
	feed: Pick<DayFeed, 'services'>,
	r: Pick<DayReservation, 'serviceId' | 'localStartMin'>,
	serviceId: string | null,
) {
	return serviceId === null || serviceOf(feed, r)?.id === serviceId
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export { foldDigits }

/** Lower case, without accents, digits as 0-9, so "José" is found by "jose" and "٠٥٥" by "055". */
export function normalize(text: string) {
	return foldDigits(text.normalize('NFKD'))
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.trim()
}

/**
 * Name words (each typed word must be inside some word of the name), the end
 * of the phone number (the last four digits), a table, or a confirmation code.
 */
function matches(
	query: string,
	fields: {
		name: string
		phone?: string | null
		tables?: string[]
		code?: string
	},
) {
	const q = normalize(query)
	if (!q) return true
	const name = normalize(fields.name)
	const words = q.split(/\s+/)
	if (words.every((word) => name.includes(word))) return true
	const digits = phoneDigits(q)
	const phone = phoneDigits(fields.phone)
	if (digits.length >= 2 && phone) {
		// A few digits are the end of the number; more are looked for as typed
		// and as the number reads without its trunk zero (`0551234567` is the
		// end of `+966551234567`).
		const hit =
			digits.length <= 4
				? phone.slice(-4).includes(digits)
				: phone.includes(digits) || phone.includes(nationalDigits(q))
		if (hit) return true
	}
	if (
		(fields.tables ?? []).some((label) => normalize(label).includes(q)) ||
		(fields.code && normalize(fields.code).includes(q))
	)
		return true
	return false
}

export const matchesReservation = (r: DayReservation, query: string) =>
	matches(query, {
		name: [r.guest?.name, r.guest?.firstName, r.guest?.lastName]
			.filter(Boolean)
			.join(' '),
		phone: r.guest?.phone,
		tables: r.tableLabels,
		code: r.confirmationCode,
	})

export const matchesWaitlistEntry = (e: WaitlistEntry, query: string) =>
	matches(query, {
		name: [e.displayName, e.firstName, e.lastName].filter(Boolean).join(' '),
		phone: e.phone,
	})

// ---------------------------------------------------------------------------
// Where a party stands
// ---------------------------------------------------------------------------

export type PartyStatus = {
	kind:
		| 'seated'
		| 'here'
		| 'late'
		| 'running'
		| 'booked'
		| 'confirmed'
		| 'awaiting'
		| 'finished'
		| 'no_show'
	/** Minutes past the booked time (0 when not late yet). */
	late: number
	/** Minutes the guest said they would be late (0 when they did not call). */
	said: number
}

/** One word for how a party stands, for the list's stripe and its second line. */
export function partyStatus(
	r: Pick<DayReservation, 'status' | 'startAt' | 'runningLateMin'>,
	now: number,
): PartyStatus {
	const late = minutesLate(r, now)
	const said = r.runningLateMin ?? 0
	if (isOnFloor(r)) return { kind: 'seated', late: 0, said: 0 }
	if (r.status === 'finished') return { kind: 'finished', late: 0, said: 0 }
	if (r.status === 'no_show') return { kind: 'no_show', late: 0, said: 0 }
	if (isWaitingAtStand(r)) return { kind: 'here', late, said }
	// Held until its deposit is paid: not late, not due, whatever the clock says.
	if (r.status === 'pending_payment')
		return { kind: 'awaiting', late: 0, said: 0 }
	// Later than they said: the real figure leads, and what they said follows it.
	if (said > 0 && late > said) return { kind: 'late', late, said }
	if (said > 0) return { kind: 'running', late, said }
	if (late > 0) return { kind: 'late', late, said }
	return {
		kind: r.status === 'confirmed' ? 'confirmed' : 'booked',
		late,
		said,
	}
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type BookList = {
	/** Parties still to seat, in the order they are due. */
	toSeat: DayReservation[]
	/**
	 * Bookings held until a deposit is paid, in time order. The till cannot
	 * seat them (a manager settles the payment), so they offer details only.
	 */
	awaiting: DayReservation[]
	/** Parties on the floor, the longest seated first. */
	seated: DayReservation[]
	/** Bookings whose time passed with nobody arriving, and recent no-shows. */
	missed: DayReservation[]
	/** Parties that have left, the latest first. */
	finished: DayReservation[]
	waitlist: WaitlistEntry[]
}

const byStart = (a: DayReservation, b: DayReservation) =>
	a.startAt - b.startAt || a.partySize - b.partySize

/**
 * Whether a party is at the stand or on the floor: it is there whatever
 * service is chosen, so a filter never hides someone the host must seat or serve.
 */
const isPresent = (r: Pick<DayReservation, 'status'>) =>
	isWaitingAtStand(r) || isOnFloor(r)

/**
 * The lists the stand's panel shows. Today, the host works the live service:
 * what is due, what is seated, what was missed. Another day is a book to read:
 * everything booked, in time order. A service narrows what is due and what
 * has left; parties at the stand or on the floor always show (they are there).
 */
export function bookList({
	feed,
	waitlist,
	now,
	isToday,
	serviceId = null,
	query = '',
}: {
	feed: Pick<DayFeed, 'reservations' | 'services'>
	waitlist: WaitlistEntry[]
	now: number
	isToday: boolean
	serviceId?: string | null
	query?: string
}): BookList {
	const scoped = {
		reservations: feed.reservations.filter(
			(r) => isWaitingAtStand(r) || inService(feed, r, serviceId),
		),
	}
	const find = (r: DayReservation) => matchesReservation(r, query)
	const toSeat = (
		isToday ? arrivals(scoped, now) : scoped.reservations.filter(isUpcoming)
	)
		.sort(byStart)
		.filter(find)
	const awaiting = scoped.reservations
		.filter((r) => r.status === 'pending_payment')
		.sort(byStart)
		.filter(find)
	const missed = (
		isToday
			? [...missedArrivals(scoped, now), ...recentNoShows(scoped, now)]
			: scoped.reservations
					.filter((r) => r.status === 'no_show')
					.sort((a, b) => b.startAt - a.startAt)
	).filter(find)
	const seated = feed.reservations
		.filter(isOnFloor)
		.sort((a, b) => (a.seatedAt ?? a.startAt) - (b.seatedAt ?? b.startAt))
		.filter(find)
	const finished = scoped.reservations
		.filter((r) => r.status === 'finished')
		.sort((a, b) => (b.finishedAt ?? b.endAt) - (a.finishedAt ?? a.endAt))
		.filter(find)
	return {
		toSeat,
		awaiting,
		seated,
		missed,
		finished,
		waitlist: isToday
			? [...waitlist]
					.sort(
						(a, b) =>
							(a.position ?? a.sortKey) - (b.position ?? b.sortKey) ||
							a.joinedAt - b.joinedAt,
					)
					.filter((e) => matchesWaitlistEntry(e, query))
			: [],
	}
}

export const coversOf = (list: Array<{ partySize: number }>) =>
	list.reduce((sum, r) => sum + r.partySize, 0)

export type DayTotals = {
	/** Every booking that counts today (still to come, seated, or gone). */
	parties: number
	covers: number
	toSeat: number
	seated: number
}

/** The header's summary: "23 parties, 98 covers, 5 to seat, 3 seated". */
export function dayTotals(input: {
	feed: Pick<DayFeed, 'reservations' | 'services'>
	now: number
	isToday: boolean
	serviceId?: string | null
}): DayTotals {
	const { feed, serviceId = null } = input
	const counted = feed.reservations.filter(
		(r) => isCounted(r) && (isPresent(r) || inService(feed, r, serviceId)),
	)
	const list = bookList({ ...input, waitlist: [], serviceId, query: '' })
	return {
		parties: counted.length,
		covers: coversOf(counted),
		toSeat: list.toSeat.length,
		seated: list.seated.length,
	}
}

/** What the stand knew of each booking at one look: to compare the next look with. */
export type DaySnapshot = ReadonlyMap<
	string,
	{ status: string; partySize: number }
>

export const daySnapshot = (feed: Pick<DayFeed, 'reservations'>): DaySnapshot =>
	new Map(
		feed.reservations.map((r) => [
			r.id,
			{ status: r.status, partySize: r.partySize },
		]),
	)

/** Where a party is before it has turned up: only a step from one of these is an arrival. */
const PRE_ARRIVAL = new Set([
	'booked',
	'confirmed',
	'requested',
	'pending_payment',
])

/**
 * Parties that have turned up since `before` (an earlier snapshot): at the
 * stand now, and expected at the last look (booked, confirmed, requested or
 * awaiting payment), and not marked here by this tablet (which says so
 * itself). Undoing a seating also leaves a party "arrived", but from seated:
 * that is not an arrival. Nothing on the first look at a day.
 */
export function newArrivals(
	before: DaySnapshot | null,
	feed: Pick<DayFeed, 'reservations'>,
	markedHere: ReadonlySet<string> = new Set(),
): DayReservation[] {
	if (!before) return []
	return feed.reservations.filter((r) => {
		const was = before.get(r.id)?.status
		return (
			r.status === 'arrived' &&
			was !== undefined &&
			PRE_ARRIVAL.has(was) &&
			!markedHere.has(r.id)
		)
	})
}

export type DayNotice =
	| { kind: 'online'; reservation: DayReservation }
	| { kind: 'cancelled'; reservation: DayReservation }
	| { kind: 'size'; reservation: DayReservation; from: number }

/** A booking made this recently is "new": an older one that merely appears was moved onto the day. */
export const NEW_BOOKING_WINDOW_MS = 30 * 60_000

/** Steps a booking takes while it still holds a table (not over, not cancelled). */
const STANDING = new Set([
	'requested',
	'pending_payment',
	'booked',
	'confirmed',
	'partially_arrived',
	'arrived',
])

/**
 * What changed in the book since the last look, for a quiet word at the stand:
 * a booking a guest made online or in an app, one that was cancelled, a party
 * size that changed. Not what this tablet did itself (`byUs`), and nothing on
 * the first look at a day. Arrivals are `newArrivals`.
 */
export function dayNotices(
	before: DaySnapshot | null,
	feed: Pick<DayFeed, 'reservations'>,
	options: { now: number; byUs?: ReadonlySet<string> },
): DayNotice[] {
	if (!before) return []
	const byUs = options.byUs ?? new Set<string>()
	const notices: DayNotice[] = []
	for (const r of feed.reservations) {
		if (byUs.has(r.id)) continue
		const was = before.get(r.id)
		if (!was) {
			const recent =
				typeof r.createdAt !== 'number' ||
				options.now - r.createdAt <= NEW_BOOKING_WINDOW_MS
			if (isGuestChannel(r.channel) && STANDING.has(r.status) && recent)
				notices.push({ kind: 'online', reservation: r })
			continue
		}
		if (r.status === 'cancelled' && STANDING.has(was.status))
			notices.push({ kind: 'cancelled', reservation: r })
		else if (
			STANDING.has(r.status) &&
			STANDING.has(was.status) &&
			was.partySize !== r.partySize
		)
			notices.push({ kind: 'size', reservation: r, from: was.partySize })
	}
	return notices
}

/**
 * A look older than this is no basis for news: a tablet that slept, or a poll
 * that stalled, would otherwise announce the whole gap as if it had just
 * happened. Past it, the next look is a first look again (it says nothing).
 */
export const NEWS_FRESH_MS = 3 * 60_000

/** The last look at the day, as the stand kept it. */
export type SeenDay = { date: string; snapshot: DaySnapshot; at: number }

/**
 * The look to compare the day with now: the last one, if it is of this day and
 * recent enough to be news. Null otherwise (nothing is announced).
 */
export function snapshotToCompare(
	seen: SeenDay | null,
	date: string,
	now: number,
): DaySnapshot | null {
	if (!seen || seen.date !== date) return null
	const age = now - seen.at
	return age >= 0 && age <= NEWS_FRESH_MS ? seen.snapshot : null
}

/** How long a change this tablet made is remembered as its own, if it never shows up. */
export const SELF_MARK_MS = 2 * 60_000

/**
 * Bookings this tablet changed itself (marked here, cancelled, resized): the
 * stand already said so, so the next look does not announce it again. A mark
 * is dropped when the change fails, when the day shows it (`settle`), and by
 * itself after a while, so a later change by someone else is never swallowed.
 */
export function createSelfMarks(ttlMs = SELF_MARK_MS) {
	const marks = new Map<string, number>()
	return {
		mark(id: string, now: number) {
			marks.set(id, now)
		},
		unmark(id: string) {
			marks.delete(id)
		},
		/** The ids still marked at `now` (older ones are forgotten). */
		live(now: number): Set<string> {
			for (const [id, at] of marks)
				if (now - at > ttlMs || now < at) marks.delete(id)
			return new Set(marks.keys())
		},
		/**
		 * Drops the marks the day has now shown: a marked booking whose status or
		 * size is not what the last look held.
		 */
		settle(before: DaySnapshot | null, feed: Pick<DayFeed, 'reservations'>) {
			for (const id of marks.keys()) {
				const r = feed.reservations.find((x) => x.id === id)
				const was = before?.get(id)
				if (
					!r ||
					!was ||
					was.status !== r.status ||
					was.partySize !== r.partySize
				)
					marks.delete(id)
			}
		},
		size: () => marks.size,
	}
}

export type SelfMarks = ReturnType<typeof createSelfMarks>
