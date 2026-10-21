import { Plural, Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
	OrderStatusLabel,
	PaymentStatusLabel,
} from '#app/components/orders/order-status.tsx'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import {
	fetchPersonOrders,
	type PeopleClient,
	type PersonOrder,
	type PersonOrdersPage,
} from '#app/utils/people/people-api.ts'
import { formatInstantDate } from '#app/utils/people/people-view.ts'

/**
 * Every order of one customer, newest first, 20 per page. The regional API
 * matches by customer id and by the customer's verified phone, so a guest
 * checkout with the same proven number shows here too.
 */
export function PersonOrdersPanel({
	client,
	orgSlug,
	personKey,
}: {
	client: PeopleClient
	orgSlug: string
	personKey: string
}) {
	const { _, i18n } = useLingui()
	const [orders, setOrders] = useState<PersonOrder[]>([])
	const [totals, setTotals] = useState<PersonOrdersPage['totals'] | null>(null)
	const [cursor, setCursor] = useState<string | null>(null)
	const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
	const [more, setMore] = useState(false)

	useEffect(() => {
		const controller = new AbortController()
		setState('loading')
		setOrders([])
		fetchPersonOrders(client, personKey, null, controller.signal)
			.then((page) => {
				if (controller.signal.aborted) return
				setOrders(page.orders)
				setTotals(page.totals)
				setCursor(page.nextCursor)
				setState('ready')
			})
			.catch(() => {
				if (!controller.signal.aborted) setState('failed')
			})
		return () => controller.abort()
	}, [client, personKey])

	const loadMore = useCallback(async () => {
		if (!cursor || more) return
		setMore(true)
		try {
			const page = await fetchPersonOrders(client, personKey, cursor)
			setOrders((current) => {
				const seen = new Set(current.map((order) => order.id))
				return [...current, ...page.orders.filter((o) => !seen.has(o.id))]
			})
			setCursor(page.nextCursor)
		} catch {
			setState('failed')
		} finally {
			setMore(false)
		}
	}, [client, personKey, cursor, more])

	const money = (cents: number, currency: string) => {
		try {
			return new Intl.NumberFormat(i18n.locale, {
				style: 'currency',
				currency,
			}).format(cents / 100)
		} catch {
			return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
		}
	}

	return (
		<Frame
			role="region"
			aria-labelledby="person-orders-title"
			data-testid="person-orders"
		>
			<FrameHeader>
				<FrameTitle id="person-orders-title">
					<Trans>Orders</Trans>
				</FrameTitle>
				<FrameDescription>
					{totals && totals.count > 0 ? (
						<span data-testid="person-orders-totals">
							<Plural value={totals.count} one="# order" other="# orders" />
							{totals.spend.length > 0 ? (
								<>
									{' · '}
									<Trans>Lifetime spend</Trans>{' '}
									<bdi>
										{totals.spend
											.map((entry) => money(entry.cents, entry.currency))
											.join(' · ')}
									</bdi>
								</>
							) : null}
						</span>
					) : (
						<Trans>Menu and drop orders placed by this customer.</Trans>
					)}
				</FrameDescription>
			</FrameHeader>
			{state === 'loading' ? (
				<FramePanel>
					<Skeleton className="h-16 w-full" />
				</FramePanel>
			) : state === 'failed' ? (
				<FramePanel>
					<p role="alert" className="text-destructive text-sm">
						<Trans>Orders could not be loaded. Try again.</Trans>
					</p>
				</FramePanel>
			) : orders.length === 0 ? (
				<FramePanel>
					<p
						className="text-muted-foreground text-sm"
						data-testid="person-orders-empty"
					>
						<Trans>No orders yet.</Trans>
					</p>
				</FramePanel>
			) : (
				<>
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Order</Trans>
								</TableHead>
								<TableHead>
									<Trans>Date</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead>
									<Trans>Fulfillment</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Items</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Total</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{orders.map((order) => {
								return (
									<TableRow
										key={order.id}
										data-testid={`person-order-${order.id}`}
									>
										<TableCell>
											<Link
												className="text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
												to={ordersHref(orgSlug, { orderId: order.id })}
											>
												<bdi dir="ltr">{order.number}</bdi>
											</Link>
										</TableCell>
										<TableCell>
											{order.createdAt
												? (formatInstantDate(
														new Date(order.createdAt).getTime(),
														i18n.locale,
													) ?? '—')
												: '—'}
										</TableCell>
										<TableCell>
											<span className="flex flex-col gap-1">
												<OrderStatusLabel status={order.status} />
												<PaymentStatusLabel status={order.paymentStatus} />
											</span>
										</TableCell>
										<TableCell>
											<span className="text-muted-foreground flex items-center gap-1.5">
												<Icon
													name={
														order.fulfillment === 'delivery'
															? 'route'
															: 'building'
													}
													className="size-3.5"
												/>
												{order.fulfillment === 'delivery'
													? _(msg`Delivery`)
													: _(msg`Pickup`)}
											</span>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											<bdi>{order.itemCount}</bdi>
										</TableCell>
										<TableCell className="text-end tabular-nums">
											<bdi>{money(order.totalCents, order.currency)}</bdi>
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
					{cursor ? (
						<FramePanel className="flex justify-center">
							<Button
								type="button"
								variant="outline"
								disabled={more}
								onClick={() => void loadMore()}
								data-testid="person-orders-more"
							>
								<Trans>Load more</Trans>
							</Button>
						</FramePanel>
					) : null}
				</>
			)}
		</Frame>
	)
}
