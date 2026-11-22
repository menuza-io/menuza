/**
 * The upload queue behind "Add dish photos in bulk" (#316). Pure: the fetch,
 * the storage, the clock and the online signal are all injected, so it is
 * tested without a browser.
 *
 * - One file per request, a few at a time (the existing library upload takes
 *   one file per request and does all the checking).
 * - A failed upload is retried with exponential backoff. While the browser is
 *   offline nothing is sent and attempts are not used up; the queue resumes by
 *   itself on the `online` event ("uploads resume after a dropped connection").
 * - Files that finished are remembered in storage by content hash, name and
 *   size, so dropping the same folder again skips what is already uploaded.
 * - Every storage access is guarded: private windows and blocked storage just
 *   mean nothing is remembered.
 */

export type QueueFileState = 'waiting' | 'uploading' | 'done' | 'failed'

export type UploadResult =
	| { ok: true; assetId: string }
	| { ok: false; retryable: boolean; error: string }

export type QueueItem<F> = {
	id: string
	file: F
	name: string
	size: number
	hash: string | null
	state: QueueFileState
	/** Tries made so far (offline waits do not count). */
	attempts: number
	assetId: string | null
	error: string | null
	/** Finished in an earlier visit and skipped now. */
	resumed: boolean
	/** Earliest time of the next try (ms since epoch), 0 when none is waiting. */
	readyAt: number
}

export type QueueSnapshot<F> = {
	items: QueueItem<F>[]
	/** Nothing is being sent because the browser is offline. */
	paused: boolean
	counts: Record<QueueFileState, number>
}

export type KeyValueStore = {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
}

export type UploadQueueOptions<F extends { name: string; size: number }> = {
	/** Sends one file. May throw on a network error (counts as retryable). */
	upload(file: F, signal: AbortSignal): Promise<UploadResult>
	isOnline(): boolean
	/** Calls back when the browser comes online; returns an unsubscribe. */
	onOnline(callback: () => void): () => void
	sleep(ms: number): Promise<void>
	now(): number
	store?: KeyValueStore | null
	/** Includes the organization, so one organization never sees another's. */
	storageKey?: string
	concurrency?: number
	maxAttempts?: number
	baseDelayMs?: number
	maxDelayMs?: number
	onChange?(snapshot: QueueSnapshot<F>): void
}

export const UPLOAD_QUEUE_DEFAULTS = {
	concurrency: 3,
	maxAttempts: 4,
	baseDelayMs: 1000,
	maxDelayMs: 15_000,
} as const

const MAX_REMEMBERED = 2000

export function rememberedKey(file: {
	hash: string | null
	name: string
	size: number
}) {
	return file.hash ? `${file.hash}:${file.name}:${file.size}` : null
}

export function backoffDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
) {
	return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1))
}

