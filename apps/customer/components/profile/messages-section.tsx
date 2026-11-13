import { useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import {
	type SubscriptionChannel,
	SubscriptionsClient,
	subscriptionFailure,
	type SubscriptionRow,
	type SubscriptionState,
	subscriptionState,
	type SubscriptionTopic,
} from '../../lib/api/subscriptions'
import { useAppSnapshot, useReservations } from '../../lib/app/use-app'
import { Card, Text } from '../ui'

type Topic = Extract<SubscriptionTopic, 'marketing' | 'reservations'>
const CHANNELS: readonly SubscriptionChannel[] = ['email', 'sms']

const keyOf = (topic: SubscriptionTopic, channel: SubscriptionChannel) =>
	`${topic}:${channel}`

/**
 * "Messages from <Restaurant>": one switch per channel for offers and for
 * reservation news, saved straight to the regional tenant-api with the
 * customer token (optimistic, rolled back on an error). Drop alerts are not
 * offered here: the app has no drops screen.
 */
export function MessagesSection() {
	const { t } = useLingui()
	const { session, organization } = useAppSnapshot()
	const reservations = useReservations()
	const client = useMemo(
		() => (session ? new SubscriptionsClient(session) : null),
		[session],
	)
	const [rows, setRows] = useState<readonly SubscriptionRow[] | null>(null)
	const [overrides, setOverrides] = useState<Record<string, SubscriptionState>>(
		{},
	)
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
	const [notes, setNotes] = useState<Record<string, string>>({})

	useEffect(() => {
		if (!client) return
		let live = true
		client
			.list()
			.then((loaded) => {
				if (live) setRows(loaded)
			})
			.catch(() => {
				// Stay hidden: the screen above is complete without this section.
			})
		return () => {
			live = false
		}
	}, [client])

	if (!client || !rows) return null

	const name = organization?.name ?? ''
	const bookingOn =
		reservations?.snapshot.loadState.kind === 'ready' ||
		rows.some((row) => row.topic === 'reservations' && row.subscribed)
	const topics: Array<{ topic: Topic; label: string }> = [
		{ topic: 'marketing', label: t`Offers and news` },
		...(bookingOn
			? [{ topic: 'reservations' as const, label: t`Reservation news` }]
			: []),
	]
	const channelLabel = (channel: SubscriptionChannel) =>
		channel === 'email' ? t`Email` : t`Text`

	const stateOf = (topic: Topic, channel: SubscriptionChannel) =>
		overrides[keyOf(topic, channel)] ?? subscriptionState(rows, topic, channel)

	const setNote = (topic: Topic, text: string) =>
		setNotes((current) => ({ ...current, [topic]: text }))

	const toggle = async (topic: Topic, channel: SubscriptionChannel) => {
		const key = keyOf(topic, channel)
		if (busy.has(key)) return
		const before = stateOf(topic, channel)
		const next = before === 'off'
		setBusy((current) => new Set(current).add(key))
		setOverrides((current) => ({ ...current, [key]: next ? 'on' : 'off' }))
		setNote(topic, '')
		try {
			const state = await client.set(topic, channel, next)
			setOverrides((current) => ({ ...current, [key]: state }))
		} catch (error) {
			setOverrides((current) => ({ ...current, [key]: before }))
			const failure = subscriptionFailure(error, channel)
			setNote(
				topic,
				failure === 'needs_email'
					? t`Add an email address first`
					: failure === 'needs_phone'
						? t`Verify your phone first`
						: t`We couldn't save that. Try again.`,
			)
		} finally {
			setBusy((current) => {
				const rest = new Set(current)
				rest.delete(key)
				return rest
			})
		}
	}

	return (
		<Card className="gap-3">
			<View className="gap-1.5">
				<Text variant="heading" accessibilityRole="header">
					{t`Messages from ${name}`}
				</Text>
				<Text variant="muted">{t`Choose what you hear from us, and how.`}</Text>
			</View>
			{topics.map(({ topic, label }) => {
				const pending = stateOf(topic, 'email') === 'pending'
				const note =
					notes[topic] || (pending ? t`Check your inbox to confirm` : '')
				return (
					<View key={topic} className="gap-1">
						<Text variant="label">{label}</Text>
						<View className="flex-row flex-wrap gap-x-6">
							{CHANNELS.map((channel) => {
								const checked = stateOf(topic, channel) !== 'off'
								const disabled = busy.has(keyOf(topic, channel))
								return (
									<Pressable
										key={channel}
										accessibilityRole="switch"
										accessibilityLabel={`${label}: ${channelLabel(channel)}`}
										accessibilityState={{ checked, disabled }}
										disabled={disabled}
										onPress={() => void toggle(topic, channel)}
										className={`flex-row items-center gap-3 py-2${disabled ? 'opacity-50' : ''}`}
									>
										<View
											className={`h-6 w-11 justify-center rounded-full px-0.5 ${checked ? 'bg-primary items-end' : 'bg-input items-start'}`}
										>
											<View className="bg-background h-5 w-5 rounded-full" />
										</View>
										<Text importantForAccessibility="no">
											{channelLabel(channel)}
										</Text>
									</Pressable>
								)
							})}
						</View>
						{note ? (
							<Text variant="muted" accessibilityLiveRegion="polite">
								{note}
							</Text>
						) : null}
					</View>
				)
			})}
			<Text variant="muted">
				{t`Turning a switch off never affects receipts or booking confirmations.`}
			</Text>
		</Card>
	)
}
