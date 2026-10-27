import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PrintOrderStatus } from '@repo/common/print-shop'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	PRINT_ORDER_STATUS_LABELS,
	printOrderStatusTone,
} from '#app/components/print/print-order-labels.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'
import {
	isPrintShippingPaused,
	requirePrintShopAccess,
} from '#app/utils/print/access.server.ts'
import { listPrintOrders } from '#app/utils/print/orders.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	if (!access.features.shipping)
		throw new Response('Not Found', { status: 404 })
	const orders = await listPrintOrders(access.organization.id)
	return {
		orgSlug: access.organization.slug,
		canPay: access.canPay && !isPrintShippingPaused(),
		paused: isPrintShippingPaused(),
		orders: orders.map((order) => ({
			id: order.id,
			status: order.status as PrintOrderStatus,
			totalCents: order.totalCents,
			currency: order.currency,
			createdAt: order.createdAt.toISOString(),
			recipient: order.recipientName,
			city: order.city,
		})),
	}
}

export default function PrintOrdersRoute() {
	const { _, i18n } = useLingui()
	const { orgSlug, canPay, paused, orders } = useLoaderData<typeof loader>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Print orders`)}
				description={
					paused
						? _(
								msg`Shipped prints are paused for a moment. Downloads still work.`,
							)
						: _(
								msg`Printed and shipped to your door. You can cancel until production starts.`,
							)
				}
				actions={
					canPay ? (
						<Button
							render={<Link to={`/${orgSlug}/marketing/print/orders/new`} />}
						>
							{_(msg`Order prints`)}
						</Button>
					) : null
				}
			/>
			{orders.length === 0 ? (
				<EmptyState
					title={_(msg`No print orders yet`)}
					description={_(
						msg`Approve a print, then order copies shipped to any US address.`,
					)}
					icons={['printer']}
					action={
						canPay
							? {
									label: _(msg`Order prints`),
									href: `/${orgSlug}/marketing/print/orders/new`,
								}
							: undefined
					}
				/>
			) : (
				<ItemGroup>
					{orders.map((order) => (
						<Item
							key={order.id}
							variant="outline"
							size="sm"
							render={
								<Link to={`/${orgSlug}/marketing/print/orders/${order.id}`} />
							}
						>
							<ItemContent>
								<ItemTitle>
									{(() => {
										const date = new Date(order.createdAt).toLocaleDateString(
											i18n.locale,
											{ dateStyle: 'medium' },
										)
										return _(msg`Order of ${date}`)
									})()}
								</ItemTitle>
								<ItemDescription>
									<bdi>
										{formatMoney(order.totalCents, order.currency, i18n.locale)}
									</bdi>
									{' · '}
									<span className="wrap-anywhere">{order.recipient}</span>
									{' · '}
									{order.city}
								</ItemDescription>
							</ItemContent>
							<ItemActions>
								<Badge variant={printOrderStatusTone(order.status)}>
									{_(PRINT_ORDER_STATUS_LABELS[order.status])}
								</Badge>
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}
		</div>
	)
}
