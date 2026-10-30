import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Modal, View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import {
	manageActions,
	reservationDateStrip,
} from '../../lib/reservations/booking-flow'
import { ltr, timeOfDay } from '../../lib/reservations/format'
import {
	parseServerTime,
	type ReservationAvailability,
	type ReservationManageView,
} from '../../lib/reservations/models'
import {
	type PendingPayment,
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { Button, Card, Chip, InsetView, LoadingView, Screen, Text } from '../ui'
import { useReservationsNavigation } from './navigation'
import {
	DateStrip,
	DetailRow,
	FailureText,
	PartyStepper,
	ScreenHeader,
	Section,
	StatusBadge,
	TimeChips,
	useReservationText,
	whenLabel,
} from './parts'

const LATE_MINUTES = [5, 10, 15, 30] as const
const MODIFY_DAYS = 14
const MODIFY_HORIZON_DAYS = 60

/**
 * One booking: its status and, while the server allows it, a new time, a
 * cancellation or a "running late" note. The manage token comes from secure
 * storage, or from `/mine` after a reinstall. A booking still waiting for
 * its payment follows the payment status until it is final.
 */
export function ReservationDetailScreen({ id }: { id: string }) {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Detail
			id={id}
			store={reservations.store}
			snapshot={reservations.snapshot}
		/>
	)
}

