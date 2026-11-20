import { useLocalSearchParams } from 'expo-router'
import { OrderScreen } from '../../components/orders/order-screen'

/** An order (#112), opened from the Profile or from an order link (#195). */
export default function OrderRoute() {
	const { id, link } = useLocalSearchParams<{ id: string; link?: string }>()
	return (
		<OrderScreen
			id={id}
			linkToken={typeof link === 'string' ? link : undefined}
		/>
	)
}
