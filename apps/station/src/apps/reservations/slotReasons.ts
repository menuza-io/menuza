import { type Availability, type DayFeed } from './feed.ts'
import { configuredCap, mergePacing } from './timeline.ts'

/**
 * Why a time in the booking form is not open, in the few words the form has
 * room for. The server's availability only says a slot is open or not, so the
 * reason is read from what the stand knows: no table or combination seats a
 * party this big, the slot's covers are used up (for the day on screen), or
 * the slot is held for someone else. Anything else is just "not open".
 */
export type SlotReason = 'big' | 'full' | 'held' | 'closed'

type Slot = Availability['slots'][number]

/** The most any single table or defined combination seats at this location. */
export function biggestSeating(feed: Pick<DayFeed, 'tables' | 'combos'>) {
	return Math.max(
		0,
		...feed.tables.filter((t) => !t.archivedAt).map((t) => t.maxCovers),
		...feed.combos.filter((c) => !c.archivedAt).map((c) => c.maxCovers),
	)
}

export function slotReason({
	slot,
	partySize,
	date,
	feed,
}: {
	slot: Pick<Slot, 'localStartMin'> & { held?: unknown }
	partySize: number
	/** The day the form is booking. */
	date: string
	feed: Pick<DayFeed, 'tables' | 'combos' | 'pacing' | 'businessDate'> | null
}): SlotReason {
	if (feed && partySize > biggestSeating(feed)) return 'big'
	if (slot.held === true) return 'held'
	if (feed && feed.businessDate === date) {
		// Read as the timeline's bottom row reads it: rows for one minute merged
		// (they repeat the same bookings), and only a cap someone configured (the
		// server's default cap says nothing about pace).
		const bucket = mergePacing(
			feed.pacing.filter((p) => p.localMin === slot.localStartMin),
		)
		const totalSeats = feed.tables
			.filter((t) => !t.archivedAt)
			.reduce((sum, t) => sum + t.maxCovers, 0)
		const cap = configuredCap(bucket ?? undefined, totalSeats)
		if (bucket && cap !== null && bucket.bookedCovers + partySize > cap)
			return 'full'
	}
	return 'closed'
}
