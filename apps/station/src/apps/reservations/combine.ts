import {
	fitVerdict,
	isFreeKind,
	tableState,
	type DayCombo,
	type DayFeed,
	type DayTable,
	type FitVerdict,
	type PartyToPlace,
	type TableState,
} from './feed.ts'

/**
 * Seating a large party on several tables, and saying what to do when nothing
 * seats them alone: which tables join (a defined combination, or tables that
 * stand side by side), what a group seats and whether it is free for the
 * party's time, and the best group to start from. Pure, so each rule is
 * tested apart from the floor that draws it.
 */

/** A party this size or bigger is "a large party": the book marks it so it is never a surprise. */
export const LARGE_PARTY_MIN = 8

export const isLargeParty = (partySize: number) => partySize >= LARGE_PARTY_MIN

/** The most tables a till joins for one party (a longer run is a manager's floor plan). */
export const MAX_COMBINED_TABLES = 4

type TableLike = Pick<DayTable, 'id' | 'areaId' | 'x' | 'y' | 'w' | 'h'>

/** Seats of a group: what its tables seat together. */
export const groupSeats = (
	tables: ReadonlyArray<Pick<DayTable, 'maxCovers'>>,
) => tables.reduce((sum, table) => sum + table.maxCovers, 0)

const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id) => b.includes(id))

/** The defined combination these tables are exactly (any order), if one is. */
export function comboFor(
	feed: Pick<DayFeed, 'combos'>,
	tableIds: readonly string[],
): DayCombo | null {
	if (tableIds.length < 2) return null
	return (
		feed.combos.find(
			(combo) => !combo.archivedAt && sameSet(combo.tableIds, tableIds),
		) ?? null
	)
}

/**
 * The gap between two tables on the plan, in plan units (0 when they touch or
 * overlap). Turning is ignored: neighbours are judged by where they stand.
 */
export function gapBetween(a: TableLike, b: TableLike): number {
	const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w))
	const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h))
	return Math.hypot(dx, dy)
}

/**
 * Whether two tables are the sort that go together: in one room, and either
 * the two halves of a defined combination or standing side by side (a gap no
 * wider than the smaller table's longer side). A room nobody has drawn has no
 * places to compare: its tables are one grid, so any two count.
 */
export function neighbours(
	a: TableLike,
	b: TableLike,
	feed: Pick<DayFeed, 'combos' | 'tables'>,
): boolean {
	if (a.id === b.id || a.areaId !== b.areaId) return false
	if (
		feed.combos.some(
			(combo) =>
				!combo.archivedAt &&
				combo.tableIds.includes(a.id) &&
				combo.tableIds.includes(b.id),
		)
	)
		return true
	const room = feed.tables.filter((t) => t.areaId === a.areaId && !t.archivedAt)
	const drawn = new Set(room.map((t) => `${t.x}:${t.y}`)).size > 1
	if (!drawn) return true
	const reach = Math.min(Math.max(a.w, a.h), Math.max(b.w, b.h))
	return gapBetween(a, b) <= reach
}

/** A table that has no part in a group's reason to exist: free for the party's whole time. */
export type GroupVerdict =
	| { fits: true; seats: number }
	/** Every table is free, but together they do not seat the party. */
	| { fits: false; why: 'small'; seats: number }
	/** One of the tables cannot be had: the table, and why (the single-table verdict's reason). */
	| {
			fits: false
			why: 'taken' | 'resetting' | 'booked' | 'blocked'
			tableId: string
			at?: number
			until?: number
	  }

/**
 * Whether a party can sit at all of these tables: every table is free for the
 * party's window (by the server's own check, with the party's seats left out
 * of it), and together they seat the party. A table is judged for one cover:
 * how many it seats counts for the group, not for each table.
 */
