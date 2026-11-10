import { type UnitRef } from '@repo/inventory'

/**
 * The offline queue behind the counting screen. A walk-in fridge has no
 * signal, so a count must never look saved when it is not:
 *
 * - every entry is written to `localStorage` (keyed by the count) BEFORE it is
 *   sent, so a dropped connection, a closed tab or a reload loses nothing;
 * - entries go to the region in order, one request at a time, and leave the
 *   queue only when the region answers for them (accepted, a replay of the
 *   same `clientId`, or refused for good);
 * - a request that fails keeps every entry queued and marks it failed until
 *   the next attempt (a new entry, "Retry", the browser coming back online);
 * - an entry that replaces a still unsent entry for the same item, area and
 *   unit takes its place, so the queue never grows past the number of fields
 *   on the sheet.
 *
 * It is plain TypeScript with injected storage and transport so it can be
 * tested without a browser; `useCountEntrySync` wraps it for React.
 */

export type QueuedEntry = {
	/** Idempotency key: a replay of the same id is reported as a duplicate. */
	clientId: string
	itemId: string
	areaId: string | null
	/** Typed amount in `unit`; `null` clears this counter's entry. */
	amount: number | null
	unit: UnitRef
	queuedAt: number
}

export type EntryResult = {
	accepted: ReadonlyArray<{ clientId: string }>
	duplicates: readonly string[]
	refused: ReadonlyArray<{ clientId: string; code: string }>
}

/** The region takes up to 200 entries per request. */
export const MAX_ENTRIES_PER_REQUEST = 200

/** What one field on the sheet is: an item in an area, in one unit. */
export function entrySlotKey(
	entry: Pick<QueuedEntry, 'itemId' | 'areaId' | 'unit'>,
): string {
	return `${entry.itemId}|${entry.areaId ?? ''}|${entry.unit}`
}

export function queueStorageKey(orgSlug: string, countId: string): string {
	return `inventory-count-queue:${orgSlug}:${countId}`
}

/** `entry` joins the queue; an unsent entry for the same slot or `clientId` is replaced. */
export function enqueueEntry(
	queue: readonly QueuedEntry[],
	entry: QueuedEntry,
): QueuedEntry[] {
	const slot = entrySlotKey(entry)
	return [
		...queue.filter(
			(queued) =>
				queued.clientId !== entry.clientId && entrySlotKey(queued) !== slot,
		),
		entry,
	]
}

