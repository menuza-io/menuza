import { useLingui } from '@lingui/react/macro'
import { buildLink } from '@repo/common/links'
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { ApiError } from '../../lib/api/api-error'
import {
	type CustomerOrderReceipt,
	CustomerOrdersClient,
} from '../../lib/api/customer-orders'
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
}: {
	id: string
	linkToken?: string
}) {
	const { t } = useLingui()
	const { session, organization, configuration } = useAppSnapshot()
	const statusLabel = useOrderStatusLabel()
	const client = useMemo(
		() => (session ? new CustomerOrdersClient(session) : null),
		[session],
	)
	const [state, setState] = useState<State>({ kind: 'loading' })
	const [again, setAgain] = useState<'idle' | 'busy' | 'failed'>('idle')

	useEffect(() => {
		if (!client) return
		let cancelled = false
		void client
			.get(id)
			.then((order) => !cancelled && setState({ kind: 'ready', order }))
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
	}, [client, id])

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