export function groupVerdict(
	tables: readonly DayTable[],
	feed: Pick<DayFeed, 'reservations' | 'blocks'>,
	party: PartyToPlace,
	now: number,
): GroupVerdict {
	const alone = { ...party, partySize: 1 }
	for (const table of tables) {
		const state = tableState(table, feed, now)
		const verdict = fitVerdict(table, state, alone, now, feed)
		if (!verdict.fits)
			return (
				reasonOf(verdict, table.id) ?? {
					fits: false,
					why: 'taken',
					tableId: table.id,
				}
			)
	}
	const seats = groupSeats(tables)
	return seats >= party.partySize
		? { fits: true, seats }
		: { fits: false, why: 'small', seats }
}

function reasonOf(verdict: FitVerdict, tableId: string): GroupVerdict | null {
	if (verdict.fits || verdict.why === 'small') return null
	if (verdict.why === 'resetting')
		return { fits: false, why: 'resetting', tableId, until: verdict.until }
	if (verdict.why === 'booked')
		return { fits: false, why: 'booked', tableId, at: verdict.at }
	if (verdict.why === 'blocked')
		return { fits: false, why: 'blocked', tableId, at: verdict.at }
	return { fits: false, why: 'taken', tableId }
}

/**
 * What a table is, to a host who is joining tables: already in the group, free
 * and next to it (it can be added), or something that says why not.
 */
export type JoinVerdict =
	| { kind: 'selected' }
	| { kind: 'addable' }
	/** Free, but not beside the tables already chosen (or in another room). */
	| { kind: 'far' }
	/** Not free for the party's time: taken, booked, being reset, taped off. */
	| { kind: 'blocked'; verdict: Exclude<FitVerdict, { fits: true }> }
	/** The group is as long as a till makes one. */
	| { kind: 'full' }

/** How the floor reads one table while the host is joining tables for a party. */
export function joinVerdict(input: {
	table: DayTable
	state: TableState
	selected: readonly DayTable[]
	feed: Pick<DayFeed, 'reservations' | 'blocks' | 'combos' | 'tables'>
	party: PartyToPlace
	now: number
}): JoinVerdict {
	const { table, state, selected, feed, party, now } = input
	if (selected.some((t) => t.id === table.id)) return { kind: 'selected' }
	const alone = fitVerdict(table, state, { ...party, partySize: 1 }, now, feed)
	if (!alone.fits)
		return {
			kind: 'blocked',
			verdict: alone as Exclude<FitVerdict, { fits: true }>,
		}
	if (selected.length >= MAX_COMBINED_TABLES) return { kind: 'full' }
	if (selected.length > 0 && !selected.some((t) => neighbours(t, table, feed)))
		return { kind: 'far' }
	return { kind: 'addable' }
}

export type SeatGroup = {
	tableIds: string[]
	tables: DayTable[]
	seats: number
	/** The defined combination this group is, when it is one. */
	comboId: string | null
}

const byLabel = (a: DayTable, b: DayTable) =>
	a.label.localeCompare(b.label, undefined, { numeric: true })

const asGroup = (
	tables: DayTable[],
	feed: Pick<DayFeed, 'combos'>,
): SeatGroup => {
	const sorted = [...tables].sort(byLabel)
	const ids = sorted.map((t) => t.id)
	return {
		tableIds: ids,
		tables: sorted,
		seats: groupSeats(sorted),
		comboId: comboFor(feed, ids)?.id ?? null,
	}
}

/**
 * The group to start from for a party no single table seats: a defined
 * combination that is free and seats them (the smallest that does), else the
 * fewest free tables that stand together and seat them (least left over), in
 * one room. Null when no such group is free.
 */
