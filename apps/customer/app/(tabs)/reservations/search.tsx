import { useRouteFocus } from '../../../components/reservations/expo-navigation'
import { ReservationSearchScreen } from '../../../components/reservations/search-screen'

export default function ReservationSearchRoute() {
	const focused = useRouteFocus()
	return <ReservationSearchScreen focused={focused} />
}
