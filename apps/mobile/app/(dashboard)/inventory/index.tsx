import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_PERMISSIONS,
	listCountRunsResultSchema,
	listCountsResultSchema,
	type CountRun,
	type CountSummary,
} from '@repo/inventory'
import { randomUUID } from 'expo-crypto'
import React, { useRef, useState } from 'react'
import {
	Alert,
	RefreshControl,
	ScrollView,
	Text,
	TouchableOpacity,
	View,
} from 'react-native'
import { InventoryGate } from '../../../components/inventory/inventory-gate'
import { InventoryHeader } from '../../../components/inventory/screen-header'
import { Card, Screen } from '../../../components/ui'
import { useInventory } from '../../../hooks/use-inventory'
import { useRegionQuery } from '../../../hooks/use-region-query'
import { go } from '../../../lib/inventory/nav'
import { RegionError } from '../../../lib/inventory/region-client'

const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING

export default function InventoryHome() {
	return (
		<InventoryGate>
			<Home />
		</InventoryGate>
	)
}

function Home() {
	const { t } = useLingui()
	const inventory = useInventory()
	const { client, access, locationId, can } = inventory
	const canCount = can(UPDATE)
	const ordersOn = Boolean(access?.features.purchasing)
	const location = encodeURIComponent(locationId ?? '')
	const counts = useRegionQuery(
		client,
		locationId ? `/counts?locationId=${location}&status=open&limit=20` : null,
		listCountsResultSchema,
	)
	const runs = useRegionQuery(
		client,
		locationId ? `/count-runs?locationId=${location}` : null,
		listCountRunsResultSchema,
	)
	const [starting, setStarting] = useState(false)
	// A retry replays the same start, never a second count.
	const startId = useRef(randomUUID())

	async function start(kind: 'full' | 'quick', listId: string | null = null) {
		if (!client || !locationId || starting) return
		setStarting(true)
		try {
			const count = (await client.request('/counts', {
				method: 'POST',
				write: true,
				body: {
					clientId: startId.current,
					locationId,
					listId,
					...(kind === 'quick' ? { kind: 'quick' } : {}),
				},
			})) as CountSummary
			startId.current = randomUUID()
			counts.reload()
			go(`/inventory/count?id=${encodeURIComponent(count.id)}`)
		} catch (error) {
			// Another person already has this count open: join it.
			if (
				error instanceof RegionError &&
				error.code === 'count_in_progress' &&
				typeof error.body?.countId === 'string'
			) {
				go(`/inventory/count?id=${encodeURIComponent(error.body.countId)}`)
			} else {
				Alert.alert(
					t`Could not start the count`,
					t`Check your connection and try again.`,
				)
			}
		} finally {
			setStarting(false)
		}
	}

	const dueNow = (runs.data?.runs ?? []).filter(
		(run) => run.status === 'due' && Date.now() >= run.dueAt,
	)
	const openCounts = counts.data?.counts ?? []
	const busy = counts.loading || runs.loading

	return (
		<Screen>
			<ScrollView
				refreshControl={
					<RefreshControl
						refreshing={busy && Boolean(counts.data)}
						onRefresh={() => {
							counts.reload()
							runs.reload()
						}}
					/>
				}
			>
				<InventoryHeader
					title={t`Inventory`}
					subtitle={access ? undefined : null}
				/>
				<View className="gap-4 p-5">
					{dueNow.length > 0 ? (
						<Card testID="inventory-due">
							<Text className="text-foreground mb-2 text-lg font-semibold">
								<Trans>Counts due today</Trans>
							</Text>
							{dueNow.map((run) => (
								<DueRow
									key={run.id}
									run={run}
									disabled={!canCount || starting}
									onStart={() => void start(run.kind, run.listId)}
								/>
							))}
						</Card>
					) : null}

					<Card>
						<Text className="text-foreground mb-2 text-lg font-semibold">
							<Trans>Counts</Trans>
						</Text>
						{counts.error && !counts.data ? (
							<Text className="text-destructive text-sm">
								<Trans>We could not load the counts.</Trans>
							</Text>
						) : openCounts.length === 0 ? (
							<Text className="text-muted-foreground text-sm">
								<Trans>No count is open.</Trans>
							</Text>
						) : (
							openCounts.map((count) => (
								<TouchableOpacity
									key={count.id}
									onPress={() =>
										go(`/inventory/count?id=${encodeURIComponent(count.id)}`)
									}
									accessibilityRole="button"
									className="border-border flex-row items-center justify-between border-b py-3"
									testID={`open-count-${count.id}`}
								>
									<View className="flex-1 pe-3">
										<Text className="text-foreground text-base font-medium">
											{count.listName ??
												(count.kind === 'quick'
													? t`Quick count of key items`
													: t`Full count`)}
										</Text>
										<Text className="text-muted-foreground text-xs">
											{count.secondState === 'waiting'
												? t`Waiting for a second person`
												: count.status === 'in_review'
													? t`Waiting for review`
													: t`${count.itemsCounted} of ${count.itemTotal} counted`}
										</Text>
									</View>
									<Ionicons name="chevron-forward" size={18} color="#888" />
								</TouchableOpacity>
							))
						)}
						{canCount ? (
							<View className="mt-3 flex-row flex-wrap gap-2">
								<TouchableOpacity
									disabled={starting}
									onPress={() => void start('quick')}
									accessibilityRole="button"
									className="bg-primary rounded-lg px-4 py-2.5"
									testID="start-quick-count"
								>
									<Text className="text-primary-foreground text-sm font-semibold">
										<Trans>Count key items</Trans>
									</Text>
								</TouchableOpacity>
								<TouchableOpacity
									disabled={starting}
									onPress={() => void start('full')}
									accessibilityRole="button"
									className="border-border rounded-lg border px-4 py-2.5"
									testID="start-full-count"
								>
									<Text className="text-foreground text-sm font-semibold">
										<Trans>Count everything</Trans>
									</Text>
								</TouchableOpacity>
							</View>
						) : null}
					</Card>

					<NavRow
						icon="cube-outline"
						title={t`Stock`}
						hint={t`Search items and mark key items`}
						onPress={() => go('/inventory/stock')}
						testID="go-stock"
					/>
					{canCount ? (
						<NavRow
							icon="download-outline"
							title={t`Receive a delivery`}
							hint={t`Confirm what arrived and add the invoice photo`}
							onPress={() => go('/inventory/receive')}
							testID="go-receive"
						/>
					) : null}
					{ordersOn && can(PURCHASING) ? (
						<NavRow
							icon="cart-outline"
							title={t`Orders`}
							hint={t`Approve and send what to order`}
							onPress={() => go('/inventory/orders')}
							testID="go-orders"
						/>
					) : null}
				</View>
			</ScrollView>
		</Screen>
	)
}

