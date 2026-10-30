import { useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { type LoyaltyStore } from '../../lib/loyalty/loyalty-store'

/** Foreground means anything but background (iOS reports `inactive` while a system sheet is up), as in the reservations store. */
function isForeground(state: AppStateStatus): boolean {
	return state !== 'background'
}

/**
 * Starts the wallet and runs its polling and countdowns only while the tab
 * is focused and the app is in the foreground. Coming back refreshes the
 * balance behind the screen (a purchase on the website may have earned).
 */
export function useLoyaltyActivity(
	store: LoyaltyStore | null,
	focused: boolean,
): void {
	const [foreground, setForeground] = useState(() =>
		isForeground((AppState.currentState ?? 'active') as AppStateStatus),
	)
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => {
			setForeground(isForeground(state))
		})
		return () => subscription.remove()
	}, [])

	useEffect(() => {
		store?.start()
	}, [store])

	const active = focused && foreground
	const wasActive = useRef(active)
	useEffect(() => {
		if (!store) return
		store.setActive(active)
		if (active && !wasActive.current) void store.refresh()
		wasActive.current = active
	}, [store, active])
}
