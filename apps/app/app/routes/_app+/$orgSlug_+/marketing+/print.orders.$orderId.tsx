import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PRINT_SELF_CANCEL_STATUSES,
	type PrintOrderStatus,
	type PrintProductKey,
} from '@repo/common/print-shop'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { PageHeader } from '@repo/ui/page-header'
import {
	Form,
	Link,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { PRINT_PRODUCT_LABELS } from '#app/components/print/print-labels.ts'
import {
	PRINT_ORDER_STATUS_LABELS,
	printOrderStatusTone,
} from '#app/components/print/print-order-labels.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'
import {
	isPrintShippingPaused,
	requirePrintShopAccess,
} from '#app/utils/print/access.server.ts'
import {
	cancelPrintOrder,
	getPrintOrderDetail,
	PrintOrderError,
	startPrintCheckout,
} from '#app/utils/print/orders.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug)
	if (!access.features.shipping)
		throw new Response('Not Found', { status: 404 })
	const { order, vendorOrders, items } = await getPrintOrderDetail(
		access.organization.id,
		params.orderId ?? '',
	)
	const url = new URL(request.url)
	return {
		orgSlug: access.organization.slug,
		canPay: access.canPay && !isPrintShippingPaused(),
		justPaid: url.searchParams.get('paid') === '1',
		paymentCancelled: url.searchParams.get('cancelled') === '1',
		order: {
			id: order.id,
			status: order.status as PrintOrderStatus,
			currency: order.currency,
			itemsCents: order.itemsCents,
			shippingCents: order.shippingCents,
			taxCents: order.taxCents,
			totalCents: order.totalCents,
			refundCents: order.refundCents,
			quoteExpiresAt: order.quoteExpiresAt.toISOString(),
			createdAt: order.createdAt.toISOString(),
			holdReason: order.holdReason,
			address: [
				order.recipientName,
				order.addressLine1,
				order.addressLine2,
				`${order.city}, ${order.state} ${order.postalCode}`,
			].filter(Boolean),
		},
		shipments: vendorOrders.map((vendorOrder) => ({
			id: vendorOrder.id,
			status: vendorOrder.status,
			carrier: vendorOrder.carrier,
			trackingNumber: vendorOrder.trackingNumber,
			trackingUrl:
				vendorOrder.trackingUrl &&
				vendorOrder.trackingUrl.startsWith('https://')
					? vendorOrder.trackingUrl
					: null,
		})),
		items: items.map(({ item, designName }) => ({
			id: item.id,
			name: designName,
			product: item.product as PrintProductKey,
			quantity: item.quantity,
			pieces: item.pieces,
			retailCents: item.retailCents,
		})),
	}
}

const IntentSchema = z.enum(['pay', 'cancel'])

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		pay: true,
	})
	const intent = IntentSchema.safeParse(
		(await request.formData()).get('intent'),
	)
	if (!intent.success) return { error: 'Unknown action' }
	const orderId = params.orderId ?? ''
	try {
		if (intent.data === 'pay') {
			if (isPrintShippingPaused()) {
				return {
					error: 'Shipped prints are paused for a moment. Try again later.',
				}
			}
			const base = `${new URL(request.url).origin}/${access.organization.slug}/marketing/print/orders/${encodeURIComponent(orderId)}`
			return redirect(await startPrintCheckout(access, orderId, base))
		}
		await cancelPrintOrder(access, orderId)
		return { error: null }
	} catch (error) {
		if (error instanceof PrintOrderError) return { error: error.message }
		throw error
	}
}

