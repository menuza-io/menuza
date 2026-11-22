import { Ionicons } from '@expo/vector-icons'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
	FlatList,
	Image,
	RefreshControl,
	Text,
	TouchableOpacity,
	View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
	PhotoCaptureModal,
	type CaptureDish,
} from '../../components/menu-photos/photo-capture-modal'
import { Button, Input, LoadingSpinner, Screen } from '../../components/ui'
import { usePhotoQueue } from '../../hooks/use-photo-queue'
import { useOrganizations } from '../../lib/api/hooks/use-organizations'
import { fetchMenuPhotos, type MenuPhotoDish } from '../../lib/api/menu-photos'
import { type QueueItem } from '../../lib/photo-queue/types'

const LIST_LIMIT = 100
const SEARCH_DELAY_MS = 300

interface LoadError {
	code: string
	message: string
}

export default function MenuPhotosScreen() {
	const { t } = useLingui()
	const insets = useSafeAreaInsets()
	const { organizations, isLoading: organizationsLoading } = useOrganizations()
	// The selected organization is the default one (see the switcher).
	const organization = organizations.find((org) => org.isDefault)
	const organizationId = organization?.id

	const [search, setSearch] = useState('')
	const [query, setQuery] = useState('')
	const [dishes, setDishes] = useState<MenuPhotoDish[]>([])
	const [missingCount, setMissingCount] = useState(0)
	const [loading, setLoading] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [loadError, setLoadError] = useState<LoadError | null>(null)
	const [capturing, setCapturing] = useState<CaptureDish | null>(null)

	const load = useCallback(async () => {
		if (!organizationId) return
		const result = await fetchMenuPhotos({
			organizationId,
			query,
			limit: LIST_LIMIT,
		})
		if (result.ok) {
			setDishes(result.data.items)
			setMissingCount(result.data.missingCount)
			setLoadError(null)
		} else {
			setLoadError({ code: result.code, message: result.message })
		}
	}, [organizationId, query])

	// A photo reached the server: the dish has one now. Drop it from the list
	// at once, then read the list again.
	const handleUploaded = useCallback(
		(event: { item: { itemId: string } }) => {
			setDishes((current) =>
				query
					? current
					: current.filter((dish) => dish.id !== event.item.itemId),
			)
			void load()
		},
		[load, query],
	)
	const {
		items: queued,
		enqueue,
		retry,
		remove,
	} = usePhotoQueue({ onUploaded: handleUploaded })

	useEffect(() => {
		const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS)
		return () => clearTimeout(timer)
	}, [search])

	useEffect(() => {
		if (!organizationId) return
		let cancelled = false
		setLoading(true)
		void load().finally(() => {
			if (!cancelled) setLoading(false)
		})
		return () => {
			cancelled = true
		}
	}, [organizationId, load])

	const onRefresh = async () => {
		setRefreshing(true)
		await load()
		setRefreshing(false)
	}

	const inThisOrganization = useMemo(
		() => queued.filter((item) => item.organizationId === organizationId),
		[queued, organizationId],
	)
	const queuedDishIds = useMemo(
		() => new Set(inThisOrganization.map((item) => item.itemId)),
		[inThisOrganization],
	)

	// A dish with a photo on its way leaves the list at once and shows as a
	// queue row ("Waiting to upload") until the server confirms.
	const visibleDishes = dishes.filter((dish) => !queuedDishIds.has(dish.id))
	const queuedMissing = dishes.filter(
		(dish) => !dish.hasPhoto && queuedDishIds.has(dish.id),
	).length
	const stillMissing = Math.max(0, missingCount - queuedMissing)
	const searching = query.length > 0

	const handleUse: React.ComponentProps<
		typeof PhotoCaptureModal
	>['onUse'] = async (dish, photo) => {
		if (!organizationId) return
		await enqueue({
			organizationId,
			itemId: dish.id,
			itemName: dish.name,
			sourceUri: photo.uri,
		})
	}

	const reasonFor = (item: QueueItem): string => {
		switch (item.lastError?.code) {
			case 'forbidden':
				return t`You can't edit the menu in this organization.`
			case 'not_found':
				return t`This dish is no longer on the menu.`
			case 'unsupported_media_type':
				return t`This photo format is not supported.`
			case 'payload_too_large':
				return t`The photo is too large.`
			case 'validation_error':
				return t`The photo could not be read.`
			case 'gave_up':
				return t`It still did not go through after several tries.`
			default:
				return t`Something went wrong.`
		}
	}

	const header = (
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
			<Text className="text-foreground text-2xl font-bold">
				<Trans>Menu photos</Trans>
			</Text>
			{organization && (
				<Text className="text-muted-foreground mt-1 text-sm">
					{organization.name}
				</Text>
			)}
			{!loadError && !searching && (
				<Text
					className="text-foreground mt-3 text-base"
					accessibilityLiveRegion="polite"
				>
					{stillMissing > 0 ? (
						<Plural
							value={stillMissing}
							one="# dish needs a photo"
							other="# dishes need a photo"
						/>
					) : (
						<Trans>Every dish has a photo.</Trans>
					)}
				</Text>
			)}
			<Input
				className="mt-3"
				value={search}
				onChangeText={setSearch}
				placeholder={t`Search any dish to replace its photo`}
				inputType="text"
				returnKeyType="search"
				accessibilityLabel={t`Search dishes`}
			/>
		</View>
	)

	if (organizationsLoading || (loading && dishes.length === 0 && !loadError)) {
		return (
			<Screen safeArea={false}>
				<View className="flex-1" style={{ paddingTop: insets.top }}>
					<LoadingSpinner text={t`Loading dishes...`} />
				</View>
			</Screen>
		)
	}

	if (!organizationId) {
		return (
			<Screen safeArea={false}>
				<View className="flex-1" style={{ paddingTop: insets.top }}>
					<View className="flex-1 items-center justify-center px-8">
						<Text className="text-muted-foreground text-center text-base">
							<Trans>Choose an organization first.</Trans>
						</Text>
					</View>
				</View>
			</Screen>
		)
	}

	if (loadError) {
		const forbidden = loadError.code === 'forbidden'
		return (
			<Screen safeArea={false}>
				<View className="flex-1" style={{ paddingTop: insets.top }}>
					{header}
					<View className="items-center px-8 pt-10">
						<Ionicons
							name={forbidden ? 'lock-closed-outline' : 'cloud-offline-outline'}
							size={40}
							color="#888"
						/>
						<Text className="text-foreground mt-4 text-center text-base">
							{forbidden ? (
								<Trans>
									You don't have permission to edit the menu in this
									organization. Ask an owner or admin for access.
								</Trans>
							) : (
								<Trans>The dishes could not be loaded.</Trans>
							)}
						</Text>
						{!forbidden && (
							<Button
								className="mt-4"
								variant="outline"
								onPress={() => void onRefresh()}
							>
								<Trans>Try again</Trans>
							</Button>
						)}
					</View>
				</View>
			</Screen>
		)
	}

	return (
		<Screen safeArea={false}>
			<View className="flex-1" style={{ paddingTop: insets.top }}>
				<FlatList
					data={visibleDishes}
					keyExtractor={(dish: MenuPhotoDish) => dish.id}
					ListHeaderComponent={
						<>
							{header}
							{inThisOrganization.map((item) => (
								<QueueRow
									key={item.id}
									item={item}
									reason={reasonFor(item)}
									onRetry={() => void retry(item.id)}
									onRemove={() => void remove(item.id)}
								/>
							))}
						</>
					}
					ListEmptyComponent={
						<View className="items-center px-8 pt-10">
							<Text className="text-muted-foreground text-center text-sm">
								{searching ? (
									<Trans>No dish matches your search.</Trans>
								) : inThisOrganization.length === 0 ? (
									<Trans>Nothing to photograph. Nice.</Trans>
								) : null}
							</Text>
						</View>
					}
					renderItem={({ item: dish }: { item: MenuPhotoDish }) => (
						<TouchableOpacity
							onPress={() => setCapturing({ id: dish.id, name: dish.name })}
							className="border-border flex-row items-center border-b px-5 py-3"
							accessibilityRole="button"
							accessibilityLabel={
								dish.hasPhoto
									? t`Replace the photo of ${dish.name}`
									: t`Take a photo of ${dish.name}`
							}
						>
							{dish.imageUrl ? (
								<Image
									source={{ uri: dish.imageUrl }}
									className="bg-muted h-12 w-12 rounded-lg"
								/>
							) : (
								<View className="bg-muted h-12 w-12 items-center justify-center rounded-lg">
									<Ionicons name="camera-outline" size={22} color="#888" />
								</View>
							)}
							<View className="ms-3 flex-1">
								<Text className="text-foreground text-base" numberOfLines={1}>
									{dish.name}
								</Text>
								{dish.categoryName && (
									<Text
										className="text-muted-foreground text-xs"
										numberOfLines={1}
									>
										{dish.categoryName}
									</Text>
								)}
							</View>
							<Text className="text-primary text-sm">
								{dish.hasPhoto ? (
									<Trans>Replace</Trans>
								) : (
									<Trans>Take photo</Trans>
								)}
							</Text>
						</TouchableOpacity>
					)}
					refreshControl={
						<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
					}
					keyboardShouldPersistTaps="handled"
				/>
				<PhotoCaptureModal
					dish={capturing}
					onClose={() => setCapturing(null)}
					onUse={handleUse}
				/>
			</View>
		</Screen>
	)
}

