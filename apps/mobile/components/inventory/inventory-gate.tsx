import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React from 'react'
import { Text, TouchableOpacity, View } from 'react-native'
import { useInventory } from '../../hooks/use-inventory'
import { Button, LoadingSpinner, Screen } from '../ui'

/**
 * What every inventory screen shows until it can work: loading the token, the
 * module being off for the organization, the member having no inventory role,
 * or the connection failing. The phone never guesses: each answer says what to
 * do next.
 */
export function InventoryGate({ children }: { children: React.ReactNode }) {
	const { t } = useLingui()
	const inventory = useInventory()
	if (inventory.status === 'ready' && inventory.locationId)
		return <>{children}</>
	return (
		<Screen>
			<View className="flex-1 items-center justify-center gap-3 p-6">
				<TouchableOpacity
					onPress={() => router.back()}
					accessibilityRole="button"
					accessibilityLabel={t`Back`}
					hitSlop={12}
					className="absolute top-4 left-4"
				>
					<Ionicons name="chevron-back" size={26} color="#888" />
				</TouchableOpacity>
				{inventory.status === 'loading' ? (
					<LoadingSpinner />
				) : (
					<>
						<Text className="text-foreground text-center text-lg font-semibold">
							{inventory.status === 'off' ? (
								<Trans>Inventory is not turned on for this business.</Trans>
							) : inventory.status === 'no_access' ? (
								<Trans>Your role does not include inventory.</Trans>
							) : inventory.status === 'ready' ? (
								<Trans>There is no location you can see.</Trans>
							) : (
								<Trans>We could not reach your inventory.</Trans>
							)}
						</Text>
						{inventory.status === 'error' ? (
							<Button onPress={inventory.reload}>
								<Trans>Try again</Trans>
							</Button>
						) : (
							<Text className="text-muted-foreground text-center text-sm">
								<Trans>
									Ask an owner to check your role in the Menuza app on the web.
								</Trans>
							</Text>
						)}
					</>
				)}
			</View>
		</Screen>
	)
}
