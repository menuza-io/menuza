import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { useFocusEffect } from 'expo-router'
import React, { useCallback, useState } from 'react'
import { FlatList, Text, TouchableOpacity, View } from 'react-native'
import { Button, LoadingSpinner, Screen } from '../../components/ui'
import { useOrganizations } from '../../lib/api/hooks/use-organizations'
import { alertCopy } from '../../lib/inventory/alert-copy'
import {
	type AlertRow,
	fetchAlerts,
	markAlertsRead,
} from '../../lib/inventory/alerts-api'

/**
 * The Alerts tab (#516): inventory and staffing notifications for the selected
 * business, newest first. Counts, kinds and places only: no guest or staff
 * name, no amount. Opening a row marks it read.
 */
export default function AlertsScreen() {
	const { i18n } = useLingui()
	const { organizations } = useOrganizations()
	const organizationId = organizations.find((org) => org.isDefault)?.id ?? null
	const [alerts, setAlerts] = useState<AlertRow[] | null>(null)
	const [failed, setFailed] = useState(false)
	const [refreshing, setRefreshing] = useState(false)

	const load = useCallback(async () => {
		if (!organizationId) return
		const result = await fetchAlerts(organizationId)
		if (result.ok) {
			setAlerts(result.feed.alerts)
			setFailed(false)
		} else {
			setFailed(true)
		}
	}, [organizationId])

	useFocusEffect(
		useCallback(() => {
			void load()
		}, [load]),
	)

	async function open(alert: AlertRow) {
		if (!organizationId || alert.isRead) return
		setAlerts((current) =>
			(current ?? []).map((row) =>
				row.id === alert.id ? { ...row, isRead: true } : row,
			),
		)
		await markAlertsRead(organizationId, alert.id)
	}

	async function readAll() {
		if (!organizationId) return
		setAlerts((current) =>
			(current ?? []).map((row) => ({ ...row, isRead: true })),
		)
		await markAlertsRead(organizationId)
	}

	const unread = (alerts ?? []).filter((row) => !row.isRead).length

	return (
		<Screen>
			<View className="flex-row items-center justify-between px-5 pt-4 pb-2">
				<Text className="text-foreground text-2xl font-bold">
					<Trans>Alerts</Trans>
				</Text>
				{unread > 0 ? (
					<Button
						variant="ghost"
						size="sm"
						onPress={() => void readAll()}
						testID="alerts-read-all"
					>
						<Trans>Mark all as read</Trans>
					</Button>
				) : null}
			</View>
			{alerts === null && !failed ? (
				<View className="items-center p-8">
					<LoadingSpinner />
				</View>
			) : failed && alerts === null ? (
				<View className="items-center gap-3 p-8">
					<Text className="text-destructive">
						<Trans>We could not load your alerts.</Trans>
					</Text>
					<Button onPress={() => void load()}>
						<Trans>Try again</Trans>
					</Button>
				</View>
			) : (
				<FlatList<AlertRow>
					data={alerts ?? []}
					keyExtractor={(alert: AlertRow) => alert.id}
					contentContainerClassName="gap-2 p-5"
					refreshing={refreshing}
					onRefresh={async () => {
						setRefreshing(true)
						await load()
						setRefreshing(false)
					}}
					ListEmptyComponent={
						<Text className="text-muted-foreground text-sm">
							<Trans>You have no alerts.</Trans>
						</Text>
					}
					renderItem={({ item }: { item: AlertRow }) => {
						const copy = alertCopy(item.type, item.payload)
						return (
							<TouchableOpacity
								onPress={() => void open(item)}
								accessibilityRole="button"
								accessibilityLabel={copy.title}
								className="bg-card border-border flex-row items-start gap-3 rounded-xl border p-3"
								testID={`alert-${item.id}`}
							>
								<Ionicons
									name={item.isRead ? 'notifications-outline' : 'notifications'}
									size={20}
									color={item.isRead ? '#888' : '#2563eb'}
								/>
								<View className="flex-1">
									<Text
										className={`text-base ${item.isRead ? 'text-muted-foreground' : 'text-foreground font-semibold'}`}
									>
										{copy.title}
									</Text>
									{copy.hint ? (
										<Text className="text-muted-foreground text-xs">
											{copy.hint}
										</Text>
									) : null}
									<Text className="text-muted-foreground mt-1 text-xs">
										{new Intl.DateTimeFormat(i18n.locale, {
											dateStyle: 'medium',
											timeStyle: 'short',
										}).format(new Date(item.createdAt))}
									</Text>
								</View>
							</TouchableOpacity>
						)
					}}
				/>
			)}
		</Screen>
	)
}
