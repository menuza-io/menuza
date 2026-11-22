import { Stack } from 'expo-router'
import { useColorScheme } from 'react-native'

export default function SettingsLayout() {
	const colorScheme = useColorScheme()
	const isDark = colorScheme === 'dark'

	return (
		<Stack
			screenOptions={{
				headerStyle: {
					backgroundColor: isDark ? '#1a1a1a' : '#fff',
				},
				headerTintColor: isDark ? '#fff' : '#000',
			}}
		>
			<Stack.Screen
				name="index"
				options={{
					title: 'Settings',
				}}
			/>
			<Stack.Screen
				name="profile"
				options={{
					title: 'Edit Profile',
				}}
			/>
			<Stack.Screen
				name="security"
				options={{
					title: 'Security',
				}}
			/>
			<Stack.Screen
				name="notifications"
				options={{
					title: 'Notifications',
				}}
			/>
			<Stack.Screen
				name="devices"
				options={{
					title: 'Your phones',
				}}
			/>
		</Stack>
	)
}
