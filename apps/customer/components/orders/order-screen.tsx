import { useLingui } from '@lingui/react/macro'
import { buildLink } from '@repo/common/links'
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { ApiError } from '../../lib/api/api-error'
import {
	type CustomerOrderReceipt,
	CustomerOrdersClient,
} from '../../lib/api/customer-orders'
import {
	type EligibleGuestPhotoDish,
	type GuestPhotoFileInput,
	GuestPhotosClient,
} from '../../lib/api/guest-photos'
import { useAppSnapshot } from '../../lib/app/use-app'
import { websitePageUrl } from '../../lib/loyalty/website-link'
import { openWebsitePage } from '../../lib/ordering/open-site'
import { reorderWebsiteUrl } from '../../lib/orders/reorder'
import { appErrorFrom } from '../../lib/state/app-error'
import { Button, Card, ErrorMessage, LoadingView, Screen, Text } from '../ui'
import { formatCents, useOrderStatusLabel } from './format'

type State =
	| { kind: 'loading' }
	| { kind: 'ready'; order: CustomerOrderReceipt }
	| { kind: 'not_yours' }
	| { kind: 'failed'; error: unknown }

/**
 * One of the guest's orders (#112, #195). An order link opens it here. The
 * order comes from the regional tenant-api with the guest's token, so it
 * shows only when it is theirs; an order that is not (a forwarded link, an
 * order placed as a guest) is shown on the website instead, where the link's
 * own token (kept in memory here, never stored or logged) opens it read-only.
 */
