import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Avatar, AvatarFallback } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@repo/ui/breadcrumb'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Separator } from '@repo/ui/separator'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import {
	CLOSED_ORDER_STATUSES,
	formatDateTime,
	formatMoney,
	initialsOf,
	localizedName,
	nextOrderStatus,
	type Order,
	relativeTime,
} from '#app/utils/orders/order-model.ts'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { OrderStatusLabel, PaymentStatusLabel } from './order-status.tsx'

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false)
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={label}
			onClick={() => {
				void navigator.clipboard
					?.writeText(value)
					.then(() => {
						setCopied(true)
						window.setTimeout(() => setCopied(false), 1500)
					})
					.catch(() => undefined)
			}}
		>
			<Icon name={copied ? 'check' : 'copy'} />
		</Button>
	)
}

function Section({
	title,
	children,
	testId,
}: {
	title: ReactNode
	children: ReactNode
	testId?: string
}) {
	return (
		<section className="flex flex-col gap-3" data-testid={testId}>
			<h2 className="text-sm font-semibold">{title}</h2>
			{children}
		</section>
	)
}

function pickupDate(date: string, locale: string): string {
	const [y, m, d] = date.split('-').map(Number)
	if (!y || !m || !d) return date
	try {
		return new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(new Date(y, m - 1, d))
	} catch {
		return date
	}
}

/**
 * One order, read top to bottom: what it is and where it stands, who it is
 * for, how it gets to them, what is in it, what it costs, how it was paid.
 * Actions sit in a footer that stays in reach.
 */
