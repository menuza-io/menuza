import { useSyncExternalStore } from 'react'
import {
	type LoyaltySnapshot,
	type LoyaltyStore,
} from '../loyalty/loyalty-store'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../reservations/reservations-store'
import { type AppSnapshot, type AppStore } from '../state/app-store'
import { type SiteTheme } from '../theme/site-theme'
import { useAppStoreContext } from './app-provider'
import { type AppFeatures } from './features'

/** The app's store; every screen lives under `AppProvider`. */
export function useAppStore(): AppStore<AppFeatures> {
	const store = useAppStoreContext()
	if (!store) throw new Error('useAppStore must be used under AppProvider')
	return store
}

/** The whole app snapshot; re-renders whenever any part changes. */
export function useAppSnapshot(): AppSnapshot<AppFeatures> {
	const store = useAppStore()
	return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

const noSubscribe = () => () => {}
const nullSnapshot = () => null

/** The reservations feature and its snapshot; `null` before the site is ready. */
export function useReservations(): {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
} | null {
	const store = useAppSnapshot().features?.reservations ?? null
	const snapshot = useSyncExternalStore(
		store ? store.subscribe : noSubscribe,
		store ? store.getSnapshot : nullSnapshot,
	)
	return store && snapshot ? { store, snapshot } : null
}

/** The loyalty feature and its snapshot; `null` before the site is ready. */
export function useLoyalty(): {
	store: LoyaltyStore
	snapshot: LoyaltySnapshot
} | null {
	const store = useAppSnapshot().features?.loyalty ?? null
	const snapshot = useSyncExternalStore(
		store ? store.subscribe : noSubscribe,
		store ? store.getSnapshot : nullSnapshot,
	)
	return store && snapshot ? { store, snapshot } : null
}

/** The organization's theme (the neutral fallback before the site loads). */
export function useSiteTheme(): SiteTheme {
	return useAppSnapshot().theme
}
