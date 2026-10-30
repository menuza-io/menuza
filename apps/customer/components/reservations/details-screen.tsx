import { useEffect } from 'react'
import { View } from 'react-native'
import { type CustomerProfile } from '../../lib/api/public-site'
import { useAppSnapshot, useReservations } from '../../lib/app/use-app'
import { ltr } from '../../lib/reservations/format'
import { timeLabel } from '../../lib/reservations/models'
import {
	type ReservationsSnapshot,
	type ReservationsStore,
} from '../../lib/reservations/reservations-store'
import { displayPhone } from '../../lib/support/phone-number'
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
	ChoiceChips,
	CountdownBanner,
	FailureText,
	PolicyPanel,
	ScreenHeader,
	useReservationText,
	whenLabel,
} from './parts'

const URGENT_HOLD_MS = 60_000

/**
 * The booking form. The phone is the signed-in customer's verified number:
 * there is no phone field. With a payment policy the guest accepts the terms
 * here before reviewing; a large party sends its request from here.
 */
export function ReservationDetailsScreen({
	focused = true,
}: {
	focused?: boolean
}) {
	const reservations = useReservations()
	const { profile } = useAppSnapshot()
	const { m } = useReservationText()
	if (!reservations) return <LoadingView label={m('app.loading')} />
	return (
		<Details
			store={reservations.store}
			snapshot={reservations.snapshot}
			profile={profile}
			focused={focused}
		/>
	)
}

function Details({
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

	// Name and email once per visit of the form; the phone and language every time.
	useEffect(() => {
		if (focused) store.prefillDraft(profile)
	}, [focused, profile, store])

	const { flow, draft, location, config } = snapshot
	const hold = flow.hold
	const phase = flow.phase
	const policy = hold?.policy ?? null
	const areas = location?.areas ?? []
	const occasions = config?.occasions ?? []
	const dietaryHint = (config?.dietary ?? [])
		.map((chip) => chip.name)
		.join(', ')

	return (
		<Screen scroll>
			<ScreenHeader
				title={m('rsv.details.title')}
				onBack={() => navigation.back()}
			/>
			<View className="gap-4 pb-5">
				<HoldCountdown snapshot={snapshot} />
				<BookingSummary snapshot={snapshot} />
				<Card className="gap-4">
					<TextField
						label={m('rsv.details.firstName')}
						value={draft.firstName}
						onChangeText={(firstName) => store.updateDraft({ firstName })}
						textContentType="givenName"
						autoComplete="given-name"
					/>
					<TextField
						label={m('rsv.details.lastName')}
						value={draft.lastName}
						onChangeText={(lastName) => store.updateDraft({ lastName })}
						textContentType="familyName"
						autoComplete="family-name"
					/>
					<TextField
						label={m('rsv.details.email')}
						value={draft.email}
						onChangeText={(email) => store.updateDraft({ email })}
						keyboardType="email-address"
						textContentType="emailAddress"
						autoComplete="email"
						autoCapitalize="none"
						autoCorrect={false}
					/>
					<Text variant="caption">
						{m('rsv.details.phoneNote', {
							phone: ltr(displayPhone(profile?.phone ?? '')),
						})}
					</Text>
					{occasions.length > 0 ? (
						<ChoiceChips
							label={m('rsv.details.occasion')}
							noneLabel={m('rsv.details.none')}
							options={occasions}
							selected={draft.occasionTagId}
							onSelect={(occasionTagId) => store.updateDraft({ occasionTagId })}
						/>
					) : null}
					{areas.length > 1 ? (
						<ChoiceChips
							label={m('rsv.details.area')}
							noneLabel={m('rsv.details.anyArea')}
							options={areas}
							selected={draft.areaId}
							onSelect={(areaId) => store.updateDraft({ areaId })}
						/>
					) : null}
					<TextField
						label={m('rsv.details.dietary')}
						value={draft.dietary}
						placeholder={dietaryHint}
						onChangeText={(dietary) => store.updateDraft({ dietary })}
					/>
					<TextField
						label={m('rsv.details.requests')}
						value={draft.requests}
						onChangeText={(requests) => store.updateDraft({ requests })}
					/>
					<Checkbox
						checked={draft.smsOptIn}
						onChange={(smsOptIn) => store.updateDraft({ smsOptIn })}
						label={m('rsv.details.sms')}
					/>
				</Card>
				{hold && policy && snapshot.needsPolicyConsent ? (
					<PolicyPanel
						policy={policy}
						consent={{
							checked: snapshot.consented,
							onChange: (checked) => store.setConsented(checked),
						}}
					/>
				) : null}
				{phase.kind === 'failed' ? (
					<Card>
						<FailureText failure={phase.failure} />
					</Card>
				) : null}
				<Button
					loading={snapshot.isBusy}
					disabled={!snapshot.canReview && !snapshot.isRequestReady}
					onPress={() => void store.continueFromDetails()}
				>
					{m(snapshot.isRequest ? 'rsv.search.request' : 'rsv.details.review')}
				</Button>
			</View>
		</Screen>
	)
}

/** "We're holding your table for 6:42", urgent in the last minute. */
export function HoldCountdown({
	snapshot,
}: {
	snapshot: ReservationsSnapshot
}) {
	const { m } = useReservationText()
	const countdown = snapshot.holdCountdown
	const remaining = snapshot.holdRemainingMs
	if (countdown === null || remaining === null) return null
	return (
		<CountdownBanner
			text={m('rsv.details.holding', { time: ltr(countdown) })}
			urgent={remaining < URGENT_HOLD_MS}
		/>
	)
}

/** The held (or requested) table: where, when and for how many. */
function BookingSummary({ snapshot }: { snapshot: ReservationsSnapshot }) {
	const { m, locale } = useReservationText()
	const { flow, location } = snapshot
	const date = flow.hold?.date ?? flow.date
	const time = flow.hold
		? timeLabel(flow.hold.localMin)
		: (flow.selectedSlot?.time ?? '')
	return (
		<Card className="gap-2">
			{location ? <Text variant="heading">{location.name}</Text> : null}
			<Text variant="muted">
				{`${whenLabel(date, time, locale)} \u00B7 ${m('rsv.search.partyCount', { count: snapshot.partySize })}`}
			</Text>
		</Card>
	)
}
