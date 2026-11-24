import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	listOrdersResultSchema,
	suggestedOrdersSchema,
	type OrderSummary,
	type SuggestedSupplierOrder,
} from '@repo/inventory'
import { randomUUID } from 'expo-crypto'
import React, { useRef, useState } from 'react'
import {
	ActionSheetIOS,
	Alert,
	Linking,
	Platform,
	ScrollView,
	Text,
	View,
} from 'react-native'
import { InventoryGate } from '../../../components/inventory/inventory-gate'
import { InventoryHeader } from '../../../components/inventory/screen-header'
import { Button, Card, Screen } from '../../../components/ui'
import { useInventory } from '../../../hooks/use-inventory'
import { useRegionQuery } from '../../../hooks/use-region-query'
import {
	approveOrder,
	createDraftFromSuggestion,
	sendOrder,
	type SendChannel,
} from '../../../lib/inventory/order-flow'
import { RegionError } from '../../../lib/inventory/region-client'

const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING

export default function OrdersScreen() {
	return (
		<InventoryGate>
			<Orders />
		</InventoryGate>
	)
}

function Orders() {
	const { t, i18n } = useLingui()
	const { client, locationId, access, can } = useInventory()
	const canOrder = can(PURCHASING) && Boolean(access?.features.purchasing)
	const location = encodeURIComponent(locationId ?? '')
	const suggested = useRegionQuery(
		client,
		canOrder && locationId ? `/orders/suggested?locationId=${location}` : null,
		suggestedOrdersSchema,
	)
	const waiting = useRegionQuery(
		client,
		canOrder && locationId
			? `/orders?locationId=${location}&status=waiting_for_approval&limit=20`
			: null,
		listOrdersResultSchema,
	)
	const draftIds = useRef(new Map<string, string>())
	const [busy, setBusy] = useState<string | null>(null)
	const locale = i18n.locale.startsWith('ar') ? 'ar' : 'en'
	const canApprove = Boolean(access?.canManageSettings)

	/** The person picks how the order goes: the region emails it, a WhatsApp message opens, or the text is copied. */
	function pickChannel(): Promise<SendChannel | null> {
		return new Promise((resolve) => {
			const choices: Array<{ label: string; channel: SendChannel }> = [
				{ label: t`Email the supplier`, channel: 'email' },
				{ label: t`WhatsApp`, channel: 'whatsapp' },
				{ label: t`Copy the text`, channel: 'copy' },
			]
			if (Platform.OS === 'ios') {
				ActionSheetIOS.showActionSheetWithOptions(
					{
						options: [...choices.map((choice) => choice.label), t`Cancel`],
						cancelButtonIndex: choices.length,
					},
					(index) => resolve(choices[index]?.channel ?? null),
				)
			} else {
				Alert.alert(t`Send the order`, undefined, [
					...choices.map((choice) => ({
						text: choice.label,
						onPress: () => resolve(choice.channel),
					})),
					{ text: t`Cancel`, style: 'cancel', onPress: () => resolve(null) },
				])
			}
		})
	}

	async function afterSend(result: Awaited<ReturnType<typeof sendOrder>>) {
		if (result.waitingForApproval) {
			Alert.alert(
				t`Waiting for approval`,
				t`This order is over a spending limit. A manager has to approve it before it goes out.`,
			)
		} else if (result.waLink) {
			await Linking.openURL(result.waLink).catch(() => undefined)
		} else if (result.mailto && !result.emailSent) {
			await Linking.openURL(result.mailto).catch(() => undefined)
		} else if (result.channel === 'copy') {
			Alert.alert(t`Order text`, result.text)
		} else {
			Alert.alert(t`Order sent`)
		}
		suggested.reload()
		waiting.reload()
	}

	async function createAndSend(card: SuggestedSupplierOrder) {
		if (!client || !locationId || busy) return
		const channel = await pickChannel()
		if (!channel) return
		setBusy(card.supplierId)
		try {
			const draftId = draftIds.current.get(card.supplierId) ?? randomUUID()
			draftIds.current.set(card.supplierId, draftId)
			// A draft already started for this supplier is continued, never doubled.
			const draft = card.draftOrderId
				? { id: card.draftOrderId, version: null as number | null }
				: await createDraftFromSuggestion({
						client,
						clientId: draftId,
						locationId,
						supplierId: card.supplierId,
					})
			let version = draft.version
			if (version === null) {
				const list = await client.request(
					`/orders/${encodeURIComponent(draft.id)}`,
				)
				version = (list as { version: number }).version
			}
			const result = await sendOrder({
				client,
				orderId: draft.id,
				expectedVersion: version,
				channel,
				locale,
			})
			draftIds.current.delete(card.supplierId)
			await afterSend(result)
		} catch (error) {
			Alert.alert(
				t`Could not send the order`,
				error instanceof RegionError && error.code === 'email_failed'
					? t`The email could not be sent. Try WhatsApp or copy the text.`
					: t`Check your connection and try again.`,
			)
		} finally {
			setBusy(null)
		}
	}

	async function approve(order: OrderSummary) {
		if (!client || busy) return
		const channel = await pickChannel()
		if (!channel) return
		setBusy(order.id)
		try {
			await afterSend(
				await approveOrder({
					client,
					orderId: order.id,
					expectedVersion: order.version,
					channel,
					locale,
				}),
			)
		} catch (error) {
			Alert.alert(
				t`Could not approve the order`,
				error instanceof RegionError && error.code === 'self_approval_forbidden'
					? t`You cannot approve your own order. Ask another manager.`
					: t`Check your connection and try again.`,
			)
		} finally {
			setBusy(null)
		}
	}

	const cards = suggested.data?.suppliers ?? []
	const toApprove = waiting.data?.orders ?? []

	return (
		<Screen>
			<InventoryHeader title={t`Orders`} />
			{!canOrder ? (
				<Text className="text-muted-foreground p-5">
					<Trans>Your role cannot place orders.</Trans>
				</Text>
			) : (
				<ScrollView contentContainerClassName="gap-4 p-5">
					{toApprove.length > 0 && canApprove ? (
						<Card testID="orders-waiting">
							<Text className="text-foreground mb-2 text-lg font-semibold">
								<Trans>Waiting for your approval</Trans>
							</Text>
							{toApprove.map((order) => (
								<View
									key={order.id}
									className="border-border flex-row items-center justify-between border-b py-3"
								>
									<View className="flex-1 pe-3">
										<Text className="text-foreground text-base">
											{order.supplierName}
										</Text>
										<Text className="text-muted-foreground text-xs">
											{t`Order ${order.number}`}
										</Text>
									</View>
									<Button
										size="sm"
										loading={busy === order.id}
										onPress={() => void approve(order)}
										testID={`approve-${order.id}`}
									>
										<Trans>Approve and send</Trans>
									</Button>
								</View>
							))}
						</Card>
					) : null}

					<Text className="text-foreground text-lg font-semibold">
						<Trans>Suggested orders</Trans>
					</Text>
					{suggested.error && !suggested.data ? (
						<Text className="text-destructive text-sm">
							<Trans>We could not load the suggestions.</Trans>
						</Text>
					) : cards.length === 0 && !suggested.loading ? (
						<Text className="text-muted-foreground text-sm">
							<Trans>Nothing needs ordering right now.</Trans>
						</Text>
					) : (
						cards.map((card) => (
							<Card
								key={card.supplierId}
								testID={`suggested-${card.supplierId}`}
							>
								<Text className="text-foreground text-base font-semibold">
									{card.supplierName}
								</Text>
								<Text className="text-muted-foreground text-xs">
									<Plural
										value={card.lineCount}
										one="# item to order"
										other="# items to order"
									/>
									{card.expectedDate
										? ` · ${t`Delivery ${new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(new Date(`${card.expectedDate}T12:00:00`))}`}`
										: ''}
								</Text>
								{card.draftOrderId ? (
									<Text className="text-muted-foreground mt-1 text-xs">
										<Trans>A draft is already started. It will be sent.</Trans>
									</Text>
								) : null}
								<View className="mt-3 flex-row">
									<Button
										size="sm"
										loading={busy === card.supplierId}
										onPress={() => void createAndSend(card)}
										testID={`send-${card.supplierId}`}
									>
										<Trans>Approve and send</Trans>
									</Button>
								</View>
							</Card>
						))
					)}
				</ScrollView>
			)}
		</Screen>
	)
}
