import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React from 'react'
import {
	View,
	Text,
	ScrollView,
	TouchableOpacity,
	RefreshControl,
} from 'react-native'
import { Screen, Card, CardHeader, CardContent } from '../../components/ui'
import { useOrganizations } from '../../lib/api/hooks/use-organizations'
import { useAuth } from '../../lib/auth/hooks/use-auth'

export default function DashboardScreen() {
	const { t } = useLingui()
	const { user } = useAuth()
	const {
		organizations,
		isLoading: organizationsLoading,
		refetch,
	} = useOrganizations()

	const [refreshing, setRefreshing] = React.useState(false)

	const onRefresh = async () => {
		setRefreshing(true)
		await refetch()
		setRefreshing(false)
	}

	const defaultOrg = organizations?.find((org) => org.isDefault)

	if (!user) {
		return (
			<Screen>
				<View className="flex-1 items-center justify-center">
					<Text
						className="text-muted-foreground text-base"
						accessibilityLiveRegion="polite"
					>
						<Trans>Loading...</Trans>
					</Text>
				</View>
			</Screen>
		)
	}

	return (
		<Screen>
			<ScrollView
				contentContainerClassName="grow"
				showsVerticalScrollIndicator={false}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
				}
			>
				<View className="flex-1 p-5">
					{/* Welcome Header */}
					<View className="mb-6">
						<Text className="text-muted-foreground mb-1 text-lg">
							<Trans>Welcome back,</Trans>
						</Text>
						<Text className="text-foreground text-2xl font-bold">
							{user.name || user.username}
						</Text>
						{defaultOrg && (
							<Text className="text-muted-foreground mt-1 text-sm">
								{t`Working in ${defaultOrg.name}`}
							</Text>
						)}
					</View>

					{/* Quick Actions */}
					<Card className="mb-4">
						<CardHeader>
							<Text className="text-foreground text-lg">
								<Trans>Quick Actions</Trans>
							</Text>
						</CardHeader>
						<CardContent>
							<View className="flex-row flex-wrap gap-3">
								<TouchableOpacity
									onPress={() => router.push('/(dashboard)/organizations')}
									className="bg-muted min-w-[140px] flex-1 items-center rounded-lg p-4"
								>
									<Ionicons name="business-outline" size={24} color="#888" />
									<Text className="text-foreground mt-2 text-sm font-medium">
										<Trans>Organizations</Trans>
									</Text>
								</TouchableOpacity>
								<TouchableOpacity
									onPress={() => router.push('/(dashboard)/settings/profile')}
									className="bg-muted min-w-[140px] flex-1 items-center rounded-lg p-4"
								>
									<Ionicons name="person-outline" size={24} color="#888" />
									<Text className="text-foreground mt-2 text-sm font-medium">
										<Trans>Edit Profile</Trans>
									</Text>
								</TouchableOpacity>
							</View>
						</CardContent>
					</Card>

					{/* Organizations Summary */}
					<Card className="mb-4">
						<CardHeader>
							<View className="flex-row items-center justify-between">
								<Text className="text-foreground text-lg">
									<Trans>Your Organizations</Trans>
								</Text>
								<TouchableOpacity
									onPress={() => router.push('/(dashboard)/organizations')}
								>
									<Text className="text-primary text-sm">
										<Trans>View All</Trans>
									</Text>
								</TouchableOpacity>
							</View>
						</CardHeader>
						<CardContent>
							{organizationsLoading ? (
								<Text className="text-muted-foreground text-base">
									<Trans>Loading organizations...</Trans>
								</Text>
							) : organizations && organizations.length === 0 ? (
								<Text className="text-muted-foreground text-center text-sm italic">
									<Trans>No organizations found</Trans>
								</Text>
							) : (
								<View>
									{organizations?.slice(0, 3).map((org, index) => (
										<View
											key={org.id}
											className={`flex-row items-center py-3 ${
												index !== Math.min(organizations.length - 1, 2)
													? 'border-border border-b'
													: ''
											}`}
										>
											<View className="bg-primary/10 h-10 w-10 items-center justify-center rounded-full">
												<Text className="text-primary">
													{org.name.charAt(0).toUpperCase()}
												</Text>
											</View>
											<View className="ml-3 flex-1">
												<View className="flex-row items-center">
													<Text className="text-foreground text-sm">
														{org.name}
													</Text>
													{org.isDefault && (
														<View className="bg-primary ml-2 rounded-full px-2 py-0.5">
															<Text className="text-primary-foreground text-[10px] uppercase">
																<Trans>Current</Trans>
															</Text>
														</View>
													)}
												</View>
												<Text className="text-muted-foreground text-xs capitalize">
													{org.role.name}
												</Text>
											</View>
										</View>
									))}
									{organizations && organizations.length > 3 && (
										<TouchableOpacity
											onPress={() => router.push('/(dashboard)/organizations')}
											className="mt-2 py-2"
										>
											<Text className="text-primary text-center text-sm">
												{t`+${organizations.length - 3} more organizations`}
											</Text>
										</TouchableOpacity>
									)}
								</View>
							)}
						</CardContent>
					</Card>

					{/* App Info */}
					<Card>
						<CardContent className="p-4">
							<View className="flex-row items-center">
								<Ionicons
									name="information-circle-outline"
									size={20}
									color="#888"
								/>
								<Text className="text-muted-foreground ml-2 text-sm">
									<Trans>Epic Stack Mobile v1.0.0</Trans>
								</Text>
							</View>
						</CardContent>
					</Card>
				</View>
			</ScrollView>
		</Screen>
	)
}
