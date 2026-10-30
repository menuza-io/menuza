import { useRouteFocus } from '../../../components/reservations/expo-navigation'
import { ReservationsHomeScreen } from '../../../components/reservations/home-screen'

export default function ReservationsHomeRoute() {
	const focused = useRouteFocus()
	return <ReservationsHomeScreen focused={focused} />
}
