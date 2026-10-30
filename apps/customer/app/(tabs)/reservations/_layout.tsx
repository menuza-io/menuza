import { Stack } from 'expo-router'
import {
	useExpoReservationsNavigation,
	useRouteFocus,
} from '../../../components/reservations/expo-navigation'
import { ReservationsNavigationProvider } from '../../../components/reservations/navigation'
import { ReservationsController } from '../../../components/reservations/reservations-controller'
import { useThemePalette } from '../../../lib/theme/use-theme-palette'

/**
 * The reservations tab: a stack rooted at home whose screens draw their own
 * title row. The controller beside it moves the stack with the booking flow.
 * Payment and confirmation cannot be swiped away (the booking is made).
 */
export default function ReservationsLayout() {
	const navigation = useExpoReservationsNavigation()
	const focused = useRouteFocus()
	const palette = useThemePalette()
	return (
		<ReservationsNavigationProvider navigation={navigation}>
			<ReservationsController focused={focused} />
			<Stack
				screenOptions={{
					headerShown: false,
					contentStyle: { backgroundColor: palette.background },
				}}
			>
				<Stack.Screen name="payment" options={{ gestureEnabled: false }} />
				<Stack.Screen name="confirmed" options={{ gestureEnabled: false }} />
			</Stack>
		</ReservationsNavigationProvider>
	)
}
