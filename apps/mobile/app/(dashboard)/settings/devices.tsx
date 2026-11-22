import { Trans, useLingui } from '@lingui/react/macro'
import React, { useCallback, useEffect, useState } from 'react'
import {
	ActivityIndicator,
	Alert,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from 'react-native'
import { Screen, Card, Divider } from '../../../components/ui'
import {
	listPushDevices,
	removePushDevice,
	type PushDevice,
} from '../../../lib/api/push'
import { storedPushDeviceId } from '../../../lib/push/operator-push'

/**
 * Profile, Devices (#106): the phones that get pushes for you. Remove one and it
 * stops at once (the same list is in Settings, Notifications in the App).
 */
export default function DevicesScreen() {
	const { t } = useLingui()
	const [devices, setDevices] = useState<PushDevice[] | null>(null)
	const [thisDevice, setThisDevice] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)

	const load = useCallback(async () => {
		setLoading(true)
		const [result, mine] = await Promise.all([
			listPushDevices(),
			storedPushDeviceId(),
		])
		setThisDevice(mine)
		if (result.ok) setDevices(result.data.devices)
		else Alert.alert(t`Error`, result.message)
		setLoading(false)
	}, [t])

	useEffect(() => {
		void load()
	}, [load])

	const confirmRemove = (device: PushDevice) =>
		Alert.alert(
			t`Remove this phone?`,
			t`It will stop getting alerts for you.`,
			[
				{ text: t`Cancel`, style: 'cancel' },
				{
					text: t`Remove`,
					style: 'destructive',
					onPress: async () => {
						const result = await removePushDevice({ deviceId: device.id })
						if (!result.ok) Alert.alert(t`Error`, result.message)
						await load()
					},
				},
			],
		)

	return (
		<Screen>
			<ScrollView contentContainerClassName="grow p-4">
				{loading ? (
					<ActivityIndicator accessibilityLabel={t`Loading`} />
				) : !devices || devices.length === 0 ? (
					<Text className="text-muted-foreground text-base">
						<Trans>No phone is set up for alerts yet.</Trans>
					</Text>
				) : (
					<Card>
						<View className="px-4">
							{devices.map((device, index) => (
								<View key={device.id}>
									{index > 0 ? <Divider /> : null}
									<View className="flex-row items-center justify-between py-3">
										<View className="mr-3 flex-1">
											<Text className="text-foreground text-base">
												{device.deviceName ?? device.platform}
												{device.id === thisDevice ? ` · ${t`This phone`}` : ''}
											</Text>
											<Text className="text-muted-foreground text-sm">
												<Trans>
													Last used{' '}
													{new Date(device.lastSeenAt).toLocaleString()}
												</Trans>
											</Text>
										</View>
										<TouchableOpacity onPress={() => confirmRemove(device)}>
											<Text className="text-destructive text-base font-medium">
												<Trans>Remove</Trans>
											</Text>
										</TouchableOpacity>
									</View>
								</View>
							))}
						</View>
					</Card>
				)}
			</ScrollView>
		</Screen>
	)
}