function QueueRow({
	item,
	reason,
	onRetry,
	onRemove,
}: {
	item: QueueItem
	reason: string
	onRetry: () => void
	onRemove: () => void
}) {
	const { t } = useLingui()
	const failed = item.status === 'failed'
	return (
		<View
			className={`mx-5 mb-2 rounded-lg border p-3 ${
				failed ? 'border-destructive bg-red-50' : 'border-border bg-card'
			}`}
		>
			<View className="flex-row items-center">
				<Image
					source={{ uri: item.fileUri }}
					className="bg-muted h-12 w-12 rounded-lg"
				/>
				<View className="ms-3 flex-1">
					<Text className="text-foreground text-base" numberOfLines={1}>
						{item.itemName ?? t`Dish`}
					</Text>
					<Text
						className={`text-xs ${failed ? 'text-red-600' : 'text-muted-foreground'}`}
						accessibilityLiveRegion="polite"
					>
						{failed ? (
							<Trans>Couldn't upload</Trans>
						) : item.status === 'uploading' ? (
							<Trans>Uploading...</Trans>
						) : (
							<Trans>Waiting to upload</Trans>
						)}
					</Text>
				</View>
			</View>
			{failed && (
				<>
					<Text className="mt-2 text-sm text-red-600">{reason}</Text>
					<View className="mt-2 flex-row gap-3">
						<Button size="sm" variant="outline" onPress={onRetry}>
							<Trans>Try again</Trans>
						</Button>
						<Button size="sm" variant="ghost" onPress={onRemove}>
							<Trans>Remove</Trans>
						</Button>
					</View>
				</>
			)}
		</View>
	)
}
