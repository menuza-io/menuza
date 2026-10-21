/**
 * Half-open `[startAt, endAt)` table occupancy index with binary-search
 * overlap and neighbor queries (`architecture.md` §6.4).
 */
export type TableIntervalEntry = {
	ownerId: string
	ownerKind: 'reservation' | 'hold' | 'block'
	tableId: string
	startAt: number
	endAt: number
	hardLocked: boolean
	overbook: boolean
}

export function intervalsOverlap(
	aStart: number,
	aEnd: number,
	bStart: number,
	bEnd: number,
): boolean {
	return aStart < bEnd && bStart < aEnd
}

export class OccupancyIndex {
	private readonly byTable = new Map<string, TableIntervalEntry[]>()

	constructor(entries: readonly TableIntervalEntry[] = []) {
		for (const entry of entries) {
			this.insert(entry)
		}
	}

	clone(): OccupancyIndex {
		const copy = new OccupancyIndex()
		for (const [tableId, list] of this.byTable.entries()) {
			copy.byTable.set(tableId, [...list])
		}
		return copy
	}

	insert(entry: TableIntervalEntry): void {
		if (entry.endAt <= entry.startAt) return
		let list = this.byTable.get(entry.tableId)
		if (!list) {
			list = []
			this.byTable.set(entry.tableId, list)
		}
		// Binary search insertion point by startAt ASC, endAt ASC, ownerId ASC
		let lo = 0
		let hi = list.length
		while (lo < hi) {
			const mid = (lo + hi) >>> 1
			const m = list[mid]!
			if (
				m.startAt < entry.startAt ||
				(m.startAt === entry.startAt && m.endAt < entry.endAt) ||
				(m.startAt === entry.startAt &&
					m.endAt === entry.endAt &&
					m.ownerId.localeCompare(entry.ownerId) <= 0)
			) {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		list.splice(lo, 0, entry)
	}

	removeByOwner(ownerId: string): void {
		for (const [tableId, list] of this.byTable.entries()) {
			const next = list.filter((e) => e.ownerId !== ownerId)
			if (next.length !== list.length) {
				this.byTable.set(tableId, next)
			}
		}
	}

	/**
	 * Return all active entries on `tableId` overlapping `[startAt, endAt)`,
	 * optionally ignoring `ignoreOwnerIds`. Overbook rows count as occupying their
	 * tables so guest channels never borrow capacity from staff overbooks (Invariant I3).
	 */
	overlappingOnTable(
		tableId: string,
		startAt: number,
		endAt: number,
		ignoreOwnerIds?: ReadonlySet<string>,
	): TableIntervalEntry[] {
		const list = this.byTable.get(tableId)
		if (!list || list.length === 0) return []
		const out: TableIntervalEntry[] = []
		// Since intervals may have varying durations, scan entries with entry.startAt < endAt
		for (const entry of list) {
			if (entry.startAt >= endAt) break
			if (ignoreOwnerIds?.has(entry.ownerId)) continue
			if (entry.endAt > startAt) {
				out.push(entry)
			}
		}
		return out
	}

	/**
	 * Fast boolean check whether all `tableIds` are completely free over `[startAt, endAt)`.
	 * Overbook rows count as occupying their tables (Invariant I3).
	 */
	areTablesFree(
		tableIds: readonly string[],
		startAt: number,
		endAt: number,
		ignoreOwnerIds?: ReadonlySet<string>,
	): boolean {
		for (const tableId of tableIds) {
			const list = this.byTable.get(tableId)
			if (!list || list.length === 0) continue
			for (const entry of list) {
				if (entry.startAt >= endAt) break
				if (ignoreOwnerIds?.has(entry.ownerId)) continue
				if (entry.endAt > startAt) return false
			}
		}
		return true
	}

	/**
	 * Return all unique conflicting entries across `tableIds` over `[startAt, endAt)`.
	 */
	conflictsForTables(
		tableIds: readonly string[],
		startAt: number,
		endAt: number,
		ignoreOwnerIds?: ReadonlySet<string>,
	): TableIntervalEntry[] {
		const out: TableIntervalEntry[] = []
		for (const tableId of tableIds) {
			const overlaps = this.overlappingOnTable(
				tableId,
				startAt,
				endAt,
				ignoreOwnerIds,
			)
			for (const entry of overlaps) {
				out.push(entry)
			}
		}
		return out
	}

	/**
	 * Find the nearest preceding end (`prevEnd <= startAt`) and nearest succeeding
	 * start (`nextStart >= endAt`) on `tableId` for gap scoring.
	 */
	neighborBoundsOnTable(
		tableId: string,
		startAt: number,
		endAt: number,
		ignoreOwnerIds?: ReadonlySet<string>,
	): { prevEnd: number | null; nextStart: number | null } {
		const list = this.byTable.get(tableId)
		if (!list || list.length === 0) {
			return { prevEnd: null, nextStart: null }
		}
		let prevEnd: number | null = null
		let nextStart: number | null = null
		for (const entry of list) {
			if (ignoreOwnerIds?.has(entry.ownerId)) continue
			if (entry.endAt <= startAt) {
				if (prevEnd === null || entry.endAt > prevEnd) {
					prevEnd = entry.endAt
				}
			} else if (entry.startAt >= endAt) {
				if (nextStart === null || entry.startAt < nextStart) {
					nextStart = entry.startAt
				}
				break
			}
		}
		return { prevEnd, nextStart }
	}
}
