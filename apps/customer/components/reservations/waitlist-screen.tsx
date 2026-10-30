import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { type CustomerProfile } from '../../lib/api/public-site'
import { useAppSnapshot, useReservations } from '../../lib/app/use-app'
import { ltr } from '../../lib/reservations/format'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { displayPhone, isValidPhone } from '../../lib/support/phone-number'
import {
	Button,
	Card,
	Checkbox,
	LoadingView,
	Screen,
	Text,
	TextField,
} from '../ui'
import { useReservationsNavigation } from './navigation'
import {
	FailureText,
	PartyStepper,
	ScreenHeader,
	useReservationText,
} from './parts'

/** Join the waitlist with the verified phone, then follow the place in line. */
export function ReservationWaitlistScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { profile } = useAppSnapshot()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Waitlist
			store={reservations.store}
			snapshot={reservations.snapshot}
			profile={profile}
			focused={focused}
		/>
	)
}

function Waitlist({
	store,
	snapshot,
	profile,
	focused,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	profile: CustomerProfile | null
	focused: boolean
}) {
	const { m } = useReservationText()
	const navigation = useReservationsNavigation()

	// The place in line refreshes while the screen is in front.
	useEffect(() => {
		if (!focused) return
		store.startWaitlistUpdates()
		return () => store.stopWaitlistUpdates()
	}, [focused, store])

	const phase = snapshot.waitlist.phase.kind
	// Holding a status token means the guest is on the line, whatever failed since.
	const joining =
		snapshot.waitlist.statusToken === null &&
		(phase === 'idle' || phase === 'joining' || phase === 'failed')
	return (
		<Screen scroll>
			<ScreenHeader
				title={m('rsv.waitlist.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-4 pb-5">
				{joining ? (
					<JoinCard store={store} snapshot={snapshot} profile={profile} />
				) : (
					<StatusCard store={store} snapshot={snapshot} />
				)}
			</View>
		</Screen>
	)
}

function JoinCard({
	store,
	snapshot,
	profile,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
	profile: CustomerProfile | null
}) {
	const { m } = useReservationText()
	const [name, setName] = useState(profile?.name ?? '')
	const [smsOptIn, setSmsOptIn] = useState(false)
	const profileName = profile?.name ?? ''

	// The profile can arrive after the screen opened; an empty field takes its name.
	useEffect(() => {
		if (profileName !== '')
			setName((current) => (current === '' ? profileName : current))
	}, [profileName])

	const location = snapshot.location
	const phone = profile?.phone ?? ''
	const failure =
		snapshot.waitlist.phase.kind === 'failed'
			? snapshot.waitlist.phase.failure
			: null
	return (
		<Card className="gap-4">
			{location ? <Text variant="heading">{location.name}</Text> : null}
			<PartyStepper
				value={snapshot.partySize}
				min={1}
				max={Math.max(location?.partySize.max ?? 8, 2)}
				onChange={(partySize) => store.setPartySize(partySize)}
			/>
			<TextField
				label={m('rsv.waitlist.name')}
				value={name}
				onChangeText={setName}
				textContentType="name"
				autoComplete="name"
			/>
			<Text variant="caption">
				{m('rsv.details.phoneNote', { phone: ltr(displayPhone(phone)) })}
			</Text>
			<Checkbox
				checked={smsOptIn}
				onChange={setSmsOptIn}
				label={m('rsv.details.sms')}
			/>
			{failure ? <FailureText failure={failure} /> : null}
			<Button
				loading={snapshot.isBusy}
				disabled={name.trim() === '' || !isValidPhone(phone)}
				onPress={() =>
					void store.joinWaitlist({ name: name.trim(), phone, smsOptIn })
				}
			>
				{m('rsv.waitlist.join')}
			</Button>
		</Card>
	)
}

function StatusCard({
	store,
	snapshot,
}: {
	store: ReservationsStore
	snapshot: ReservationsSnapshot
}) {
	const { m } = useReservationText()
	const phase = snapshot.waitlist.phase.kind
	const status = snapshot.waitlist.status
	const finished =
		phase === 'left' || phase === 'seated' || phase === 'linkInvalid'
	const refreshFailed = snapshot.waitlist.refreshFailure !== null
	return (
		<Card className="gap-3">
			{refreshFailed && !finished ? (
				<Text
					variant="error"
					accessibilityLiveRegion="polite"
					accessibilityRole="alert"
				>
					{m('rsv.waitlist.refreshFailed')}
				</Text>
			) : null}
			{phase === 'left' ? (
				<Text accessibilityLiveRegion="polite">{m('rsv.waitlist.left')}</Text>
			) : phase === 'seated' ? (
				<Text accessibilityLiveRegion="polite">{m('rsv.waitlist.seated')}</Text>
			) : phase === 'linkInvalid' ? (
				<Text accessibilityLiveRegion="polite">
					{m('rsv.waitlist.invalid')}
				</Text>
			) : status ? (
				<>
					{status.status === 'notified' ? (
						<Text variant="heading" accessibilityLiveRegion="polite">
							{m('rsv.waitlist.notified')}
						</Text>
					) : status.position !== null && status.position !== undefined ? (
						<Text variant="heading" accessibilityLiveRegion="polite">
							{m('rsv.waitlist.position', { position: status.position })}
						</Text>
					) : null}
					{status.quotedMin && status.quotedMin > 0 ? (
						<Text variant="muted">
							{m('rsv.waitlist.quoted', { count: status.quotedMin })}
						</Text>
					) : null}
					{status.canOnMyWay ? (
						<Button
							loading={snapshot.isBusy}
							onPress={() => void store.waitlistOnMyWay()}
						>
							{m('rsv.waitlist.onMyWay')}
						</Button>
					) : null}
					{status.canLeave ? (
						<Button
							variant="outline"
							disabled={snapshot.isBusy}
							onPress={() => void store.leaveWaitlist()}
						>
							{m('rsv.waitlist.leave')}
						</Button>
					) : null}
				</>
			) : (
				<ActivityIndicator
					colorClassName="accent-primary"
					accessibilityLabel={m('app.loading')}
				/>
			)}
			{finished ? (
				<Button variant="outline" onPress={() => store.resetWaitlist()}>
					{m('rsv.confirmed.done')}
				</Button>
			) : null}
		</Card>
	)
}
