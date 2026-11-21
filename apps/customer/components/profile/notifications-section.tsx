import { useLingui } from '@lingui/react/macro'
import { useEffect, useMemo, useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { type PushPreferences } from '../../lib/api/push'
import { useAppSnapshot } from '../../lib/app/use-app'
import { PushManager, type PushState } from '../../lib/push/push-manager'
import { Button, Card, Text } from '../ui'
import { rowClass } from './messages-section'

type Category = 'orders' | 'bookings' | 'rewards'

/**
 * "Notifications" (#105): a pre-prompt that says what the app will tell the
 * guest before the system asks, then one switch per category and the separate,
 * default-off "Offers and news" opt-in. Hidden whenever push is not on for
 * this restaurant (flag, kill switch, KSA, or no push credentials for the app).
 *
 * The system prompt appears only after "Turn on". "Not now" hides the pre-prompt
 * for the session and asks nothing. Receipts and booking confirmations are
 * emails or texts and are never affected by these switches.
 */
export function NotificationsSection(props: { manager?: PushManager }) {
	const { t } = useLingui()
	const { session, organization, language } = useAppSnapshot()
	const manager = useMemo(
		() =>
			props.manager ??
			(session
				? new PushManager({ session, language: () => language.code })
				: null),
		[props.manager, session, language.code],
	)
	const [state, setState] = useState<PushState | null>(null)
	const [dismissed, setDismissed] = useState(false)
	const [offers, setOffers] = useState(false)
	const [busy, setBusy] = useState(false)
	const [note, setNote] = useState('')

	useEffect(() => {
		if (!manager) return
		let live = true
		manager
			.state()
			.then((loaded) => {
				if (live) setState(loaded)
			})
			.catch(() => {
				// Stay hidden: the profile above is complete without this section.
			})
		return () => {
			live = false
		}
	}, [manager])

	if (!manager || !state || state.kind === 'unavailable') return null

	const name = organization?.name ?? ''
	const { permission, preferences } = state
	const on = permission === 'granted' && preferences.hasDevice
	const set = (preferences: PushPreferences) =>
		setState({ kind: 'ready', permission: 'granted', preferences })

	const turnOn = async () => {
		if (busy) return
		setBusy(true)
		setNote('')
		try {
			const result = await manager.enable({ marketing: offers })
			if (result.kind === 'enabled') set(result.preferences)
			else if (result.kind === 'denied') {
				setState({ kind: 'ready', permission: 'denied', preferences })
			} else {
				setNote(t`Notifications are not available on this device.`)
			}
		} catch {
			setNote(t`We couldn't turn notifications on. Try again.`)
		} finally {
			setBusy(false)
		}
	}

	const change = async (
		next: Partial<Pick<PushPreferences, Category | 'marketing'>>,
	) => {
		if (busy) return
		const before = preferences
		setBusy(true)
		setNote('')
		set({ ...preferences, ...next })
		try {
			set(
				await manager.setPreferences({
					...next,
					...('marketing' in next && next.marketing
						? { source: 'profile' }
						: {}),
				}),
			)
		} catch {
			set(before)
			setNote(t`We couldn't save that. Try again.`)
		} finally {
			setBusy(false)
		}
	}

	const categories: Array<{ key: Category; label: string }> = [
		{ key: 'orders', label: t`Order updates` },
		{ key: 'bookings', label: t`Booking updates` },
		{ key: 'rewards', label: t`Rewards` },
	]

	const Switch = ({
		label,
		checked,
		onPress,
	}: {
		label: string
		checked: boolean
		onPress: () => void
	}) => (
		<Pressable
			accessibilityRole="switch"
			accessibilityLabel={label}
			accessibilityState={{ checked, disabled: busy }}
			disabled={busy}
			onPress={onPress}
			hitSlop={8}
			className={rowClass(busy)}
		>
			<View
				className={`h-6 w-11 justify-center rounded-full px-0.5 ${checked ? 'bg-primary items-end' : 'bg-input items-start'}`}
			>
				<View className="bg-background h-5 w-5 rounded-full" />
			</View>
			<Text importantForAccessibility="no">{label}</Text>
		</Pressable>
	)

	if (!on && permission !== 'denied') {
		if (dismissed) return null
		// The pre-prompt: say what we will send before the system asks.
		return (
			<Card className="gap-3">
				<View className="gap-1.5">
					<Text variant="heading" accessibilityRole="header">
						{t`Notifications from ${name}`}
					</Text>
					<Text variant="muted">
						{t`Get a message when your order is accepted or ready, when your booking is confirmed or coming up, and when a reward is waiting.`}
					</Text>
				</View>
				{preferences.marketingAvailable ? (
					<Switch
						label={t`Also send me offers and news`}
						checked={offers}
						onPress={() => setOffers((value) => !value)}
					/>
				) : null}
				<View className="flex-row gap-3">
					<Button onPress={() => void turnOn()} loading={busy}>
						{t`Turn on notifications`}
					</Button>
					<Button variant="ghost" onPress={() => setDismissed(true)}>
						{t`Not now`}
					</Button>
				</View>
				{note ? <Text variant="muted">{note}</Text> : null}
			</Card>
		)
	}

	if (permission === 'denied') {
		return (
			<Card className="gap-3">
				<Text variant="heading" accessibilityRole="header">
					{t`Notifications from ${name}`}
				</Text>
				<Text variant="muted">
					{t`Notifications are off in your phone's settings. Turn them on there to hear about your orders and bookings.`}
				</Text>
				<Button variant="outline" onPress={() => void Linking.openSettings()}>
					{t`Open settings`}
				</Button>
			</Card>
		)
	}

	return (
		<Card className="gap-3">
			<View className="gap-1.5">
				<Text variant="heading" accessibilityRole="header">
					{t`Notifications from ${name}`}
				</Text>
				<Text variant="muted">{t`Choose what this phone tells you about.`}</Text>
			</View>
			<View className="flex-row flex-wrap gap-x-6">
				{categories.map(({ key, label }) => (
					<Switch
						key={key}
						label={label}
						checked={preferences[key]}
						onPress={() => void change({ [key]: !preferences[key] })}
					/>
				))}
			</View>
			{preferences.marketingAvailable ? (
				<View className="gap-1">
					<Switch
						label={t`Offers and news`}
						checked={preferences.marketing}
						onPress={() => void change({ marketing: !preferences.marketing })}
					/>
					<Text variant="muted">
						{t`A few messages a month. You can turn this off anytime.`}
					</Text>
				</View>
			) : null}
			{note ? <Text variant="muted">{note}</Text> : null}
			<Text variant="muted">
				{t`Turning a switch off never affects receipts or booking confirmations.`}
			</Text>
		</Card>
	)
}
