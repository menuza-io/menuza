import { useLocalSearchParams } from 'expo-router'
import { ReservationDetailScreen } from '../../../components/reservations/detail-screen'

export default function ReservationDetailRoute() {
	const { id } = useLocalSearchParams<{ id: string }>()
	return <ReservationDetailScreen id={id} />
}
