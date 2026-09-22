import { Ionicons } from '@expo/vector-icons'
import { useLingui } from '@lingui/react/macro'
import { type UserOrganization } from '@repo/types'
import { router } from 'expo-router'
import React, { useState } from 'react'
import {
	View,
	Text,
	TouchableOpacity,
	Modal,
	FlatList,
	Pressable,
	Alert,
} from 'react-native'
import { useDefaultOrganization } from '../lib/api/hooks/use-default-organization'
import { useOrganizations } from '../lib/api/hooks/use-organizations'
import { LoadingSpinner } from './ui'

interface OrganizationSwitcherProps {
	compact?: boolean
}

export function OrganizationSwitcher({
	compact = false,
}: OrganizationSwitcherProps) {
	const { t } = useLingui()
	const { organizations, isLoading, refetch } = useOrganizations()
	const { setDefaultOrganization, isUpdating } = useDefaultOrganization()
	const [isOpen, setIsOpen] = useState(false)

	const currentOrg = organizations?.find((org) => org.isDefault)

	const handleSelectOrganization = async (orgId: string) => {
		if (isUpdating) return

		const result = await setDefaultOrganization(orgId)
		if (result.success) {
			setIsOpen(false)
			await refetch()
		} else {
			Alert.alert(t`Error`, result.error || t`Failed to switch organization`)
		}
	}

	if (isLoading) {
		return (
			<View
				className={`flex-row items-center ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
			>
				<LoadingSpinner size="small" />
			</View>
		)
	}

	if (!currentOrg) {
		return null
	}

	return (
		<>
			{/* Trigger Button */}
			<TouchableOpacity
				onPress={() => setIsOpen(true)}
				className={`border-border bg-card flex-row items-center rounded-lg border ${
					compact ? 'px-2 py-1.5' : 'px-3 py-2'
				}`}
				accessibilityLabel={t`Switch organization`}
				accessibilityHint={t`Opens organization switcher`}
			>
				{/* Avatar */}
				<View
					className={`bg-primary items-center justify-center rounded-md ${
						compact ? 'h-7 w-7' : 'h-9 w-9'
					}`}
				>
					<Text
						className={`text-primary-foreground font-bold ${
							compact ? 'text-xs' : 'text-sm'
						}`}
					>
						{currentOrg.name.slice(0, 2).toUpperCase()}
					</Text>
				</View>

				{/* Name */}
				{!compact && (
					<View className="ml-2 flex-1">
						<Text className="text-foreground text-sm" numberOfLines={1}>
							{currentOrg.name}
						</Text>
						<Text className="text-muted-foreground text-xs">
							{currentOrg.role.name}
						</Text>
					</View>
				)}

				{/* Chevron */}
				<Ionicons
					name="chevron-down"
					size={compact ? 14 : 16}
					color="#888"
					style={{ marginLeft: compact ? 4 : 8 }}
				/>
			</TouchableOpacity>

			{/* Dropdown Modal */}
			<Modal
				visible={isOpen}
				transparent
				animationType="fade"
				onRequestClose={() => setIsOpen(false)}
			>
				<Pressable
					className="flex-1 bg-black/50"
					onPress={() => setIsOpen(false)}
				>
					<View className="flex-1 justify-start pt-24">
						<Pressable onPress={() => {}}>
							<View className="border-border bg-card mx-4 max-h-[60%] overflow-hidden rounded-xl border shadow-xl">
								{/* Header */}
								<View className="border-border border-b px-4 py-3">
									<Text className="text-muted-foreground text-xs font-medium uppercase">
										{t`Organizations`}
									</Text>
								</View>

								{/* Organization List */}
								<FlatList
									data={organizations}
									keyExtractor={(item: UserOrganization) => item.id}
									renderItem={({ item }: { item: UserOrganization }) => (
										<TouchableOpacity
											onPress={() => handleSelectOrganization(item.id)}
											disabled={isUpdating || item.isDefault}
											className={`flex-row items-center px-4 py-3 ${
												item.isDefault ? 'bg-primary/5' : ''
											}`}
										>
											{/* Avatar */}
											<View className="bg-primary h-9 w-9 items-center justify-center rounded-md">
												<Text className="text-primary-foreground text-sm font-bold">
													{item.name.slice(0, 2).toUpperCase()}
												</Text>
											</View>

											{/* Name & Role */}
											<View className="ml-3 flex-1">
												<Text className="text-foreground text-sm">
													{item.name}
												</Text>
												<Text className="text-muted-foreground text-xs capitalize">
													{item.role.name}
												</Text>
											</View>

											{/* Check mark for current */}
											{item.isDefault && (
												<Ionicons name="checkmark" size={20} color="#22c55e" />
											)}

											{/* Loading indicator when switching */}
											{isUpdating && !item.isDefault && (
												<LoadingSpinner size="small" />
											)}
										</TouchableOpacity>
									)}
									ItemSeparatorComponent={() => (
										<View className="bg-border mx-4 h-px" />
									)}
								/>

								{/* Footer Actions */}
								<View className="border-border border-t">
									<TouchableOpacity
										onPress={() => {
											setIsOpen(false)
											router.push('/(dashboard)/create-organization')
										}}
										className="flex-row items-center px-4 py-3"
									>
										<View className="border-border h-9 w-9 items-center justify-center rounded-md border">
											<Ionicons name="add" size={20} color="#888" />
										</View>
										<Text className="text-foreground ml-3 text-sm font-medium">
											{t`Add organization`}
										</Text>
									</TouchableOpacity>
								</View>
							</View>
						</Pressable>
					</View>
				</Pressable>
			</Modal>
		</>
	)
}
