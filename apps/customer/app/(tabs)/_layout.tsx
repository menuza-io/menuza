import { useLingui } from '@lingui/react/macro'
import { Tabs } from 'expo-router'
import { useEffect } from 'react'
import { type ColorValue } from 'react-native'
import { Icon } from '../../components/ui/icon'
import { useLoyalty } from '../../lib/app/use-app'
import { useThemePalette } from '../../lib/theme/use-theme-palette'

function tabIconColor(color: ColorValue | undefined, fallback: string): string {
	return typeof color === 'string' ? color : fallback
}

/**
 * The signed-in customer's tabs, in the organization's colors. The shell
 * above draws the brand header, so the tabs have no header of their own.
 * Rewards hides itself on a site that runs no rewards program.
 */
export default function TabsLayout() {
	const { t } = useLingui()
	const palette = useThemePalette()
	const loyalty = useLoyalty()
	const loyaltyStore = loyalty?.store ?? null
	useEffect(() => {
		loyaltyStore?.start()
	}, [loyaltyStore])
	const hideRewards = loyalty?.snapshot.status === 'unavailable'

	return (
		<Tabs
			screenOptions={{
				headerShown: false,
				tabBarActiveTintColor: palette.primary,
				tabBarInactiveTintColor: palette.mutedForeground,
				tabBarStyle: {
					backgroundColor: palette.card,
					borderTopColor: palette.border,
				},
				sceneStyle: { backgroundColor: palette.background },
			}}
		>
			<Tabs.Screen name="index" options={{ href: null }} />
			<Tabs.Screen
				name="reservations"
				options={{
					title: t`Reservations`,
					tabBarIcon: ({ color, size }) => (
						<Icon
							name="calendar-outline"
							size={size}
							color={tabIconColor(color, palette.primary)}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="rewards"
				options={{
					title: t`Rewards`,
					href: hideRewards ? null : undefined,
					tabBarIcon: ({ color, size }) => (
						<Icon
							name="gift-outline"
							size={size}
							color={tabIconColor(color, palette.primary)}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="profile"
				options={{
					title: t`Profile`,
					tabBarIcon: ({ color, size }) => (
						<Icon
							name="person-circle-outline"
							size={size}
							color={tabIconColor(color, palette.primary)}
						/>
					),
				}}
			/>
		</Tabs>
	)
}
