/**
 * Dish photo upload queue (#222). Pure TypeScript: no React and no native
 * module imports, so every rule here runs under plain Jest. The native pieces
 * (AsyncStorage, the document directory, NetInfo, the app state) are injected
 * from `runtime.ts`.
 */

export type QueueItemStatus = 'waiting' | 'uploading' | 'failed'

/** Why an item is waiting again or has failed. Codes are stable; the screen words them. */
export interface QueueItemError {
	/** Server error code (`forbidden`, `not_found`, ...) or one of ours (`gave_up`, `session_expired`). */
	code: string
	/** The server's own message when it sent one. Not shown as-is: the screen words each code. */
	message: string
	/** HTTP status, 0 when there was no answer. */
	status: number
	/** `true` when retrying can never help (the item is `failed` and stays so until the person acts). */
	permanent: boolean
}

export interface QueueItem {
	/** A uuid. It is also the API `clientId` (idempotency key), so a re-send never makes a second photo. */
	id: string
	organizationId: string
	itemId: string
	/** The dish name, only to word the row on the screen. */
	itemName: string | null
	/** A copy of the prepared photo in the app's document directory. */
	fileUri: string
	status: QueueItemStatus
	/** Failed tries that count against the item (offline never counts). */
	attempts: number
	/** Epoch ms: not tried again before this. */
	nextAttemptAt: number
	createdAt: number
	/** Epoch ms when `uploading` began, used to reclaim a row whose request died with the app. */
	uploadStartedAt: number | null
	lastError: QueueItemError | null
}

export interface QueueStorage {
	load(): Promise<QueueItem[]>
	save(items: QueueItem[]): Promise<void>
}

export interface PhotoFiles {
	/** Copies a prepared photo into durable storage and returns its new uri. */
	persist(sourceUri: string, id: string): Promise<string>
	/** Deletes a stored photo. Never throws for a file that is already gone. */
	remove(uri: string): Promise<void>
}

export type UploadOutcome =
	| { kind: 'ok'; itemId: string; assetId: string; imageUrl: string }
	/** 401: the access token is no good (expired or revoked). */
	| { kind: 'unauthorized' }
	/** 400/403/404/413/415 and any other 4xx but 401/408/429: the same request can never work. */
	| { kind: 'refused'; status: number; code: string; message: string }
	/** 408/429/5xx: the server could not take it now. */
	| { kind: 'transient'; status: number; code: string; message: string }
	/** No answer at all (offline, timeout, connection lost). */
	| { kind: 'network'; message: string }

export interface UploadInput {
	item: QueueItem
	accessToken: string
}

export interface PhotoQueueDeps {
	storage: QueueStorage
	files: PhotoFiles
	upload: (input: UploadInput) => Promise<UploadOutcome>
	getAccessToken: () => Promise<string | null>
	/** Refreshes the stored session once (`refreshSessionOnce`); throws when it cannot. */
	refreshSession: () => Promise<void>
	isOnline: () => boolean | Promise<boolean>
	newId: () => string
	now?: () => number
	setTimer?: (fn: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}

export interface QueueSnapshot {
	items: QueueItem[]
}

export interface UploadedEvent {
	item: QueueItem
	assetId: string
	imageUrl: string
}