export function createUploadQueue<F extends { name: string; size: number }>(
	options: UploadQueueOptions<F>,
) {
	const concurrency = options.concurrency ?? UPLOAD_QUEUE_DEFAULTS.concurrency
	const maxAttempts = options.maxAttempts ?? UPLOAD_QUEUE_DEFAULTS.maxAttempts
	const baseDelayMs = options.baseDelayMs ?? UPLOAD_QUEUE_DEFAULTS.baseDelayMs
	const maxDelayMs = options.maxDelayMs ?? UPLOAD_QUEUE_DEFAULTS.maxDelayMs

	const items: QueueItem<F>[] = []
	let nextId = 0
	let stopped = false
	let running: Promise<void> | null = null
	let activeUploads = 0
	let peakUploads = 0
	const controller = new AbortController()
	const onlineWaiters = new Set<() => void>()
	const unsubscribe = options.onOnline(() => {
		for (const wake of [...onlineWaiters]) wake()
		onlineWaiters.clear()
	})

	function readRemembered(): Record<string, string> {
		if (!options.store || !options.storageKey) return {}
		try {
			const raw = options.store.getItem(options.storageKey)
			if (!raw) return {}
			const parsed: unknown = JSON.parse(raw)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return {}
			}
			const out: Record<string, string> = {}
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'string') out[key] = value
			}
			return out
		} catch {
			return {}
		}
	}

	function writeRemembered(map: Record<string, string>) {
		if (!options.store || !options.storageKey) return
		try {
			const entries = Object.entries(map)
			const kept =
				entries.length > MAX_REMEMBERED
					? Object.fromEntries(entries.slice(-MAX_REMEMBERED))
					: map
			options.store.setItem(options.storageKey, JSON.stringify(kept))
		} catch {
			/* storage is full or blocked: nothing is remembered */
		}
	}

	function remember(item: QueueItem<F>) {
		const key = rememberedKey(item)
		if (!key || !item.assetId) return
		const map = readRemembered()
		// Re-insert so the newest entry is the last one kept.
		delete map[key]
		map[key] = item.assetId
		writeRemembered(map)
	}

	/** Forget uploads whose library photo is gone (so a drop uploads them again). */
	function forget(assetIds: readonly string[]) {
		if (assetIds.length === 0) return
		const gone = new Set(assetIds)
		const map = readRemembered()
		let changed = false
		for (const [key, value] of Object.entries(map)) {
			if (gone.has(value)) {
				delete map[key]
				changed = true
			}
		}
		if (changed) writeRemembered(map)
	}

	function snapshot(): QueueSnapshot<F> {
		const counts: Record<QueueFileState, number> = {
			waiting: 0,
			uploading: 0,
			done: 0,
			failed: 0,
		}
		for (const item of items) counts[item.state] += 1
		return {
			items: items.map((item) => ({ ...item })),
			paused:
				!options.isOnline() && (counts.waiting > 0 || counts.uploading > 0),
			counts,
		}
	}

	function emit() {
		options.onChange?.(snapshot())
	}

	function waitForOnline() {
		return new Promise<void>((resolve) => {
			onlineWaiters.add(resolve)
		})
	}

	function takeNext(): QueueItem<F> | null {
		const now = options.now()
		return (
			items.find((item) => item.state === 'waiting' && item.readyAt <= now) ??
			null
		)
	}

	async function runItem(item: QueueItem<F>) {
		item.state = 'uploading'
		item.error = null
		activeUploads += 1
		peakUploads = Math.max(peakUploads, activeUploads)
		emit()
		let result: UploadResult
		try {
			result = await options.upload(item.file, controller.signal)
		} catch (error) {
			result = {
				ok: false,
				retryable: true,
				error: error instanceof Error ? error.message : 'Network error',
			}
		} finally {
			activeUploads -= 1
		}
		if (result.ok) {
			item.state = 'done'
			item.assetId = result.assetId
			item.readyAt = 0
			remember(item)
		} else if (!options.isOnline() && result.retryable) {
			// The connection dropped: wait for it, and do not use up a try.
			item.state = 'waiting'
			item.error = result.error
			item.readyAt = 0
		} else {
			item.attempts += 1
			item.error = result.error
			if (result.retryable && item.attempts < maxAttempts) {
				item.state = 'waiting'
				item.readyAt =
					options.now() + backoffDelay(item.attempts, baseDelayMs, maxDelayMs)
			} else {
				item.state = 'failed'
				item.readyAt = 0
			}
		}
		emit()
	}

	async function worker() {
		while (!stopped) {
			if (!options.isOnline()) {
				emit()
				await waitForOnline()
				emit()
				continue
			}
			const item = takeNext()
			if (item) {
				await runItem(item)
				continue
			}
			const waiting = items.filter((candidate) => candidate.state === 'waiting')
			if (waiting.length === 0) return
			const soonest = Math.min(...waiting.map((candidate) => candidate.readyAt))
			await options.sleep(Math.max(0, soonest - options.now()))
		}
	}

	const api = {
		/** Adds files; a file remembered from an earlier visit starts as done. */
		add(
			files: ReadonlyArray<{ file: F; hash: string | null }>,
		): QueueItem<F>[] {
			const remembered = readRemembered()
			const added = files.map(({ file, hash }) => {
				const item: QueueItem<F> = {
					id: `f${nextId++}`,
					file,
					name: file.name,
					size: file.size,
					hash,
					state: 'waiting',
					attempts: 0,
					assetId: null,
					error: null,
					resumed: false,
					readyAt: 0,
				}
				const key = rememberedKey(item)
				const known = key ? remembered[key] : undefined
				if (known) {
					item.state = 'done'
					item.assetId = known
					item.resumed = true
				}
				items.push(item)
				return item
			})
			emit()
			return added
		},
		/** Runs until nothing is waiting. Safe to call again after `add`. */
		start(): Promise<void> {
			if (!running) {
				running = Promise.all(
					Array.from({ length: concurrency }, () => worker()),
				)
					.then(() => undefined)
					.finally(() => {
						running = null
						// Files added while the last worker was leaving still run.
						if (!stopped && items.some((item) => item.state === 'waiting')) {
							void api.start()
						}
					})
			}
			return running
		},
		/** Puts failed files back in the queue with a fresh set of tries. */
		retryFailed(): Promise<void> {
			for (const item of items) {
				if (item.state === 'failed') {
					item.state = 'waiting'
					item.attempts = 0
					item.error = null
					item.readyAt = 0
				}
			}
			emit()
			return api.start()
		},
		forget,
		snapshot,
		/** The most uploads that ever ran at once (a test of the limit). */
		peakConcurrency: () => peakUploads,
		stop() {
			stopped = true
			controller.abort()
			unsubscribe()
			for (const wake of [...onlineWaiters]) wake()
			onlineWaiters.clear()
		},
	}
	return api
}

export type UploadQueue<F extends { name: string; size: number }> = ReturnType<
	typeof createUploadQueue<F>
>
