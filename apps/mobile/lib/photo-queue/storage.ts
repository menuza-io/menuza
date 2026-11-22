import { type QueueItem, type QueueStorage } from './types'

export const QUEUE_STORAGE_KEY = 'menuza.photoQueue.v1'

/** The part of `@react-native-async-storage/async-storage` the queue needs. */
export interface KeyValueStore {
	getItem(key: string): Promise<string | null>
	setItem(key: string, value: string): Promise<void>
}

const STATUSES = new Set(['waiting', 'uploading', 'failed'])

function isQueueItem(value: unknown): value is QueueItem {
	if (!value || typeof value !== 'object') return false
	const item = value as Record<string, unknown>
	return (
		typeof item.id === 'string' &&
		typeof item.organizationId === 'string' &&
		typeof item.itemId === 'string' &&
		typeof item.fileUri === 'string' &&
		typeof item.status === 'string' &&
		STATUSES.has(item.status) &&
		typeof item.attempts === 'number' &&
		typeof item.nextAttemptAt === 'number' &&
		typeof item.createdAt === 'number'
	)
}

/** Persists the queue as one JSON value. A damaged value reads as an empty queue. */
export function createKeyValueQueueStorage(
	store: KeyValueStore,
	key: string = QUEUE_STORAGE_KEY,
): QueueStorage {
	return {
		async load() {
			const raw = await store.getItem(key)
			if (!raw) return []
			try {
				const parsed: unknown = JSON.parse(raw)
				if (!Array.isArray(parsed)) return []
				return parsed.filter(isQueueItem).map((item) => ({
					...item,
					itemName: item.itemName ?? null,
					uploadStartedAt: item.uploadStartedAt ?? null,
					lastError: item.lastError ?? null,
				}))
			} catch {
				return []
			}
		},
		async save(items) {
			await store.setItem(key, JSON.stringify(items))
		},
	}
}

/** For tests: lives as long as the object, shared by "restarts" that reuse it. */
export function createMemoryQueueStorage(
	initial: QueueItem[] = [],
): QueueStorage & { snapshot: () => QueueItem[] } {
	let saved = JSON.stringify(initial)
	return {
		async load() {
			return JSON.parse(saved) as QueueItem[]
		},
		async save(items) {
			saved = JSON.stringify(items)
		},
		snapshot: () => JSON.parse(saved) as QueueItem[],
	}
}

export function createMemoryPhotoFiles(): {
	persist: (sourceUri: string, id: string) => Promise<string>
	remove: (uri: string) => Promise<void>
	stored: Set<string>
} {
	const stored = new Set<string>()
	return {
		stored,
		async persist(_sourceUri, id) {
			const uri = `file:///documents/dish-photos/${id}.jpg`
			stored.add(uri)
			return uri
		},
		async remove(uri) {
			stored.delete(uri)
		},
	}
}
