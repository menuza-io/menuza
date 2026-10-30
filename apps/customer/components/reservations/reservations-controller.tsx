import { useEffect, useRef } from 'react'
import { Alert, AppState } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import {
	type BookingPhase,
	sameBookingPhase,
} from '../../lib/reservations/booking-flow'
import { followPhase, useReservationsNavigation } from './navigation'
import { useReservationText } from './parts'

/**
 * Runs beside the reservations stack: loads the configuration once, follows
 * the booking flow from screen to screen, tells the guest when a hold or a
 * payment window ran out, and checks a pending payment again when the app
 * comes back from the browser.
 *
 * While the tab is not focused, a phase change waits: navigating then would
 * pull the guest back to this tab.
 */
export function ReservationsController({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const navigation = useReservationsNavigation()
	const { m } = useReservationText()
	const store = reservations?.store ?? null
	const phase = reservations?.snapshot.flow.phase ?? null
	const lastPhase = useRef<BookingPhase | null>(null)
	const pending = useRef(false)

	useEffect(() => {
		if (store && store.getSnapshot().loadState.kind === 'idle')
			void store.loadConfig()
	}, [store])

	useEffect(() => {
		if (!store) return
		const subscription = AppState.addEventListener('change', (state) => {
			if (state === 'active') store.resumePolling()
		})
		return () => subscription.remove()
	}, [store])

	useEffect(() => {
		if (!phase) return
		const previous = lastPhase.current
		lastPhase.current = phase
		if (
			previous &&
			sameBookingPhase(previous, phase) &&
			!(focused && pending.current)
		)
			return
		if (!focused) {
			pending.current = true
			return
		}
		pending.current = false
		const next = followPhase(phase, navigation.stack())
		if (next.stack) navigation.resetTo(next.stack)
		if (next.alert)
			Alert.alert(m(next.alert), undefined, [{ text: m('rsv.ok') }])
	}, [phase, focused, navigation, m])

	return null
}