export default function PrintOrderRoute() {
	const { _, i18n } = useLingui()
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const busy = useNavigation().state !== 'idle'
	const { order } = data
	const money = (cents: number) =>
		formatMoney(cents, order.currency, i18n.locale)
	const expired = new Date(order.quoteExpiresAt).getTime() <= Date.now()
	const payable =
		data.canPay &&
		(order.status === 'quote' || order.status === 'awaiting_payment') &&
		!expired
	const cancellable =
		data.canPay && PRINT_SELF_CANCEL_STATUSES.includes(order.status)
	const expiresAt = new Date(order.quoteExpiresAt).toLocaleTimeString(
		i18n.locale,
		{
			hour: 'numeric',
			minute: '2-digit',
		},
	)

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Print order`)}
				description={new Date(order.createdAt).toLocaleString(i18n.locale)}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/marketing/print/orders`} />}
					>
						{_(msg`Print orders`)}
					</Button>
				}
			/>

			{data.justPaid && order.status === 'awaiting_payment' ? (
				<Alert role="status">
					<AlertTitle>{_(msg`Payment received`)}</AlertTitle>
					<AlertDescription>
						{_(
							msg`We are confirming it with the bank. This page updates in a moment.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}
			{data.paymentCancelled && payable ? (
				<Alert role="status">
					<AlertTitle>{_(msg`Payment not finished`)}</AlertTitle>
					<AlertDescription>
						{_(msg`Nothing was charged. You can pay again below.`)}
					</AlertDescription>
				</Alert>
			) : null}
			{order.status === 'held' ? (
				<Alert role="status">
					<AlertTitle>{_(msg`Your order is on hold`)}</AlertTitle>
					<AlertDescription>
						{_(
							msg`We are checking it with the printer and will update you by email. You can still cancel for a full refund.`,
						)}
					</AlertDescription>
				</Alert>
			) : null}
			{actionData?.error ? (
				<Alert variant="destructive" role="alert">
					<AlertTitle>{_(msg`That did not work`)}</AlertTitle>
					<AlertDescription>{actionData.error}</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
				<Card>
					<CardHeader>
						<CardTitle className="flex flex-wrap items-center gap-2">
							{_(msg`Summary`)}
							<Badge variant={printOrderStatusTone(order.status)}>
								{_(PRINT_ORDER_STATUS_LABELS[order.status])}
							</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-6">
						<ul className="divide-border divide-y">
							{data.items.map((item) => (
								<li
									key={item.id}
									className="flex items-baseline justify-between gap-4 py-3"
								>
									<span className="flex min-w-0 flex-col">
										<span className="font-medium wrap-anywhere">
											{item.name}
										</span>
										<span className="text-muted-foreground text-sm">
											{_(PRINT_PRODUCT_LABELS[item.product].name)}
											{' · '}
											{(() => {
												const copies = item.quantity * item.pieces
												return _(msg`${copies} printed`)
											})()}
										</span>
									</span>
									<span className="tabular-nums">
										<bdi>{money(item.retailCents)}</bdi>
									</span>
								</li>
							))}
						</ul>
						<dl className="space-y-2 text-sm">
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">{_(msg`Prints`)}</dt>
								<dd className="tabular-nums">
									<bdi>{money(order.itemsCents)}</bdi>
								</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">{_(msg`Shipping`)}</dt>
								<dd className="tabular-nums">
									<bdi>{money(order.shippingCents)}</bdi>
								</dd>
							</div>
							<div className="flex justify-between gap-4">
								<dt className="text-muted-foreground">{_(msg`Sales tax`)}</dt>
								<dd className="tabular-nums">
									{order.status === 'quote' ||
									order.status === 'awaiting_payment' ? (
										_(msg`Added at payment`)
									) : (
										<bdi>{money(order.taxCents)}</bdi>
									)}
								</dd>
							</div>
							<div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
								<dt>{_(msg`Total`)}</dt>
								<dd className="tabular-nums">
									<bdi>{money(order.totalCents)}</bdi>
								</dd>
							</div>
							{order.refundCents > 0 ? (
								<div className="flex justify-between gap-4">
									<dt className="text-muted-foreground">{_(msg`Refunded`)}</dt>
									<dd className="tabular-nums">
										<bdi>{money(order.refundCents)}</bdi>
									</dd>
								</div>
							) : null}
						</dl>
						{payable || cancellable ? (
							<div className="flex flex-wrap items-center gap-3">
								{payable ? (
									<Form method="post">
										<Button
											type="submit"
											name="intent"
											value="pay"
											disabled={busy}
										>
											{_(msg`Pay securely`)}
										</Button>
									</Form>
								) : null}
								{cancellable ? (
									<AlertDialog>
										<AlertDialogTrigger
											render={
												<Button variant="ghost" disabled={busy}>
													{_(msg`Cancel order`)}
												</Button>
											}
										/>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													{_(msg`Cancel this order?`)}
												</AlertDialogTitle>
												<AlertDialogDescription>
													{order.status === 'quote' ||
													order.status === 'awaiting_payment'
														? _(msg`Nothing has been charged yet.`)
														: _(
																msg`You get a full refund to the card you paid with.`,
															)}
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>
													{_(msg`Keep the order`)}
												</AlertDialogCancel>
												<Form method="post">
													<Button
														type="submit"
														name="intent"
														value="cancel"
														variant="destructive"
													>
														{_(msg`Cancel order`)}
													</Button>
												</Form>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								) : null}
								{payable ? (
									<p className="text-muted-foreground text-sm">
										{_(msg`This price is held until ${expiresAt}.`)}
									</p>
								) : null}
							</div>
						) : null}
						{(order.status === 'quote' ||
							order.status === 'awaiting_payment') &&
						expired ? (
							<p className="text-muted-foreground text-sm">
								{_(msg`This price has expired.`)}{' '}
								<Link
									className="underline underline-offset-4"
									to={`/${data.orgSlug}/marketing/print/orders/new`}
								>
									{_(msg`Get a new price`)}
								</Link>
							</p>
						) : null}
					</CardContent>
				</Card>

				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>{_(msg`Ship to`)}</CardTitle>
						</CardHeader>
						<CardContent>
							<address className="text-sm not-italic">
								{order.address.map((line) => (
									<span key={line} className="block wrap-anywhere">
										{line}
									</span>
								))}
							</address>
						</CardContent>
					</Card>
					{data.shipments.some((shipment) => shipment.trackingNumber) ? (
						<Card>
							<CardHeader>
								<CardTitle>{_(msg`Tracking`)}</CardTitle>
								<CardDescription>
									{_(msg`Large orders can arrive in more than one parcel.`)}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-2">
								{data.shipments
									.filter((shipment) => shipment.trackingNumber)
									.map((shipment) => (
										<p key={shipment.id} className="text-sm">
											{shipment.carrier ? `${shipment.carrier} · ` : ''}
											{shipment.trackingUrl ? (
												<a
													href={shipment.trackingUrl}
													target="_blank"
													rel="noopener noreferrer"
													className="underline underline-offset-4"
												>
													<bdi dir="ltr">{shipment.trackingNumber}</bdi>
												</a>
											) : (
												<bdi dir="ltr">{shipment.trackingNumber}</bdi>
											)}
										</p>
									))}
							</CardContent>
						</Card>
					) : null}
				</div>
			</div>
		</div>
	)
}
