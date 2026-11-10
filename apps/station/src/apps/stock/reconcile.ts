import { type StationCatalog, type StationRef } from '@repo/inventory'
import { StockApiError, type StockApi } from './api.ts'
import {
	localCounts,
	saveLocalCounts,
	type CountState,
	type LocalCount,
} from './local.ts'
import { db } from '~/lib/db.ts'

/**
 * Keeps this tablet's idea of its counts in line with the region's. The
 * count belongs to the manager: it can be reviewed (`in_review`, late entries
 * still welcome), approved or cancelled (nothing more can be added) without
 * this tablet doing anything, so the tablet asks: after a catalogue refresh,
 * after "I'm done", and when entries are refused because the count closed.
 */

/** Records what the region says about a count this tablet knows by its server id. */
export async function noteCountStatus(
	origin: string,
	ref: Extract<StationRef, { id: string }>,
	status: CountState,
): Promise<void> {
	await db.transaction('rw', db.stockCatalog, async () => {
		const counts = await localCounts(origin)
		let changed = false
		const next = counts.map((count): LocalCount => {
			if (!('id' in count.ref) || count.ref.id !== ref.id) return count
			if ((count.serverStatus ?? 'counting') === status) return count
			changed = true
			if (status === 'counting') {
				const { serverStatus: ignoredStatus, ...rest } = count
				return rest
			}
			return { ...count, serverStatus: status }
		})
		if (changed) await saveLocalCounts(origin, next)
	})
}

/** Asks the region for one count's state (its counting sheet carries the summary) and records it. Never throws. */
export async function refreshCountStatus(
	api: StockApi,
	origin: string,
	countId: string,
): Promise<CountState | null> {
	try {
		const sheet = await api.countSheet(countId)
		await noteCountStatus(origin, { id: countId }, sheet.count.status)
		return sheet.count.status
	} catch (failure) {
		// The region no longer has it: nothing can be added, so it is as good as cancelled.
		if (failure instanceof StockApiError && failure.status === 404) {
			await noteCountStatus(origin, { id: countId }, 'cancelled')
			return 'cancelled'
		}
		return null
	}
}

/**
 * After a catalogue refresh: a count the catalogue lists as in progress is
 * `counting`; any other count this tablet knows by id is asked about
 * (sequentially, there are few) so a count sent for review, approved or
 * cancelled elsewhere is recognised.
 */
export async function reconcileCounts(
	api: StockApi,
	origin: string,
	catalog: Pick<StationCatalog, 'counts'>,
): Promise<void> {
	for (const count of await localCounts(origin)) {
		if (!('id' in count.ref) || count.startFailed) continue
		const id = count.ref.id
		const listed = catalog.counts.find((entry) => entry.id === id)
		if (listed) await noteCountStatus(origin, { id }, listed.status)
		else await refreshCountStatus(api, origin, id)
	}
}
