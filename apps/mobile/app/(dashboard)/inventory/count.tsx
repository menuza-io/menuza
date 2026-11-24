import { Ionicons } from '@expo/vector-icons'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	countSheetSchema,
	INVENTORY_PERMISSIONS,
	type CountSheet,
} from '@repo/inventory'
import { randomUUID } from 'expo-crypto'
import { useLocalSearchParams } from 'expo-router'
import React, { useMemo, useState } from 'react'
import {
	Alert,
	FlatList,
	ScrollView,
	Text,
	TextInput,
	TouchableOpacity,
	View,
} from 'react-native'
import { BottleRow } from '../../../components/inventory/bottle-row'
import { InventoryGate } from '../../../components/inventory/inventory-gate'
import { InventoryHeader } from '../../../components/inventory/screen-header'
import { Button, Screen } from '../../../components/ui'
import { useCountQueue } from '../../../hooks/use-count-queue'
import { useInventory } from '../../../hooks/use-inventory'
import { useRegionQuery } from '../../../hooks/use-region-query'
import { slotKey } from '../../../lib/inventory/count-queue'
import { parseTypedAmount } from '../../../lib/inventory/format'
import { RegionError } from '../../../lib/inventory/region-client'

type Item = CountSheet['areas'][number]['items'][number]

export default function CountScreen() {
	return (
		<InventoryGate>
			<Count />
		</InventoryGate>
	)
}

function unitLabel(item: Item): string {
	if (item.countUnit.startsWith('unit:')) {
		const id = item.countUnit.slice(5)
		return item.units.find((unit) => unit.id === id)?.name ?? ''
	}
	return item.countUnit
}