function Detail({
	id,
	store,
	snapshot,
}: {
	id: string
	store: ReservationsStore
	snapshot: ReservationsSnapshot
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()
	const [token, setToken] = useState<string | null>(null)
	const [modifying, setModifying] = useState(false)
	const [pulling, setPulling] = useState(false)

	const reload = useCallback(async () => {
		await store.reloadReservation(id)
		setToken(await store.manageToken(id))
	}, [id, store])

	useEffect(() => {
		void reload()
	}, [reload])

	const onRefresh = () => {
		setPulling(true)
		void reload().finally(() => setPulling(false))
	}

	const view = snapshot.manage?.reservation.id === id ? snapshot.manage : null
	const failure = snapshot.manageFailure
	const awaitingPayment = view?.status === 'pending_payment'
	const pending =
		snapshot.pendingPayment?.reservationId === id
			? snapshot.pendingPayment
			: null

	useEffect(() => {
		if (!awaitingPayment || !token) return
		store.watchPayment(id, token)
	}, [awaitingPayment, id, store, token])

	return (
		<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
			<ScreenHeader
				title={m('rsv.detail.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-4 pb-5">
				{view ? (
					<>
						<Summary view={view} />
						{awaitingPayment ? <PaymentProgress pending={pending} /> : null}
						<Actions
							store={store}
							snapshot={snapshot}
							view={view}
							token={token}
							onModify={() => setModifying(true)}
						/>
					</>
				) : failure ? (
					<Card>
						<FailureText failure={failure} />
					</Card>
				) : (
					<View className="items-center py-6">
						<ActivityIndicator
							colorClassName="accent-primary"
							accessibilityLabel={m('app.loading')}
						/>
					</View>
				)}
				{view && failure && !modifying ? (
					<FailureText failure={failure} />
				) : null}
				{snapshot.manageNotice ? (
					<Text
						variant="label"
						accessibilityLiveRegion="polite"
						accessibilityRole="alert"
					>
						{m(snapshot.manageNotice)}
					</Text>
				) : null}
			</View>
			{view && token ? (
				<Modal
					visible={modifying}
					animationType="slide"
					presentationStyle="pageSheet"
					onRequestClose={() => setModifying(false)}
				>
					<ModifySheet
						store={store}
						snapshot={snapshot}
						token={token}
						view={view}
						onClose={() => setModifying(false)}
					/>
				</Modal>
			) : null}
		</Screen>
	)
}

function Summary({ view }: { view: ReservationManageView }) {
	const { m, locale } = useReservationText()
	const reservation = view.reservation
	const deadline =
		(view.canCancel || view.canModify) && view.cancelDeadline
			? parseServerTime(view.cancelDeadline)
			: null
	return (
		<Card className="gap-3">
			<View className="flex-row items-center justify-between gap-3">
				<Text variant="heading" className="shrink">
					{reservation.location.name ?? reservation.locationName ?? ''}
				</Text>
				<StatusBadge status={view.status} />
			</View>
			<DetailRow
				label={m('rsv.detail.when')}
				value={whenLabel(reservation.date, reservation.time, locale)}
			/>
			<DetailRow
				label={m('rsv.detail.party')}
				value={m('rsv.search.partyCount', { count: reservation.partySize })}
			/>
			<DetailRow
				label={m('rsv.confirmed.code')}
				value={ltr(reservation.confirmationCode)}
			/>
			{reservation.location.address ? (
				<DetailRow
					label={m('rsv.detail.where')}
					value={reservation.location.address}
				/>
			) : null}
			{deadline !== null ? (
				<Text variant="caption">
					{m('rsv.detail.deadline', {
						time: timeOfDay(deadline, reservation.timeZone, locale),
					})}
				</Text>
			) : null}
		</Card>
	)
}

function PaymentProgress({ pending }: { pending: PendingPayment | null }) {
	const { m } = useReservationText()
	if (pending?.outcome === 'review') {
		return (
			<Card>
				<Text accessibilityLiveRegion="polite">{m('rsv.pay.review')}</Text>
			</Card>
		)
	}
	return (
		<Card className="flex-row items-center gap-2">
			{pending?.isPolling ? (
				<ActivityIndicator colorClassName="accent-primary" />
			) : null}
			<Text className="shrink">{m('rsv.pay.checking')}</Text>
		</Card>
	)
}

function Actions({
	store,
	snapshot,
	view,
	token,
	onModify,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	view: ReservationManageView
	token: string | null
	onModify: () => void
}) {
	const { m } = useReservationText()
	const actions = manageActions(view)
	const confirmCancel = () => {
		if (!token) return
		Alert.alert(m('rsv.detail.cancelConfirm'), undefined, [
			{ text: m('rsv.detail.cancelKeep'), style: 'cancel' },
			{
				text: m('rsv.detail.cancel'),
				style: 'destructive',
				onPress: () => void store.confirmCancellation(token),
			},
		])
	}
	return (
		<>
			{actions.canModify && token ? (
				<Button variant="outline" onPress={onModify}>
					{m('rsv.detail.modify')}
				</Button>
			) : null}
			{actions.canRunLate && token ? (
				<Section title={m('rsv.detail.late')}>
					<View className="flex-row flex-wrap gap-2">
						{LATE_MINUTES.map((minutes) => (
							<Chip
								key={minutes}
								label={m('rsv.detail.lateMinutes', { count: minutes })}
								disabled={snapshot.isBusy}
								onPress={() => void store.runningLate(token, minutes)}
							/>
						))}
					</View>
				</Section>
			) : null}
			{actions.isLive && view.reservation.location.phone ? (
				<Button variant="outline" onPress={() => void store.callVenue()}>
					{m('rsv.detail.call')}
				</Button>
			) : null}
			{actions.canCancel && token ? (
				<Button variant="ghost" onPress={confirmCancel}>
					{m('rsv.detail.cancel')}
				</Button>
			) : null}
		</>
	)
}

/**
 * A new time (and party size) out of the times the server offers this
 * booking, its own table excluded.
 */
function ModifySheet({
	store,
	snapshot,
	token,
	view,
	onClose,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	token: string
	view: ReservationManageView
	onClose: () => void
}) {
	const { m } = useReservationText()
	const reservation = view.reservation
	const [date, setDate] = useState(reservation.date)
	const [party, setParty] = useState(reservation.partySize)
	const [availability, setAvailability] =
		useState<ReservationAvailability | null>(null)
	const [days] = useState(() =>
		reservationDateStrip(
			Date.now() + snapshot.serverOffsetMs,
			reservation.timeZone,
			MODIFY_DAYS,
			MODIFY_HORIZON_DAYS,
		),
	)

	useEffect(() => {
		let current = true
		void store.availability(token, date, party).then((next) => {
			if (current) setAvailability(next)
		})
		return () => {
			current = false
		}
	}, [store, token, date, party])

	const slots = availability?.slots ?? []
	return (
		<InsetView edges={['top', 'bottom']} className="flex-1">
			<Screen scroll>
				<View className="flex-row items-center justify-between gap-3 py-4">
					<Text variant="heading" accessibilityRole="header" className="flex-1">
						{m('rsv.detail.modify')}
					</Text>
					<Button variant="ghost" size="sm" onPress={onClose}>
						{m('rsv.ok')}
					</Button>
				</View>
				<Card className="gap-4">
					<PartyStepper
						value={party}
						min={1}
						max={Math.max(reservation.partySize + 4, 8)}
						onChange={setParty}
					/>
					<DateStrip days={days} selected={date} onSelect={setDate} />
					<TimeChips
						slots={slots}
						disabled={snapshot.isBusy}
						onChoose={(slot) =>
							void store
								.applyModification(token, {
									date,
									localMin: slot.localMin,
									partySize: party,
								})
								.then((changed) => {
									if (changed) onClose()
								})
						}
					/>
					{availability && slots.length === 0 ? (
						<Text variant="muted">{m('rsv.search.noTimes')}</Text>
					) : null}
					{snapshot.manageFailure ? (
						<FailureText failure={snapshot.manageFailure} />
					) : null}
				</Card>
			</Screen>
		</InsetView>
	)
}
