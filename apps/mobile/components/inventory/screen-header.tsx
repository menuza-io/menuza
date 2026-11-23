import { Ionicons } from '@expo/vector-icons'
import { useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { LocationPicker } from './location-picker'

/** The top of an inventory screen: back, the title, the business and the location switcher. */
export function InventoryHeader({
	title,
	subtitle,
	showLocation = true,
	right,
}: {
	title: string
	subtitle?: string | null
	showLocation?: boolean
	right?: React.ReactNode
}) {
	const { t } = useLingui()
	return (
		<View className="px-5 pt-4 pb-2">
			<TouchableOpacity
				onPress={() => router.back()}
				accessibilityRole="button"
				accessibilityLabel={t`Back`}
				hitSlop={12}
				className="mb-2 self-start"
			>
				<Ionicons name="chevron-back" size={26} color="#888" />
			</TouchableOpacity>
			<View className="flex-row items-start justify-between gap-3">
				<View className="flex-1">
					<Text className="text-foreground text-2xl font-bold">{title}</Text>
					{subtitle ? (
						<Text className="text-muted-foreground mt-1 text-sm">
							{subtitle}
						</Text>
					) : null}
				</View>
				{right}
			</View>
			{showLocation ? (
				<View className="mt-2">
					<LocationPicker />
				</View>
			) : null}
		</View>
	)
}