export function OrderDetail({
	order,
	orgSlug,
	canWrite,
	canViewCustomers,
	busy,
	onUpdate,
	backHref,
}: {
	order: Order
	orgSlug: string
	canWrite: boolean
	canViewCustomers: boolean
	busy: boolean
	onUpdate: (status: string, markPaid: boolean) => void
	backHref: string
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [markPaid, setMarkPaid] = useState(false)
	const [cancelOpen, setCancelOpen] = useState(false)
	const money = (cents: number) => formatMoney(cents, order.currency, locale)
	const totalMoney = money(order.totalCents)
	const tipPercent = order.tipPercent ?? 0
	const processor = order.paymentProcessor ?? ''
	const orderNumber = order.number
	const next = nextOrderStatus(order.status)
	const closed = CLOSED_ORDER_STATUSES.includes(order.status)
	const paid = order.paymentStatus === 'paid'
	const needsHandoffPayment =
		order.paymentMethod === 'handoff' && !paid && next === 'completed'
	const created = formatDateTime(order.createdAt, locale)
	const createdAgo = relativeTime(order.createdAt, locale)
	const profileHref = order.customerKey
		? customersHref(orgSlug, { personKey: order.customerKey })
		: null
	const name = order.contact.name

	const paymentExplanation =
		order.status === 'payment_review'
			? paid
				? _(
						msg`Payment arrived after the hold on this order ran out, so it was not confirmed automatically. The money was received: start preparing to honor the order, or cancel it and refund through your payment processor.`,
					)
				: _(
						msg`This order needs a manual check before it goes ahead. Start preparing to accept it, or cancel it.`,
					)
			: null

	const timeline: Array<{ key: string; label: string; at: string | null }> = [
		{ key: 'placed', label: _(msg`Placed`), at: order.createdAt },
		{ key: 'paid', label: _(msg`Payment received`), at: order.paidAt ?? null },
		{
			key: 'completed',
			label: _(msg`Completed`),
			at: order.completedAt ?? null,
		},
		{
			key: 'cancelled',
			label: _(msg`Cancelled`),
			at: order.cancelledAt ?? null,
		},
	]
	const events = timeline.filter((event) => event.at)
	const placedAt = order.createdAt
	const showUpdated =
		order.updatedAt &&
		order.updatedAt !== placedAt &&
		!events.some((event) => event.at === order.updatedAt)

	const primaryLabel =
		next === 'preparing'
			? order.status === 'payment_review'
				? _(msg`Accept and start preparing`)
				: _(msg`Start preparing`)
			: next === 'ready'
				? _(msg`Mark ready`)
				: _(msg`Complete order`)

	const hasTotalsBreakdown =
		order.subtotalCents != null ||
		!!order.taxCents ||
		!!order.tipCents ||
		!!order.deliveryFeeCents

	return (
		<div
			className="flex flex-col gap-6"
			aria-label={_(msg`Order details`)}
			data-testid="order-detail"
		>
			<header className="flex flex-col gap-4" data-testid="order-header">
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink render={<Link to={backHref} />}>
								<Trans>Orders</Trans>
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage>
								<bdi dir="ltr">{order.number}</bdi>
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex min-w-0 flex-col gap-1">
						<div className="flex items-center gap-1">
							<h1 className="text-2xl font-semibold tabular-nums">
								<bdi dir="ltr">{order.number}</bdi>
							</h1>
							<CopyButton
								value={order.number}
								label={_(msg`Copy order number`)}
							/>
						</div>
						{created ? (
							<p className="text-muted-foreground text-sm">
								<time dateTime={order.createdAt ?? undefined}>{created}</time>
								{createdAgo ? ` · ${createdAgo}` : ''}
							</p>
						) : null}
					</div>
					<dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Order</Trans>
							</dt>
							<dd>
								<OrderStatusLabel
									status={order.status}
									className="text-sm"
									testId="order-status"
								/>
							</dd>
						</div>
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Payment</Trans>
							</dt>
							<dd>
								<PaymentStatusLabel
									status={order.paymentStatus}
									className="text-sm"
									testId="order-payment-status"
								/>
							</dd>
						</div>
					</dl>
				</div>
				{paymentExplanation ? (
					<p
						role="note"
						className="bg-destructive/10 text-foreground rounded-md p-3 text-sm"
						data-testid="order-review-note"
					>
						{paymentExplanation}
					</p>
				) : null}
			</header>

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
				<Card className="lg:col-start-2 lg:row-start-1">
					<CardContent className="flex flex-col gap-5">
						<Section title={<Trans>Customer</Trans>} testId="order-customer">
							<div className="flex items-start gap-3">
								<Avatar size="lg">
									<AvatarFallback>{initialsOf(name)}</AvatarFallback>
								</Avatar>
								<div className="flex min-w-0 flex-1 flex-col gap-1.5">
									<div className="flex flex-wrap items-center gap-2">
										{profileHref && canViewCustomers ? (
											<Link
												to={profileHref}
												className="text-foreground focus-visible:ring-ring rounded-sm font-medium wrap-anywhere underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
												data-testid="order-customer-link"
											>
												{name}
											</Link>
										) : (
											<span className="font-medium wrap-anywhere">{name}</span>
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
									</div>
									<div className="text-muted-foreground flex flex-col gap-0.5 text-sm">
										<div className="flex items-center gap-1">
											<Icon name="phone" className="size-3.5" />
											<a
												href={`tel:${order.contact.phone}`}
												className="hover:text-foreground focus-visible:ring-ring rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
											>
												<bdi dir="ltr">{order.contact.phone}</bdi>
											</a>
											<CopyButton
												value={order.contact.phone}
												label={_(msg`Copy phone number`)}
											/>
										</div>
										{order.contact.email ? (
											<div className="flex min-w-0 items-center gap-1">
												<Icon name="mail" className="size-3.5 shrink-0" />
												<a
													href={`mailto:${order.contact.email}`}
													className="hover:text-foreground focus-visible:ring-ring min-w-0 rounded-sm wrap-anywhere underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
												>
													{order.contact.email}
												</a>
												<CopyButton
													value={order.contact.email}
													label={_(msg`Copy email address`)}
												/>
											</div>
										) : null}
									</div>
									{canViewCustomers ? (
										profileHref ? (
											<Link
												to={profileHref}
												className="text-primary focus-visible:ring-ring w-fit rounded-sm text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
												data-testid="order-customer-orders"
											>
												<Trans>View all orders</Trans>
											</Link>
										) : (
											<p
												className="text-muted-foreground text-xs"
												data-testid="order-no-profile"
											>
												<Trans>No customer profile</Trans>
											</p>
										)
									) : null}
								</div>
							</div>
						</Section>
						<Separator variant="dashed" />

						<Section
							title={<Trans>Fulfillment</Trans>}
							testId="order-fulfillment"
						>
							<div className="flex flex-col gap-1 text-sm">
								<p className="flex items-center gap-2 font-medium">
									<Icon
										name={
											order.fulfillment === 'delivery' ? 'route' : 'building'
										}
										className="text-muted-foreground size-4"
									/>
									{order.fulfillment === 'delivery'
										? _(msg`Delivery`)
										: _(msg`Pickup`)}
								</p>
								{order.pickup ? (
									<p>
										<span className="tabular-nums">
											{pickupDate(order.pickup.date, locale)} ·{' '}
											{order.pickup.time}
										</span>
										<span className="text-muted-foreground">
											{' · '}
											{localizedName(order.location.name, locale)}
										</span>
									</p>
								) : (
									<p className="text-muted-foreground">
										{localizedName(order.location.name, locale)}
									</p>
								)}
								{order.delivery ? (
									<>
										<p className="wrap-anywhere">
											{[
												order.delivery.address,
												order.delivery.unit,
												order.delivery.city,
												order.delivery.postalCode,
											]
												.filter(Boolean)
												.join(', ')}
										</p>
										{order.delivery.notes ? (
											<p className="text-muted-foreground wrap-anywhere">
												<Trans>Delivery notes:</Trans> {order.delivery.notes}
											</p>
										) : null}
									</>
								) : null}
								{order.drop ? (
									<p className="text-muted-foreground">
										<Trans>Drop:</Trans> {order.drop.slug}
									</p>
								) : null}
							</div>
						</Section>
					</CardContent>
				</Card>
				<Card className="lg:col-start-1 lg:row-start-1">
					<CardContent className="flex flex-col gap-5">
						<Section title={<Trans>Items</Trans>} testId="order-items">
							<table className="w-full text-sm">
								<thead>
									<tr className="text-muted-foreground border-input border-b border-dashed text-xs">
										<th
											scope="col"
											className="w-10 py-2 pe-3 text-start font-medium"
										>
											<Trans>Qty</Trans>
										</th>
										<th
											scope="col"
											className="py-2 pe-3 text-start font-medium"
										>
											<Trans>Item</Trans>
										</th>
										<th scope="col" className="py-2 text-end font-medium">
											<Trans>Price</Trans>
										</th>
									</tr>
								</thead>
								<tbody>
									{order.lines.map((line, index) => (
										<tr
											key={index}
											className="border-input border-b border-dashed"
											data-testid="order-line"
										>
											<td className="py-3 pe-3 align-top tabular-nums">
												{line.quantity}
											</td>
											<td className="py-3 pe-3 align-top">
												<p className="wrap-anywhere">
													{localizedName(line.itemName, locale)}
												</p>
												{line.options.length ? (
													<p className="text-muted-foreground text-xs">
														{line.options
															.map((option) =>
																option.quantity > 1
																	? `${option.quantity} × ${localizedName(option.optionName, locale)}`
																	: localizedName(option.optionName, locale),
															)
															.join(', ')}
													</p>
												) : null}
												{line.instructions ? (
													<p className="mt-0.5 text-xs wrap-anywhere italic">
														{line.instructions}
													</p>
												) : null}
											</td>
											<td className="py-3 text-end align-top tabular-nums">
												<bdi>{money(line.totalCents)}</bdi>
											</td>
										</tr>
									))}
								</tbody>
								<tfoot data-testid="order-totals">
									{hasTotalsBreakdown ? (
										<>
											{order.subtotalCents != null ? (
												<TotalRow label={<Trans>Subtotal</Trans>}>
													{money(order.subtotalCents)}
												</TotalRow>
											) : null}
											{order.deliveryFeeCents ? (
												<TotalRow label={<Trans>Delivery fee</Trans>}>
													{money(order.deliveryFeeCents)}
												</TotalRow>
											) : null}
											{order.taxCents ? (
												<TotalRow label={<Trans>Tax</Trans>}>
													{money(order.taxCents)}
												</TotalRow>
											) : null}
											{order.tipCents ? (
												<TotalRow
													label={
														order.tipPercent
															? _(msg`Tip (${tipPercent}%)`)
															: _(msg`Tip`)
													}
												>
													{money(order.tipCents)}
												</TotalRow>
											) : null}
											<tr aria-hidden="true">
												<td colSpan={3} className="py-1">
													<Separator variant="dashed" />
												</td>
											</tr>
										</>
									) : null}
									<tr className="text-base font-semibold">
										<td />
										<th
											scope="row"
											className="py-1.5 pe-3 text-start font-semibold"
										>
											<Trans>Total</Trans>
										</th>
										<td
											className="py-1.5 text-end tabular-nums"
											data-testid="order-total"
										>
											<bdi>{money(order.totalCents)}</bdi>
										</td>
									</tr>
								</tfoot>
							</table>
						</Section>
						<Separator variant="dashed" />

						<Section title={<Trans>Payment</Trans>} testId="order-payment">
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
								<dt className="text-muted-foreground">
									<Trans>Method</Trans>
								</dt>
								<dd>
									{order.paymentMethod === 'handoff'
										? _(msg`Pay at handoff`)
										: order.paymentProcessor
											? _(msg`Online (${processor})`)
											: _(msg`Online`)}
								</dd>
								<dt className="text-muted-foreground">
									<Trans>Status</Trans>
								</dt>
								<dd data-testid="order-payment-summary">
									{paid
										? _(msg`Paid ${totalMoney}`)
										: order.paymentStatus === 'failed'
											? _(msg`Payment failed. Nothing was charged.`)
											: order.paymentStatus === 'expired'
												? _(msg`Payment window expired before it was paid.`)
												: _(msg`Payment not yet received`)}
								</dd>
								{order.paidAt ? (
									<>
										<dt className="text-muted-foreground">
											<Trans>Paid at</Trans>
										</dt>
										<dd>{formatDateTime(order.paidAt, locale)}</dd>
									</>
								) : null}
							</dl>
						</Section>
						<Separator variant="dashed" />

						<Section title={<Trans>Activity</Trans>} testId="order-timeline">
							<ol className="flex flex-col gap-2 text-sm">
								{events.map((event) => (
									<li
										key={event.key}
										className="flex items-baseline justify-between gap-3"
									>
										<span>{event.label}</span>
										<span className="text-muted-foreground text-xs tabular-nums">
											{formatDateTime(event.at, locale)}
										</span>
									</li>
								))}
								{showUpdated ? (
									<li className="flex items-baseline justify-between gap-3">
										<span className="text-muted-foreground">
											<Trans>Last updated</Trans>
										</span>
										<span className="text-muted-foreground text-xs tabular-nums">
											{formatDateTime(order.updatedAt, locale)}
										</span>
									</li>
								) : null}
							</ol>
						</Section>
					</CardContent>
				</Card>
			</div>

			{canWrite && !closed ? (
				<footer
					className="bg-background/95 border-input sticky bottom-0 z-10 flex flex-col gap-3 border-t border-dashed py-3 backdrop-blur-sm"
					data-testid="order-actions"
				>
					{needsHandoffPayment ? (
						<label className="flex items-center gap-2 text-sm">
							<Checkbox
								checked={markPaid}
								onCheckedChange={(checked) => setMarkPaid(checked === true)}
							/>
							<Trans>I have received payment at handoff</Trans>
						</label>
					) : null}
					<div className="flex items-center justify-between gap-2">
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => setCancelOpen(true)}
						>
							<Trans>Cancel order</Trans>
						</Button>
						{next ? (
							<Button
								type="button"
								onClick={() => onUpdate(next, markPaid)}
								disabled={busy || (next === 'completed' && !paid && !markPaid)}
							>
								{primaryLabel}
							</Button>
						) : null}
					</div>
				</footer>
			) : null}

			<AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{_(msg`Cancel order ${orderNumber}?`)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{paid
								? _(
										msg`${totalMoney} was received for this order. Cancelling does not refund it: refund it separately with your payment processor.`,
									)
								: _(
										msg`No payment has been received, so there is nothing to refund. The order moves to Cancelled and cannot be reopened.`,
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep order</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() => {
								setCancelOpen(false)
								onUpdate('cancelled', false)
							}}
						>
							<Trans>Confirm cancellation</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function TotalRow({
	label,
	children,
}: {
	label: ReactNode
	children: ReactNode
}) {
	return (
		<tr>
			<td />
			<th
				scope="row"
				className="text-muted-foreground py-1 pe-3 text-start font-normal"
			>
				{label}
			</th>
			<td className="py-1 text-end tabular-nums">
				<bdi>{children}</bdi>
			</td>
		</tr>
	)
}
