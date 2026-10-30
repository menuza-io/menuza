import { useEffect, useRef } from 'react'
import { ActivityIndicator, ScrollView, View } from 'react-native'
import { useReservations } from '../../lib/app/use-app'
import { dateLabel, ltr } from '../../lib/reservations/format'
import {
	acceptsRequests,
	isAlternativesEmpty,
	type ReservationAlternatives,
	type ReservationAvailability,
	timeLabel,
} from '../../lib/reservations/models'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { Button, Card, Chip, LoadingView, Screen, Text } from '../ui'
import { route, useReservationsNavigation } from './navigation'
import {
	DateStrip,
	FailureText,
	PartyStepper,
	ScreenHeader,
	Section,
	TimeChips,
	useReservationText,
} from './parts'

const CLOSED_STATUSES = new Set(['closed', 'online_closed', 'beyond_horizon'])

/**
 * Party size, day, then the times the server offers. When the preferred time
 * is gone the server's alternatives show here; a party above the online
 * maximum sends a request instead.
 */
export function ReservationSearchScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Search
			store={reservations.store}
			snapshot={reservations.snapshot}
			focused={focused}
		/>
	)
}

function Search({
	store,
	snapshot,
	focused,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	focused: boolean
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()
	const didLoad = useRef(false)

	// The first visit searches; coming back from a later step re-reads the times.
	useEffect(() => {
		if (!focused) return
		if (didLoad.current) {
			void store.returnToSearch()
		} else {
			didLoad.current = true
			void store.enterSearch()
		}
	}, [focused, store])

	const location = snapshot.location
	const { phase, availability } = snapshot.flow
	const range = snapshot.partyRange

	return (
		<Screen scroll>
			<ScreenHeader
				title={m('rsv.search.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-4 pb-5">
				<Card className="gap-4">
					{location ? <Text variant="heading">{location.name}</Text> : null}
					{range ? (
						<PartyStepper
							value={snapshot.partySize}
							min={range.min}
							max={range.max}
							onChange={(partySize) => void store.changeSearch({ partySize })}
						/>
					) : null}
					<Text variant="label">{m('rsv.search.date')}</Text>
					<DateStrip
						days={snapshot.days}
						selected={snapshot.date}
						onSelect={(date) => void store.changeSearch({ date })}
					/>
				</Card>
				{phase.kind === 'failed' && phase.failure.kind !== 'slotUnavailable' ? (
					<Card>
						<FailureText failure={phase.failure} />
					</Card>
				) : null}
				{snapshot.searchFailure ? (
					<Card className="gap-3">
						<FailureText failure={snapshot.searchFailure} />
						<Button variant="outline" onPress={() => void store.search()}>
							{m('rsv.search.retry')}
						</Button>
					</Card>
				) : snapshot.isBusy && availability === null ? (
					<View className="items-center py-6">
						<ActivityIndicator
							colorClassName="accent-primary"
							accessibilityLabel={m('app.loading')}
						/>
					</View>
				) : availability ? (
					<Results
						store={store}
						snapshot={snapshot}
						availability={availability}
					/>
				) : null}
			</View>
		</Screen>
	)
}

function Results({
	store,
	snapshot,
	availability,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	availability: ReservationAvailability
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()
	const isLargeParty = availability.status === 'large_party'
	const noTables =
		!isLargeParty &&
		(availability.status === 'full' || availability.slots.length === 0)
	const alternatives = snapshot.flow.alternatives
	const showAlternatives =
		noTables || (snapshot.takenNotice && !isAlternativesEmpty(alternatives))
	return (
		<>
			<Card className="gap-3.5">
				{snapshot.takenNotice ? (
					<Text
						variant="error"
						accessibilityLiveRegion="polite"
						accessibilityRole="alert"
					>
						{m('rsv.error.slotUnavailable')}
					</Text>
				) : null}
				{CLOSED_STATUSES.has(availability.status) ? (
					<Text variant="muted">
						{availability.closed?.note ??
							availability.onlineClosed?.note ??
							m('rsv.search.closed')}
					</Text>
				) : isLargeParty ? (
					<LargeParty
						store={store}
						snapshot={snapshot}
						availability={availability}
					/>
				) : (
					<>
						<Text variant="label" accessibilityRole="header">
							{m('rsv.search.times')}
						</Text>
						{availability.slots.length === 0 ? (
							<Text variant="muted">{m('rsv.search.noTimes')}</Text>
						) : (
							<TimeChips
								slots={availability.slots}
								disabled={snapshot.isBusy}
								onChoose={(slot) => void store.choose(slot)}
							/>
						)}
					</>
				)}
			</Card>
			{showAlternatives ? (
				<Alternatives
					store={store}
					snapshot={snapshot}
					alternatives={alternatives}
				/>
			) : null}
			{availability.waitlist && noTables ? (
				<Button
					variant="outline"
					onPress={() => navigation.push(route('waitlist'))}
				>
					{m('rsv.search.waitlist')}
				</Button>
			) : null}
		</>
	)
}

function LargeParty({
	store,
	snapshot,
	availability,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	availability: ReservationAvailability
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()
	const largeParty =
		availability.largeParty ?? snapshot.location?.largeParty ?? null
	if (!largeParty || !acceptsRequests(largeParty)) {
		const phone =
			largeParty?.phone ??
			largeParty?.contact.phone ??
			snapshot.location?.phone ??
			''
		return (
			<Text variant="muted">
				{m('rsv.search.largePartyContact', { phone: ltr(phone) })}
			</Text>
		)
	}
	return (
		<>
			<Text variant="muted">{m('rsv.search.largeParty')}</Text>
			{largeParty.note ? (
				<Text variant="caption">{largeParty.note}</Text>
			) : null}
			<Text variant="label" nativeID="request-time-label">
				{m('rsv.search.preferredTime')}
			</Text>
			<ScrollView horizontal showsHorizontalScrollIndicator={false}>
				<View
					className="flex-row gap-2 py-0.5"
					accessibilityRole="radiogroup"
					accessibilityLabelledBy="request-time-label"
				>
					{snapshot.requestMinutes.map((minute) => (
						<Chip
							key={minute}
							role="radio"
							label={ltr(timeLabel(minute))}
							accessibilityLabel={timeLabel(minute)}
							selected={minute === snapshot.requestMinute}
							onPress={() => store.setRequestMinute(minute)}
						/>
					))}
				</View>
			</ScrollView>
			<Button
				onPress={() => {
					store.startRequest()
					navigation.push(route('details'))
				}}
			>
				{m('rsv.search.request')}
			</Button>
		</>
	)
}

function Alternatives({
	store,
	snapshot,
	alternatives,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	alternatives: ReservationAlternatives
}) {
	const { m, locale } = useReservationText()
	if (isAlternativesEmpty(alternatives)) return null
	return (
		<Section>
			{alternatives.sameDay.length > 0 ? (
				<>
					<Text variant="label" accessibilityRole="header">
						{m('rsv.search.alternatives')}
					</Text>
					<TimeChips
						slots={alternatives.sameDay}
						disabled={snapshot.isBusy}
						onChoose={(slot) => void store.choose(slot)}
					/>
				</>
			) : null}
			{alternatives.otherDates.length > 0 ? (
				<>
					<Text variant="label" accessibilityRole="header">
						{m('rsv.search.otherDays')}
					</Text>
					<ScrollView horizontal showsHorizontalScrollIndicator={false}>
						<View className="flex-row gap-2 py-0.5">
							{alternatives.otherDates.map((other) => (
								<Chip
									key={other.date}
									label={ltr(timeLabel(other.firstLocalMin))}
									sublabel={dateLabel(other.date, locale)}
									accessibilityLabel={`${dateLabel(other.date, locale)} ${timeLabel(other.firstLocalMin)}`}
									onPress={() => void store.chooseAlternativeDate(other.date)}
								/>
							))}
						</View>
					</ScrollView>
				</>
			) : null}
		</Section>
	)
}
