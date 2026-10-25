import { inService, isCounted, liveServices } from './book.ts'
import {
	isOnFloor,
	rooms,
	type DayArea,
	type DayFeed,
	type DayReservation,
	type DayTable,
} from './feed.ts'
import { zonedEpoch } from './zoned.ts'

/**
 * The book as a grid: tables as rows grouped by room, time across the top,
 * bookings as bars. This is the maths behind it (where a bar starts and how
 * wide it is, which bars share a table and stack, what the bottom row counts),
 * kept apart from the screen so it is tested on its own. All times here are
 * minutes after the location's local midnight.
 */

/** The grid's resolution. */
export const SLOT_MIN = 15
/** The grid never shows less than this much of the day. */
const MIN_SPAN_MIN = 180
/** Without services or bookings the grid shows a working day. */
const FALLBACK_RANGE = { startMin: 11 * 60, endMin: 23 * 60 }

export type TimelineRange = { startMin: number; endMin: number }

/** A booking that takes a place on the grid (not cancelled, not a no-show). */
export const onGrid = (r: Pick<DayReservation, 'status'>) => isCounted(r)

/** Minutes a booking lasts, from its own start and end. */
const lengthOf = (r: Pick<DayReservation, 'startAt' | 'endAt'>) =>
	Math.max(SLOT_MIN, Math.round((r.endAt - r.startAt) / 60_000))

/** The instant of the feed's local midnight. */
export function dayOrigin(feed: Pick<DayFeed, 'businessDate' | 'settings'>) {
	const zone = feed.settings?.timeZone || 'UTC'
	try {
		return zonedEpoch(feed.businessDate, 0, zone)
	} catch {
		return zonedEpoch(feed.businessDate, 0, 'UTC')
	}
}

/**
 * The hours the grid covers. From the services' hours when the feed has them
 * (the chosen one, else the whole day), else from the bookings with an hour of
 * room on both sides; whole hours, never under three.
 */
export function timelineRange(
	feed: Pick<DayFeed, 'services' | 'reservations'>,
	serviceId: string | null = null,
): TimelineRange {
	const services = liveServices(feed)
	const chosen = serviceId ? services.find((s) => s.id === serviceId) : null
	const bookings = feed.reservations.filter(
		(r) => onGrid(r) && inService(feed, r, serviceId),
	)
	let lo: number | null = null
	let hi: number | null = null
	if (chosen) {
		lo = chosen.firstSeatingMin
		hi = chosen.endMin
	} else if (services.length > 0) {
		lo = Math.min(...services.map((s) => s.firstSeatingMin))
		hi = Math.max(...services.map((s) => s.endMin))
	}
	if (bookings.length > 0) {
		const first = Math.min(...bookings.map((r) => r.localStartMin))
		const last = Math.max(...bookings.map((r) => r.localStartMin + lengthOf(r)))
		// Services give the hours; bookings only widen them (a late stay, an odd hour).
		// With no services, they give the hours with an hour to spare.
		lo = lo === null ? first - 60 : Math.min(lo, first)
		hi = hi === null ? last + 60 : Math.max(hi, last)
	}
	if (lo === null || hi === null) return { ...FALLBACK_RANGE }
	const startMin = Math.max(0, Math.floor(lo / 60) * 60)
	const endMin = Math.max(startMin + MIN_SPAN_MIN, Math.ceil(hi / 60) * 60)
	return { startMin, endMin }
}

export type TimelineBar = {
	reservation: DayReservation
	/** Minutes after local midnight, clipped to the range. */
	startMin: number
	endMin: number
	/** The booking starts before / runs past what the grid shows. */
	clippedStart: boolean
	clippedEnd: boolean
	/** Seated and still there after the booked end: the bar runs to now. */
	overrun: boolean
	/** Which stacked line it sits on when bars share a table. */
	lane: number
}

export type TimelineBlock = {
	id: string
	startMin: number
	endMin: number
	reason: string | null
}

export type TimelineRow = {
	key: string
	/** Null for the "No table" row. */
	table: DayTable | null
	bars: TimelineBar[]
	blocks: TimelineBlock[]
	/** How many lines tall the row is (bars that overlap stack). */
	lanes: number
}

export type TimelineGroup = {
	key: string
	/** Null for the "No table" row. */
	area: DayArea | null
	rows: TimelineRow[]
}

/** Gives each item a line so that items on the same line never overlap. */
export function packLanes<T extends { startMin: number; endMin: number }>(
	items: T[],
): Array<T & { lane: number }> {
	const ends: number[] = []
	return [...items]
		.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
		.map((item) => {
			let lane = ends.findIndex((end) => end <= item.startMin)
			if (lane === -1) lane = ends.length
			ends[lane] = item.endMin
			return { ...item, lane }
		})
}

const labelOrder = (a: DayTable, b: DayTable) =>
	a.label.localeCompare(b.label, undefined, { numeric: true })

/**
 * Rows for the grid: first the bookings with no table, then each room's tables
 * in label order, each with its bars and the blocks that close it. A party
 * seated on several tables has a bar on each.
 */
