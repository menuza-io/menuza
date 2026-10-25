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

/**
 * Arabic-Indic (٠-٩) and Persian (۰-۹) digits as 0-9, so a number typed on an
 * Arabic keyboard finds a phone number or a code stored with Western digits
 * (and the other way round). NFKD folds the full-width digits already.
 */
export function foldDigits(text: string) {
	return text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) =>
		String(digit.charCodeAt(0) & 0xf),
	)
}

/** Lower case, without accents, digits as 0-9, so "José" is found by "jose" and "٠٥٥" by "055". */
export function normalize(text: string) {
	return foldDigits(text.normalize('NFKD'))
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.trim()
}

const digitsOf = (text: string) => foldDigits(text).replace(/\D/g, '')

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
	const digits = digitsOf(q)
	const phone = digitsOf(fields.phone ?? '')
	if (digits.length >= 2 && phone) {
		const hit =
			digits.length <= 4
				? phone.slice(-4).includes(digits)
				: phone.includes(digits)
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

/** Every booking's status by id: what to compare the next look at the day against. */
export const statusMap = (feed: Pick<DayFeed, 'reservations'>) =>
	new Map(feed.reservations.map((r) => [r.id, r.status]))

/**
 * Parties that have turned up since `before` (an earlier `statusMap`): at the
 * stand now, known and not there before, and not marked here by this tablet
 * (which says so itself). Nothing on the first look at a day.
 */
export function newArrivals(
	before: ReadonlyMap<string, string> | null,
	feed: Pick<DayFeed, 'reservations'>,
	markedHere: ReadonlySet<string> = new Set(),
): DayReservation[] {
	if (!before) return []
	return feed.reservations.filter(
		(r) =>
			r.status === 'arrived' &&
			before.has(r.id) &&
			before.get(r.id) !== 'arrived' &&
			!markedHere.has(r.id),
	)
}
