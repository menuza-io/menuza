import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import React, { useState } from 'react'
import {
	FlatList,
	Modal,
	Pressable,
	Text,
	TouchableOpacity,
	View,
} from 'react-native'
import { useInventory } from '../../hooks/use-inventory'

/**
 * The location switcher. It lists only the locations the member may see (the
 * token route names no others), so choosing one can never reach another
 * location's stock. Hidden when there is only one.
 */
export function LocationPicker() {
	const { t } = useLingui()
	const { access, locationId, setLocationId } = useInventory()
	const [open, setOpen] = useState(false)
	const locations = access?.locations ?? []
	const current = locations.find((location) => location.id === locationId)
	if (locations.length < 2 || !current) {
		return current ? (
			<Text className="text-muted-foreground text-sm">{current.name}</Text>
		) : null
	}
	return (
		<>
			<TouchableOpacity
				onPress={() => setOpen(true)}
				accessibilityRole="button"
				accessibilityLabel={t`Change location, now ${current.name}`}
				className="flex-row items-center gap-1 self-start"
			>
				<Ionicons name="location-outline" size={16} color="#888" />
				<Text className="text-foreground text-sm font-medium">
					{current.name}
				</Text>
				<Ionicons name="chevron-down" size={14} color="#888" />
			</TouchableOpacity>
			<Modal
				visible={open}
				transparent
				animationType="fade"
				onRequestClose={() => setOpen(false)}
			>
				<Pressable
					className="flex-1 justify-end bg-black/40"
					onPress={() => setOpen(false)}
				>
					<View className="bg-card rounded-t-2xl p-4">
						<Text className="text-foreground mb-2 text-lg font-semibold">
							<Trans>Location</Trans>
						</Text>
						<FlatList<{ id: string; name: string }>
							data={locations}
							keyExtractor={(location: { id: string }) => location.id}
							renderItem={({
								item,
							}: {
								item: { id: string; name: string }
							}) => (
								<TouchableOpacity
									onPress={() => {
										setLocationId(item.id)
										setOpen(false)
									}}
									accessibilityRole="button"
									className="flex-row items-center justify-between py-3"
									testID={`location-${item.id}`}
								>
									<Text className="text-foreground text-base">{item.name}</Text>
									{item.id === locationId ? (
										<Ionicons name="checkmark" size={20} color="#16a34a" />
									) : null}
								</TouchableOpacity>
							)}
						/>
					</View>
				</Pressable>
			</Modal>
		</>
	)
}