export function layoutTimeline(
	feed: DayFeed,
	range: TimelineRange,
	options: { serviceId?: string | null; now?: number | null } = {},
): TimelineGroup[] {
	const { serviceId = null, now = null } = options
	const origin = dayOrigin(feed)
	const nowMin = now === null ? null : (now - origin) / 60_000
	const bookings = feed.reservations.filter(
		(r) => onGrid(r) && inService(feed, r, serviceId),
	)
	const barFor = (r: DayReservation): Omit<TimelineBar, 'lane'> | null => {
		const scheduledEnd = r.localStartMin + lengthOf(r)
		const overrun = nowMin !== null && isOnFloor(r) && nowMin > scheduledEnd
		const end = overrun ? Math.ceil(nowMin) : scheduledEnd
		if (end <= range.startMin || r.localStartMin >= range.endMin) return null
		return {
			reservation: r,
			startMin: Math.max(r.localStartMin, range.startMin),
			endMin: Math.min(end, range.endMin),
			clippedStart: r.localStartMin < range.startMin,
			clippedEnd: end > range.endMin,
			overrun,
		}
	}
	const rowOf = (
		key: string,
		table: DayTable | null,
		list: DayReservation[],
		blocks: TimelineBlock[],
	): TimelineRow => {
		const bars = packLanes(
			list.flatMap((r) => {
				const bar = barFor(r)
				return bar ? [bar] : []
			}),
		)
		return {
			key,
			table,
			bars,
			blocks,
			lanes: Math.max(1, ...bars.map((bar) => bar.lane + 1)),
		}
	}

	const groups: TimelineGroup[] = []
	const unassigned = bookings.filter((r) => r.tableIds.length === 0)
	if (unassigned.length > 0) {
		const row = rowOf('none', null, unassigned, [])
		if (row.bars.length > 0)
			groups.push({ key: 'none', area: null, rows: [row] })
	}
	for (const area of rooms(feed)) {
		const tables = feed.tables
			.filter((t) => t.areaId === area.id && !t.archivedAt)
			.sort(labelOrder)
		groups.push({
			key: area.id,
			area,
			rows: tables.map((table) =>
				rowOf(
					table.id,
					table,
					bookings.filter((r) => r.tableIds.includes(table.id)),
					feed.blocks
						.filter((b) =>
							b.tableId ? b.tableId === table.id : b.areaId === table.areaId,
						)
						.flatMap((b) => {
							const startMin = Math.max(
								range.startMin,
								(b.startAt - origin) / 60_000,
							)
							const endMin = Math.min(range.endMin, (b.endAt - origin) / 60_000)
							return endMin > startMin
								? [{ id: b.id, startMin, endMin, reason: b.reason ?? null }]
								: []
						}),
				),
			),
		})
	}
	return groups
}

/** Where "now" falls, as minutes from the start of the range (null outside it). */
export function nowOffset(
	now: number,
	feed: Pick<DayFeed, 'businessDate' | 'settings'>,
	range: TimelineRange,
): number | null {
	const minutes = (now - dayOrigin(feed)) / 60_000
	return minutes >= range.startMin && minutes <= range.endMin
		? minutes - range.startMin
		: null
}

export type SlotCell = {
	startMin: number
	spanMin: number
	covers: number
	parties: number
	/** What the slot can take, when the feed's pacing says. */
	cap: number | null
}

export type SlotTotals = {
	/** Per slot against capacity (pacing), or per hour when the feed has none. */
	kind: 'slots' | 'hours'
	cells: SlotCell[]
	parties: number
	covers: number
}

/**
 * The bottom row: covers (and parties) starting in each slot against what the
 * slot can take, from the feed's pacing; with no pacing, covers per hour.
 */
export function slotTotals(
	feed: Pick<DayFeed, 'reservations' | 'pacing' | 'services'>,
	range: TimelineRange,
	serviceId: string | null = null,
): SlotTotals {
	const bookings = feed.reservations.filter(
		(r) => onGrid(r) && inService(feed, r, serviceId),
	)
	const pacing = new Map(
		feed.pacing
			.filter(
				(p) =>
					p.localMin >= range.startMin &&
					p.localMin < range.endMin &&
					(serviceId === null || !p.serviceId || p.serviceId === serviceId),
			)
			.map((p) => [p.localMin, p]),
	)
	const usePacing = pacing.size > 0
	const step = usePacing ? SLOT_MIN : 60
	const cells: SlotCell[] = []
	for (let start = range.startMin; start < range.endMin; start += step) {
		const starting = bookings.filter(
			(r) => r.localStartMin >= start && r.localStartMin < start + step,
		)
		const pace = pacing.get(start)
		cells.push({
			startMin: start,
			spanMin: step,
			covers: pace ? pace.bookedCovers : sum(starting),
			parties: pace ? pace.partyCount : starting.length,
			cap: pace?.maxCovers ?? null,
		})
	}
	return {
		kind: usePacing ? 'slots' : 'hours',
		cells,
		parties: bookings.length,
		covers: sum(bookings),
	}
}

const sum = (list: Array<{ partySize: number }>) =>
	list.reduce((total, r) => total + r.partySize, 0)

/** The slot under a pointer: `offsetPx` from the start of the track, in slots of `slotPx`. */
export function minuteAt(
	offsetPx: number,
	slotPx: number,
	range: TimelineRange,
): number {
	const slot = Math.max(0, Math.floor(offsetPx / slotPx))
	return Math.min(range.endMin - SLOT_MIN, range.startMin + slot * SLOT_MIN)
}

/** Formats minutes after midnight the way the stand shows times ("7:30 PM"). */
export function minutesFormatter(locale: string) {
	const format = new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	})
	return (minutes: number) =>
		format.format(Date.UTC(2000, 0, 1, 0, ((minutes % 1440) + 1440) % 1440))
}
