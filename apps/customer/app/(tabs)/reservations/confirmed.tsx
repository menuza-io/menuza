import { ReservationConfirmedScreen } from '../../../components/reservations/confirmed-screen'
import { useRouteFocus } from '../../../components/reservations/expo-navigation'

export default function ReservationConfirmedRoute() {
	const focused = useRouteFocus()
	return <ReservationConfirmedScreen focused={focused} />
}
