import { create } from 'zustand'

/**
 * Whether the browser promised not to evict this app's storage. Unsent orders,
 * the fiscal chain head, the ZATCA key and the device secret all live there, so
 * a refusal is shown until it is granted (installing the app to the home
 * screen usually is what grants it).
 */
type StorageState = {
	/** True: kept under storage pressure. False: may be evicted. Null: not known yet, or no API. */
	persisted: boolean | null
}

export const useStoragePersistence = create<StorageState>(() => ({
	persisted: null,
}))

export async function requestPersistentStorage(
	storage:
		| Pick<StorageManager, 'persist' | 'persisted'>
		| undefined = typeof navigator === 'undefined'
		? undefined
		: navigator.storage,
): Promise<boolean | null> {
	if (!storage?.persist) return null
	let persisted: boolean | null = null
	try {
		persisted = (await storage.persisted?.()) ?? false
		if (!persisted) persisted = await storage.persist()
	} catch {
		persisted = null
	}
	useStoragePersistence.setState({ persisted })
	return persisted
}
