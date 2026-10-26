import { partyStatus } from './book.ts'
import { isLargeParty } from './combine.ts'
import {
	isVip,
	isWaitingAtStand,
	type DayFeed,
	type DayReservation,
} from './feed.ts'
import { isGuestChannel } from './guest.ts'
import { slotTotals, timelineRange } from './timeline.ts'

/**
 * How the reservation list reads on a day with sixty bookings: the filter chips
 * (what they mean, how many each holds, what the host chose, kept per device),
 * the hours the rows are grouped under with their totals, and which party is
 * due next. Pure, so each rule is tested apart from the panel that draws it.
 */

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The filter chips, in the order they show. */
export const LIST_FILTERS = [
	'toSeat',
	'late',
	'vip',
	'large',
	'online',
	'noTable',
] as const

export type ListFilter = (typeof LIST_FILTERS)[number]

/**
 * Whether a booking is one of a kind the host filters for:
 * - `toSeat`: at the stand now, waiting for a table;
 * - `late`: past its time (or told us it is running late), not here yet;
 * - `vip`: a guest tagged VIP;
 * - `large`: a large party;
 * - `online`: booked by the guest (the website, an app, the phone agent);
 * - `noTable`: no table chosen for it yet.
 */
export function matchesFilter(
	r: Pick<
		DayReservation,
		| 'status'
		| 'startAt'
		| 'runningLateMin'
		| 'guest'
		| 'partySize'
		| 'channel'
		| 'tableIds'
	>,
	filter: ListFilter,
	now: number,
): boolean {
	switch (filter) {
		case 'toSeat':
			return isWaitingAtStand(r)
		case 'late': {
			const kind = partyStatus(r, now).kind
			return kind === 'late' || kind === 'running'
		}
		case 'vip':
			return isVip(r)
		case 'large':
			return isLargeParty(r.partySize)
		case 'online':
			return isGuestChannel(r.channel)
		case 'noTable':
			return r.tableIds.length === 0
	}
}

/** How many of the bookings each chip would show on its own. */
export function filterCounts(
	rows: readonly DayReservation[],
	now: number,
): Record<ListFilter, number> {
	const counts = Object.fromEntries(LIST_FILTERS.map((f) => [f, 0])) as Record<
		ListFilter,
		number
	>
	for (const r of rows)
		for (const filter of LIST_FILTERS)
			if (matchesFilter(r, filter, now)) counts[filter] += 1
	return counts
}

/**
 * The bookings that match any of the chosen filters (several chips widen what
 * shows, as each chip's count says); everything when none is chosen.
 */
export function applyFilters<T extends DayReservation>(
	rows: readonly T[],
	active: ReadonlySet<ListFilter>,
	now: number,
): T[] {
	if (active.size === 0) return [...rows]
	return rows.filter((r) =>
		[...active].some((filter) => matchesFilter(r, filter, now)),
	)
}

export const FILTERS_KEY = 'station.hostStand.listFilters'

/** The filters this device chose last time (none when it never did, or storage is unavailable). */
export function readFilters(): Set<ListFilter> {
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(FILTERS_KEY) ?? '[]',
		)
		return new Set(
			Array.isArray(parsed)
				? parsed.filter((f): f is ListFilter =>
						(LIST_FILTERS as readonly unknown[]).includes(f),
					)
				: [],
		)
	} catch {
		return new Set()
	}
}

export function writeFilters(active: ReadonlySet<ListFilter>) {
	try {
		localStorage.setItem(
			FILTERS_KEY,
			JSON.stringify(LIST_FILTERS.filter((f) => active.has(f))),
		)
	} catch {
		/* kept for this session only */
	}
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

/** How full a slot is against its cap (a slot at four fifths is "high"). */
export type Pressure = 'high' | 'full'

/** The busiest slot of an hour: its covers against its cap. */
export type HourPressure = {
	level: Pressure
	covers: number
	cap: number
}

/** A slot this full (of its cap) is worth a second look. */
export const HIGH_RATIO = 0.8

/**
 * Which hours of the day have a slot near its cap, from the feed's pacing: the
 * busiest slot of each hour with a configured cap (a cap the server only sets
 * as its own default says nothing about pace, and counts for nothing here).
 * Hours are whole hours after local midnight (14 is 2 PM).
 */
export function hourPressure(
	feed: Pick<DayFeed, 'reservations' | 'pacing' | 'services'> &
		Partial<Pick<DayFeed, 'tables'>>,
	serviceId: string | null = null,
): Map<number, HourPressure> {
	const range = timelineRange(feed, serviceId)
	const totals = slotTotals(feed, range, serviceId)
	const busiest = new Map<number, HourPressure & { ratio: number }>()
	if (totals.kind !== 'slots') return new Map()
	for (const cell of totals.cells) {
		if (cell.cap === null || cell.cap <= 0) continue
		const ratio = cell.covers / cell.cap
		if (ratio < HIGH_RATIO) continue
		const hour = Math.floor(cell.startMin / 60)
		const known = busiest.get(hour)
		if (!known || ratio > known.ratio)
			busiest.set(hour, {
				ratio,
				level: ratio >= 1 ? 'full' : 'high',
				covers: cell.covers,
				cap: cell.cap,
			})
	}
	return new Map(
		[...busiest].map(([hour, { level, covers, cap }]) => [
			hour,
			{ level, covers, cap },
		]),
	)
}

export type HourGroup = {
	/** Whole hours after local midnight (a late slot past midnight is 24, 25...). */
	hour: number
	/** The hour as minutes after local midnight (for formatting "2:00 PM"). */
	startMin: number
	rows: DayReservation[]
	parties: number
	covers: number
	/** The group's busiest slot, when pacing says it is near its cap. */
	pressure: HourPressure | null
}

/**
 * The rows under hour headers, in the order given (they are in time order):
 * "2:00 PM · 5 parties · 21 covers", with the pace when the hour is filling up.
 */
export function groupByHour(
	rows: readonly DayReservation[],
	pressure: ReadonlyMap<number, HourPressure> = new Map(),
): HourGroup[] {
	const groups: HourGroup[] = []
	for (const r of rows) {
		const hour = Math.floor(r.localStartMin / 60)
		let group = groups.at(-1)
		if (!group || group.hour !== hour) {
			group = {
				hour,
				startMin: hour * 60,
				rows: [],
				parties: 0,
				covers: 0,
				pressure: pressure.get(hour) ?? null,
			}
			groups.push(group)
		}
		group.rows.push(r)
		group.parties += 1
		group.covers += r.partySize
	}
	return groups
}

/**
 * The party the "Now" button takes the host to: the first booking still to
 * come (its time not yet passed), skipping parties at the stand (they are at
 * the top of every host's mind already). Null when nobody else is due today.
 */
export function nextDue(
	rows: readonly DayReservation[],
	now: number,
): DayReservation | null {
	return rows.find((r) => !isWaitingAtStand(r) && r.startAt >= now) ?? null
}
