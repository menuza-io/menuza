import { useCallback, useSyncExternalStore } from 'react'
import { ALL_LOCATIONS } from '#app/utils/dashboards/today.ts'

export { homeLocationStorageKey } from '#app/utils/dashboards/today.ts'

/**
 * The home page's location picker: one choice shared by every block on the
 * page (Today, Needs attention, the launch checklist), remembered per user and
 * organization in `localStorage`. The first visit starts at All locations.
 * Storage may be missing or throw (private windows, blocked site data); the
 * picker then simply forgets.
 */
const listeners = new Set<() => void>()
const memory = new Map<string, string>()

function read(key: string): string {
	const cached = memory.get(key)
	if (cached !== undefined) return cached
	let stored: string | null = null
	try {
		stored = window.localStorage.getItem(key)
	} catch {
		stored = null
	}
	const value = stored || ALL_LOCATIONS
	memory.set(key, value)
	return value
}

function write(key: string, value: string) {
	memory.set(key, value)
	try {
		window.localStorage.setItem(key, value)
	} catch {
		// Remembering the choice is a convenience only.
	}
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useHomeLocation(storageKey: string) {
	const value = useSyncExternalStore(
		subscribe,
		() => read(storageKey),
		() => ALL_LOCATIONS,
	)
	const setValue = useCallback(
		(next: string) => write(storageKey, next),
		[storageKey],
	)
	return [value, setValue] as const
}

/** Test helper: forget the in-memory copy so storage is read again. */
export function resetHomeLocationMemory() {
	memory.clear()
}
