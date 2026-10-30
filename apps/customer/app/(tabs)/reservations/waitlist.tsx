import { useRouteFocus } from '../../../components/reservations/expo-navigation'
import { ReservationWaitlistScreen } from '../../../components/reservations/waitlist-screen'

export default function ReservationWaitlistRoute() {
	const focused = useRouteFocus()
	return <ReservationWaitlistScreen focused={focused} />
}
