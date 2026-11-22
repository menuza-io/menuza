import {
	MAX_ATTEMPTS,
	POLL_MS,
	SESSION_RETRY_MS,
	STALE_UPLOADING_MS,
	backoffFor,
} from './backoff'
import {
	type PhotoQueueDeps,
	type QueueItem,
	type QueueItemError,
	type QueueSnapshot,
	type UploadedEvent,
	type UploadOutcome,
} from './types'

export interface EnqueueInput {
	organizationId: string
	itemId: string
	itemName?: string | null
	/** The prepared (resized, re-encoded) photo. It is copied into durable storage. */
	sourceUri: string
}

/**
 * The upload queue. Items live in memory and in `storage`; every change is
 * written before the next step, so a restart picks up exactly where it was.
 * One pass runs at a time, and a trigger that arrives during a pass asks for
 * one more pass instead of starting a second.
 */
export class PhotoUploadQueue {
	private items: QueueItem[] = []
	private loaded = false
	private running: Promise<void> | null = null
	private again = false
	private timer: unknown = null
	private writes: Promise<void> = Promise.resolve()
	private readonly listeners = new Set<(snapshot: QueueSnapshot) => void>()
	private readonly uploadedListeners = new Set<(event: UploadedEvent) => void>()
	private disposed = false

