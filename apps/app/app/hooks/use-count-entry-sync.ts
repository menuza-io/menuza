import { countEntriesResultSchema } from '@repo/inventory'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	type CountEntrySync,
	type CountSyncSnapshot,
	createCountEntrySync,
	type EntryResult,
	type QueuedEntry,
	queueStorageKey,
} from '#app/utils/inventory/count-queue.ts'

/** How often a count with unsent entries tries again on its own. */
export const COUNT_RETRY_MS = 15_000

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage
	} catch {
		return null
	}
}

type Post = (entries: QueuedEntry[]) => Promise<EntryResult>

/**
 * Sends a batch of entries. The region refuses a whole request with a 400 when
 * one entry is unusable, which would keep every later entry from ever
 * landing: a refused batch is split until the unusable entry stands alone and
 * is reported as refused for good. Any other failure (no signal, a 5xx, a
 * 401) rejects, and the queue keeps everything for the next attempt.
 */
export async function sendCountEntries(
	post: Post,
	entries: QueuedEntry[],
): Promise<EntryResult> {
	try {
		return await post(entries)
	} catch (error) {
		if (!(error instanceof OperatorRequestError) || error.status !== 400) {
			throw error
		}
		if (entries.length === 1) {
			return {
				accepted: [],
				duplicates: [],
				refused: [{ clientId: entries[0]!.clientId, code: 'invalid_request' }],
			}
		}
		const middle = Math.ceil(entries.length / 2)
		const first = await sendCountEntries(post, entries.slice(0, middle))
		const second = await sendCountEntries(post, entries.slice(middle))
		return {
			accepted: [...first.accepted, ...second.accepted],
			duplicates: [...first.duplicates, ...second.duplicates],
			refused: [...first.refused, ...second.refused],
		}
	}
}

/**
 * The offline-safe entry queue of one count, as React state: unsent entries
 * live in `localStorage` keyed by the count, are sent as they are typed, and
 * go again when the connection returns, the tab is shown, or on a timer.
 */
export function useCountEntrySync({
	orgSlug,
	countId,
	enabled,
}: {
	orgSlug: string
	countId: string
	/** Sending stops once the count no longer takes entries. */
	enabled: boolean
}): { sync: CountEntrySync; snapshot: CountSyncSnapshot } {
	const { request } = useInventoryClient()
	const requestRef = useRef(request)
	requestRef.current = request

	const sync = useMemo(
		() =>
			createCountEntrySync({
				storage: browserStorage(),
				key: queueStorageKey(orgSlug, countId),
				send: (entries) =>
					sendCountEntries(async (batch) => {
						const body = {
							entries: batch.map(({ queuedAt: _queuedAt, ...entry }) => entry),
						}
						return countEntriesResultSchema.parse(
							await requestRef.current(
								`/counts/${encodeURIComponent(countId)}/entries`,
								{ method: 'POST', body: JSON.stringify(body) },
							),
						)
					}, entries),
			}),
		[orgSlug, countId],
	)
	const snapshot = useSyncExternalStore(
		sync.subscribe,
		sync.getSnapshot,
		sync.getSnapshot,
	)
	const waiting = snapshot.pending.length > 0

	useEffect(() => {
		const key = queueStorageKey(orgSlug, countId)
		const onStorage = (event: StorageEvent) => {
			if (event.key === key) sync.reloadFromStorage()
		}
		window.addEventListener('storage', onStorage)
		return () => window.removeEventListener('storage', onStorage)
	}, [orgSlug, countId, sync])

	useEffect(() => {
		if (!enabled) return
		const flush = () => void sync.flush()
		flush()
		const onVisible = () => {
			if (document.visibilityState === 'visible') flush()
		}
		window.addEventListener('online', flush)
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			window.removeEventListener('online', flush)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [enabled, sync])

	useEffect(() => {
		if (!enabled || !waiting) return
		const timer = setInterval(() => void sync.flush(), COUNT_RETRY_MS)
		return () => clearInterval(timer)
	}, [enabled, waiting, sync])

	return { sync, snapshot }
}
