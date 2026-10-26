import {
	bestFit,
	fitVerdict,
	isOnFloor,
	isWaitingAtStand,
	minutesLate,
	tableState,
	type DayFeed,
	type DayReservation,
} from './feed.ts'
import { clearAtOf } from './stay.ts'

/**
 * What the host should know about a party at the door or on its way: how long
 * the ones at the stand have waited, how early an early arrival is and when a
 * table is free for them, when a late party is worth a text or a no-show, and
 * how many of a partly arrived (or partly seated) party are here. Pure, so
 * each rule is tested apart from the rows that say it.
 */

/** A party that has waited at the stand this long is a warning. */
export const WAIT_WARN_MIN = 10

/** A booked party this many minutes late is worth a text, or (the grace has passed) a no-show. */
export const LATE_PROMPT_MIN = 15
/** And this late the prompt is louder. */
export const LATE_URGENT_MIN = 30

/** An arrival this much before their time counts as early. */
export const EARLY_MIN = 5

export type StandWait = {
	/** Whole minutes since they were marked here (never negative). */
	minutes: number
	/** A wait long enough to be a warning. */
	warn: boolean
}

/** How long a party at the stand has waited; null for one that is not there or was never stamped. */
export function standWait(
	r: Pick<DayReservation, 'status' | 'arrivedAt'>,
	now: number,
): StandWait | null {
	if (!isWaitingAtStand(r) || typeof r.arrivedAt !== 'number') return null
	const minutes = Math.max(0, Math.floor((now - r.arrivedAt) / 60_000))
	return { minutes, warn: minutes >= WAIT_WARN_MIN }
}

export type EarlyArrival = {
	/** Whole minutes before their booked time. */
	earlyMin: number
	/** The table to put them at, or when one is free: null when nothing can be said. */
	table:
		| { kind: 'free_now'; label: string }
		| { kind: 'free_in'; minutes: number; label: string | null }
		| null
}

/**
 * An arrival before their time, and what the floor can do for them: a table
 * free now (their own, else the smallest that seats them), or how long until
 * one is. Null for a party that is on time, late, or not at the stand.
 */
export function earlyArrival(
	r: DayReservation,
	feed: Pick<DayFeed, 'tables' | 'reservations' | 'blocks'>,
	now: number,
): EarlyArrival | null {
	if (!isWaitingAtStand(r)) return null
	const earlyMs = r.startAt - now
	if (earlyMs < EARLY_MIN * 60_000) return null
	const earlyMin = Math.floor(earlyMs / 60_000)
	const party = {
		partySize: r.partySize,
		durationMin: r.durationMin,
		reservationId: r.id,
		startAt: r.startAt,
		endAt: r.endAt,
	}
	const live = feed.tables.filter((t) => !t.archivedAt)
	const candidates = live.map((table) => ({
		table,
		state: tableState(table, feed, now),
	}))
	// Their own table first, when it is free for them.
	const own = candidates.filter((c) => r.tableIds.includes(c.table.id))
	const ownFree =
		own.length > 0 &&
		own.length === r.tableIds.length &&
		own.every(
			(c) =>
				fitVerdict(c.table, c.state, { ...party, partySize: 1 }, now, feed)
					.fits,
		) &&
		own.reduce((sum, c) => sum + c.table.maxCovers, 0) >= r.partySize
	if (ownFree)
		return {
			earlyMin,
			table: {
				kind: 'free_now',
				label: own.map((c) => c.table.label).join(' + '),
			},
		}
	const bestId = bestFit(candidates, party, now, feed)
	if (bestId !== null)
		return {
			earlyMin,
			table: {
				kind: 'free_now',
				label: live.find((t) => t.id === bestId)?.label ?? '',
			},
		}
	// Nothing is free now: the table that clears first among those that seat them.
	let soonest: { at: number; label: string } | null = null
	for (const { table, state } of candidates) {
		if (table.maxCovers < r.partySize) continue
		let at: number | null = null
		if (state.kind === 'seated') at = clearAtOf(state.party)
		else if (state.kind === 'resetting') at = state.readyAt
		if (at !== null && (!soonest || at < soonest.at))
			soonest = { at, label: table.label }
	}
	if (soonest)
		return {
			earlyMin,
			table: {
				kind: 'free_in',
				minutes: Math.max(1, Math.ceil((soonest.at - now) / 60_000)),
				label: soonest.label,
			},
		}
	return { earlyMin, table: null }
}

export type LatePrompt = {
	/** Whole minutes past their booked time. */
	late: number
	/** Past the second threshold: the prompt is louder. */
	urgent: boolean
}

/**
 * A booked party this late is worth a nudge: text them, or mark a no-show (a
 * till may only from fifteen minutes after the time). Only for a party that has
 * not turned up and has not said how late they will be: a guest who called to
 * say they are running late has already been heard.
 */
export function latePrompt(
	r: Pick<DayReservation, 'status' | 'startAt' | 'runningLateMin'>,
	now: number,
): LatePrompt | null {
	if (r.status !== 'booked' && r.status !== 'confirmed') return null
	const late = minutesLate(r, now)
	if (late < LATE_PROMPT_MIN) return null
	// They said they would be this late, and they are not later than that yet.
	if ((r.runningLateMin ?? 0) > 0 && late <= (r.runningLateMin ?? 0))
		return null
	return { late, urgent: late >= LATE_URGENT_MIN }
}

export type CoversHere = {
	/** How many are here (at the door, or at the table). */
	here: number
	/** How many in the party. */
	of: number
	/** Where the ones who are here are: at the door (arrived), or at their table (seated). */
	stage: 'door' | 'table'
}

/**
 * "3 of 5 here" at the door, "seated 3 of 5" at the table: a party only partly
 * there. The server has no partial statuses for a till: it keeps the count on
 * an `arrived` booking (`arrivedCovers`) and a `seated` one (`seatedCovers`),
 * so a count below the party size is what says it. Null for a whole party, and
 * for a booking nobody is at yet (the server keeps an old count through an
 * undo). A party that grew after it sat ("we're six now") reads as partial
 * too: the server does not move the count with the size.
 */
export function coversHere(
	r: Pick<
		DayReservation,
		'status' | 'partySize' | 'arrivedCovers' | 'seatedCovers'
	>,
): CoversHere | null {
	const stage = isOnFloor(r) ? 'table' : isWaitingAtStand(r) ? 'door' : null
	if (stage === null) return null
	const count = stage === 'table' ? r.seatedCovers : r.arrivedCovers
	if (typeof count !== 'number' || count <= 0 || count >= r.partySize)
		return null
	return { here: count, of: r.partySize, stage }
}
