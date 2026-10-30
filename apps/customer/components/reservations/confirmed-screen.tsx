import { Icon } from '../ui/icon'
import { View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { ltr } from '../../lib/reservations/format'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { useThemePalette } from '../../lib/theme/use-theme-palette'
import { Button, Card, LoadingView, Screen, Text } from '../ui'
import { detailRoute, useReservationsNavigation } from './navigation'
import {
	DetailRow,
	ScreenHeader,
	useHardwareBack,
	useReservationText,
	whenLabel,
} from './parts'

/** The booking is confirmed or, for a large party, requested. */
export function ReservationConfirmedScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Confirmed
			store={reservations.store}
			snapshot={reservations.snapshot}
			focused={focused}
		/>
	)
}

function Confirmed({
	store,
	snapshot,
	focused,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	focused: boolean
}) {
	const { m, locale } = useReservationText()
	const navigation = useReservationsNavigation()
	const palette = useThemePalette()
	const isRequest = snapshot.flow.phase.kind === 'requested'
	const reservation = snapshot.flow.booking?.reservation ?? null

	const done = () => {
		void store.finishBooking()
		navigation.resetTo([])
	}
	// Back from here means the same as "Done": the booking steps are over.
	useHardwareBack(focused, done)

	return (
		<Screen scroll>
			<ScreenHeader
				title={m(isRequest ? 'rsv.confirmed.requested' : 'rsv.confirmed.title')}
			/>
			<View className="gap-4 pb-5">
				<Card className="gap-3">
					<View
						accessibilityElementsHidden
						importantForAccessibility="no-hide-descendants"
					>
						<Icon
							name={isRequest ? 'paper-plane' : 'checkmark-circle'}
							size={40}
							color={palette.primary}
						/>
					</View>
					{isRequest ? (
						<Text variant="muted">{m('rsv.confirmed.requestedBody')}</Text>
					) : null}
					{reservation ? (
						<>
							<DetailRow
								label={m('rsv.confirmed.code')}
								value={ltr(reservation.confirmationCode)}
							/>
							<DetailRow
								label={m('rsv.detail.where')}
								value={reservation.locationName ?? ''}
							/>
							<DetailRow
								label={m('rsv.detail.when')}
								value={whenLabel(reservation.date, reservation.time, locale)}
							/>
							<DetailRow
								label={m('rsv.detail.party')}
								value={m('rsv.search.partyCount', {
									count: reservation.partySize,
								})}
							/>
						</>
					) : null}
				</Card>
				{reservation ? (
					<Button
						variant="outline"
						onPress={() => navigation.resetTo([detailRoute(reservation.id)])}
					>
						{m('rsv.confirmed.view')}
					</Button>
				) : null}
				<Button onPress={done}>{m('rsv.confirmed.done')}</Button>
			</View>
		</Screen>
	)
}
