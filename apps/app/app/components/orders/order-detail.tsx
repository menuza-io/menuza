import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ORDER_CANCEL_REASONS,
	type OrderRejectReason,
} from '@repo/common/restaurant-orders'
import { DEFAULT_SERVICE_FEE_LABEL } from '@repo/common/service-fee'
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
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Separator } from '@repo/ui/separator'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { SelectField } from '#app/components/staff/controls.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { useSettledFocus } from '#app/hooks/use-settled-focus.ts'
import { isRejectedOrder } from '#app/utils/orders/acceptance.ts'
import {
	CLOSED_ORDER_STATUSES,
	WAITING_ORDER_STATUS,
	formatDateTime,
	appliedDiscounts,
	formatMoney,
	initialsOf,
	isPaymentNotRequired,
	localizedName,
	MAX_PROMISED_DELAY_MINUTES,
	nextOrderStatus,
	PUSH_BACK_MINUTES,
	PUSHABLE_ORDER_STATUSES,
	type PushBackMinutes,
	type AppliedOrderDiscount,
	type Order,
	type OrderRefundBody,
	paymentDisplayStatus,
	providerRefundableCents,
	refundableCents,
	relativeTime,
} from '#app/utils/orders/order-model.ts'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { AcceptanceCountdown, RejectOrderDialog } from './acceptance.tsx'
import { OrderStatusLabel, PaymentStatusLabel } from './order-status.tsx'
import {
	ProviderRefundDialog,
	type ProviderRefundOutcome,
} from './provider-refund-dialog.tsx'
import { RecordOrderRefundDialog } from './record-order-refund-dialog.tsx'
import {
	CANCEL_REASON_LABELS,
	CANCELLED_BY_LABELS,
	REFUND_FAILURE_FALLBACK,
	REFUND_FAILURE_LABELS,
} from './refund-labels.ts'

/** What the cancel dialog sends with the cancellation. */
export type CancelOptions = {
	cancelReason: (typeof ORDER_CANCEL_REASONS)[number]
	refund: 'none' | 'full'
}

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
	headingId,
}: {
	title: ReactNode
	children: ReactNode
	testId?: string
	headingId?: string
}) {
	return (
		<section className="flex flex-col gap-3" data-testid={testId}>
			<h2 id={headingId} className="text-sm font-semibold">
				{title}
			</h2>
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

function promisedClock(
	iso: string,
	locale: string,
	timeZone: string | undefined,
): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	try {
		return new Intl.DateTimeFormat(locale, {
			timeStyle: 'short',
			timeZone,
		}).format(date)
	} catch {
		return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date)
	}
}

/**
 * One order, read top to bottom: what it is and where it stands, who it is
 * for, how it gets to them, what is in it, what it costs, how it was paid.
 * Actions sit in a footer that stays in reach; recording a refund sits with
 * the payment, because a closed order can still give money back.
 */
