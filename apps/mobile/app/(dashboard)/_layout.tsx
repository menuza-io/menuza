import { Ionicons } from '@expo/vector-icons'
import { Tabs } from 'expo-router'
import React from 'react'
import { View, useColorScheme } from 'react-native'
import { OrganizationSwitcher } from '../../components/organization-switcher'

export default function DashboardLayout() {
	const colorScheme = useColorScheme()
	const isDark = colorScheme === 'dark'

	return (
		<Tabs
			screenOptions={{
				tabBarActiveTintColor: isDark ? '#fff' : '#000',
				tabBarInactiveTintColor: isDark ? '#888' : '#666',
				tabBarStyle: {
					backgroundColor: isDark ? '#1a1a1a' : '#fff',
					borderTopColor: isDark ? '#333' : '#e5e5e5',
				},
				headerStyle: {
					backgroundColor: isDark ? '#1a1a1a' : '#fff',
				},
				headerTintColor: isDark ? '#fff' : '#000',
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: 'Home',
					headerLeft: () => (
						<View style={{ marginLeft: 16 }}>
							<OrganizationSwitcher />
						</View>
					),
					headerTitle: () => null,
					tabBarIcon: ({ color, size }) => (
						<Ionicons name="home-outline" size={size} color={color as string} />
					),
				}}
			/>
			<Tabs.Screen
				name="organizations"
				options={{
					title: 'Organizations',
					tabBarIcon: ({ color, size }) => (
						<Ionicons
							name="business-outline"
							size={size}
							color={color as string}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					title: 'Settings',
					headerShown: false,
					tabBarIcon: ({ color, size }) => (
						<Ionicons
							name="settings-outline"
							size={size}
							color={color as string}
						/>
					),
				}}
			/>
			<Tabs.Screen
				name="create-organization"
				options={{
					title: 'Create Organization',
					href: null, // Hide from tab bar
				}}
			/>
		</Tabs>
	)
}