function Count() {
	const { t } = useLingui()
	const { id: rawId } = useLocalSearchParams<{ id: string }>()
	const countId = String(rawId ?? '')
	const { client, organizationId, can } = useInventory()
	const sheet = useRegionQuery(
		client,
		countId ? `/counts/${encodeURIComponent(countId)}` : null,
		countSheetSchema,
	)
	const count = sheet.data?.count ?? null
	const secondPass = sheet.data?.pass === 2
	const secondState = count?.secondState ?? null
	const canWrite = can(INVENTORY_PERMISSIONS.UPDATE_INVENTORY)
	// The key-item second-person check (#525): only a person who did not make
	// the first count counts the key items, blind; nobody counts while settling.
	const counting =
		canWrite &&
		count?.status === 'counting' &&
		secondState !== 'settling' &&
		(secondState !== 'waiting' || secondPass)
	const { queue, state } = useCountQueue({
		client,
		organizationId,
		countId,
		enabled: Boolean(counting),
	})
	const [areaKey, setAreaKey] = useState<string | null>(null)
	const [typed, setTyped] = useState<Record<string, string>>({})
	const [bottleMl, setBottleMl] = useState<Record<string, number>>({})
	const [finishing, setFinishing] = useState(false)

	const areas = sheet.data?.areas ?? []
	const current =
		areas.find((area) => (area.areaId ?? 'none') === areaKey) ??
		areas[0] ??
		null
	const rowKey = (item: Item, areaId: string | null) =>
		`${item.itemId}|${areaId ?? ''}`
	const pendingSlots = useMemo(
		() => new Set(state.pending.map((entry) => slotKey(entry))),
		[state.pending],
	)

	function commit(item: Item, areaId: string | null, amount: number | null) {
		void queue.submit({
			clientId: randomUUID(),
			itemId: item.itemId,
			areaId,
			amount,
			unit: item.bottle ? 'ml' : item.countUnit,
		})
	}

	async function finish() {
		if (!client || !count || finishing) return
		setFinishing(true)
		try {
			await queue.flush()
			if (queue.getState().pending.length > 0) {
				Alert.alert(
					t`Entries are still on this phone`,
					t`Check your connection and try Finish again. Nothing is lost.`,
				)
				return
			}
			await client.request(
				`/counts/${encodeURIComponent(countId)}/${secondPass ? 'second/finish' : 'send'}`,
				{
					method: 'POST',
					write: true,
					body: { expectedVersion: count.version },
				},
			)
			sheet.reload()
		} catch (error) {
			Alert.alert(
				t`Could not finish`,
				error instanceof RegionError && error.code === 'second_count_pending'
					? t`This count is waiting for a second person to count the key items.`
					: t`Try again in a moment.`,
			)
		} finally {
			setFinishing(false)
		}
	}

	const total = areas.reduce((sum, area) => sum + area.items.length, 0)
	const counted = areas.reduce(
		(sum, area) =>
			sum +
			area.items.filter(
				(item) =>
					item.quantity !== null ||
					pendingSlots.has(
						slotKey({
							itemId: item.itemId,
							areaId: area.areaId,
							unit: item.bottle ? 'ml' : item.countUnit,
						}),
					),
			).length,
		0,
	)
	const title =
		count?.listName ??
		(count?.kind === 'quick' ? t`Quick count of key items` : t`Full count`)

	return (
		<Screen>
			<InventoryHeader
				title={title}
				subtitle={count ? t`${counted} of ${total} counted` : null}
				showLocation={false}
				right={
					counting ? (
						<Button
							onPress={() => void finish()}
							loading={finishing}
							size="sm"
							testID="count-finish"
						>
							<Trans>Finish</Trans>
						</Button>
					) : null
				}
			/>
			<View className="gap-2 px-5 pb-2">
				{secondPass && counting ? (
					<Banner testID="count-second-pass">
						<Trans>
							You are counting the key items a second time. The first count is
							hidden.
						</Trans>
					</Banner>
				) : null}
				{secondState === 'waiting' && !secondPass ? (
					<Banner testID="count-second-waiting">
						<Trans>
							This count is waiting for a different person to count the key
							items again.
						</Trans>
					</Banner>
				) : null}
				{secondState === 'settling' ? (
					<Banner testID="count-second-settling">
						<Trans>
							The two counts differ. A manager settles them in the web app.
						</Trans>
					</Banner>
				) : null}
				{count && count.status !== 'counting' ? (
					<Banner testID="count-closed">
						{count.status === 'in_review' ? (
							<Trans>This count is waiting for review.</Trans>
						) : (
							<Trans>This count is finished.</Trans>
						)}
					</Banner>
				) : null}
				{state.pending.length > 0 ? (
					<Banner testID="count-queue">
						<Plural
							value={state.pending.length}
							one="# entry is on this phone, waiting to send"
							other="# entries are on this phone, waiting to send"
						/>
						{state.failed ? (
							<Text
								className="text-primary text-sm font-semibold"
								onPress={() => void queue.flush()}
							>
								{' '}
								<Trans>Send now</Trans>
							</Text>
						) : null}
					</Banner>
				) : null}
				{state.lateCount > 0 ? (
					<Banner testID="count-late">
						<Plural
							value={state.lateCount}
							one="# entry arrived after the count was approved. A manager will see it."
							other="# entries arrived after the count was approved. A manager will see them."
						/>
					</Banner>
				) : null}
			</View>
			{sheet.error && !sheet.data ? (
				<View className="items-center gap-3 p-6">
					<Text className="text-destructive">
						<Trans>We could not load this count.</Trans>
					</Text>
					<Button onPress={sheet.reload}>
						<Trans>Try again</Trans>
					</Button>
				</View>
			) : (
				<>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						className="max-h-14 grow-0 px-5"
						contentContainerClassName="gap-2 items-center"
					>
						{areas.map((area) => {
							const key = area.areaId ?? 'none'
							const active = current
								? (current.areaId ?? 'none') === key
								: false
							return (
								<TouchableOpacity
									key={key}
									onPress={() => setAreaKey(key)}
									accessibilityRole="tab"
									accessibilityState={{ selected: active }}
									className={`rounded-full border px-4 py-2 ${
										active ? 'bg-primary border-primary' : 'border-border'
									}`}
									testID={`area-${key}`}
								>
									<Text
										className={
											active ? 'text-primary-foreground' : 'text-foreground'
										}
									>
										{area.name ?? t`Other items`}
									</Text>
								</TouchableOpacity>
							)
						})}
					</ScrollView>
					<FlatList<Item>
						data={current?.items ?? []}
						keyExtractor={(item: Item) => item.itemId}
						contentContainerClassName="gap-3 p-5"
						renderItem={({ item }: { item: Item }) => {
							const areaId = current?.areaId ?? null
							const key = rowKey(item, areaId)
							const saved =
								item.quantity !== null &&
								!pendingSlots.has(
									slotKey({
										itemId: item.itemId,
										areaId,
										unit: item.bottle ? 'ml' : item.countUnit,
									}),
								)
							return (
								<View
									className="bg-card border-border rounded-xl border p-3"
									testID={`row-${item.itemId}`}
								>
									<View className="flex-row items-center justify-between">
										<View className="flex-1 flex-row items-center gap-1.5 pe-3">
											{item.isKey ? (
												<Ionicons name="star" size={14} color="#d97706" />
											) : null}
											<Text className="text-foreground text-base font-medium">
												{item.name}
											</Text>
										</View>
										{saved ? (
											<Ionicons
												name="checkmark-circle"
												size={18}
												color="#16a34a"
											/>
										) : null}
									</View>
									{item.bottle ? (
										counting ? (
											<BottleRow
												bottle={item.bottle}
												valueMl={
													bottleMl[key] ??
													(item.mine && item.mine.unit === 'ml'
														? item.mine.amount
														: null)
												}
												onValueMl={(ml) => {
													setBottleMl((state) => ({ ...state, [key]: ml }))
													commit(item, areaId, ml)
												}}
											/>
										) : null
									) : counting ? (
										<View className="mt-2 flex-row items-center gap-2">
											<TextInput
												value={
													typed[key] ??
													(item.mine ? String(item.mine.amount) : '')
												}
												onChangeText={(text) =>
													setTyped((state) => ({ ...state, [key]: text }))
												}
												onEndEditing={() =>
													commit(
														item,
														areaId,
														parseTypedAmount(
															typed[key] ??
																(item.mine ? String(item.mine.amount) : ''),
														),
													)
												}
												keyboardType="decimal-pad"
												placeholder="0"
												accessibilityLabel={t`${item.name}, amount in ${unitLabel(item)}`}
												className="border-border text-foreground h-12 flex-1 rounded-lg border px-3 text-lg"
												testID={`input-${item.itemId}`}
											/>
											<Text className="text-muted-foreground w-14 text-sm">
												{unitLabel(item)}
											</Text>
										</View>
									) : item.quantity !== null ? (
										<Text className="text-muted-foreground mt-1 text-sm">
											{(item.quantity / 1000).toLocaleString()} {item.baseUnit}
										</Text>
									) : null}
								</View>
							)
						}}
					/>
				</>
			)}
		</Screen>
	)
}

function Banner({
	children,
	testID,
}: {
	children: React.ReactNode
	testID: string
}) {
	return (
		<View
			className="bg-secondary border-border rounded-lg border p-3"
			testID={testID}
			accessibilityLiveRegion="polite"
		>
			<Text className="text-foreground text-sm">{children}</Text>
		</View>
	)
}