export function OrderDetail({
	order,
	orgSlug,
	canWrite,
	canViewCustomers,
	canRefund = false,
	busy,
	notice,
	onUpdate,
	onAccept,
	onReject,
	onRecordRefund,
	onReload,
	onPushBack,
	backHref,
}: {
	order: Order
	orgSlug: string
	canWrite: boolean
	canViewCustomers: boolean
	/** Holds the order refund permission: provider refunds are offered. */
	canRefund?: boolean
	busy: boolean
	/** The answer to the last action (for example the refund of a cancel). */
	notice?: string | null
	onUpdate: (status: string, markPaid: boolean, cancel?: CancelOptions) => void
	/** Accepts a waiting order (manual acceptance). */
	onAccept?: () => void
	/** Rejects a waiting order with a reason; a paid online order is refunded. */
	onReject?: (reason: OrderRejectReason) => void
	/** Records money returned at the counter (pay at handoff orders only). */
	onRecordRefund?: (
		body: OrderRefundBody,
		idempotencyKey: string,
	) => Promise<void>
	/** Loads the order again, when a refund answer shows it changed. */
	onReload?: () => void
	/** Pushes the promised time back; omit to hide the control. */
	onPushBack?: (delayMinutes: PushBackMinutes) => Promise<void>
	backHref: string
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [markPaid, setMarkPaid] = useState(false)
	const [cancelOpen, setCancelOpen] = useState(false)
	const [rejectOpen, setRejectOpen] = useState(false)
	const [refundOpen, setRefundOpen] = useState(false)
	const [providerRefundOpen, setProviderRefundOpen] = useState(false)
	const [refundNotice, setRefundNotice] = useState<string | null>(null)
	const [cancelReason, setCancelReason] = useState('')
	const [cancelRefund, setCancelRefund] = useState<'none' | 'full'>('full')
	const [pushing, setPushing] = useState(false)
	const [pushError, setPushError] = useState<string | null>(null)
	// A full refund removes the Record a refund button.
	const refundFocus = useSettledFocus('order-payment-heading')
	const money = (cents: number) => formatMoney(cents, order.currency, locale)
	const totalMoney = money(order.totalCents)
	const tipPercent = order.tipPercent ?? 0
	const processor = order.paymentProcessor ?? ''
	const orderNumber = order.number
	const next = nextOrderStatus(order.status)
	const closed = CLOSED_ORDER_STATUSES.includes(order.status)
	const waiting = order.status === WAITING_ORDER_STATUS
	// Accept and Reject leave with the waiting banner, and focus would fall to
	// the page: bring it to the order's heading, unless it is already elsewhere.
	const headingRef = useRef<HTMLHeadingElement>(null)
	const wasWaiting = useRef(waiting)
	useEffect(() => {
		if (wasWaiting.current && !waiting) {
			const active = document.activeElement
			if (!active || active === document.body) headingRef.current?.focus()
		}
		wasWaiting.current = waiting
	}, [waiting])
	const rejected = isRejectedOrder(order)
	const rejectedReasonLabel = rejected
		? CANCEL_REASON_LABELS[
				order.rejectedReason || order.cancelReason || 'other'
			]
		: undefined
	const paid = order.paymentStatus === 'paid'
	const paymentNotRequired = isPaymentNotRequired(order)
	const discounts = appliedDiscounts(order)
	const discountCents = order.discountCents ?? 0
	const deliveryDiscountCents = order.deliveryDiscountCents ?? 0
	const listedDiscountCents = discounts.reduce(
		(sum, discount) => sum + discount.amountMinor,
		0,
	)
	const listedDeliveryDiscountCents = discounts.reduce(
		(sum, discount) => sum + discount.deliveryAmountMinor,
		0,
	)
	// A table round is paid once, when its tab closes (QR ordering).
	const onTab = Boolean(order.tabId)
	const needsHandoffPayment =
		!onTab &&
		!paymentNotRequired &&
		order.paymentMethod === 'handoff' &&
		!paid &&
		next === 'completed'
	const paidOnline = paid && order.paymentMethod === 'online'
	const refundedCents = order.refundedCents ?? 0
	const refundedMoney = money(refundedCents)
	const paidAtHandoff = paid && order.paymentMethod === 'handoff'
	const disputed = order.disputed === true
	const refundPendingCents = order.refundPendingCents ?? 0
	const refundPending =
		refundPendingCents > 0 || order.refundStatus === 'pending'
	const refundFailed = order.refundStatus === 'failed' && !refundPending
	const refundableLeft = providerRefundableCents(order)
	// Pay at counter orders only record money handed back; online orders
	// are refunded through the payment provider.
	const canRecordRefund =
		canWrite &&
		Boolean(onRecordRefund) &&
		paidAtHandoff &&
		!onTab &&
		refundableCents(order) > 0
	const canProviderRefund =
		canWrite &&
		canRefund &&
		paidOnline &&
		!onTab &&
		!disputed &&
		!refundPending &&
		refundableLeft > 0
	const failureText = refundFailed
		? _(
				(order.refundFailureCode &&
					REFUND_FAILURE_LABELS[order.refundFailureCode]) ||
					REFUND_FAILURE_FALLBACK,
			)
		: null
	const refundPendingMoney = money(refundPendingCents)
	const cancelReasonLabel = order.cancelReason
		? CANCEL_REASON_LABELS[order.cancelReason]
		: undefined
	const cancelledByLabel = order.cancelledBy
		? CANCELLED_BY_LABELS[order.cancelledBy]
		: undefined
	const offerCancelRefund = canProviderRefund
	const cancelReasonOptions = ORDER_CANCEL_REASONS.map((value) => ({
		value,
		label: _(CANCEL_REASON_LABELS[value]!),
	}))
	const created = formatDateTime(order.createdAt, locale)
	const createdAgo = relativeTime(order.createdAt, locale)
	const profileHref = order.customerKey
		? customersHref(orgSlug, { personKey: order.customerKey })
		: null
	const name = order.contact.name

	const orderZone = order.timeZone ?? order.pickup?.timezone ?? undefined
	const promisedFrom = order.promisedAt
		? promisedClock(order.promisedAt, locale, orderZone)
		: ''
	const promisedTo = order.promisedUntil
		? promisedClock(order.promisedUntil, locale, orderZone)
		: ''
	const promisedLabel = !promisedFrom
		? null
		: promisedTo
			? _(msg`Arriving ${promisedFrom} to ${promisedTo}`)
			: order.fulfillment === 'delivery'
				? _(msg`Arriving around ${promisedFrom}`)
				: _(msg`Ready around ${promisedFrom}`)
	const delayLeft = MAX_PROMISED_DELAY_MINUTES - order.promisedDelayMinutes
	const canPushBack =
		canWrite &&
		Boolean(onPushBack) &&
		Boolean(promisedLabel) &&
		PUSHABLE_ORDER_STATUSES.includes(order.status)

	const pushBack = async (minutes: PushBackMinutes) => {
		if (!onPushBack || pushing) return
		setPushing(true)
		setPushError(null)
		try {
			await onPushBack(minutes)
		} catch (err) {
			const code = err instanceof OperatorRequestError ? err.code : ''
			if (code === 'stale_version') {
				onReload?.()
				setPushError(
					_(
						msg`This order changed on another screen. Check the new time and try again.`,
					),
				)
			} else if (code === 'delay_limit') {
				setPushError(_(msg`This order can't be pushed back any further.`))
			} else if (code === 'order_closed') {
				setPushError(_(msg`This order is finished, so its time can't change.`))
			} else {
				setPushError(
					_(msg`Unable to update this order. Refresh and try again.`),
				)
			}
		} finally {
			setPushing(false)
		}
	}

	const paymentExplanation =
		order.status === 'payment_review'
			? paid
				? _(
						msg`Payment arrived after the hold on this order ran out, so it was not confirmed automatically. The money was received: start preparing to honor the order, or cancel it, refund it through your payment processor and record the refund on this order.`,
					)
				: _(
						msg`This order needs a manual check before it goes ahead. Start preparing to accept it, or cancel it.`,
					)
			: null
	const reviewReasonNote =
		order.status === 'payment_review' &&
		order.reviewReason === 'discount_limit_exceeded'
			? _(
					msg`A discount on this order reached its use limit before the payment arrived. The customer was charged the discounted price, so honoring the order means accepting that overrun.`,
				)
			: null

	const timeline: Array<{
		key: string
		label: string
		at: string | null
		detail?: string | null
	}> = [
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
		...(order.refunds ?? []).map((refund) => {
			const amount = money(refund.amountCents)
			const provider = refund.kind === 'provider'
			const label = !provider
				? _(msg`Refund recorded: ${amount}`)
				: refund.status === 'pending'
					? _(msg`Refund pending: ${amount}`)
					: refund.status === 'failed'
						? _(msg`Refund failed: ${amount}`)
						: _(msg`Refunded to card: ${amount}`)
			const failure =
				provider && refund.status === 'failed'
					? _(
							(refund.failureCode &&
								REFUND_FAILURE_LABELS[refund.failureCode]) ||
								REFUND_FAILURE_FALLBACK,
						)
					: null
			return {
				key: `refund:${refund.id}`,
				label,
				at: refund.createdAt,
				detail: [failure, refund.note].filter(Boolean).join(' · ') || null,
			}
		}),
	]
	const events = timeline
		.filter((event) => event.at)
		.sort(
			(a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0),
		)
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
		!!order.loyaltyDiscountCents ||
		discountCents > 0 ||
		deliveryDiscountCents > 0 ||
		discounts.length > 0 ||
		!!order.taxCents ||
		!!order.tipCents ||
		!!order.serviceFeeCents ||
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
							<h1
								ref={headingRef}
								tabIndex={-1}
								className="text-2xl font-semibold tabular-nums outline-none"
							>
								<bdi dir="ltr">{order.number}</bdi>
							</h1>
							{paymentNotRequired ? (
								<Badge variant="secondary" data-testid="order-free-badge">
									<Trans>Free order</Trans>
								</Badge>
							) : null}
							{disputed ? (
								<Badge variant="destructive" data-testid="order-disputed-badge">
									<Trans>Disputed</Trans>
								</Badge>
							) : null}
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
									status={paymentDisplayStatus(order)}
									className="text-sm"
									testId="order-payment-status"
								/>
							</dd>
						</div>
						{rejected && rejectedReasonLabel ? (
							<div className="flex flex-col gap-1">
								<dt className="text-muted-foreground text-xs">
									<Trans>Cancelled</Trans>
								</dt>
								<dd data-testid="order-cancel-info">
									{order.cancelReason === 'not_accepted_in_time'
										? _(msg`Not accepted in time`)
										: (() => {
												const reason = _(rejectedReasonLabel)
												return _(msg`Rejected: ${reason}`)
											})()}
								</dd>
							</div>
						) : order.status === 'cancelled' &&
						  (cancelledByLabel || cancelReasonLabel) ? (
							<div className="flex flex-col gap-1">
								<dt className="text-muted-foreground text-xs">
									<Trans>Cancelled</Trans>
								</dt>
								<dd data-testid="order-cancel-info">
									{[
										cancelledByLabel ? _(cancelledByLabel) : null,
										cancelReasonLabel ? _(cancelReasonLabel) : null,
									]
										.filter(Boolean)
										.join(' · ')}
								</dd>
							</div>
						) : null}
					</dl>
				</div>
				{paymentExplanation ? (
					<p
						role="note"
						className="bg-destructive/10 text-foreground rounded-md p-3 text-sm"
						data-testid="order-review-note"
					>
						{paymentExplanation}
						{reviewReasonNote ? (
							<>
								{' '}
								<span data-testid="order-review-reason">
									{reviewReasonNote}
								</span>
							</>
						) : null}
					</p>
				) : null}
			</header>

			{waiting ? (
				<section
					className="border-warning/50 bg-warning/5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
					aria-label={_(msg`Waiting for you`)}
					data-testid="order-acceptance-banner"
				>
					<div className="flex flex-col gap-0.5">
						<p className="text-sm font-medium">
							<Trans>This order is waiting for you to accept it.</Trans>
						</p>
						<AcceptanceCountdown
							deadline={order.acceptanceDeadlineAt}
							className="text-warning text-sm tabular-nums"
						/>
					</div>
					{canWrite ? (
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={busy || !onReject}
								data-testid="order-reject"
								onClick={() => setRejectOpen(true)}
							>
								<Trans>Reject</Trans>
							</Button>
							<Button
								type="button"
								disabled={busy || !onAccept}
								data-testid="order-accept"
								onClick={() => onAccept?.()}
							>
								<Trans>Accept</Trans>
							</Button>
						</div>
					) : null}
				</section>
			) : null}

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
										: order.fulfillment === 'dine_in'
											? _(msg`At the table`)
											: _(msg`Pickup`)}
								</p>
								{order.table ? (
									<p
										data-testid="order-table"
										className="flex flex-wrap items-baseline gap-x-2"
									>
										<bdi>
											{(() => {
												const label = order.table.label
												return _(msg`Table ${label}`)
											})()}
										</bdi>
										<span className="text-muted-foreground">
											<Trans>Paid when the tab closes</Trans>
										</span>
									</p>
								) : null}
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
								{promisedLabel ? (
									<p data-testid="order-promised" className="font-medium">
										{promisedLabel}
									</p>
								) : null}
								{canPushBack ? (
									<div
										className="flex flex-col gap-2 pt-1"
										data-testid="order-push-back"
									>
										<div
											role="group"
											aria-label={_(msg`Push the promised time back`)}
											className="flex flex-wrap gap-2"
										>
											{PUSH_BACK_MINUTES.map((minutes) => (
												<Button
													key={minutes}
													type="button"
													variant="outline"
													size="sm"
													disabled={busy || pushing || minutes > delayLeft}
													onClick={() => void pushBack(minutes)}
												>
													{_(msg`+${minutes} min`)}
												</Button>
											))}
										</div>
										<p className="text-muted-foreground text-xs">
											{delayLeft <= 0
												? _(msg`This order can't be pushed back any further.`)
												: _(
														msg`Push the time back. The guest's page updates, and 10 minutes or more also sends them the new time.`,
													)}
										</p>
										{pushError ? (
											<p
												role="alert"
												className="text-destructive text-xs"
												data-testid="order-push-back-error"
											>
												{pushError}
											</p>
										) : null}
									</div>
								) : null}
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
												{line.options.length || line.variantNames?.length ? (
													<p className="text-muted-foreground text-xs">
														{[
															...(line.variantNames ?? []),
															...line.options.map((option) =>
																option.quantity > 1
																	? `${option.quantity} × ${localizedName(option.optionName, locale)}`
																	: localizedName(option.optionName, locale),
															),
														].join(', ')}
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
											{discounts.map((discount, index) => (
												<Fragment key={`${discount.discountId}-${index}`}>
													{discount.amountMinor > 0 ? (
														<TotalRow
															label={<DiscountLabel discount={discount} />}
															testId="order-discount-row"
														>
															{money(-discount.amountMinor)}
														</TotalRow>
													) : null}
													{discount.deliveryAmountMinor > 0 ? (
														<TotalRow
															label={
																<DiscountLabel discount={discount} delivery />
															}
															testId="order-delivery-discount-row"
														>
															{money(-discount.deliveryAmountMinor)}
														</TotalRow>
													) : null}
												</Fragment>
											))}
											{discountCents > listedDiscountCents ? (
												<TotalRow
													label={<Trans>Discount</Trans>}
													testId="order-discount-row"
												>
													{money(-(discountCents - listedDiscountCents))}
												</TotalRow>
											) : null}
											{deliveryDiscountCents > listedDeliveryDiscountCents ? (
												<TotalRow
													label={<Trans>Delivery discount</Trans>}
													testId="order-delivery-discount-row"
												>
													{money(
														-(
															deliveryDiscountCents -
															listedDeliveryDiscountCents
														),
													)}
												</TotalRow>
											) : null}
											{order.loyaltyDiscountCents ? (
												<TotalRow label={<Trans>Loyalty reward</Trans>}>
													{money(-order.loyaltyDiscountCents)}
												</TotalRow>
											) : null}
											{order.deliveryFeeCents ? (
												<TotalRow label={<Trans>Delivery fee</Trans>}>
													{money(order.deliveryFeeCents)}
												</TotalRow>
											) : null}
											{order.serviceFeeCents ? (
												<TotalRow
													label={
														order.serviceFeeLabel &&
														order.serviceFeeLabel !== DEFAULT_SERVICE_FEE_LABEL
															? order.serviceFeeLabel
															: _(msg`Service fee`)
													}
													testId="order-service-fee-row"
												>
													{money(order.serviceFeeCents)}
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

						<Section
							title={<Trans>Payment</Trans>}
							testId="order-payment"
							headingId="order-payment-heading"
						>
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
										: paymentNotRequired
											? _(msg`No payment needed`)
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
								{refundedCents > 0 ? (
									<>
										<dt className="text-muted-foreground">
											<Trans>Refunded</Trans>
										</dt>
										<dd data-testid="order-refunded">
											<bdi>{_(msg`${refundedMoney} of ${totalMoney}`)}</bdi>
										</dd>
									</>
								) : null}
								{refundPending ? (
									<>
										<dt className="text-muted-foreground">
											<Trans>Refund</Trans>
										</dt>
										<dd data-testid="order-refund-pending">
											<bdi>
												{_(msg`Refund pending (${refundPendingMoney})`)}
											</bdi>
										</dd>
									</>
								) : null}
								{refundFailed ? (
									<>
										<dt className="text-muted-foreground">
											<Trans>Refund</Trans>
										</dt>
										<dd
											className="text-destructive"
											data-testid="order-refund-failed"
										>
											<Trans>Refund failed.</Trans> {failureText}
										</dd>
									</>
								) : null}
							</dl>
							{disputed ? (
								<p
									role="note"
									className="text-muted-foreground text-sm"
									data-testid="order-disputed-note"
								>
									<Trans>
										The guest disputed this payment with their card issuer, so
										it cannot be refunded here until the dispute is settled.
									</Trans>
								</p>
							) : null}
							{canProviderRefund ? (
								<div className="flex flex-col items-start gap-1.5">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											setRefundNotice(null)
											setProviderRefundOpen(true)
										}}
										data-testid="order-provider-refund-open"
									>
										{refundFailed ? (
											<Trans>Try again</Trans>
										) : (
											<Trans>Refund</Trans>
										)}
									</Button>
									<p className="text-muted-foreground text-xs">
										<Trans>
											The money goes back to the guest's card through your
											payment provider.
										</Trans>
									</p>
								</div>
							) : null}
							{canRecordRefund ? (
								<div className="flex flex-col items-start gap-1.5">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											setRefundNotice(null)
											setRefundOpen(true)
										}}
										data-testid="order-refund-open"
									>
										<Trans>Record a refund</Trans>
									</Button>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Give the money back at the counter first, then record it
											here.
										</Trans>
									</p>
								</div>
							) : null}
							<p
								aria-live="polite"
								className="text-sm empty:hidden"
								data-testid="order-refund-notice"
							>
								{refundNotice ?? notice}
							</p>
						</Section>
						<Separator variant="dashed" />

						<Section title={<Trans>Activity</Trans>} testId="order-timeline">
							<ol className="flex flex-col gap-2 text-sm">
								{events.map((event) => (
									<li key={event.key} className="flex flex-col gap-0.5">
										<div className="flex items-baseline justify-between gap-3">
											<span>{event.label}</span>
											<span className="text-muted-foreground text-xs tabular-nums">
												{formatDateTime(event.at, locale)}
											</span>
										</div>
										{event.detail ? (
											<p className="text-muted-foreground text-xs wrap-anywhere">
												{event.detail}
											</p>
										) : null}
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

			{canWrite && !closed && !waiting ? (
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
							onClick={() => {
								setCancelReason('')
								setCancelRefund('full')
								setCancelOpen(true)
							}}
						>
							<Trans>Cancel order</Trans>
						</Button>
						{next ? (
							<Button
								type="button"
								onClick={() => onUpdate(next, markPaid)}
								disabled={
									busy ||
									(next === 'completed' &&
										!paid &&
										!paymentNotRequired &&
										!markPaid &&
										!onTab)
								}
							>
								{primaryLabel}
							</Button>
						) : null}
					</div>
				</footer>
			) : null}

			{waiting && canWrite ? (
				<RejectOrderDialog
					open={rejectOpen}
					onOpenChange={setRejectOpen}
					orderNumber={orderNumber}
					refundsGuest={paidOnline}
					busy={busy}
					onConfirm={(reason) => onReject?.(reason)}
				/>
			) : null}

			<AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{_(msg`Cancel order ${orderNumber}?`)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{offerCancelRefund
								? _(
										msg`${totalMoney} was received for this order. The order is cancelled right away. Choose whether the guest gets their money back.`,
									)
								: paidOnline
									? _(
											msg`${totalMoney} was received for this order. Cancelling does not refund it. The order moves to Cancelled and cannot be reopened.`,
										)
									: paid
										? _(
												msg`${totalMoney} was received for this order. Cancelling does not refund it: give the money back at the counter, then record the refund on this order.`,
											)
										: _(
												msg`No payment has been received, so there is nothing to refund. The order moves to Cancelled and cannot be reopened.`,
											)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="flex flex-col gap-4">
						<SelectField
							label={<Trans>Why is it cancelled?</Trans>}
							hint={_(
								msg`Saved on the order. The guest is told only when an item ran out or the kitchen is closed.`,
							)}
							id="order-cancel-reason"
							testId="order-cancel-reason"
							options={cancelReasonOptions}
							value={cancelReason}
							onValueChange={setCancelReason}
							placeholder={_(msg`Choose a reason`)}
						/>
						{offerCancelRefund ? (
							<fieldset className="flex flex-col gap-2">
								<legend className="mb-1 text-sm font-medium">
									<Trans>Refund the guest?</Trans>
								</legend>
								<RadioGroup
									value={cancelRefund}
									onValueChange={(next) =>
										setCancelRefund(next === 'none' ? 'none' : 'full')
									}
									data-testid="order-cancel-refund"
								>
									<label className="flex items-center gap-2 text-sm">
										<RadioGroupItem value="full" />
										<Trans>Full refund</Trans>
									</label>
									<label className="flex items-center gap-2 text-sm">
										<RadioGroupItem value="none" />
										<Trans>No refund</Trans>
									</label>
								</RadioGroup>
								{cancelRefund === 'full' ? (
									<p className="text-muted-foreground text-xs">
										<Trans>
											The money goes back to the guest's card through your
											payment provider. Card and payment provider fees are
											usually not returned to you.
										</Trans>
									</p>
								) : null}
							</fieldset>
						) : null}
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep order</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy || !cancelReason}
							onClick={() => {
								if (!cancelReason) return
								setCancelOpen(false)
								onUpdate('cancelled', false, {
									cancelReason: cancelReason as CancelOptions['cancelReason'],
									refund: offerCancelRefund ? cancelRefund : 'none',
								})
							}}
						>
							<Trans>Confirm cancellation</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{canWrite && canRefund && providerRefundOpen ? (
				<ProviderRefundDialog
					order={order}
					orgSlug={orgSlug}
					open
					onOpenChange={setProviderRefundOpen}
					onRefresh={() => onReload?.()}
					finalFocus={refundFocus.finalFocus}
					onDone={(outcome: ProviderRefundOutcome) => {
						refundFocus.settle()
						setProviderRefundOpen(false)
						setRefundNotice(
							outcome.delayed || outcome.refund.status === 'pending'
								? _(msg`Refund pending. It is still being processed.`)
								: outcome.refund.status === 'failed'
									? _(msg`Refund failed. You can try again.`)
									: _(msg`Refund sent to the guest's card.`),
						)
					}}
				/>
			) : null}

			{/* Stays open after a reload makes the order fully refunded, so the
			    answer that caused the reload is still on screen. */}
			{canWrite && refundOpen && onRecordRefund ? (
				<RecordOrderRefundDialog
					order={order}
					open
					onOpenChange={setRefundOpen}
					onSubmit={onRecordRefund}
					onStale={onReload}
					finalFocus={refundFocus.finalFocus}
					onRecorded={() => {
						refundFocus.settle()
						setRefundOpen(false)
						setRefundNotice(_(msg`Refund recorded.`))
					}}
				/>
			) : null}
		</div>
	)
}

function DiscountLabel({
	discount,
	delivery = false,
}: {
	discount: AppliedOrderDiscount
	delivery?: boolean
}) {
	const name = discount.name || undefined
	return (
		<>
			{delivery ? (
				<Trans>Delivery discount</Trans>
			) : (
				(name ?? <Trans>Discount</Trans>)
			)}
			{delivery && name ? ` · ${name}` : null}
			{discount.code ? (
				<>
					{' '}
					<bdi dir="ltr" className="font-mono text-xs">
						({discount.code})
					</bdi>
				</>
			) : null}
		</>
	)
}

function TotalRow({
	label,
	children,
	testId,
}: {
	label: ReactNode
	children: ReactNode
	testId?: string
}) {
	return (
		<tr data-testid={testId}>
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
