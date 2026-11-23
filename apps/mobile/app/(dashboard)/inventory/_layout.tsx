import { Stack } from 'expo-router'
import React from 'react'
import { InventoryProvider } from '../../../hooks/use-inventory'

/** The Inventory tab: one stack under one session (token, grants, location). */
export default function InventoryLayout() {
	return (
		<InventoryProvider>
			<Stack screenOptions={{ headerShown: false }} />
		</InventoryProvider>
	)
}
