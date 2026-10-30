import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { clock, ltr, money } from '../../lib/reservations/format'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { Button, Card, LoadingView, Screen, Text } from '../ui'
import { useReservationsNavigation } from './navigation'
import {
	CountdownBanner,
	FailureText,
	ScreenHeader,
	useHardwareBack,
	useReservationText,
} from './parts'

const URGENT_PAYMENT_MS = 120_000

/**
 * A booking waiting for its deposit or card guarantee. "Pay now" opens the
 * payment page in an in-app browser; nothing here says "paid" until the
 * status poll does. The poll runs while the screen is in front (and again
 * when the app comes back from the browser, or after a relaunch). There is
 * no way back: the table is booked and only the payment is missing. Pay
 * shows only while the payment is still open; a payment under review, or
 * one that failed or was refunded, ends with Done.
 */
export function ReservationPaymentScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Payment
			store={reservations.store}
			snapshot={reservations.snapshot}
			focused={focused}
		/>
	)
}

function Payment({
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

	useEffect(() => {
		if (!focused) return
		store.startPolling()
		return () => store.stopPolling()
	}, [focused, store])

	useHardwareBack(focused, () => undefined)

	const payment = snapshot.flow.booking?.payment ?? null
	const remaining = snapshot.paymentRemainingMs
	const phase = snapshot.flow.phase
	const outcome = snapshot.flow.paymentOutcome
	const isOpen =
		phase.kind === 'awaitingPayment' &&
		(outcome === null || outcome === 'pending')
	const finish = () => {
		void store.finishBooking()
		navigation.resetTo([])
	}

	return (
		<Screen scroll>
			<ScreenHeader title={m('rsv.pay.title')} />
			<View className="gap-4 pb-5">
				<Card className="gap-3">
					{payment ? (
						<Text variant="heading">
							{m('rsv.pay.amount', {
								amount: ltr(
									money(payment.amountMinor, payment.currency, locale),
								),
							})}
						</Text>
					) : null}
					<Text variant="muted">{m('rsv.pay.hint')}</Text>
					{remaining !== null ? (
						<CountdownBanner
							text={m('rsv.pay.expires', { time: ltr(clock(remaining)) })}
							urgent={remaining < URGENT_PAYMENT_MS}
						/>
					) : null}
				</Card>
				<Card className="gap-2">
					{outcome === 'review' ? (
						<Text accessibilityLiveRegion="polite">{m('rsv.pay.review')}</Text>
					) : outcome === 'failed' ? (
						<Text accessibilityLiveRegion="polite">{m('rsv.pay.failed')}</Text>
					) : outcome === 'refunded' ? (
						<Text accessibilityLiveRegion="polite">
							{m('rsv.pay.refunded')}
						</Text>
					) : (
						<View className="flex-row items-center gap-2">
							{snapshot.isPolling ? (
								<ActivityIndicator colorClassName="accent-primary" />
							) : null}
							<Text>{m('rsv.pay.checking')}</Text>
						</View>
					)}
					{phase.kind === 'failed' ? (
						<FailureText failure={phase.failure} />
					) : null}
					{phase.kind === 'failed' || outcome === 'review' ? (
						<Button variant="outline" onPress={finish}>
							{m('rsv.confirmed.done')}
						</Button>
					) : null}
				</Card>
				{isOpen && payment?.payUrl ? (
					<Button onPress={() => void store.openPayment()}>
						{m('rsv.pay.open')}
					</Button>
				) : null}
				{isOpen ? (
					<Button variant="outline" onPress={() => store.startPolling()}>
						{m('rsv.pay.check')}
					</Button>
				) : null}
			</View>
		</Screen>
	)
}