	constructor(private readonly deps: PhotoQueueDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)()
	}

	/**
	 * Reads the saved queue. An item left `uploading` belongs to a request
	 * that died with the previous run (nothing is in flight yet), so it goes
	 * back to `waiting` right away; its clientId makes a re-send safe.
	 */
	async load(): Promise<void> {
		if (this.loaded) return
		const saved = await this.deps.storage.load()
		// An enqueue that raced the load keeps its place.
		const known = new Set(this.items.map((item) => item.id))
		const restored = saved
			.filter((item) => !known.has(item.id))
			.map((item) =>
				item.status === 'uploading'
					? {
							...item,
							status: 'waiting' as const,
							uploadStartedAt: null,
							nextAttemptAt: Math.min(item.nextAttemptAt, this.now()),
						}
					: item,
			)
		this.items = [...restored, ...this.items]
		this.loaded = true
		this.emit()
		await this.persist()
		this.schedule()
	}

	getSnapshot(): QueueSnapshot {
		return { items: this.items.map((item) => ({ ...item })) }
	}

	subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Called once per photo that reached the server (and was removed from the queue). */
	onUploaded(listener: (event: UploadedEvent) => void): () => void {
		this.uploadedListeners.add(listener)
		return () => this.uploadedListeners.delete(listener)
	}

	/**
	 * Queues a photo for a dish. A photo for the same dish that has not left
	 * the phone yet is replaced: the latest one wins and the older file goes.
	 */
	async enqueue(input: EnqueueInput): Promise<QueueItem> {
		await this.load()
		const id = this.deps.newId()
		const fileUri = await this.deps.files.persist(input.sourceUri, id)
		const superseded = this.items.filter(
			(item) =>
				item.organizationId === input.organizationId &&
				item.itemId === input.itemId &&
				item.status !== 'uploading',
		)
		const item: QueueItem = {
			id,
			organizationId: input.organizationId,
			itemId: input.itemId,
			itemName: input.itemName ?? null,
			fileUri,
			status: 'waiting',
			attempts: 0,
			nextAttemptAt: this.now(),
			createdAt: this.now(),
			uploadStartedAt: null,
			lastError: null,
		}
		this.items = [
			...this.items.filter((existing) => !superseded.includes(existing)),
			item,
		]
		this.emit()
		await this.persist()
		await Promise.all(superseded.map((old) => this.removeFile(old.fileUri)))
		void this.kick()
		return { ...item }
	}

	/** Puts a failed item back in line with a clean slate. */
	async retry(id: string): Promise<void> {
		await this.load()
		const item = this.items.find((entry) => entry.id === id)
		if (!item || item.status !== 'failed') return
		item.status = 'waiting'
		item.attempts = 0
		item.nextAttemptAt = this.now()
		item.lastError = null
		this.emit()
		await this.persist()
		void this.kick()
	}

	/** Drops an item and its file (the person gave up on it). */
	async remove(id: string): Promise<void> {
		await this.load()
		const item = this.items.find((entry) => entry.id === id)
		if (!item) return
		this.items = this.items.filter((entry) => entry.id !== id)
		this.emit()
		await this.persist()
		await this.removeFile(item.fileUri)
	}

	/** Drops everything, files included (sign-out). */
	async clear(): Promise<void> {
		await this.load()
		const old = this.items
		this.items = []
		this.emit()
		await this.persist()
		await Promise.all(old.map((item) => this.removeFile(item.fileUri)))
	}

	/**
	 * Runs a pass over what is due. Call it when the phone comes online, when
	 * the app returns to the foreground and on start; the timer calls it too.
	 */
	kick(): Promise<void> {
		if (this.disposed) return Promise.resolve()
		if (this.running) {
			this.again = true
			return this.running
		}
		this.running = this.drain().finally(() => {
			this.running = null
		})
		return this.running
	}

	dispose(): void {
		this.disposed = true
		this.clearTimer()
		this.listeners.clear()
		this.uploadedListeners.clear()
	}

	private async drain(): Promise<void> {
		try {
			await this.load()
			do {
				this.again = false
				await this.pass()
			} while (this.again && !this.disposed)
		} finally {
			this.schedule()
		}
	}

	private async pass(): Promise<void> {
		this.reclaimStale()
		for (;;) {
			if (this.disposed) return
			const next = this.items
				.filter(
					(item) =>
						item.status === 'waiting' && item.nextAttemptAt <= this.now(),
				)
				.sort((a, b) => a.createdAt - b.createdAt)[0]
			if (!next) return
			// Offline: leave every item untouched, a reconnect kicks again.
			if (!(await this.deps.isOnline())) return
			await this.attempt(next)
		}
	}

	/** A request that outlived the upload timeout can no longer be in flight. */
	private reclaimStale(): void {
		let changed = false
		for (const item of this.items) {
			if (
				item.status === 'uploading' &&
				item.uploadStartedAt !== null &&
				this.now() - item.uploadStartedAt > STALE_UPLOADING_MS
			) {
				item.status = 'waiting'
				item.uploadStartedAt = null
				changed = true
			}
		}
		if (changed) {
			this.emit()
			void this.persist()
		}
	}

	private async attempt(item: QueueItem): Promise<void> {
		item.status = 'uploading'
		item.uploadStartedAt = this.now()
		this.emit()
		await this.persist()

		let token = await this.deps.getAccessToken()
		if (!token) {
			await this.release(item, {
				code: 'session_expired',
				message: 'Not signed in',
				status: 401,
				permanent: false,
			})
			return
		}

		let outcome = await this.safeUpload(item, token)
		if (outcome.kind === 'unauthorized') {
			// One refresh, one more try. The refresh is the app's shared one, so
			// it never replays a refresh token another caller already rotated.
			try {
				await this.deps.refreshSession()
				token = await this.deps.getAccessToken()
			} catch {
				token = null
			}
			if (!token) {
				await this.release(item, {
					code: 'session_expired',
					message: 'Session could not be refreshed',
					status: 401,
					permanent: false,
				})
				return
			}
			outcome = await this.safeUpload(item, token)
		}
		await this.settle(item, outcome)
	}

	private async safeUpload(
		item: QueueItem,
		accessToken: string,
	): Promise<UploadOutcome> {
		try {
			return await this.deps.upload({ item, accessToken })
		} catch (error) {
			return {
				kind: 'network',
				message: error instanceof Error ? error.message : 'Upload failed',
			}
		}
	}

	private async settle(item: QueueItem, outcome: UploadOutcome): Promise<void> {
		switch (outcome.kind) {
			case 'ok': {
				this.items = this.items.filter((entry) => entry.id !== item.id)
				this.emit()
				await this.persist()
				await this.removeFile(item.fileUri)
				const event: UploadedEvent = {
					item: { ...item },
					assetId: outcome.assetId,
					imageUrl: outcome.imageUrl,
				}
				for (const listener of this.uploadedListeners) listener(event)
				return
			}
			case 'refused': {
				item.status = 'failed'
				item.uploadStartedAt = null
				item.lastError = {
					code: outcome.code,
					message: outcome.message,
					status: outcome.status,
					permanent: true,
				}
				this.emit()
				await this.persist()
				return
			}
			case 'unauthorized': {
				// Still 401 after a refresh: hold the item, counted, so it backs off.
				await this.burn(item, {
					code: 'session_expired',
					message: 'Unauthorized',
					status: 401,
					permanent: false,
				})
				return
			}
			case 'transient': {
				await this.burn(item, {
					code: outcome.code,
					message: outcome.message,
					status: outcome.status,
					permanent: false,
				})
				return
			}
			case 'network': {
				const error: QueueItemError = {
					code: 'network_error',
					message: outcome.message,
					status: 0,
					permanent: false,
				}
				// Offline is not the photo's fault: no attempt is spent and the
				// reconnect listener kicks the queue.
				if (!(await this.deps.isOnline())) await this.release(item, error, 0)
				else await this.burn(item, error)
				return
			}
		}
	}

	/** Back to `waiting` without spending an attempt. */
	private async release(
		item: QueueItem,
		error: QueueItemError,
		delayMs: number = SESSION_RETRY_MS,
	): Promise<void> {
		item.status = 'waiting'
		item.uploadStartedAt = null
		item.lastError = error
		item.nextAttemptAt = this.now() + delayMs
		this.emit()
		await this.persist()
	}

	/** Spends an attempt: waits out the backoff, or stops after too many. */
	private async burn(item: QueueItem, error: QueueItemError): Promise<void> {
		item.attempts += 1
		item.uploadStartedAt = null
		if (item.attempts >= MAX_ATTEMPTS) {
			item.status = 'failed'
			item.lastError = { ...error, code: 'gave_up', permanent: false }
		} else {
			item.status = 'waiting'
			item.lastError = error
			item.nextAttemptAt = this.now() + backoffFor(item.attempts)
		}
		this.emit()
		await this.persist()
	}

	/** Wakes the queue at the next due time, and at least every `POLL_MS` while anything waits. */
	private schedule(): void {
		this.clearTimer()
		if (this.disposed) return
		const waiting = this.items.filter((item) => item.status === 'waiting')
		const uploading = this.items.some((item) => item.status === 'uploading')
		if (waiting.length === 0 && !uploading) return
		// An item already due that is still here could not run (offline): look
		// again after the poll interval instead of spinning.
		const untilDue = Math.min(
			...waiting.map((item) => item.nextAttemptAt - this.now()),
		)
		const delay =
			untilDue > 0 ? Math.min(POLL_MS, Math.max(1_000, untilDue)) : POLL_MS
		const setTimer =
			this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown)
		this.timer = setTimer(() => {
			this.timer = null
			void this.kick()
		}, delay)
	}

	private clearTimer(): void {
		if (this.timer === null) return
		const clear =
			this.deps.clearTimer ??
			((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
		clear(this.timer)
		this.timer = null
	}

	private emit(): void {
		if (this.listeners.size === 0) return
		const snapshot = this.getSnapshot()
		for (const listener of this.listeners) listener(snapshot)
	}

	/** Writes are chained so a slow save never lands after a newer one. */
	private persist(): Promise<void> {
		const write = this.writes.then(() =>
			this.deps.storage
				.save(this.items.map((item) => ({ ...item })))
				.catch(() => {
					// A failed save keeps the in-memory queue; the next change retries it.
				}),
		)
		this.writes = write
		return write
	}

	private async removeFile(uri: string): Promise<void> {
		try {
			await this.deps.files.remove(uri)
		} catch {
			// A file that cannot be deleted is not worth failing the queue over.
		}
	}
}
