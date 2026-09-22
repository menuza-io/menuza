import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { type UserOrganization } from '@repo/types'
import { router } from 'expo-router'
import React, { useState } from 'react'
import {
	View,
	Text,
	FlatList,
	TouchableOpacity,
	RefreshControl,
	Alert,
} from 'react-native'
import { Screen, Card, Button, LoadingSpinner } from '../../components/ui'
import { useDefaultOrganization } from '../../lib/api/hooks/use-default-organization'
import { useOrganizations } from '../../lib/api/hooks/use-organizations'

export default function OrganizationsScreen() {
	const { t } = useLingui()
	const { organizations, isLoading, error, refetch } = useOrganizations()
	const { setDefaultOrganization, isUpdating } = useDefaultOrganization()
	const [refreshing, setRefreshing] = useState(false)

	const onRefresh = async () => {
		setRefreshing(true)
		await refetch()
		setRefreshing(false)
	}

	const handleSetDefault = (orgId: string, orgName: string) => {
		Alert.alert(
			t`Set Default Organization`,
			t`Set "${orgName}" as your default organization?`,
			[
				{ text: t`Cancel`, style: 'cancel' },
				{
					text: t`Set Default`,
					onPress: async () => {
						const result = await setDefaultOrganization(orgId)
						if (result.success) {
							Alert.alert(
								t`Success`,
								t`${orgName} is now your default organization`,
							)
							await refetch()
						} else {
							Alert.alert(
								t`Error`,
								result.error || t`Failed to set default organization`,
							)
						}
					},
				},
			],
		)
	}

	if (isLoading && !refreshing) {
		return (
			<Screen>
				<View className="flex-1 items-center justify-center">
					<LoadingSpinner size="large" />
				</View>
			</Screen>
		)
	}

	if (error) {
		return (
			<Screen>
				<View className="flex-1 items-center justify-center p-5">
					<Text className="text-destructive text-center">{error}</Text>
					<TouchableOpacity onPress={refetch} className="mt-4">
						<Text className="text-primary">
							<Trans>Tap to retry</Trans>
						</Text>
					</TouchableOpacity>
				</View>
			</Screen>
		)
	}

	return (
		<Screen>
			<FlatList
				data={organizations}
				keyExtractor={(item: UserOrganization) => item.id}
				contentContainerStyle={{ padding: 16 }}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				}
				ListHeaderComponent={
					<View className="mb-4">
						<Button
							onPress={() => router.push('/(dashboard)/create-organization')}
							variant="outline"
							className="w-full"
						>
							<View className="flex-row items-center">
								<Ionicons name="add" size={18} color="#888" />
								<Text className="text-foreground ml-2">
									<Trans>Add Organization</Trans>
								</Text>
							</View>
						</Button>
					</View>
				}
				ListEmptyComponent={
					<View className="items-center justify-center py-8">
						<Ionicons name="business-outline" size={48} color="#888" />
						<Text className="text-muted-foreground mt-4 text-center">
							<Trans>No organizations found</Trans>
						</Text>
						<Button
							onPress={() => router.push('/(dashboard)/create-organization')}
							className="mt-4"
						>
							<Trans>Create Your First Organization</Trans>
						</Button>
					</View>
				}
				renderItem={({ item }: { item: UserOrganization }) => (
					<Card className="mb-3">
						<TouchableOpacity
							onPress={() => handleSetDefault(item.id, item.name)}
							disabled={isUpdating || item.isDefault}
							className="p-4"
						>
							<View className="flex-row items-center">
								<View className="bg-primary/10 h-12 w-12 items-center justify-center rounded-full">
									<Text className="text-primary text-lg font-bold">
										{item.name.charAt(0).toUpperCase()}
									</Text>
								</View>
								<View className="ml-3 flex-1">
									<View className="flex-row items-center">
										<Text className="text-foreground text-base">
											{item.name}
										</Text>
										{item.isDefault && (
											<View className="bg-primary ml-2 rounded-full px-2 py-0.5">
												<Text className="text-primary-foreground text-xs font-medium">
													<Trans>Default</Trans>
												</Text>
											</View>
										)}
									</View>
									<Text className="text-muted-foreground text-sm capitalize">
										{item.role.name}
									</Text>
								</View>
								{!item.isDefault && (
									<Ionicons name="chevron-forward" size={20} color="#888" />
								)}
							</View>
						</TouchableOpacity>
					</Card>
				)}
			/>
		</Screen>
	)
}