export function OrderScreen({
	id,
	linkToken,
	pickPhoto,
}: {
	id: string
	linkToken?: string
	pickPhoto?: (
		dish: EligibleGuestPhotoDish,
	) => Promise<GuestPhotoFileInput | null>
}) {
	const { t } = useLingui()
	const { session, organization, configuration } = useAppSnapshot()
	const statusLabel = useOrderStatusLabel()
	const client = useMemo(
		() => (session ? new CustomerOrdersClient(session) : null),
		[session],
	)
	const photosClient = useMemo(
		() => (session ? new GuestPhotosClient(session) : null),
		[session],
	)
	const [state, setState] = useState<State>({ kind: 'loading' })
	const [again, setAgain] = useState<'idle' | 'busy' | 'failed'>('idle')
	const [eligibleDishes, setEligibleDishes] = useState<
		EligibleGuestPhotoDish[]
	>([])
	const [photoBusyId, setPhotoBusyId] = useState<string | null>(null)
	const [photoSubmittedIds, setPhotoSubmittedIds] = useState<
		Record<string, boolean>
	>({})
	const [photoError, setPhotoError] = useState<string | null>(null)

	useEffect(() => {
		if (!client) return
		let cancelled = false
		void client
			.get(id)
			.then((order) => {
				if (cancelled) return
				setState({ kind: 'ready', order })
				if (photosClient) {
					void photosClient
						.eligibility(id)
						.then((elig) => {
							if (!cancelled && elig?.eligible) {
								setEligibleDishes(
									elig.dishes.filter(
										(d) => d.eligible && d.remainingForDish > 0,
									),
								)
							}
						})
						.catch(() => {})
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return
				setState(
					error instanceof ApiError && error.isNotFound
						? { kind: 'not_yours' }
						: { kind: 'failed', error },
				)
			})
		return () => {
			cancelled = true
		}
	}, [client, id, photosClient])

	const pageInput = organization
		? {
				organization,
				siteAddress: configuration.siteAddress,
				brandDomain: configuration.brandDomain,
			}
		: null
	const menuUrl = pageInput
		? websitePageUrl({ ...pageInput, page: 'menu' })
		: null

	const orderAgain = async () => {
		if (!client || !menuUrl) return
		setAgain('busy')
		try {
			const url = reorderWebsiteUrl(menuUrl, await client.reorder(id))
			if (!url) throw new Error('unusable')
			openWebsitePage(url)
			setAgain('idle')
		} catch {
			setAgain('failed')
		}
	}

	const openOnWebsite = () => {
		const origin = menuUrl ? new URL(menuUrl).origin : null
		const url = buildLink(
			'order',
			{ order: id, ...(linkToken ? { link: linkToken } : {}) },
			{ origin },
		)
		if (url) openWebsitePage(url)
	}

	const shareDishPhoto = async (dish: EligibleGuestPhotoDish) => {
		if (!photosClient || !pickPhoto) {
			openOnWebsite()
			return
		}
		setPhotoError(null)
		const picked = await pickPhoto(dish)
		if (!picked) return
		setPhotoBusyId(dish.itemId)
		try {
			const uploaded = await photosClient.upload({
				orderId: id,
				itemId: dish.itemId,
				file: picked,
			})
			await photosClient.submit({
				orderId: id,
				itemId: dish.itemId,
				objectKey: uploaded.objectKey,
				contentType: uploaded.contentType,
				byteSize: uploaded.byteSize,
			})
			setPhotoSubmittedIds((prev) => ({ ...prev, [dish.itemId]: true }))
		} catch {
			setPhotoError(t`We could not upload your photo. Please try again.`)
		} finally {
			setPhotoBusyId(null)
		}
	}

	if (!client || state.kind === 'loading') {
		return <LoadingView label={t`Loading your order`} />
	}
	if (state.kind === 'not_yours') {
		return (
			<Screen>
				<View className="flex-1 items-start justify-center gap-3">
					<Text variant="heading">{t`We can't show this order here`}</Text>
					<Text variant="muted">
						{t`It was not placed from your signed-in account. You can still view it on the website.`}
					</Text>
					<Button onPress={openOnWebsite}>{t`View on the website`}</Button>
				</View>
			</Screen>
		)
	}
	if (state.kind === 'failed') {
		return (
			<Screen>
				<View className="flex-1 items-start justify-center gap-3">
					<ErrorMessage error={appErrorFrom(state.error, 'profile')} />
				</View>
			</Screen>
		)
	}
	const { order } = state
	return (
		<Screen scroll>
			<View className="gap-4 py-5">
				<Card className="gap-1.5">
					<Text variant="heading" accessibilityRole="header">
						{t`Order ${order.number}`}
					</Text>
					<Text variant="muted">{statusLabel(order.status)}</Text>
					<Text variant="muted">{order.location.name}</Text>
				</Card>
				<Card className="gap-2">
					{order.lines.map((line, index) => (
						<View
							key={`${line.itemName}-${index}`}
							className="flex-row justify-between gap-3"
						>
							<Text className="flex-1">{`${line.quantity}× ${line.itemName}`}</Text>
							<Text>{formatCents(line.totalCents, order.currency)}</Text>
						</View>
					))}
					<View className="flex-row justify-between gap-3 pt-2">
						<Text variant="label">{t`Total`}</Text>
						<Text variant="label">
							{formatCents(order.totalCents, order.currency)}
						</Text>
					</View>
				</Card>
				{eligibleDishes.length > 0 ? (
					<Card className="gap-2">
						{eligibleDishes.map((dish) =>
							photoSubmittedIds[dish.itemId] ? (
								<Text key={dish.itemId} variant="muted">
									{t`Thanks, the restaurant will review it.`}
								</Text>
							) : (
								<Button
									key={dish.itemId}
									variant="outline"
									loading={photoBusyId === dish.itemId}
									onPress={() => void shareDishPhoto(dish)}
								>
									{t`Share a photo of your ${dish.itemName}`}
								</Button>
							),
						)}
						<Text variant="muted" className="text-xs">
							{t`By sharing a photo, you allow the restaurant to display it on their menu.`}
						</Text>
						{photoError ? <Text variant="error">{photoError}</Text> : null}
					</Card>
				) : null}
				{again === 'failed' ? (
					<Text variant="error">{t`We could not start this order again.`}</Text>
				) : null}
				<Button loading={again === 'busy'} onPress={() => void orderAgain()}>
					{t`Order again`}
				</Button>
			</View>
		</Screen>
	)
}
