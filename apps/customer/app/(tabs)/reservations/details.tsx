import { ReservationDetailsScreen } from '../../../components/reservations/details-screen'
import { useRouteFocus } from '../../../components/reservations/expo-navigation'

export default function ReservationDetailsRoute() {
	const focused = useRouteFocus()
	return <ReservationDetailsScreen focused={focused} />
}
