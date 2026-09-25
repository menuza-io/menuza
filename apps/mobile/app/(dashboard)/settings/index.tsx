import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React from 'react'
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native'
import { Screen, Card, Divider } from '../../../components/ui'
import { useAuth } from '../../../lib/auth/hooks/use-auth'

interface SettingsItemProps {
	icon: keyof typeof Ionicons.glyphMap
	label: string
	onPress: () => void
	destructive?: boolean
	value?: string
}

function SettingsItem({
	icon,
	label,
	onPress,
	destructive,
	value,
}: SettingsItemProps) {
	return (
		<TouchableOpacity onPress={onPress} className="flex-row items-center py-3">
			<Ionicons
				name={icon}
				size={22}
				color={destructive ? '#ef4444' : '#888'}
			/>
			<Text
				className={`ml-3 flex-1 text-base ${
					destructive ? 'text-destructive' : 'text-foreground'
				}`}
			>
				{label}
			</Text>
			{value && (
				<Text className="text-muted-foreground mr-2 text-sm">{value}</Text>
			)}
			<Ionicons name="chevron-forward" size={18} color="#888" />
		</TouchableOpacity>
	)
}

export default function SettingsScreen() {
	const { t } = useLingui()
	const { user, logout } = useAuth()

	const handleLogout = () => {
		Alert.alert(t`Sign Out`, t`Are you sure you want to sign out?`, [
			{ text: t`Cancel`, style: 'cancel' },
			{
				text: t`Sign Out`,
				style: 'destructive',
				onPress: async () => {
					await logout()
					router.replace('/(auth)/sign-in')
				},
			},
		])
	}

	return (
		<Screen>
			<ScrollView
				contentContainerClassName="grow p-4"
				showsVerticalScrollIndicator={false}
			>
				{/* User Info Section */}
				<Card className="mb-4">
					<TouchableOpacity
						onPress={() => router.push('/(dashboard)/settings/profile')}
						className="flex-row items-center p-4"
					>
						<View className="bg-primary h-14 w-14 items-center justify-center rounded-full">
							<Text className="text-primary-foreground text-xl font-bold">
								{(user?.name || user?.username || 'U').charAt(0).toUpperCase()}
							</Text>
						</View>
						<View className="ml-3 flex-1">
							<Text className="text-foreground text-lg">
								{user?.name || user?.username}
							</Text>
							<Text className="text-muted-foreground text-sm">
								{user?.email}
							</Text>
						</View>
						<Ionicons name="chevron-forward" size={20} color="#888" />
					</TouchableOpacity>
				</Card>

				{/* Account Section */}
				<Card className="mb-4">
					<View className="px-4 pt-4 pb-1">
						<Text className="text-muted-foreground text-xs font-medium uppercase">
							<Trans>Account</Trans>
						</Text>
					</View>
					<View className="px-4">
						<SettingsItem
							icon="person-outline"
							label={t`Edit Profile`}
							onPress={() => router.push('/(dashboard)/settings/profile')}
						/>
						<Divider />
						<SettingsItem
							icon="shield-outline"
							label={t`Security`}
							onPress={() => router.push('/(dashboard)/settings/security')}
						/>
					</View>
				</Card>

				{/* App Section */}
				<Card className="mb-4">
					<View className="px-4 pt-4 pb-1">
						<Text className="text-muted-foreground text-xs font-medium uppercase">
							<Trans>App</Trans>
						</Text>
					</View>
					<View className="px-4">
						<SettingsItem
							icon="information-circle-outline"
							label={t`About`}
							onPress={() =>
								Alert.alert(t`Epic Stack Mobile`, t`Version 1.0.0`)
							}
							value="v1.0.0"
						/>
					</View>
				</Card>

				{/* Danger Zone */}
				<Card>
					<View className="px-4 py-3">
						<SettingsItem
							icon="log-out-outline"
							label={t`Sign Out`}
							onPress={handleLogout}
							destructive
						/>
					</View>
				</Card>
			</ScrollView>
		</Screen>
	)
}
