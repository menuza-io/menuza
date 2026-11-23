import { Ionicons } from '@expo/vector-icons'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	listItemsResultSchema,
	type StockItem,
} from '@repo/inventory'
import React, { useEffect, useState } from 'react'
import { Alert, FlatList, Text, TouchableOpacity, View } from 'react-native'
import { InventoryGate } from '../../../components/inventory/inventory-gate'
import { InventoryHeader } from '../../../components/inventory/screen-header'
import { Input, Screen } from '../../../components/ui'
import { useInventory } from '../../../hooks/use-inventory'
import { useRegionQuery } from '../../../hooks/use-region-query'
import { baseToDisplay, trimNumber } from '../../../lib/inventory/format'

const SEARCH_DELAY_MS = 300

export default function StockScreen() {
	return (
		<InventoryGate>
			<Stock />
		</InventoryGate>
	)
}

function Stock() {
	const { t, i18n } = useLingui()
	const { client, locationId, can } = useInventory()
	const canEdit = can(INVENTORY_PERMISSIONS.UPDATE_INVENTORY)
	const [search, setSearch] = useState('')
	const [query, setQuery] = useState('')
	const [keyOnly, setKeyOnly] = useState(false)
	useEffect(() => {
		const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS)
		return () => clearTimeout(timer)
	}, [search])

	const params = new URLSearchParams({
		locationId: locationId ?? '',
		limit: '100',
	})
	if (query) params.set('q', query)
	if (keyOnly) params.set('key', 'true')
	const list = useRegionQuery(
		client,
		locationId ? `/items?${params.toString()}` : null,
		listItemsResultSchema,
	)
	const items = list.data?.items ?? []

	async function toggleKey(item: StockItem) {
		if (!client) return
		try {
			await client.request(`/items/${encodeURIComponent(item.id)}`, {
				method: 'PATCH',
				write: true,
				body: { expectedVersion: item.version, isKey: item.isKey !== true },
			})
		} catch {
			Alert.alert(t`Could not save`, t`Try again in a moment.`)
		}
		list.reload()
	}

	return (
		<Screen>
			<InventoryHeader title={t`Stock`} />
			<View className="gap-2 px-5">
				<Input
					value={search}
					onChangeText={setSearch}
					placeholder={t`Search items`}
					inputType="text"
					returnKeyType="search"
					accessibilityLabel={t`Search items`}
				/>
				<TouchableOpacity
					onPress={() => setKeyOnly((on) => !on)}
					accessibilityRole="button"
					accessibilityState={{ selected: keyOnly }}
					className={`flex-row items-center gap-1.5 self-start rounded-full border px-3 py-2 ${
						keyOnly ? 'bg-primary border-primary' : 'border-border'
					}`}
					testID="stock-key-filter"
				>
					<Ionicons
						name="star"
						size={14}
						color={keyOnly ? '#fff' : '#d97706'}
					/>
					<Text
						className={keyOnly ? 'text-primary-foreground' : 'text-foreground'}
					>
						<Trans>Key items</Trans>
					</Text>
				</TouchableOpacity>
			</View>
			{list.error && !list.data ? (
				<Text className="text-destructive p-5">
					<Trans>We could not load the stock list.</Trans>
				</Text>
			) : (
				<FlatList<StockItem>
					data={items}
					keyExtractor={(item: StockItem) => item.id}
					contentContainerClassName="gap-2 p-5"
					refreshing={list.loading && Boolean(list.data)}
					onRefresh={list.reload}
					ListEmptyComponent={
						list.loading ? null : (
							<Text className="text-muted-foreground text-sm">
								<Trans>No items match.</Trans>
							</Text>
						)
					}
					ListFooterComponent={
						list.data && list.data.total > items.length ? (
							<Text className="text-muted-foreground text-xs">
								<Plural
									value={list.data.total - items.length}
									one="# more item. Search to find it."
									other="# more items. Search to find them."
								/>
							</Text>
						) : null
					}
					renderItem={({ item }: { item: StockItem }) => {
						const shown = baseToDisplay(item.onHand, item.baseUnit)
						return (
							<View
								className="bg-card border-border flex-row items-center gap-3 rounded-xl border p-3"
								testID={`stock-${item.id}`}
							>
								<TouchableOpacity
									disabled={!canEdit}
									onPress={() => void toggleKey(item)}
									accessibilityRole="button"
									accessibilityState={{ selected: item.isKey === true }}
									accessibilityLabel={
										item.isKey
											? t`Remove from key items`
											: t`Mark as a key item`
									}
									hitSlop={8}
									testID={`stock-star-${item.id}`}
								>
									<Ionicons
										name={item.isKey ? 'star' : 'star-outline'}
										size={22}
										color={item.isKey ? '#d97706' : '#888'}
									/>
								</TouchableOpacity>
								<View className="flex-1">
									<Text className="text-foreground text-base font-medium">
										{item.name}
									</Text>
									<Text className="text-muted-foreground text-xs">
										{item.lastCountedAt === null
											? t`Never counted`
											: t`Last counted ${new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric' }).format(new Date(item.lastCountedAt))}`}
									</Text>
								</View>
								<View className="items-end">
									<Text className="text-foreground text-base tabular-nums">
										{trimNumber(shown.amount, i18n.locale)} {shown.unit}
									</Text>
									{item.status !== 'ok' ? (
										<Text
											className={
												item.status === 'out'
													? 'text-destructive text-xs'
													: 'text-xs text-amber-600'
											}
										>
											{item.status === 'out' ? t`Out` : t`Low`}
										</Text>
									) : null}
								</View>
							</View>
						)
					}}
				/>
			)}
		</Screen>
	)
}
