import { type WaitlistEntry } from '@repo/reservations'
import {
	DEFAULT_TURN_MIN,
	fitVerdict,
	isFreeKind,
	isWaitingAtStand,
	tableState,
	type DayFeed,
	type DayReservation,
	type DayTable,
	type TableKind,
} from './feed.ts'
import { type Placing } from './placing.ts'
import { minutesWaited } from './waitlist.ts'

/**
 * "Table 7 is free: Sofia (4, waited 13 min). Seat". When a table frees up (a
 * party is cleared, or its reset ends) the stand offers it to whoever has
 * waited longest and fits: the waitlist first, then a booked party already at
 * the stand. It is a suggestion, never an action: one tap seats them through
 * the same rules as any seating, a dismissal is remembered, and it is never
 * made twice for the same table and party. Pure, so it is tested apart from
 * the screen.
 */

/** A table that was free, and for what the stand tells the host about it, this long. */
export const FREE_OFFER_MS = 15 * 60_000

/** Statuses of a waitlist party still waiting for a table. */
const IN_LINE = new Set(['waiting', 'notified', 'on_the_way'])

/** What each of the room's live tables is doing at one look. */
export function tableKinds(
	feed: Pick<DayFeed, 'tables' | 'reservations' | 'blocks'>,
	now: number,
): Map<string, TableKind> {
	return new Map(
		feed.tables
			.filter((table) => !table.archivedAt)
			.map((table) => [table.id, tableState(table, feed, now).kind] as const),
	)
}

/**
 * The tables that went from taken (seated, or being reset) to free between two
 * looks. Nothing on a first look, and a table that was free all along is not
 * "newly" anything.
 */
export function newlyFree(
	before: ReadonlyMap<string, TableKind> | null,
	after: ReadonlyMap<string, TableKind>,
): string[] {
	if (!before) return []
	return [...after]
		.filter(([id, kind]) => {
			const was = before.get(id)
			return (was === 'seated' || was === 'resetting') && isFreeKind(kind)
		})
		.map(([id]) => id)
}

export type FreeTableOffer = {
	table: DayTable
	/** Who the table is offered to, as the placing the floor already understands. */
	placing: Extract<Placing, { kind: 'waitlist' | 'reservation' }>
	/** The party's size. */
	size: number
	/** Minutes a waitlist party has waited (null: a booking at the stand). */
	waitedMin: number | null
	/** One per table and party: what a dismissal is remembered by. */
	key: string
}

/** The key a dismissal is remembered by: this table, offered to this party. */
export const offerKey = (tableId: string, partyKey: string) =>
	`${tableId}|${partyKey}`

/**
 * Whether a party is a sensible one for a table: it seats them, and they are
 * not so few that the table's own minimum would go to waste (a party of two at
 * a table for four to six). A host may seat anyone anywhere; a suggestion is
 * only made for a good match.
 */
const suits = (
	table: Pick<DayTable, 'minCovers' | 'maxCovers'>,
	partySize: number,
) => partySize >= table.minCovers && partySize <= table.maxCovers

/**
 * The offer to show now, from the tables that freed (newest first as given),
 * or null. A table still has to be free, and the party has to fit it: seated
 * at its size, for a turn, with nobody booked on it before they would be done.
 */
export function pickOffer({
	freed,
	feed,
	waitlist,
	now,
	dismissed,
}: {
	freed: readonly string[]
	feed: Pick<DayFeed, 'tables' | 'reservations' | 'blocks'>
	waitlist: readonly WaitlistEntry[]
	now: number
	dismissed: ReadonlySet<string>
}): FreeTableOffer | null {
	const line = waitlist
		.filter((entry) => IN_LINE.has(entry.status))
		.sort((a, b) => a.joinedAt - b.joinedAt)
	const atStand = feed.reservations
		.filter((r) => r.status === 'arrived' && isWaitingAtStand(r))
		.sort((a, b) => a.startAt - b.startAt)
	for (const id of freed) {
		const table = feed.tables.find((t) => t.id === id && !t.archivedAt)
		if (!table) continue
		const state = tableState(table, feed, now)
		if (!isFreeKind(state.kind)) continue
		for (const entry of line) {
			if (!suits(table, entry.partySize)) continue
			if (dismissed.has(offerKey(table.id, `w:${entry.id}`))) continue
			const verdict = fitVerdict(
				table,
				state,
				{ partySize: entry.partySize, durationMin: DEFAULT_TURN_MIN },
				now,
			)
			if (!verdict.fits) continue
			return {
				table,
				placing: { kind: 'waitlist', entry },
				size: entry.partySize,
				waitedMin: minutesWaited(entry, now),
				key: offerKey(table.id, `w:${entry.id}`),
			}
		}
		for (const r of atStand) {
			if (!suits(table, r.partySize)) continue
			if (dismissed.has(offerKey(table.id, `r:${r.id}`))) continue
			const verdict = fitVerdict(
				table,
				state,
				{
					partySize: r.partySize,
					durationMin: r.durationMin,
					reservationId: r.id,
				},
				now,
			)
			if (!verdict.fits) continue
			return {
				table,
				placing: { kind: 'reservation', reservation: r as DayReservation },
				size: r.partySize,
				waitedMin: null,
				key: offerKey(table.id, `r:${r.id}`),
			}
		}
	}
	return null
}
