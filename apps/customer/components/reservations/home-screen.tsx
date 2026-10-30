import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { reservationStatusKey } from '../../lib/reservations/format'
import { type ReservationMineEntry } from '../../lib/reservations/models'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { Button, Card, LoadingView, Screen, Text } from '../ui'
import { detailRoute, route, useReservationsNavigation } from './navigation'
import {
	Chevron,
	FailureText,
	ScreenHeader,
	StatusBadge,
	useReservationText,
	whenLabel,
} from './parts'

const PAST_LIMIT = 5

/** Book a table, join the waitlist, and the customer's reservations. */
export function ReservationsHomeScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Home
			store={reservations.store}
			snapshot={reservations.snapshot}
			focused={focused}
		/>
	)
}

function Home({
	store,
	snapshot,
	focused,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	focused: boolean
}) {
	const { m } = useReservationText()
	const [pulling, setPulling] = useState(false)

	// Back on home: a table that is still only held is released, and the list refreshed.
	useEffect(() => {
		if (!focused) return
		void store.leaveBookingSteps()
		void store.loadMine()
	}, [focused, store])

	const onRefresh = () => {
		setPulling(true)
		void store.loadMine().finally(() => setPulling(false))
	}

	return (
		<Screen scroll onRefresh={onRefresh} refreshing={pulling}>
			<ScreenHeader title={m('rsv.home.title')} />
			<View className="gap-5 pb-5">
				<BookCard store={store} snapshot={snapshot} />
				<MineCard snapshot={snapshot} />
			</View>
		</Screen>
	)
}

function BookCard({
	store,
	snapshot,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()
	const state = snapshot.loadState
	const hasWaitlist =
		snapshot.config?.locations.some((location) => location.waitlist.online) ===
		true
	return (
		<Card className="gap-3.5">
			{state.kind === 'idle' || state.kind === 'loading' ? (
				<View className="flex-row items-center gap-2">
					<ActivityIndicator colorClassName="accent-primary" />
					<Text variant="muted">{m('app.loading')}</Text>
				</View>
			) : state.kind === 'unavailable' ? (
				<Text variant="muted">{m('rsv.unavailable')}</Text>
			) : state.kind === 'failed' ? (
				<>
					<FailureText failure={state.failure} />
					<Button variant="outline" onPress={() => void store.loadConfig()}>
						{m('app.retry')}
					</Button>
				</>
			) : (
				<>
					<Button
						onPress={() =>
							navigation.push(
								route(snapshot.location === null ? 'location' : 'search'),
							)
						}
					>
						{m('rsv.home.book')}
					</Button>
					{hasWaitlist ? (
						<Button
							variant="outline"
							onPress={() => {
								store.prepareWaitlistFromHome()
								navigation.push(route('waitlist'))
							}}
						>
							{m('rsv.home.waitlist')}
						</Button>
					) : null}
				</>
			)}
		</Card>
	)
}

function MineCard({ snapshot }: { snapshot: ReservationsSnapshot }) {
	const { m } = useReservationText()
	const upcoming = snapshot.mine?.upcoming ?? []
	const past = (snapshot.mine?.past ?? []).slice(0, PAST_LIMIT)
	return (
		<Card className="gap-3">
			<Text variant="heading" accessibilityRole="header">
				{m('rsv.home.mine')}
			</Text>
			{upcoming.length === 0 ? (
				<Text variant="muted">{m('rsv.home.empty')}</Text>
			) : null}
			{upcoming.map((entry) => (
				<ReservationRow key={entry.id} entry={entry} />
			))}
			{past.length > 0 ? (
				<>
					<Text variant="label" accessibilityRole="header" className="mt-1">
						{m('rsv.home.past')}
					</Text>
					{past.map((entry) => (
						<ReservationRow key={entry.id} entry={entry} />
					))}
				</>
			) : null}
		</Card>
	)
}

function ReservationRow({ entry }: { entry: ReservationMineEntry }) {
	const { m, locale } = useReservationText()
	const navigation = useReservationsNavigation()
	const name = entry.locationName ?? ''
	const details = `${whenLabel(entry.date, entry.time, locale)} \u00B7 ${m('rsv.search.partyCount', { count: entry.partySize })}`
	const status = m(reservationStatusKey(entry.status))
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={[name, details, status].filter(Boolean).join(', ')}
			onPress={() => navigation.push(detailRoute(entry.id))}
			className="min-h-11 flex-row items-center gap-3 py-1.5"
		>
			<View className="flex-1 gap-0.5">
				{name ? <Text variant="label">{name}</Text> : null}
				<Text variant="caption">{details}</Text>
			</View>
			<StatusBadge status={entry.status} />
			<Chevron direction="forward" size={14} />
		</Pressable>
	)
}