function DueRow({
	run,
	disabled,
	onStart,
}: {
	run: CountRun
	disabled: boolean
	onStart: () => void
}) {
	const { t, i18n } = useLingui()
	const time = new Intl.DateTimeFormat(i18n.locale, {
		timeStyle: 'short',
	}).format(new Date(run.dueAt))
	return (
		<TouchableOpacity
			onPress={onStart}
			disabled={disabled}
			accessibilityRole="button"
			className="border-border flex-row items-center justify-between border-b py-3"
			testID={`due-${run.id}`}
		>
			<View className="flex-1 pe-3">
				<Text className="text-foreground text-base font-medium">
					{run.listName ??
						(run.kind === 'quick'
							? t`Quick count of key items`
							: t`Full count`)}
				</Text>
				<Text className="text-muted-foreground text-xs">
					{run.late ? t`Late, due ${time}` : t`Due ${time}`}
				</Text>
			</View>
			<Text className="text-primary text-sm font-semibold">
				<Trans>Start</Trans>
			</Text>
		</TouchableOpacity>
	)
}

function NavRow({
	icon,
	title,
	hint,
	onPress,
	testID,
}: {
	icon: React.ComponentProps<typeof Ionicons>['name']
	title: string
	hint: string
	onPress: () => void
	testID: string
}) {
	return (
		<TouchableOpacity
			onPress={onPress}
			accessibilityRole="button"
			testID={testID}
		>
			<Card className="flex-row items-center gap-3">
				<Ionicons name={icon} size={24} color="#888" />
				<View className="flex-1">
					<Text className="text-foreground text-base font-semibold">
						{title}
					</Text>
					<Text className="text-muted-foreground text-xs">{hint}</Text>
				</View>
				<Ionicons name="chevron-forward" size={18} color="#888" />
			</Card>
		</TouchableOpacity>
	)
}
