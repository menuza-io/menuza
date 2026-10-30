import { useEffect } from 'react'
import { View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { ltr, money } from '../../lib/reservations/format'
import { timeLabel } from '../../lib/reservations/models'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { displayPhone } from '../../lib/support/phone-number'
import { Button, Card, LoadingView, Screen, Text } from '../ui'
import { HoldCountdown } from './details-screen'
import { useReservationsNavigation } from './navigation'
import {
	DetailRow,
	FailureText,
	ScreenHeader,
	useReservationText,
	whenLabel,
} from './parts'

/**
 * A last look before booking, with the hold still counting down. A booking
 * that failed on the network is sent again with the same idempotency key.
 */
export function ReservationReviewScreen() {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return <Review store={reservations.store} snapshot={reservations.snapshot} />
}

function Review({
	store,
	snapshot,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
}) {
	const { m, locale } = useReservationText()
	const navigation = useReservationsNavigation()

	// Leaving by the back gesture returns to the form with the hold still counting down.
	useEffect(() => () => store.leaveReview(), [store])

	const { flow, draft, location } = snapshot
	const hold = flow.hold
	const date = hold?.date ?? flow.date
	const time = timeLabel(hold?.localMin ?? flow.selectedSlot?.localMin ?? 0)
	const requiresPayment = hold?.requiresPayment === true
	const policy = hold?.policy ?? null
	const phase = flow.phase

	return (
		<Screen scroll>
			<ScreenHeader
				title={m('rsv.review.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-4 pb-5">
				<HoldCountdown snapshot={snapshot} />
				<Card className="gap-3">
					{location ? <Text variant="heading">{location.name}</Text> : null}
					<DetailRow
						label={m('rsv.detail.when')}
						value={whenLabel(date, time, locale)}
					/>
					<DetailRow
						label={m('rsv.detail.party')}
						value={m('rsv.search.partyCount', { count: snapshot.partySize })}
					/>
					<DetailRow
						label={m('rsv.review.name')}
						value={`${draft.firstName} ${draft.lastName}`.trim()}
					/>
					<DetailRow
						label={m('profile.phone')}
						value={ltr(displayPhone(draft.phone))}
					/>
					{requiresPayment && policy ? (
						<DetailRow
							label={m('rsv.pay.amountLabel')}
							value={ltr(
								money(policy.totalAmountMinor, policy.currency, locale),
							)}
						/>
					) : null}
				</Card>
				{phase.kind === 'failed' ? (
					<Card>
						<FailureText failure={phase.failure} />
					</Card>
				) : null}
				<Button
					loading={snapshot.isBusy || phase.kind === 'submitting'}
					onPress={() => void store.submit()}
				>
					{m(requiresPayment ? 'rsv.review.pay' : 'rsv.review.confirm')}
				</Button>
				<Button
					variant="outline"
					onPress={() => {
						store.backToDetails()
						navigation.back()
					}}
				>
					{m('rsv.review.back')}
				</Button>
			</View>
		</Screen>
	)
}