export function bestGroup(
	feed: Pick<DayFeed, 'reservations' | 'blocks' | 'combos' | 'tables'>,
	party: PartyToPlace,
	now: number,
): SeatGroup | null {
	const live = feed.tables.filter((t) => !t.archivedAt)
	const alone = { ...party, partySize: 1 }
	const free = live.filter(
		(table) =>
			fitVerdict(table, tableState(table, feed, now), alone, now, feed).fits,
	)
	const freeIds = new Set(free.map((t) => t.id))
	const byId = new Map(live.map((t) => [t.id, t]))

	const defined = feed.combos
		.filter(
			(combo) =>
				!combo.archivedAt &&
				combo.tableIds.length >= 2 &&
				combo.maxCovers >= party.partySize &&
				combo.tableIds.every((id) => freeIds.has(id)),
		)
		.map((combo) => ({
			combo,
			tables: combo.tableIds
				.map((id) => byId.get(id))
				.filter((t): t is DayTable => t !== undefined),
		}))
		.filter(({ tables, combo }) => tables.length === combo.tableIds.length)
		.sort(
			(a, b) =>
				groupSeats(a.tables) - groupSeats(b.tables) ||
				a.tables.length - b.tables.length,
		)[0]
	if (defined && groupSeats(defined.tables) >= party.partySize)
		return asGroup(defined.tables, feed)

	let best: DayTable[] | null = null
	const better = (candidate: DayTable[]) => {
		if (!best) return true
		if (candidate.length !== best.length) return candidate.length < best.length
		return groupSeats(candidate) < groupSeats(best)
	}
	// Grow a group from each free table, always adding the neighbour that seats most.
	for (const seed of free) {
		const group = [seed]
		while (
			groupSeats(group) < party.partySize &&
			group.length < MAX_COMBINED_TABLES
		) {
			const next = free
				.filter(
					(t) =>
						!group.some((g) => g.id === t.id) &&
						group.some((g) => neighbours(g, t, feed)),
				)
				.sort((a, b) => b.maxCovers - a.maxCovers || byLabel(a, b))[0]
			if (!next) break
			group.push(next)
		}
		if (groupSeats(group) >= party.partySize && better(group)) best = group
	}
	return best ? asGroup(best, feed) : null
}

/** How many tables in each room seat the party on their own (for the room tabs). */
export function fitsByRoom(
	feed: Pick<DayFeed, 'reservations' | 'blocks' | 'tables'>,
	party: PartyToPlace,
	now: number,
): Map<string, number> {
	const counts = new Map<string, number>()
	for (const table of feed.tables) {
		if (table.archivedAt) continue
		const fitsHere = fitVerdict(
			table,
			tableState(table, feed, now),
			party,
			now,
			feed,
		).fits
		counts.set(
			table.areaId,
			(counts.get(table.areaId) ?? 0) + (fitsHere ? 1 : 0),
		)
	}
	return counts
}

/** What the stand says when nothing seats the party alone, and what it can offer. */
export type NoFit = {
	/** No table, in any room, seats the party by itself for their time. */
	none: boolean
	/** The tables to join (null when no free group seats them either). */
	group: SeatGroup | null
	/** The most any single table here seats (to say "No single table seats 9"). */
	biggest: number
	/** The party is bigger than any single table: said as that, not as a floor that is busy. */
	tooBig: boolean
}

export function noFitOf(
	feed: Pick<DayFeed, 'reservations' | 'blocks' | 'combos' | 'tables'>,
	party: PartyToPlace,
	now: number,
): NoFit {
	const counts = fitsByRoom(feed, party, now)
	const none = [...counts.values()].every((count) => count === 0)
	const biggest = Math.max(
		0,
		...feed.tables.filter((t) => !t.archivedAt).map((t) => t.maxCovers),
	)
	return {
		none,
		group: none ? bestGroup(feed, party, now) : null,
		biggest,
		tooBig: party.partySize > biggest,
	}
}

/** Free tables only: what a group's picker can offer at all (not taken, booked, resetting or taped). */
export const isJoinable = (state: TableState) => isFreeKind(state.kind)

/** The seats a group seats, and how many it is short or has to spare, for the chip. */
export function seatSummary(
	tables: readonly Pick<DayTable, 'maxCovers'>[],
	partySize: number,
) {
	const seats = groupSeats(tables)
	return {
		seats,
		short: Math.max(0, partySize - seats),
		ok: seats >= partySize,
	}
}
