import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	listOrdersResultSchema,
	recordDeliveryResultSchema,
	type OrderSummary,
} from '@repo/inventory'
import { randomUUID } from 'expo-crypto'
import * as ImagePicker from 'expo-image-picker'
import React, { useRef, useState } from 'react'
import { Alert, FlatList, Text, View } from 'react-native'
import { InventoryGate } from '../../../components/inventory/inventory-gate'
import { InventoryHeader } from '../../../components/inventory/screen-header'
import { Button, Card, Screen } from '../../../components/ui'
import { useInventory } from '../../../hooks/use-inventory'
import { useRegionQuery } from '../../../hooks/use-region-query'
import { uploadInvoicePhoto } from '../../../lib/inventory/invoice-photo'
import { RegionError } from '../../../lib/inventory/region-client'

export default function ReceiveScreen() {
	return (
		<InventoryGate>
			<Receive />
		</InventoryGate>
	)
}

function Receive() {
	const { t, i18n } = useLingui()
	const { client, locationId, can } = useInventory()
	const canReceive = can(INVENTORY_PERMISSIONS.UPDATE_INVENTORY)
	const orders = useRegionQuery(
		client,
		locationId
			? `/orders?locationId=${encodeURIComponent(locationId)}&status=open&limit=50`
			: null,
		listOrdersResultSchema,
	)
	// A retry replays the same receive, never a second delivery.
	const receiveIds = useRef(new Map<string, string>())
	const [busy, setBusy] = useState<string | null>(null)
	/** Deliveries made on this screen: order id → delivery id, with whether the photo is attached. */
	const [done, setDone] = useState<
		Record<string, { deliveryId: string; photo: boolean }>
	>({})

	const open = (orders.data?.orders ?? []).filter(
		(order) => order.status === 'sent' || order.status === 'partly_received',
	)

	async function receive(order: OrderSummary) {
		if (!client || busy) return
		setBusy(order.id)
		try {
			const clientId = receiveIds.current.get(order.id) ?? randomUUID()
			receiveIds.current.set(order.id, clientId)
			const result = recordDeliveryResultSchema.parse(
				await client.request(
					`/orders/${encodeURIComponent(order.id)}/receive-as-ordered`,
					{
						method: 'POST',
						write: true,
						body: { expectedVersion: order.version, clientId },
					},
				),
			)
			setDone((current) => ({
				...current,
				[order.id]: { deliveryId: result.delivery.id, photo: false },
			}))
			orders.reload()
			await addPhoto(order.id, result.delivery.id)
		} catch (error) {
			Alert.alert(
				t`Could not receive the delivery`,
				error instanceof RegionError && error.code === 'stale_version'
					? t`Someone changed this order. Pull to refresh and try again.`
					: t`Check your connection and try again.`,
			)
		} finally {
			setBusy(null)
		}
	}

	async function addPhoto(orderId: string, deliveryId: string) {
		if (!client) return
		const permission = await ImagePicker.requestCameraPermissionsAsync()
		if (!permission.granted) {
			Alert.alert(
				t`Camera access is off`,
				t`The delivery is received. Allow the camera in Settings to add the invoice photo.`,
			)
			return
		}
		const picked = await ImagePicker.launchCameraAsync({
			mediaTypes: ['images'],
			quality: 0.7,
		})
		const asset = picked.canceled ? null : picked.assets[0]
		if (!asset) return
		try {
			const response = await fetch(asset.uri)
			const blob = await response.blob()
			await uploadInvoicePhoto({
				client,
				deliveryId,
				photo: {
					uri: asset.uri,
					contentType: blob.type || asset.mimeType || 'image/jpeg',
					sizeBytes: blob.size,
				},
				put: async (url, headers) => {
					const put = await fetch(url, { method: 'PUT', headers, body: blob })
					return put.status
				},
			})
			setDone((current) => ({
				...current,
				[orderId]: { deliveryId, photo: true },
			}))
		} catch {
			Alert.alert(
				t`The photo did not upload`,
				t`The delivery is received. Tap Add invoice photo to try again.`,
			)
		}
	}

	return (
		<Screen>
			<InventoryHeader title={t`Receive a delivery`} />
			{!canReceive ? (
				<Text className="text-muted-foreground p-5">
					<Trans>Your role cannot receive deliveries.</Trans>
				</Text>
			) : orders.error && !orders.data ? (
				<Text className="text-destructive p-5">
					<Trans>We could not load the open orders.</Trans>
				</Text>
			) : (
				<FlatList<OrderSummary>
					data={open}
					keyExtractor={(order: OrderSummary) => order.id}
					contentContainerClassName="gap-3 p-5"
					refreshing={orders.loading && Boolean(orders.data)}
					onRefresh={orders.reload}
					ListEmptyComponent={
						orders.loading ? null : (
							<Text className="text-muted-foreground text-sm">
								<Trans>No orders are waiting to be received.</Trans>
							</Text>
						)
					}
					renderItem={({ item }: { item: OrderSummary }) => {
						const received = done[item.id]
						return (
							<Card testID={`order-${item.id}`}>
								<Text className="text-foreground text-base font-semibold">
									{item.supplierName}
								</Text>
								<Text className="text-muted-foreground text-xs">
									{item.expectedDate
										? t`Order ${item.number}, expected ${new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(new Date(`${item.expectedDate}T12:00:00`))}`
										: t`Order ${item.number}`}
								</Text>
								<View className="mt-3 flex-row flex-wrap gap-2">
									{received ? (
										<>
											<Text className="text-foreground text-sm">
												<Trans>Received.</Trans>
											</Text>
											{!received.photo ? (
												<Button
													variant="outline"
													size="sm"
													onPress={() =>
														void addPhoto(item.id, received.deliveryId)
													}
													testID={`photo-${item.id}`}
												>
													<Trans>Add invoice photo</Trans>
												</Button>
											) : (
												<Text className="text-muted-foreground text-sm">
													<Trans>Invoice photo added.</Trans>
												</Text>
											)}
										</>
									) : (
										<Button
											size="sm"
											loading={busy === item.id}
											onPress={() => void receive(item)}
											testID={`receive-${item.id}`}
										>
											<Trans>Received as ordered</Trans>
										</Button>
									)}
								</View>
							</Card>
						)
					}}
				/>
			)}
		</Screen>
	)
}
