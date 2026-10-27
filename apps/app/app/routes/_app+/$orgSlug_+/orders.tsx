import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageTitle } from '@repo/ui/page-title'
import { useCallback, useEffect, useState } from 'react'
import {
	data,
	type LoaderFunctionArgs,
	Link,
	redirect,
	useLoaderData,
	useNavigate,
} from 'react-router'
import { z } from 'zod'
import {
	OrderStatusLabel,
	PaymentStatusLabel,
} from '#app/components/orders/order-status.tsx'
import { OpenTabs } from '#app/components/qr/open-tabs.tsx'
import { useOrdersClient } from '#app/hooks/use-orders-client.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { getOrderCustomerLinkAccess } from '#app/utils/orders/customer-link.server.ts'
import {
	formatMoney,
	type Order,
	orderSchema,
	relativeTime,
} from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { getQrOrderingFeatures } from '#app/utils/qr/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	// Old deep link: `/orders?order=<id>` is now the order's own page.
	const legacyId = new URL(request.url).searchParams.get('order')
	if (legacyId) throw redirect(ordersHref(orgSlug, { orderId: legacyId }))
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})
	const userId = await requireMenuRead(request, organization.id)
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	const link = await getOrderCustomerLinkAccess(request, orgSlug)
	const qr = await getQrOrderingFeatures(organization.id)
	return data(
		{
			orgSlug,
			canWrite,
			// Tabs show while QR ordering is on, even with dine-in switched off,
			// so tabs still open (and payments to check) can be settled. The
			// list renders nothing when there is nothing to show.
			showTabs: qr.enabled,
			// Customers links show only to members who can open Customers.
			canViewCustomers: link.linkCustomers || link.linkGuests,
		},
		{
			headers: { 'Cache-Control': 'private, no-store' },
		},
	)
}

export default function OrdersInbox() {
	const { orgSlug, canViewCustomers, canWrite, showTabs } =
		useLoaderData<typeof loader>()
	const [refreshKey, setRefreshKey] = useState(0)
	const navigate = useNavigate()
	const { _, i18n } = useLingui()
	const request = useOrdersClient(orgSlug)
	const [orders, setOrders] = useState<Order[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const money = (cents: number, currency: string) =>
		formatMoney(cents, currency, i18n.locale)

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const payload = z
					.object({ orders: z.array(orderSchema) })
					.parse(await request('', { signal }))
				if (signal?.aborted) return
				setOrders(payload.orders)
				setError(null)
			} catch {
				if (!signal?.aborted)
					setError(_(msg`Unable to load orders. Try again.`))
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[request, _],
	)

	useEffect(() => {
		const controller = new AbortController()
		setOrders([])
		setLoading(true)
		void refresh(controller.signal)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible')
				void refresh(controller.signal)
		}, 15000)
		return () => {
			controller.abort()
			window.clearInterval(timer)
		}
	}, [refresh])

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 py-8 md:px-6 lg:px-8">
			<div className="flex items-start justify-between gap-4">
				<PageTitle
					title={_(msg`Orders`)}
					description={_(
						msg`Receive and manage menu and drop orders. Updates refresh every 15 seconds.`,
					)}
				/>
				<Button
					variant="outline"
					onClick={() => {
						setRefreshKey((key) => key + 1)
						void refresh()
					}}
				>
					<Trans>Refresh</Trans>
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{showTabs ? (
				<OpenTabs
					orgSlug={orgSlug}
					canWrite={canWrite}
					refreshKey={refreshKey}
				/>
			) : null}
			{loading ? (
				<p role="status">
					<Trans>Loading orders…</Trans>
				</p>
			) : orders.length === 0 && !error ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">
						<Trans>No orders yet</Trans>
					</h3>
					<p className="text-muted-foreground mt-2 text-sm">
						<Trans>Submitted orders will appear here.</Trans>
					</p>
				</div>
			) : (
				<ul
					className="divide-border divide-y rounded-lg border"
					data-testid="orders-list"
				>
					{orders.map((order) => {
						const ago = relativeTime(order.createdAt, i18n.locale)
						const href = ordersHref(orgSlug, { orderId: order.id })
						return (
							<li
								key={order.id}
								className={cn('hover:bg-muted/60 relative cursor-pointer')}
								data-testid="order-row"
								onClick={() => void navigate(href)}
							>
								<div className="flex flex-col gap-2 p-4">
									<div className="flex items-baseline justify-between gap-3">
										<Link
											to={href}
											className="focus-visible:ring-ring rounded-sm font-medium tabular-nums outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2"
											data-testid="order-row-link"
											onClick={(event) => event.stopPropagation()}
										>
											<bdi dir="ltr">{order.number}</bdi>
										</Link>
										<span className="font-medium tabular-nums">
											<bdi>{money(order.totalCents, order.currency)}</bdi>
										</span>
									</div>
									<div className="flex items-center justify-between gap-3 text-sm">
										<span className="flex min-w-0 items-center gap-2">
											{canViewCustomers && order.customerKey ? (
												<Link
													to={customersHref(orgSlug, {
														personKey: order.customerKey,
													})}
													className="focus-visible:ring-ring relative z-10 truncate rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
													data-testid="order-row-customer-link"
													onClick={(event) => event.stopPropagation()}
												>
													{order.contact.name}
												</Link>
											) : (
												<span className="truncate">
													{order.contact.name ||
														(order.table
															? (() => {
																	const label = order.table.label
																	return <bdi>{_(msg`Table ${label}`)}</bdi>
																})()
															: _(msg`Guest`))}
												</span>
											)}
											{canViewCustomers ? (
												<Badge
													variant="outline"
													data-testid="order-customer-kind"
												>
													{order.customerKey
														? _(msg`Customer`)
														: _(msg`Guest checkout`)}
												</Badge>
											) : null}
										</span>
										<span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
											<Icon
												name={
													order.fulfillment === 'delivery'
														? 'route'
														: order.fulfillment === 'dine_in'
															? 'utensils'
															: 'building'
												}
												className="size-3.5"
											/>
											{order.fulfillment === 'delivery'
												? _(msg`Delivery`)
												: order.fulfillment === 'dine_in'
													? order.table
														? (() => {
																const label = order.table.label
																return <bdi>{_(msg`Table ${label}`)}</bdi>
															})()
														: _(msg`At the table`)
													: _(msg`Pickup`)}
										</span>
									</div>
									<div className="flex items-center justify-between gap-3">
										<span className="flex flex-wrap items-center gap-x-3 gap-y-1">
											<OrderStatusLabel status={order.status} />
											<PaymentStatusLabel status={order.paymentStatus} />
										</span>
										<span className="text-muted-foreground text-xs">{ago}</span>
									</div>
								</div>
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}
