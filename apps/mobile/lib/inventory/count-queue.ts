/**
 * The offline queue behind the phone's counting screen (#516), the same idea as
 * Station's outbox and the web counting screen: a walk-in has no signal, so a
 * count must never look saved when it is not.
 *
 * - an entry is written to the device BEFORE it is sent, so a dropped
 *   connection, a closed app or a restart loses nothing;
 * - entries go to the region in order, one request at a time, and leave the
 *   queue only when the region answers for them (accepted, a replay of the same
 *   `clientId`, or refused for good);
 * - a request that does not reach the region keeps every entry queued and marks
 *   the queue failed until the next attempt (a new entry, "Send now", the
 *   connection coming back);
 * - an entry that replaces a still unsent entry for the same item, area and
 *   unit takes its place, so the queue never grows past the sheet;
 * - every request reports how many entries the phone still holds, so the
 *   office sees "this device is still counting" before approving (#474).
 *
 * Plain TypeScript with injected storage and transport: no React, no native
 * modules, so it runs under Jest.
 */

export type QueuedEntry = {
	/** Idempotency key: a replay of the same id is reported as a duplicate. */
	clientId: string
	itemId: string
	areaId: string | null
	/** Typed amount in `unit`; `null` clears this person's entry. */
	amount: number | null
	unit: string
	queuedAt: number
}

export type EntryAnswer = {
	accepted: ReadonlyArray<{ clientId: string }>
	duplicates: readonly string[]
	refused: ReadonlyArray<{ clientId: string; code: string }>
	/** Entries the region kept as late entries of an approved count. */
	late?: readonly string[]
}

export interface EntryStore {
	load(): Promise<QueuedEntry[]>
	save(entries: QueuedEntry[]): Promise<void>
}

export type SendEntries = (
	batch: QueuedEntry[],
	/** What the phone still holds after this batch. */
	unsent: number,
) => Promise<EntryAnswer>

/** The region takes up to 200 entries per request. */
export const MAX_ENTRIES_PER_REQUEST = 200

export type QueueState = {
	pending: readonly QueuedEntry[]
	/** The last request did not reach the region. */
	failed: boolean
	/** The count no longer takes entries (cancelled). */
	closed: boolean
	/** Entries refused for good, with the region's reason. */
	refused: ReadonlyArray<{ entry: QueuedEntry; code: string }>
	/** Entries the region kept as late entries (the count was already approved). */
	lateCount: number
	sending: boolean
}

export function slotKey(
	entry: Pick<QueuedEntry, 'itemId' | 'areaId' | 'unit'>,
): string {
	return `${entry.itemId}|${entry.areaId ?? ''}|${entry.unit}`
}

export function queueStorageKey(organizationId: string, countId: string) {
	return `inventory-count-queue:${organizationId}:${countId}`
}

function isQueuedEntry(value: unknown): value is QueuedEntry {
	if (!value || typeof value !== 'object') return false
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

/** A store over any async key-value store (AsyncStorage); junk or a damaged value reads as empty. */
export function createKeyValueEntryStore(
	store: {
		getItem(key: string): Promise<string | null>
		setItem(key: string, value: string): Promise<void>
		removeItem(key: string): Promise<void>
	},
	key: string,
): EntryStore {
	return {
		async load() {
			try {
				const raw = await store.getItem(key)
				const parsed: unknown = raw ? JSON.parse(raw) : []
				return Array.isArray(parsed) ? parsed.filter(isQueuedEntry) : []
			} catch {
				return []
			}
		},
		async save(entries) {
			try {
				if (entries.length === 0) await store.removeItem(key)
				else await store.setItem(key, JSON.stringify(entries))
			} catch {
				// Storage full or blocked: the entries still go from memory.
			}
		},
	}
}

export function createCountQueue(options: {
	store: EntryStore
	send: SendEntries
	now?: () => number
}) {
	const { store, send } = options
	const now = options.now ?? (() => Date.now())
	const listeners = new Set<() => void>()
	let queue: QueuedEntry[] = []
	let failed = false
	let closed = false
	let refused: QueueState['refused'] = []
	let lateCount = 0
	let sending = false
	let running: Promise<void> | null = null
	let again = false
	let loaded: Promise<void> | null = null
	let snapshot: QueueState

	function rebuild() {
		snapshot = {
			pending: queue,
			failed,
			closed,
			refused,
			lateCount,
			sending,
		}
		for (const listener of listeners) listener()
	}
	rebuild()

	function ensureLoaded(): Promise<void> {
		loaded ??= store.load().then((entries) => {
			// Anything typed while loading is newer than what was stored.
			const typed = new Set(queue.map((entry) => slotKey(entry)))
			queue = [
				...entries.filter((entry) => !typed.has(slotKey(entry))),
				...queue,
			]
			rebuild()
		})
		return loaded
	}

	async function persist() {
		await store.save(queue)
	}

	async function run(): Promise<void> {
		await ensureLoaded()
		do {
			again = false
			while (queue.length > 0 && !closed) {
				const batch = queue.slice(0, MAX_ENTRIES_PER_REQUEST)
				sending = true
				rebuild()
				let answer: EntryAnswer
				try {
					answer = await send(batch, Math.max(0, queue.length - batch.length))
				} catch {
					sending = false
					failed = true
					again = false
					rebuild()
					return
				}
				sending = false
				failed = false
				const gone = new Set<string>([
					...answer.accepted.map((entry) => entry.clientId),
					...answer.duplicates,
					...answer.refused.map((entry) => entry.clientId),
				])
				const byId = new Map(batch.map((entry) => [entry.clientId, entry]))
				for (const item of answer.refused) {
					const entry = byId.get(item.clientId)
					if (entry) refused = [...refused, { entry, code: item.code }]
					if (item.code === 'count_closed') closed = true
				}
				lateCount += (answer.late ?? []).length
				queue = queue.filter((entry) => !gone.has(entry.clientId))
				if (closed) queue = []
				await persist()
				rebuild()
				// The region answered for none of them: stop, never spin.
				if (gone.size === 0) {
					failed = true
					rebuild()
					return
				}
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
		getState: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		/** Load what an earlier session left unsent. */
		load: ensureLoaded,
		/** Queue an entry (persisted at once) and start sending; resolves when the queue is quiet. */
		async submit(entry: Omit<QueuedEntry, 'queuedAt'>): Promise<void> {
			if (closed) return
			const queued: QueuedEntry = { ...entry, queuedAt: now() }
			const slot = slotKey(queued)
			queue = [
				...queue.filter(
					(item) => item.clientId !== queued.clientId && slotKey(item) !== slot,
				),
				queued,
			]
			refused = refused.filter((item) => slotKey(item.entry) !== slot)
			rebuild()
			await persist()
			return flush()
		},
		flush,
	}
}

export type CountQueue = ReturnType<typeof createCountQueue>
