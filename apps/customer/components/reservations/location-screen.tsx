import { Pressable, View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { Card, LoadingView, Screen, Text } from '../ui'
import { route, useReservationsNavigation } from './navigation'
import { Chevron, ScreenHeader, useReservationText } from './parts'

/** Several locations take bookings: the guest picks one first. */
export function ReservationLocationScreen() {
	const reservations = useReservations()
	const navigation = useReservationsNavigation()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	const { store, snapshot } = reservations
	const locations = snapshot.config?.locations ?? []
	return (
		<Screen scroll>
			<ScreenHeader
				title={m('rsv.location.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-3 pb-5">
				{locations.map((location) => {
					const address = location.address?.formattedAddress ?? null
					return (
						<Pressable
							key={location.id}
							accessibilityRole="button"
							accessibilityLabel={
								address ? `${location.name}, ${address}` : location.name
							}
							onPress={() => {
								store.selectLocation(location)
								// The picker gives way to the search, as on iOS.
								navigation.resetTo([route('search')])
							}}
						>
							<Card className="flex-row items-center gap-3">
								<View className="flex-1 gap-1">
									<Text variant="heading">{location.name}</Text>
									{address ? <Text variant="muted">{address}</Text> : null}
								</View>
								<Chevron direction="forward" size={16} />
							</Card>
						</Pressable>
					)
				})}
			</View>
		</Screen>
	)
}
