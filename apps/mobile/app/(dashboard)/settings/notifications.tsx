import { Trans, useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React, { useCallback, useEffect, useState } from 'react'
import {
	ActivityIndicator,
	Alert,
	ScrollView,
	Switch,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native'
import { Screen, Card, Divider } from '../../../components/ui'
import { useOrganizations } from '../../../lib/api/hooks/use-organizations'
import {
	fetchAlertSettings,
	saveAlertSetting,
	type AlertSettingChange,
	type AlertSettings,
	type PushCategory,
} from '../../../lib/api/push'

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Settings, Notifications (#106, #366): which alerts arrive as a push on this
 * phone, for the organization you are in, quiet hours and a snooze. The same
 * settings as Settings, Notifications in the App. Payment review is always on.
 */
export default function NotificationSettingsScreen() {
	const { t } = useLingui()
	const { organizations } = useOrganizations()
	const organization = organizations?.find((org) => org.isDefault)
	const [settings, setSettings] = useState<AlertSettings | null>(null)
	const [loading, setLoading] = useState(true)
	const [saving, setSaving] = useState(false)
	const [quietStart, setQuietStart] = useState('22:00')
	const [quietEnd, setQuietEnd] = useState('07:00')

	const labels: Record<PushCategory, string> = {
		new_orders: t`New orders`,
		orders_waiting: t`Orders waiting too long`,
		ordering_paused: t`Ordering paused for too long`,
		payment_review: t`A payment needs review`,
		large_orders: t`Large orders`,
		station_offline: t`A kitchen tablet goes offline`,
		staff: t`Staff`,
		inventory: t`Inventory`,
		reservations: t`Reservations`,
		chat_mentions: t`Team chat mentions`,
	}

	const apply = useCallback((next: AlertSettings) => {
		setSettings(next)
		setQuietStart(next.quiet.quietStart ?? '22:00')
		setQuietEnd(next.quiet.quietEnd ?? '07:00')
	}, [])

	useEffect(() => {
		if (!organization) return
		let live = true
		setLoading(true)
		void fetchAlertSettings(organization.id).then((result) => {
			if (!live) return
			if (result.ok) apply(result.data.settings)
			else Alert.alert(t`Error`, result.message)
			setLoading(false)
		})
		return () => {
			live = false
		}
	}, [organization, apply, t])

	const save = async (change: AlertSettingChange) => {
		if (!organization) return
		setSaving(true)
		const result = await saveAlertSetting(organization.id, change)
		setSaving(false)
		if (result.ok) apply(result.data.settings)
		else Alert.alert(t`Error`, result.message)
	}

	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const quietOn = Boolean(
		settings?.quiet.quietStart && settings?.quiet.quietEnd,
	)
	const snoozed =
		settings?.snoozedUntil && settings.snoozedUntil > Date.now()
			? settings.snoozedUntil
			: null

	return (
		<Screen>
			<ScrollView contentContainerClassName="grow p-4">
				{loading || !settings ? (
					<ActivityIndicator accessibilityLabel={t`Loading`} />
				) : (
					<>
						<Card className="mb-4">
							<View className="px-4 pt-4 pb-1">
								<Text className="text-muted-foreground text-xs font-medium uppercase">
									<Trans>Push notifications</Trans>
								</Text>
							</View>
							<View className="px-4 pb-2">
								{!settings.pushEnabled ? (
									<Text className="text-muted-foreground py-3 text-sm">
										<Trans>
											Push notifications are not turned on for this organization
											yet.
										</Trans>
									</Text>
								) : (
									settings.categories.map((row, index) => (
										<View key={row.category}>
											{index > 0 ? <Divider /> : null}
											<View className="flex-row items-center justify-between py-3">
												<Text className="text-foreground mr-3 flex-1 text-base">
													{labels[row.category]}
												</Text>
												<Switch
													accessibilityLabel={labels[row.category]}
													value={row.push}
													disabled={row.locked || saving}
													onValueChange={(enabled) =>
														void save({
															intent: 'push',
															category: row.category,
															enabled,
														})
													}
												/>
											</View>
										</View>
									))
								)}
							</View>
						</Card>

						<Card className="mb-4">
							<View className="px-4 pt-4 pb-1">
								<Text className="text-muted-foreground text-xs font-medium uppercase">
									<Trans>Quiet hours</Trans>
								</Text>
							</View>
							<View className="px-4 pb-4">
								<View className="flex-row items-center justify-between py-3">
									<Text className="text-foreground mr-3 flex-1 text-base">
										<Trans>Hold alerts that can wait</Trans>
									</Text>
									<Switch
										accessibilityLabel={t`Hold alerts that can wait`}
										value={quietOn}
										disabled={saving}
										onValueChange={(on) =>
											void save({
												intent: 'quiet_hours',
												quiet: on
													? {
															quietStart,
															quietEnd,
															timeZone: settings.quiet.timeZone ?? timeZone,
														}
													: {
															quietStart: null,
															quietEnd: null,
															timeZone: settings.quiet.timeZone ?? timeZone,
														},
											})
										}
									/>
								</View>
								{quietOn ? (
									<View className="flex-row items-center gap-3">
										<TextInput
											accessibilityLabel={t`From`}
											className="text-foreground border-border w-24 rounded border px-3 py-2"
											value={quietStart}
											onChangeText={setQuietStart}
											placeholder="22:00"
											autoCapitalize="none"
										/>
										<Text className="text-muted-foreground">
											<Trans>to</Trans>
										</Text>
										<TextInput
											accessibilityLabel={t`Until`}
											className="text-foreground border-border w-24 rounded border px-3 py-2"
											value={quietEnd}
											onChangeText={setQuietEnd}
											placeholder="07:00"
											autoCapitalize="none"
										/>
										<TouchableOpacity
											disabled={
												saving || !HHMM.test(quietStart) || !HHMM.test(quietEnd)
											}
											onPress={() =>
												void save({
													intent: 'quiet_hours',
													quiet: {
														quietStart,
														quietEnd,
														timeZone: settings.quiet.timeZone ?? timeZone,
													},
												})
											}
										>
											<Text className="text-primary text-base font-medium">
												<Trans>Save</Trans>
											</Text>
										</TouchableOpacity>
									</View>
								) : null}
							</View>
						</Card>

						<Card className="mb-4">
							<View className="px-4 pt-4 pb-1">
								<Text className="text-muted-foreground text-xs font-medium uppercase">
									<Trans>Snooze</Trans>
								</Text>
							</View>
							<View className="px-4 pb-4">
								{snoozed ? (
									<Text className="text-foreground mb-2 text-sm">
										<Trans>
											Snoozed until {new Date(snoozed).toLocaleString()}
										</Trans>
									</Text>
								) : null}
								<View className="flex-row flex-wrap gap-4">
									<TouchableOpacity
										disabled={saving}
										onPress={() =>
											void save({ intent: 'snooze', option: '1h' })
										}
									>
										<Text className="text-primary text-base font-medium">
											<Trans>1 hour</Trans>
										</Text>
									</TouchableOpacity>
									<TouchableOpacity
										disabled={saving}
										onPress={() =>
											void save({
												intent: 'snooze',
												option: 'tomorrow',
												timeZone: settings.quiet.timeZone ?? timeZone,
											})
										}
									>
										<Text className="text-primary text-base font-medium">
											<Trans>Until tomorrow morning</Trans>
										</Text>
									</TouchableOpacity>
									{snoozed ? (
										<TouchableOpacity
											disabled={saving}
											onPress={() =>
												void save({ intent: 'snooze', option: 'clear' })
											}
										>
											<Text className="text-primary text-base font-medium">
												<Trans>Turn off</Trans>
											</Text>
										</TouchableOpacity>
									) : null}
								</View>
							</View>
						</Card>

						<TouchableOpacity
							onPress={() => router.push('/(dashboard)/settings/devices')}
							className="px-1 py-2"
						>
							<Text className="text-primary text-base font-medium">
								<Trans>Your phones</Trans>
							</Text>
						</TouchableOpacity>
					</>
				)}
			</ScrollView>
		</Screen>
	)
}
