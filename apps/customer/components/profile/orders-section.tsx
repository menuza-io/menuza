import { useLingui } from '@lingui/react/macro'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import {
	type CustomerOrdersPage,
	CustomerOrdersClient,
} from '../../lib/api/customer-orders'
import { useAppSnapshot } from '../../lib/app/use-app'
import { websitePageUrl } from '../../lib/loyalty/website-link'
import { openWebsitePage } from '../../lib/ordering/open-site'
import { reorderWebsiteUrl } from '../../lib/orders/reorder'
import { formatCents, useOrderStatusLabel } from '../orders/format'
import { Button, Card, Text } from '../ui'

type Item = CustomerOrdersPage['orders'][number]

/**
 * Opens the order screen. The router is loaded when a row is tapped: this
 * section is imported by the profile screen's tests, which do not run the
 * navigator.
 */
function openOrder(id: string) {
	void import('expo-router').then(({ router }) =>
		router.push({ pathname: '/orders/[id]', params: { id } }),
	)
}

/**
 * Profile, Orders (#112): the signed-in guest's restaurant orders, newest
 * first, 50 a page, each opening its detail and offering "Order again" (or
 * "Finish this order" for a lapsed unpaid one). Only orders linked to the
 * guest's account are listed.
 */
export function OrdersSection() {
	const { t } = useLingui()
	const { session, organization, configuration } = useAppSnapshot()
	const statusLabel = useOrderStatusLabel()
	const client = useMemo(
		() => (session ? new CustomerOrdersClient(session) : null),
		[session],
	)
	const [orders, setOrders] = useState<Item[]>([])
	const [cursor, setCursor] = useState<string | null>(null)
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
		'loading',
	)
	const [busy, setBusy] = useState<string | null>(null)
	const [failedId, setFailedId] = useState<string | null>(null)

	const load = useCallback(
		(next: string | null) => {
			if (!client) return
			void client
				.list(next)
				.then((page) => {
					setOrders((current) =>
						next ? [...current, ...page.orders] : page.orders,
					)
					setCursor(page.nextCursor)
					setStatus('ready')
				})
				.catch(() => setStatus('failed'))
		},
		[client],
	)
	useEffect(() => load(null), [load])

	const menuUrl = organization
		? websitePageUrl({
				organization,
				siteAddress: configuration.siteAddress,
				brandDomain: configuration.brandDomain,
				page: 'menu',
			})
		: null

	const orderAgain = async (item: Item) => {
		if (!client || !menuUrl) return
		setBusy(item.id)
		setFailedId(null)
		try {
			const url = reorderWebsiteUrl(menuUrl, await client.reorder(item.id))
			if (!url) throw new Error('unusable')
			openWebsitePage(url)
		} catch {
			setFailedId(item.id)
		} finally {
			setBusy(null)
		}
	}

	return (
		<Card className="gap-3" testID="orders-section">
			<Text variant="heading" accessibilityRole="header">
				{t`Your orders`}
			</Text>
			{status === 'failed' ? (
				<View className="items-start gap-2">
					<Text variant="error">{t`Your orders could not be loaded.`}</Text>
					<Button variant="outline" onPress={() => load(null)}>
						{t`Try again`}
					</Button>
				</View>
			) : null}
			{status === 'ready' && orders.length === 0 ? (
				<Text variant="muted">{t`No orders yet. Orders you place while signed in show up here.`}</Text>
			) : null}
			{orders.map((item) => (
				<View key={item.id} className="border-border gap-2 border-t pt-3">
					<Pressable
						accessibilityRole="button"
						onPress={() => openOrder(item.id)}
						className="gap-0.5"
					>
						<Text variant="label">{t`Order ${item.number}`}</Text>
						<Text variant="muted">
							{`${statusLabel(item.status)} · ${item.location.name} · ${formatCents(item.totalCents, item.currency)}`}
						</Text>
					</Pressable>
					{item.canReorder ? (
						<Button
							variant="outline"
							loading={busy === item.id}
							onPress={() => void orderAgain(item)}
						>
							{item.canFinish ? t`Finish this order` : t`Order again`}
						</Button>
					) : null}
					{failedId === item.id ? (
						<Text variant="error">{t`We could not start this order again.`}</Text>
					) : null}
				</View>
			))}
			{cursor ? (
				<Button variant="outline" onPress={() => load(cursor)}>
					{t`Load more`}
				</Button>
			) : null}
		</Card>
	)
}
