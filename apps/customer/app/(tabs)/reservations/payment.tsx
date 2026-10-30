import { useRouteFocus } from '../../../components/reservations/expo-navigation'
import { ReservationPaymentScreen } from '../../../components/reservations/payment-screen'

export default function ReservationPaymentRoute() {
	const focused = useRouteFocus()
	return <ReservationPaymentScreen focused={focused} />
}
