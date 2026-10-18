import { type BookedUnitFact, type DemandUnit } from '@repo/staffing'
import { type StaffDb } from './staff-audit.ts'

/**
 * Where the demand guide and the forecast read how busy a scope is, one source
 * per unit: `orders` (the order source, see `order-source.ts`) and `visits`
 * (people booked or seated). The generic Staff module registers none; a
 * vertical registers its sources once at startup, in both the Node and the
 * Workers entry points. A source returns counts for one scope and window,
 * never a person, and registering one never changes where labor sales or the
 * report catalog come from (that stays `hasOrderSource()`).
 */

/** Counted units of one scope in a 15-minute bucket. */
export type DemandBucketRow = { bucket: number; units: number }

export type DemandSource = {
	/** `orders` or `visits`: also the key of its standards. */
	id: string
	unit: DemandUnit
	/**
	 * Counted units that happened in `[fromSeconds, toSeconds)`, grouped into
	 * buckets of 15 minutes aligned `alignSeconds` past the epoch.
	 */
	loadBuckets(
		db: StaffDb,
		scopeId: string,
		window: { fromSeconds: number; toSeconds: number; alignSeconds: number },
	): Promise<DemandBucketRow[]>
	/** Units already booked for an hour in `[fromSeconds, toSeconds)`, in local hours. */
	loadBooked(
		db: StaffDb,
		scopeId: string,
		window: { fromSeconds: number; toSeconds: number; timeZone: string },
	): Promise<BookedUnitFact[]>
}

const sources = new Map<string, DemandSource>()

/** Registers (or replaces) a source; `null` removes the source with that id. */
export function registerDemandSource(
	source: DemandSource | { id: string; remove: true },
) {
	if ('remove' in source) {
		sources.delete(source.id)
		return
	}
	sources.set(source.id, source)
}

export function getDemandSource(id: string): DemandSource | undefined {
	return sources.get(id)
}

/** Every registered source, orders first and the rest by id. */
export function listDemandSources(): DemandSource[] {
	return [...sources.values()].sort(
		(a, b) =>
			Number(b.id === 'orders') - Number(a.id === 'orders') ||
			a.id.localeCompare(b.id),
	)
}

export function clearDemandSourcesForTest() {
	sources.clear()
}