export function removeEntries(
	queue: readonly QueuedEntry[],
	clientIds: ReadonlySet<string>,
): QueuedEntry[] {
	return queue.filter((entry) => !clientIds.has(entry.clientId))
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isQueuedEntry(value: unknown): value is QueuedEntry {
	if (typeof value !== 'object' || value === null) return false
	const entry = value as Partial<QueuedEntry>
	return (
		typeof entry.clientId === 'string' &&
		typeof entry.itemId === 'string' &&
		(entry.areaId === null || typeof entry.areaId === 'string') &&
		(entry.amount === null ||
			(typeof entry.amount === 'number' && Number.isFinite(entry.amount))) &&
		typeof entry.unit === 'string' &&
		typeof entry.queuedAt === 'number'
	)
}

/** What was left unsent, or nothing when storage is blocked or holds junk. */
export function readQueue(
	storage: Pick<Storage, 'getItem'> | null,
	key: string,
): QueuedEntry[] {
	if (!storage) return []
	try {
		const raw = storage.getItem(key)
		const parsed: unknown = raw ? JSON.parse(raw) : []
		if (!Array.isArray(parsed)) return []
		return parsed.filter(isQueuedEntry)
	} catch {
		return []
	}
}

/** Persist the queue; storage that is full or blocked just means no survival of a reload. */
export function writeQueue(
	storage: StorageLike | null,
	key: string,
	queue: readonly QueuedEntry[],
): void {
	if (!storage) return
	try {
		if (queue.length === 0) storage.removeItem(key)
		else storage.setItem(key, JSON.stringify(queue))
	} catch {
		// Storage unavailable: the entries still go to the region from memory.
	}
}

/** How many entries for `countId` are waiting in `localStorage` on this device. */
export function pendingCountEntriesCount(
	storage: Pick<Storage, 'getItem'> | null,
	orgSlug: string,
	countId: string,
): number {
	return readQueue(storage, queueStorageKey(orgSlug, countId)).length
}

export type SettledBatch = {
	/** Entries the region took (or already had). */
	done: QueuedEntry[]
	/** Entries it will never take, with its reason. */
	refused: Array<{ entry: QueuedEntry; code: string }>
	/** Entries it did not answer for: they stay queued. */
	unanswered: QueuedEntry[]
	/** The count no longer takes entries. */
	closed: boolean
}

/** Sorts a batch into what the region's answer settled and what it did not. */
export function settleBatch(
	sent: readonly QueuedEntry[],
	result: EntryResult,
): SettledBatch {
	const refusedCodes = new Map(
		result.refused.map((item) => [item.clientId, item.code]),
	)
	const takenIds = new Set([
		...result.accepted.map((item) => item.clientId),
		...result.duplicates,
	])
	const batch: SettledBatch = {
		done: [],
		refused: [],
		unanswered: [],
		closed: false,
	}
	for (const entry of sent) {
		const code = refusedCodes.get(entry.clientId)
		if (takenIds.has(entry.clientId)) batch.done.push(entry)
		else if (code !== undefined) {
			batch.refused.push({ entry, code })
			if (code === 'count_closed') batch.closed = true
		} else batch.unanswered.push(entry)
	}
	return batch
}

export type CountSyncSnapshot = {
	/** Everything the region has not confirmed yet (queued, sending or failed). */
	pending: readonly QueuedEntry[]
	/** `clientId`s in a request right now. */
	sending: ReadonlySet<string>
	/** `clientId`s whose last attempt did not reach the region. */
	failed: ReadonlySet<string>
	/** Slots (`entrySlotKey`) the region confirmed and nothing newer has replaced. */
	saved: ReadonlySet<string>
	/** Entries the region refused for good (not found, wrong unit). */
	refused: ReadonlyArray<{ entry: QueuedEntry; code: string }>
	/** The region says the count no longer takes entries. */
	closed: boolean
}

export type CountEntrySync = {
	getSnapshot: () => CountSyncSnapshot
	subscribe: (listener: () => void) => () => void
	/** Queue an entry (persisted at once) and start sending. Resolves when the queue is quiet. */
	submit: (entry: Omit<QueuedEntry, 'queuedAt'>) => Promise<void>
	/** Send whatever is queued now: Retry, reconnect, page load. */
	flush: () => Promise<void>
	/** Reload the queue from storage when another tab writes to the same key. */
	reloadFromStorage: () => void
}

export function createCountEntrySync(options: {
	storage: StorageLike | null
	key: string
	send: (entries: QueuedEntry[]) => Promise<EntryResult>
	now?: () => number
}): CountEntrySync {
	const { storage, key, send } = options
	const now = options.now ?? (() => Date.now())
	const listeners = new Set<() => void>()
	let queue = readQueue(storage, key)
	let sending: ReadonlySet<string> = new Set()
	let failed: ReadonlySet<string> = new Set()
	let saved: ReadonlySet<string> = new Set()
	let refused: SettledBatch['refused'] = []
	let closed = false
	let running: Promise<void> | null = null
	let again = false
	let snapshot: CountSyncSnapshot

	function rebuild() {
		snapshot = { pending: queue, sending, failed, saved, refused, closed }
		for (const listener of listeners) listener()
	}
	rebuild()

	function setQueue(next: QueuedEntry[]) {
		queue = next
		writeQueue(storage, key, queue)
	}

	async function run(): Promise<void> {
		do {
			again = false
			while (queue.length > 0 && !closed) {
				const batch = queue.slice(0, MAX_ENTRIES_PER_REQUEST)
				const ids = new Set(batch.map((entry) => entry.clientId))
				sending = ids
				failed = new Set([...failed].filter((id) => !ids.has(id)))
				rebuild()
				let result: EntryResult
				try {
					result = await send(batch)
				} catch {
					sending = new Set()
					failed = new Set([...failed, ...ids])
					again = false
					rebuild()
					return
				}
				const settled = settleBatch(batch, result)
				const gone = new Set<string>([
					...settled.done.map((entry) => entry.clientId),
					...settled.refused.map((item) => item.entry.clientId),
				])
				setQueue(removeEntries(queue, gone))
				// A slot is saved while no newer entry for it is waiting.
				const waiting = new Set(queue.map((entry) => entrySlotKey(entry)))
				const nextSaved = new Set(saved)
				for (const entry of settled.done) {
					const slot = entrySlotKey(entry)
					if (!waiting.has(slot)) nextSaved.add(slot)
				}
				saved = nextSaved
				refused = [...refused, ...settled.refused]
				if (settled.closed) {
					closed = true
					// Nothing more can be saved into a closed count.
					setQueue([])
				}
				sending = new Set()
				if (settled.unanswered.length > 0) {
					failed = new Set([
						...failed,
						...settled.unanswered.map((entry) => entry.clientId),
					])
					rebuild()
					return
				}
				rebuild()
			}
		} while (again)
	}

	function flush(): Promise<void> {
		if (running) {
			again = true
			return running
		}
		running = run().finally(() => {
			running = null
		})
		return running
	}

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		submit(entry) {
			// A closed count takes nothing more; keep nothing for it either.
			if (closed) return Promise.resolve()
			const queued: QueuedEntry = { ...entry, queuedAt: now() }
			const slot = entrySlotKey(queued)
			setQueue(enqueueEntry(queue, queued))
			const nextSaved = new Set(saved)
			nextSaved.delete(slot)
			saved = nextSaved
			refused = refused.filter((item) => entrySlotKey(item.entry) !== slot)
			// A replaced entry that failed no longer counts as failed.
			failed = new Set(
				[...failed].filter((id) => queue.some((item) => item.clientId === id)),
			)
			rebuild()
			return flush()
		},
		flush,
		reloadFromStorage() {
			if (closed) return
			queue = readQueue(storage, key)
			rebuild()
		},
	}
}
