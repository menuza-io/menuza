import { type MessageDescriptor } from '@lingui/core'
import { msg, plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { toAsciiDigits } from '@repo/common/ascii-digits'
import { type KdsConfig } from '@repo/common/kds'
import {
	groupLinesByCourse,
	KITCHEN_HIGHLIGHT_ICON,
} from '@repo/common/kitchen-ticket'
import { DEFAULT_PACKAGING_FEE_LABEL } from '@repo/common/packaging-fee'
import {
	handoffNeedsPayment,
	onlineOrderInInbox,
	onlineOrdersSearchSince,
	POS_ONLINE_ORDERS_PHONE_DIGITS,
	POS_ONLINE_ORDERS_SEARCH_TEXT_MIN,
	POS_ONLINE_ORDERS_SEARCH_DAYS,
	type PosOnlineOrdersSearch,
	type PosOnlineOrdersSearchState,
	POS_ONLINE_ORDER_CANCEL_REASONS,
	type PosOnlineOrderCancelReason,
	type PosOnlineOrderCommand,
	type PosOnlineOrderDetail,
	type PosOnlineOrderSummary,
} from '@repo/common/pos-online-orders'
import { posStationControlsAllowed } from '@repo/common/pos-station-controls'
import { printAllowed } from '@repo/common/ticket-config'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { chime, chimeReady, unlockChime } from '../kitchen/chime.ts'
import { OrdersError } from './api.ts'
import { ControlsSheet } from './Controls.tsx'
import {
	acceptanceRemainingMs,
	ALERT_REPEAT_MS,
	countdownClock,
	inboxOrders,
	inboxSection,
	onlineOrderLate,
	refundCents,
	sectionCounts,
	unopenedOrders,
	waitingOrders,
	type OrderFilter,
} from './model.ts'
import { useOrders, type OrdersState } from './useOrders.ts'
import { createKitchenApi } from '~/apps/kitchen/api.ts'
import { demoKitchen } from '~/apps/kitchen/demo.ts'
import { type PosSettings } from '~/lib/config.ts'
import { menuText } from '~/lib/menu-text.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { type Session } from '~/lib/signin.ts'
import { fieldOf, useTickets } from '~/lib/tickets.ts'
import {
	Badge,
	Button,
	Checkbox,
	cn,
	IconButton,
	Input,
	Modal,
	Reveal,
	Segmented,
	Select,
} from '~/ui/primitives.tsx'

const CANCEL_REASON: Record<PosOnlineOrderCancelReason, MessageDescriptor> = {
	guest_request: msg`The guest asked to cancel`,
	out_of_stock: msg`Out of stock`,
	too_busy: msg`Too busy to make it`,
	duplicate: msg`Duplicate order`,
	other: msg`Something else`,
}

type OrderRejectReason = Extract<
	PosOnlineOrderCommand,
	{ action: 'reject' }
>['reason']
/** The reasons the region accepts when an order is rejected (typed against its contract). */
const ORDER_REJECT_REASONS = [
	'out_of_stock',
	'kitchen_closed',
	'too_busy',
	'other',
] as const satisfies readonly OrderRejectReason[]

/** What the operator picks when turning an order down, in plain words. */
const REJECT_REASON: Record<OrderRejectReason, MessageDescriptor> = {
	out_of_stock: msg`Out of stock`,
	kitchen_closed: msg`Kitchen closed`,
	too_busy: msg`Too busy to make it`,
	other: msg`Something else`,
}
/** Reasons an order can carry once turned down, including the system's. */
const REJECTED_REASON_LABEL: Record<string, MessageDescriptor> = {
	...REJECT_REASON,
	not_accepted_in_time: msg`Nobody answered in time`,
}

const HISTORY: Record<string, MessageDescriptor> = {
	opened: msg`Opened`,
	accepted: msg`Accepted`,
	rejected: msg`Rejected`,
	ready: msg`Marked ready`,
	handed_over: msg`Handed over`,
	paid: msg`Payment taken at handoff`,
	cancelled: msg`Cancelled`,
	refunded: msg`Refund recorded`,
	contact_viewed: msg`Contact shown`,
	reprinted: msg`Reprinted`,
}

type Preference = { sound: boolean }
const preferenceKey = (settings: PosSettings) =>
	`station.orders.view:${settings.tenantApiUrl}:${settings.slug}:${settings.locationId ?? ''}`
function readPreference(key: string): Preference {
	try {
		const raw = JSON.parse(
			localStorage.getItem(key) ?? 'null',
		) as Partial<Preference> | null
		// On unless someone turned it off: an order nobody hears is an order missed.
		return { sound: raw?.sound !== false }
	} catch {
		return { sound: true }
	}
}

export function Orders({
	settings,
	session,
	online,
	timeZone,
	businessName,
	onSignIn,
	renderHeader = (controls) => controls,
}: {
	renderHeader?: (controls?: React.ReactNode) => React.ReactNode
	settings: PosSettings
	session: Session | null
	online: boolean
	timeZone?: string
	businessName: string
	onSignIn: () => void
}) {
	const { _, i18n } = useLingui()
	const kitchenSwitches = useKitchenPrintSwitches(settings, session)
	const reachable = online || settings.demo
	const orders = useOrders(settings, session, reachable)
	const { feed, error, stale, busy, now } = orders
	const [filter, setFilter] = useState<OrderFilter>({
		section: 'all',
		fulfillment: 'all',
		query: '',
	})
	const [preference, setPreference] = useState(() =>
		readPreference(preferenceKey(settings)),
	)
	const select = (patch: Partial<Preference>) => {
		const next = { ...preference, ...patch }
		setPreference(next)
		try {
			localStorage.setItem(preferenceKey(settings), JSON.stringify(next))
		} catch {
			/* device-local preference only */
		}
	}
	const time = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.locale, {
				hour: 'numeric',
				minute: '2-digit',
				...(timeZone ? { timeZone } : {}),
			}),
		[i18n.locale, timeZone],
	)
	const list = useMemo(
		() => (feed ? inboxOrders(feed.orders, filter, now) : []),
		[feed, filter, now],
	)
	const counts = useMemo(() => sectionCounts(feed?.orders ?? []), [feed])
	const waitingCount = counts.waiting
	const newCount = counts.new
	const progressCount = counts.in_progress
	const readyCount = counts.ready
	const openCount = waitingCount + newCount + progressCount + readyCount
	const waiting = useMemo(
		() => (feed ? unopenedOrders(feed.orders, orders.openedHere) : []),
		[feed, orders.openedHere],
	)
	// Orders that need a decision keep the alert ringing until someone accepts or rejects them.
	const deciding = useMemo(
		() => (feed ? waitingOrders(feed.orders) : []),
		[feed],
	)
	const [searching, setSearching] = useState(false)
	const [controlling, setControlling] = useState(false)
	// Pause and sold out: a signed-in manager only (the region refuses anyone else).
	const mayControl = session !== null && posStationControlsAllowed(session)

	// The alert repeats while any new order waits to be opened, on every tablet
	// here: opening it anywhere silences it everywhere at the next read.
	const waitingKey = [...waiting, ...deciding]
		.map((order) => order.id)
		.join(',')
	const [soundBlocked, setSoundBlocked] = useState(false)
	const ringing = waitingKey !== '' && preference.sound
	// Rings at once only for an order that was not waiting before: one opened
	// at another counter shrinks the list, and that is not news.
	const heard = useRef<ReadonlySet<string>>(new Set())
	useEffect(() => {
		const ids = new Set(waitingKey ? waitingKey.split(',') : [])
		const arrived = [...ids].some((id) => !heard.current.has(id))
		heard.current = ids
		if (arrived && preference.sound) {
			chime()
			setSoundBlocked(!chimeReady())
		}
	}, [waitingKey, preference.sound])
	useEffect(() => {
		if (!ringing) return
		const timer = window.setInterval(() => {
			chime()
			setSoundBlocked(!chimeReady())
		}, ALERT_REPEAT_MS)
		return () => window.clearInterval(timer)
	}, [ringing])
	// iPad Safari plays sound only after a tap on this page load.
	useEffect(() => {
		if (!preference.sound) return
		const events = ['pointerup', 'touchend', 'click', 'keydown'] as const
		const stop = () =>
			events.forEach((name) => document.removeEventListener(name, wake))
		function wake() {
			unlockChime()
			if (chimeReady()) {
				setSoundBlocked(false)
				stop()
			}
		}
		events.forEach((name) => document.addEventListener(name, wake))
		return stop
	}, [preference.sound])

	const offline = !reachable || stale
	const needsSignIn =
		error?.code === 'staff_session_required' ||
		error?.code === 'staff_session_invalid'
	const errorMessage = needsSignIn
		? _(t`Sign in online to see online orders.`)
		: error?.code === 'orders_needs_location'
			? _(
					t`Bind this terminal to a location in Settings → Terminals in the App.`,
				)
			: error?.code === 'orders_needs_sign_in'
				? _(
						t`Turn on staff sign-in for this terminal in the App to use Orders.`,
					)
				: error?.code === 'orders_not_enabled'
					? _(t`Orders is switched off for this terminal in the App.`)
					: _(
							t`Online orders are not connected. Check the connection and refresh. Actions are paused.`,
						)

	return (
		<main
			aria-label={_(t`Online orders`)}
			className="flex min-h-0 flex-1 flex-col"
		>
			{renderHeader(
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<h2 className="sr-only">
						<Trans>Online orders</Trans>
					</h2>
					<Segmented
						label={_(t`Orders view`)}
						wrap={false}
						value={filter.section}
						onChange={(section) => setFilter({ ...filter, section })}
						options={[
							{ value: 'all', label: _(t`All open ${openCount}`) },
							...(waitingCount > 0 || filter.section === 'waiting'
								? [
										{
											value: 'waiting' as const,
											label: _(t`Waiting for you ${waitingCount}`),
										},
									]
								: []),
							{ value: 'new', label: _(t`New ${newCount}`) },
							{
								value: 'in_progress',
								label: _(t`In progress ${progressCount}`),
							},
							{ value: 'ready', label: _(t`Ready ${readyCount}`) },
							{ value: 'done', label: _(t`Done`) },
						]}
					/>
					<Select
						aria-label={_(t`Order type`)}
						className="h-11"
						containerClassName="w-36"
						value={filter.fulfillment}
						onChange={(event) =>
							setFilter({
								...filter,
								fulfillment: event.target.value as OrderFilter['fulfillment'],
							})
						}
					>
						<option value="all">{_(t`All types`)}</option>
						<option value="pickup">{_(t`Pickup`)}</option>
						<option value="delivery">{_(t`Delivery`)}</option>
						<option value="dine_in">{_(t`Dine in`)}</option>
					</Select>
					<Input
						type="search"
						aria-label={_(t`Find an order by number or name`)}
						placeholder={_(t`Number or name`)}
						className="h-11 w-44"
						value={filter.query}
						onChange={(event) =>
							setFilter({ ...filter, query: event.target.value })
						}
					/>
					<div
						role="status"
						className={cn(
							'me-auto flex items-center gap-2 text-sm',
							offline ? 'text-warning' : 'text-muted-foreground',
						)}
					>
						<span
							className={cn(
								'size-2 shrink-0 rounded-full',
								offline ? 'bg-warning' : 'bg-success',
							)}
							aria-hidden
						/>
						<span className="max-2xl:sr-only">
							{offline
								? _(t`Updates paused`)
								: settings.demo
									? _(t`Demo mode · nothing leaves this tablet`)
									: _(t`Live · refreshes every 5 seconds`)}
						</span>
					</div>
					{mayControl ? (
						<IconButton
							label={_(t`Pause and sold out`)}
							onClick={() => setControlling(true)}
						>
							<Icon name="sliders-horizontal" className="size-5" />
						</IconButton>
					) : null}
					<IconButton
						label={_(t`Search orders`)}
						onClick={() => setSearching(true)}
					>
						<Icon name="search" className="size-5" />
					</IconButton>
					<IconButton
						label={_(t`Sound for new orders`)}
						aria-pressed={preference.sound}
						className={cn(
							preference.sound && 'bg-secondary text-secondary-foreground',
						)}
						onClick={() => {
							const sound = !preference.sound
							select({ sound })
							if (sound) chime()
						}}
					>
						<Icon
							name={preference.sound ? 'bell-ring' : 'bell'}
							className="size-5"
						/>
					</IconButton>
					<IconButton
						label={_(t`Refresh orders`)}
						onClick={() => void orders.refresh()}
						disabled={!reachable || busy}
					>
						<Icon name="refresh-cw" className="size-5" />
					</IconButton>
				</div>,
			)}
			<Reveal open={deciding.length > 0}>
				<section
					aria-label={_(t`Orders waiting for you`)}
					className="notice-danger flex flex-wrap items-center gap-3 px-5 py-3"
				>
					<Icon name="bell-ring" className="size-5 shrink-0" />
					<p role="alert" className="min-w-0 flex-1 font-semibold">
						{deciding.length === 1
							? _(
									t`Order ${deciding[0]!.number} is waiting for you · accept or reject it`,
								)
							: _(
									t`${deciding.length} orders are waiting for you · accept or reject each one`,
								)}
					</p>
					{soundBlocked && preference.sound ? (
						<Button
							variant="outline"
							onClick={() => {
								unlockChime()
								chime()
								setSoundBlocked(!chimeReady())
							}}
						>
							<Icon name="bell-ring" className="size-4" />
							<Trans>Turn on sound</Trans>
						</Button>
					) : null}
					{deciding.slice(0, 3).map((order) => (
						<Button
							key={order.id}
							variant="primary"
							onClick={() => void orders.open(order.id)}
						>
							<Trans>Review {order.number}</Trans>
						</Button>
					))}
				</section>
			</Reveal>
			<Reveal open={waiting.length > 0}>
				<section
					aria-label={_(t`New orders waiting`)}
					className="notice-danger flex flex-wrap items-center gap-3 px-5 py-3"
				>
					<Icon name="bell-ring" className="size-5 shrink-0" />
					{/* The live region holds the text itself: a label would be read instead. */}
					<p role="alert" className="min-w-0 flex-1 font-semibold">
						{waiting.length === 1
							? _(
									t`New order ${waiting[0]!.number} · open it to stop the alert`,
								)
							: _(
									t`${waiting.length} new orders · open each one to stop the alert`,
								)}
						{soundBlocked && preference.sound ? (
							<span className="block text-sm font-normal">
								<Trans>Tap anywhere to let this tablet play the alert.</Trans>
							</span>
						) : null}
					</p>
					{waiting.slice(0, 3).map((order) => (
						<Button
							key={order.id}
							variant="primary"
							onClick={() => void orders.open(order.id)}
						>
							<Trans>Open {order.number}</Trans>
						</Button>
					))}
				</section>
			</Reveal>
			<Reveal open={Boolean(error) || Boolean(feed && offline)}>
				<div
					role="alert"
					className="notice-warning flex flex-wrap items-center gap-3 px-5 py-3 text-sm"
				>
					<p className="min-w-0 flex-1">
						{error
							? errorMessage
							: _(
									t`Connection lost. These are the last orders received, not a live list. Reconnect before changing an order.`,
								)}
					</p>
					{needsSignIn ? (
						<Button onClick={onSignIn}>
							<Trans>Sign in again</Trans>
						</Button>
					) : (
						<Button
							onClick={() => void orders.refresh()}
							disabled={!reachable || busy}
						>
							<Trans>Try again</Trans>
						</Button>
					)}
				</div>
			</Reveal>
			{feed?.truncated ? (
				<p role="alert" className="notice-danger px-5 py-3">
					<Trans>
						There are more orders than this screen can show. Finish or cancel
						older orders in the App before relying on this list.
					</Trans>
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				{!feed ? (
					<p className="text-muted-foreground p-6 text-center">
						{error ? null : <Trans>Loading online orders…</Trans>}
					</p>
				) : list.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>
								<Trans>No orders here</Trans>
							</EmptyTitle>
							<EmptyDescription>
								<Trans>
									New web and QR orders for this location appear as they come
									in.
								</Trans>
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<ul className="grid [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))] gap-3">
						{list.map((order) => (
							<li key={order.id}>
								<OrderCard
									order={order}
									now={now}
									time={time}
									opened={orders.openedHere.has(order.id)}
									onOpen={() => void orders.open(order.id)}
								/>
							</li>
						))}
					</ul>
				)}
				{feed && feed.phonePickups.length > 0 && filter.section !== 'done' ? (
					<section
						aria-label={_(t`Phone orders awaiting pickup`)}
						className="mt-6"
					>
						<h3 className="mb-2 text-sm font-semibold">
							<Trans>Phone orders awaiting pickup</Trans>
						</h3>
						<ul className="divide-border border-border divide-y rounded-(--station-control-radius) border">
							{feed.phonePickups.map((phone) => (
								<li
									key={phone.id}
									className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm"
								>
									<span className="tnum font-semibold">{phone.number}</span>
									{phone.guestName ? <bdi>{phone.guestName}</bdi> : null}
									<span className="text-muted-foreground me-auto">
										{phone.pickupAt
											? _(t`Pickup ${time.format(phone.pickupAt)}`)
											: null}
									</span>
									<span className="tnum">
										{moneyFormatter(phone.currency)(phone.totalCents)}
									</span>
								</li>
							))}
						</ul>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>Take payment for phone orders in Register, Orders.</Trans>
						</p>
					</section>
				) : null}
			</div>
			{mayControl ? (
				<ControlsSheet
					open={controlling}
					onClose={() => setControlling(false)}
					api={orders.api}
					online={reachable}
					timeZone={timeZone}
				/>
			) : null}
			<SearchSheet
				open={searching}
				onClose={() => setSearching(false)}
				orders={orders}
				reachable={reachable}
				timeZone={timeZone}
				onPick={(order) => {
					setSearching(false)
					// Only the inbox records an opening (and silences the alert).
					void (onlineOrderInInbox(order, orders.now)
						? orders.open(order.id)
						: orders.view(order.id))
				}}
			/>
			<OrderSheet
				orders={orders}
				stale={stale}
				time={time}
				businessName={businessName}
				kitchenSwitches={kitchenSwitches}
			/>
		</main>
	)
}

function OrderBadges({
	order,
	now,
	time,
}: {
	order: PosOnlineOrderSummary
	now: number
	time: Intl.DateTimeFormat
}) {
	const { _ } = useLingui()
	const late = onlineOrderLate(order, now)
	return (
		<div className="flex flex-wrap gap-1.5">
			{inboxSection(order) === 'waiting' ? (
				<Badge tone="danger">
					<Trans>Waiting for you</Trans>
				</Badge>
			) : null}
			{inboxSection(order) === 'new' ? (
				<Badge tone="danger">
					<Trans>New</Trans>
				</Badge>
			) : null}
			{late ? (
				<Badge tone="danger">
					<Trans>Late</Trans>
				</Badge>
			) : null}
			<Badge tone="primary">
				{order.channel === 'qr' ? _(t`QR`) : _(t`Web`)}
			</Badge>
			<Badge>
				{order.fulfillment === 'delivery'
					? _(t`Delivery`)
					: order.fulfillment === 'dine_in'
						? order.tableLabel
							? _(t`Table ${order.tableLabel}`)
							: _(t`Dine in`)
						: _(t`Pickup`)}
			</Badge>
			<Badge tone={order.paymentStatus === 'paid' ? 'success' : 'warning'}>
				{order.onTab
					? _(t`On the tab`)
					: order.paymentStatus === 'paid'
						? _(t`Paid`)
						: order.paymentStatus === 'not_required'
							? _(t`Nothing to pay`)
							: _(t`Pay at handoff`)}
			</Badge>
			{order.disputed ? (
				<Badge tone="danger">
					<Trans>Disputed</Trans>
				</Badge>
			) : null}
			{order.refundStatus === 'pending' ? (
				<Badge tone="warning">
					<Trans>Refund pending</Trans>
				</Badge>
			) : order.refundStatus === 'failed' ? (
				<Badge tone="danger">
					<Trans>Refund failed</Trans>
				</Badge>
			) : order.refundStatus === 'full' ? (
				<Badge tone="muted">
					<Trans>Refunded</Trans>
				</Badge>
			) : order.refundStatus === 'partial' ? (
				<Badge tone="muted">
					<Trans>Partly refunded</Trans>
				</Badge>
			) : null}
			<Badge tone={late ? 'danger' : 'muted'}>
				{order.dueAt
					? _(t`Due ${time.format(order.dueAt)}`)
					: _(t`As soon as possible`)}
			</Badge>
		</div>
	)
}

/** Paid online (not at handoff, not on a table tab): a refund goes through the payment provider. */
function isPaidOnline(order: PosOnlineOrderSummary): boolean {
	return (
		order.paymentMethod === 'online' &&
		order.paymentStatus === 'paid' &&
		!order.onTab
	)
}

const STATUS: Record<PosOnlineOrderSummary['status'], MessageDescriptor> = {
	pending_acceptance: msg`Waiting for you`,
	accepted: msg`Accepted`,
	preparing: msg`Preparing`,
	ready: msg`Ready`,
	completed: msg`Handed over`,
	cancelled: msg`Cancelled`,
}

/** "Accept within 3:12", then "Time is up" once the deadline has passed. */
function AcceptanceCountdown({
	order,
	now,
	className,
}: {
	order: Pick<PosOnlineOrderSummary, 'acceptanceDeadlineAt'>
	now: number
	className?: string
}) {
	const { _ } = useLingui()
	const remaining = acceptanceRemainingMs(order, now)
	if (remaining === null) return null
	const over = remaining <= 0
	return (
		<span
			className={cn(
				'tnum text-sm font-semibold',
				over ? 'text-destructive' : 'text-foreground',
				className,
			)}
		>
			{over
				? _(t`Time is up`)
				: _(t`Accept within ${countdownClock(remaining)}`)}
		</span>
	)
}

function OrderCard({
	order,
	now,
	time,
	opened,
	onOpen,
}: {
	order: PosOnlineOrderSummary
	now: number
	time: Intl.DateTimeFormat
	opened: boolean
	onOpen: () => void
}) {
	const { _ } = useLingui()
	const late = onlineOrderLate(order, now)
	const isNew = inboxSection(order) === 'new' && !opened
	const isWaiting = inboxSection(order) === 'waiting'
	return (
		<article
			aria-label={_(t`Order ${order.number}`)}
			className={cn(
				'bg-card border-border flex h-full flex-col gap-2 rounded-(--station-control-radius) border p-3',
				late && 'border-destructive border-2',
				(isNew || isWaiting) && 'ring-destructive ring-2',
			)}
		>
			<div className="flex items-baseline justify-between gap-2">
				<span className="tnum text-xl font-semibold">{order.number}</span>
				<span className="text-muted-foreground text-sm">
					{_(STATUS[order.status])}
				</span>
			</div>
			<bdi className="truncate font-medium">{order.guestName}</bdi>
			{isWaiting ? <AcceptanceCountdown order={order} now={now} /> : null}
			{order.rejectedReason ? (
				<span className="text-muted-foreground text-sm">
					{_(t`Rejected: ${rejectedReasonText(_, order.rejectedReason)}`)}
				</span>
			) : null}
			<OrderBadges order={order} now={now} time={time} />
			<div className="text-muted-foreground mt-auto flex items-center justify-between text-sm">
				<span>{_(t`${order.itemCount} items`)}</span>
				<span className="tnum">
					{moneyFormatter(order.currency)(order.totalCents)}
				</span>
			</div>
			<Button
				variant={isNew || isWaiting ? 'primary' : 'outline'}
				onClick={onOpen}
			>
				{isWaiting ? <Trans>Review</Trans> : <Trans>Open</Trans>}
			</Button>
		</article>
	)
}

function rejectedReasonText(
	_: (descriptor: MessageDescriptor) => string,
	reason: string,
): string {
	const label = REJECTED_REASON_LABEL[reason]
	return label ? _(label) : reason
}

function actionMessage(
	_: (descriptor: MessageDescriptor) => string,
	error: OrdersError,
	money?: (cents: number) => string,
	/** The order had been waiting for acceptance and no longer is. */
	decidedElsewhere = false,
): string {
	switch (error.code) {
		case 'order_not_pending':
			return _(
				msg`Someone else already decided on this order. It was read again.`,
			)
		case 'stale_version':
			if (decidedElsewhere)
				return _(
					msg`Someone else already decided on this order. It was read again.`,
				)
			return _(
				msg`This order changed on another screen. Check it, then try again.`,
			)
		case 'payment_required':
			return _(msg`Record the payment taken at handoff first.`)
		case 'permission_required':
			return _(msg`You do not have permission to do that.`)
		case 'loyalty_refund_forbidden':
			return _(
				msg`This refund takes loyalty points back. Do it in the App, where a manager with the loyalty permission can approve it.`,
			)
		case 'refund_exceeds_payment':
			return money && error.refundableCents !== undefined
				? _(
						msg`That is more than is left to refund. At most ${money(error.refundableCents)} can be refunded.`,
					)
				: _(msg`That is more than is left to refund.`)
		case 'refund_pending':
			return _(
				msg`A refund for this order is already on its way. Wait until it finishes before refunding again.`,
			)
		case 'payment_disputed':
			return _(
				msg`The guest disputed this payment with their bank, so it cannot be refunded here. Handle it in your payment provider's dashboard.`,
			)
		case 'order_not_refundable':
			return _(msg`There is nothing to refund on this order.`)
		case 'refund_complete':
			return _(msg`This order is already fully refunded.`)
		case 'invalid_transition':
			return _(msg`This order cannot do that any more.`)
		case 'tab_settlement_required':
			return _(
				msg`This order is on a table tab. Close the tab to take payment.`,
			)
		case 'connection_lost':
			return _(
				msg`The connection dropped. The order was read again: check it before trying again.`,
			)
		default:
			return _(msg`That did not work. The order was read again.`)
	}
}

function refundOutcomeMessage(
	_: (descriptor: MessageDescriptor) => string,
	outcome: { started: boolean; code: string | null },
): string {
	if (outcome.started)
		return _(
			msg`The order is cancelled and the refund has started. The money goes back to the guest's card.`,
		)
	switch (outcome.code) {
		case 'payment_disputed':
			return _(
				msg`The order is cancelled, but the payment is disputed, so it was not refunded.`,
			)
		case 'refund_pending':
			return _(
				msg`The order is cancelled. A refund for it was already on its way.`,
			)
		case 'refund_complete':
			return _(msg`The order is cancelled. It was already fully refunded.`)
		case 'loyalty_refund_forbidden':
			return _(
				msg`The order is cancelled, but not refunded: this refund takes loyalty points back. Refund it in the App.`,
			)
		default:
			return _(
				msg`The order is cancelled, but the refund did not start. Open the order and try Refund.`,
			)
	}
}

function rejectOutcomeMessage(
	_: (descriptor: MessageDescriptor) => string,
	outcome: { started: boolean; code: string | null },
): string {
	if (outcome.started)
		return _(
			msg`The order is rejected and the guest is being refunded in full. The money goes back to their card.`,
		)
	switch (outcome.code) {
		case 'payment_disputed':
			return _(
				msg`The order is rejected, but the payment is disputed, so it was not refunded.`,
			)
		case 'refund_pending':
		case 'refund_complete':
			return _(msg`The order is rejected. It was already refunded.`)
		default:
			return _(
				msg`The order is rejected, but the refund did not start. Open the order and try Refund.`,
			)
	}
}

export type KitchenPrintSwitches = Pick<
	KdsConfig,
	'showPaymentStatus' | 'showOrderTypeColor' | 'showModifierGroups'
>

function useKitchenPrintSwitches(
	settings: PosSettings,
	session: Session | null,
): KitchenPrintSwitches {
	const [switches, setSwitches] = useState<KitchenPrintSwitches>({
		showPaymentStatus: false,
		showOrderTypeColor: false,
		showModifierGroups: false,
	})
	useEffect(() => {
		let cancelled = false
		const api = settings.demo
			? demoKitchen
			: createKitchenApi(settings, session)
		void api.feed().then(
			(feed) => {
				if (cancelled) return
				setSwitches({
					showPaymentStatus: feed.config.showPaymentStatus === true,
					showOrderTypeColor: feed.config.showOrderTypeColor === true,
					showModifierGroups: feed.config.showModifierGroups === true,
				})
			},
			() => {
				/* A missed kitchen config leaves the switches off. */
			},
		)
		return () => {
			cancelled = true
		}
	}, [settings, session])
	return switches
}

function OrderSheet({
	orders,
	stale,
	time,
	businessName,
	kitchenSwitches,
}: {
	orders: OrdersState
	stale: boolean
	time: Intl.DateTimeFormat
	businessName: string
	kitchenSwitches: KitchenPrintSwitches
}) {
	const { _ } = useLingui()
	const {
		detail,
		grants,
		busy,
		actionError,
		actionName,
		pinActionError,
		selected,
		contact,
		refundOutcome,
	} = orders
	const [markPaid, setMarkPaid] = useState(false)
	const [cancelling, setCancelling] = useState(false)
	const [rejecting, setRejecting] = useState(false)
	const [refunding, setRefunding] = useState(false)
	const [printing, setPrinting] = useState<
		'guest' | 'kitchen' | 'cancelled' | null
	>(null)
	// What this location prints, and when (#363).
	const ticketSettings = useTickets()
	/** Prints the kitchen ticket by itself when the owner chose this moment for it. */
	const autoPrint = (moment: 'on_acceptance' | 'when_ready') => {
		if (
			detail &&
			ticketSettings.when.kitchen === moment &&
			printAllowed(ticketSettings, detail.fulfillment)
		)
			setPrinting('kitchen')
	}
	/** A cancelled or rejected order prints its slip at once when the owner asked. */
	const autoPrintSlip = () => {
		if (
			detail &&
			ticketSettings.cancellationSlip &&
			printAllowed(ticketSettings, detail.fulfillment)
		)
			setPrinting('cancelled')
	}
	// Each order starts unticked: payment is confirmed for this order, not the last.
	useEffect(() => {
		setMarkPaid(false)
		setCancelling(false)
		setRejecting(false)
		setRefunding(false)
	}, [selected])
	const recordReprint = useRef(orders.recordReprint)
	recordReprint.current = orders.recordReprint
	useEffect(() => {
		if (!printing) return
		const frame = window.requestAnimationFrame(() => {
			window.print()
			recordReprint.current(printing === 'cancelled' ? 'kitchen' : printing)
			setPrinting(null)
		})
		return () => window.cancelAnimationFrame(frame)
	}, [printing])

	const money = moneyFormatter(detail?.currency ?? 'USD')
	const done = detail?.status === 'completed' || detail?.status === 'cancelled'
	const needsPayment = detail ? handoffNeedsPayment(detail) : false
	// Found by search and past the inbox: read here, changed only in the App.
	const readOnly = detail ? !onlineOrderInInbox(detail, orders.now) : false
	const locked = busy || stale || !detail
	const paidOnline = detail ? isPaidOnline(detail) : false
	const waitingForDecision = detail?.status === 'pending_acceptance'
	// Only a failed accept or reject can mean another screen decided first. An
	// order that once waited keeps `acceptanceDeadlineAt`, so that alone says
	// nothing about a later command (Mark ready, Hand over).
	const decidedElsewhere =
		(actionName === 'accept' || actionName === 'reject') &&
		detail != null &&
		detail.status !== 'pending_acceptance'
	// A dialog shows the error itself: keep it up until the dialog closes.
	const dialogOpen = rejecting || cancelling || refunding
	useEffect(() => {
		pinActionError(dialogOpen)
		return () => pinActionError(false)
	}, [dialogOpen, pinActionError])
	// Another screen decided while the reject dialog was open: close it, the
	// sheet behind explains what happened.
	const stillWaiting = detail?.status === 'pending_acceptance'
	useEffect(() => {
		if (rejecting && !stillWaiting) setRejecting(false)
	}, [rejecting, stillWaiting])
	return (
		<Modal
			open={selected !== null}
			onClose={orders.close}
			title={detail ? _(t`Order ${detail.number}`) : _(t`Order`)}
			size="lg"
			footer={
				detail && readOnly ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							This order finished more than four hours ago. It is shown for
							reference: record refunds and see the guest’s contact in the App.
						</Trans>
					</p>
				) : detail ? (
					<div className="flex w-full flex-col gap-3">
						{needsPayment && !done && !waitingForDecision && grants?.manage ? (
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={markPaid}
									onChange={(event) => setMarkPaid(event.target.checked)}
								/>
								<Trans>I have received payment at handoff</Trans>
							</label>
						) : null}
						<div className="flex flex-wrap items-center gap-2">
							{waitingForDecision && grants?.cancel ? (
								<Button
									variant="danger"
									disabled={locked}
									onClick={() => setRejecting(true)}
								>
									<Trans>Reject</Trans>
								</Button>
							) : null}
							{!done && !waitingForDecision && grants?.cancel ? (
								<Button
									variant="danger"
									disabled={locked}
									onClick={() => setCancelling(true)}
								>
									<Trans>Cancel order</Trans>
								</Button>
							) : null}
							{grants?.refund &&
							!waitingForDecision &&
							detail.refundableCents > 0 &&
							!detail.disputed ? (
								<Button
									variant="outline"
									disabled={locked || (detail.refundPendingCents ?? 0) > 0}
									onClick={() => setRefunding(true)}
								>
									{paidOnline ? (
										<Trans>Refund</Trans>
									) : (
										<Trans>Record refund</Trans>
									)}
								</Button>
							) : null}
							<Button
								variant="ghost"
								// A reprint is recorded on the order: only while connected.
								disabled={!detail || stale}
								onClick={() => setPrinting('guest')}
							>
								<Icon name="printer" className="size-4" />
								<Trans>Guest ticket</Trans>
							</Button>
							<Button
								variant="ghost"
								disabled={!detail || stale}
								onClick={() => setPrinting('kitchen')}
							>
								<Icon name="printer" className="size-4" />
								<Trans>Kitchen ticket</Trans>
							</Button>
							<span className="me-auto" />
							{waitingForDecision && grants?.manage ? (
								<Button
									variant="primary"
									disabled={locked}
									onClick={() =>
										void orders
											.command({
												action: 'accept',
												expectedVersion: detail.version,
											})
											.then((ok) => ok && autoPrint('on_acceptance'))
									}
								>
									<Trans>Accept order</Trans>
								</Button>
							) : null}
							{!done &&
							!waitingForDecision &&
							grants?.manage &&
							(detail.status === 'accepted' ||
								detail.status === 'preparing') ? (
								<Button
									variant="outline"
									disabled={locked}
									onClick={() =>
										void orders
											.command({
												action: 'ready',
												expectedVersion: detail.version,
											})
											.then((ok) => ok && autoPrint('when_ready'))
									}
								>
									<Trans>Mark ready</Trans>
								</Button>
							) : null}
							{!done && !waitingForDecision && grants?.manage ? (
								<Button
									variant="primary"
									disabled={locked || (needsPayment && !markPaid)}
									onClick={() =>
										void orders.command({
											action: 'handed_over',
											expectedVersion: detail.version,
											markPaid: needsPayment && markPaid,
										})
									}
								>
									<Trans>Hand over</Trans>
								</Button>
							) : null}
						</div>
					</div>
				) : null
			}
		>
			<div className="p-4 sm:p-5">
				{actionError ? (
					<p role="alert" className="notice-warning mb-3 px-4 py-2 text-sm">
						{actionMessage(_, actionError, money, decidedElsewhere)}
					</p>
				) : null}
				{refundOutcome && !actionError ? (
					<p
						role="status"
						className={cn(
							'mb-3 px-4 py-2 text-sm',
							refundOutcome.started ? 'notice-success' : 'notice-warning',
						)}
					>
						{detail?.rejectedReason
							? rejectOutcomeMessage(_, refundOutcome)
							: refundOutcomeMessage(_, refundOutcome)}
					</p>
				) : null}
				{stale && detail ? (
					<p role="status" className="notice-warning mb-3 px-4 py-2 text-sm">
						<Trans>
							Updates are paused. Reconnect before changing this order.
						</Trans>
					</p>
				) : null}
				{!detail ? (
					<p className="text-muted-foreground py-6 text-center">
						<Trans>Loading the order…</Trans>
					</p>
				) : (
					<OrderDetailBody
						detail={detail}
						contact={contact}
						canSeeContact={grants?.contact === true && !readOnly}
						onReveal={() => void orders.revealContact()}
						revealing={orders.revealing}
						now={orders.now}
						time={time}
						money={money}
					/>
				)}
			</div>
			{detail ? (
				<>
					<RejectDialog
						open={rejecting}
						number={detail.number}
						paidOnline={paidOnline}
						busy={busy}
						error={actionError}
						decidedElsewhere={decidedElsewhere}
						onClose={() => setRejecting(false)}
						onConfirm={async (reason) => {
							const ok = await orders.command({
								action: 'reject',
								expectedVersion: detail.version,
								reason,
							})
							if (ok) {
								setRejecting(false)
								autoPrintSlip()
							}
						}}
					/>
					<CancelDialog
						open={cancelling}
						number={detail.number}
						paid={detail.paymentStatus === 'paid' && !detail.onTab}
						canRefund={
							paidOnline &&
							grants?.refund === true &&
							!detail.disputed &&
							detail.refundableCents > 0 &&
							(detail.refundPendingCents ?? 0) === 0
						}
						refundableLabel={money(detail.refundableCents)}
						busy={busy}
						error={actionError}
						money={money}
						onClose={() => setCancelling(false)}
						onConfirm={async (reason, refund) => {
							const ok = await orders.command({
								action: 'cancel',
								expectedVersion: detail.version,
								reason,
								...(refund ? { refund } : {}),
							})
							if (ok) {
								setCancelling(false)
								autoPrintSlip()
							}
						}}
					/>
					<RefundDialog
						open={refunding}
						detail={detail}
						busy={busy}
						error={actionError}
						paidOnline={paidOnline}
						onClose={() => setRefunding(false)}
						onConfirm={async (refund, key) => {
							const ok = await orders.refund(
								{ ...refund, expectedVersion: detail.version },
								key,
							)
							if (ok) setRefunding(false)
						}}
					/>
				</>
			) : null}
			{printing && detail ? (
				<PrintedTicket
					kind={printing === 'guest' ? 'guest' : 'kitchen'}
					cancelled={printing === 'cancelled'}
					detail={detail}
					businessName={businessName}
					time={time}
					kitchenSwitches={kitchenSwitches}
				/>
			) : null}
		</Modal>
	)
}

function OrderDetailBody({
	detail,
	contact,
	canSeeContact,
	onReveal,
	revealing,
	now,
	time,
	money,
}: {
	detail: PosOnlineOrderDetail
	contact: { phone: string; email: string | null } | null
	canSeeContact: boolean
	onReveal: () => void
	revealing: boolean
	/** The server's time, as the inbox uses it. */
	now: number
	time: Intl.DateTimeFormat
	money: (cents: number) => string
}) {
	const { _ } = useLingui()
	return (
		<div className="flex flex-col gap-5">
			{detail.status === 'pending_acceptance' ? (
				<section
					aria-label={_(t`Waiting for you`)}
					className="notice-danger flex flex-col gap-1 px-4 py-3"
				>
					<p className="font-semibold">
						<Trans>This order is waiting for you</Trans>
					</p>
					<AcceptanceCountdown order={detail} now={now} />
					<p className="text-sm">
						{acceptanceRemainingMs(detail, now) !== null &&
						acceptanceRemainingMs(detail, now)! <= 0 ? (
							<Trans>
								The time to answer has passed. If nobody accepts it, the order
								is turned down automatically.
							</Trans>
						) : (
							<Trans>
								Accept it to send it to the kitchen, or reject it. If nobody
								answers in time, it is turned down automatically.
							</Trans>
						)}
					</p>
				</section>
			) : null}
			{detail.rejectedReason ? (
				<p
					role="status"
					className="notice-warning px-4 py-2 text-sm font-semibold"
				>
					{_(t`Rejected: ${rejectedReasonText(_, detail.rejectedReason)}`)}
				</p>
			) : null}
			<OrderBadges order={detail} now={now} time={time} />
			<section aria-label={_(t`Guest`)} className="flex flex-col gap-1">
				<bdi className="text-xl font-semibold">{detail.guestName}</bdi>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<span>
						<Trans>Phone</Trans>:{' '}
						<bdi dir="ltr" className="tnum">
							{contact ? contact.phone : detail.phoneMasked}
						</bdi>
					</span>
					{contact?.email ? (
						<span>
							<Trans>Email</Trans>: <bdi dir="ltr">{contact.email}</bdi>
						</span>
					) : null}
					{canSeeContact && !contact ? (
						<Button variant="ghost" onClick={onReveal} disabled={revealing}>
							<Trans>Show contact</Trans>
						</Button>
					) : null}
				</div>
			</section>
			{detail.delivery ? (
				<section aria-label={_(t`Delivery`)} className="text-sm">
					<h3 className="font-semibold">
						<Trans>Deliver to</Trans>
					</h3>
					<p>
						<bdi>
							{[
								detail.delivery.address,
								detail.delivery.unit,
								detail.delivery.city,
								detail.delivery.postalCode,
							]
								.filter(Boolean)
								.join(', ')}
						</bdi>
					</p>
					{detail.delivery.notes ? (
						<p className="text-muted-foreground">
							<bdi>{detail.delivery.notes}</bdi>
						</p>
					) : null}
				</section>
			) : null}
			{detail.utensilsRequested != null ||
			(detail.largeOrderExtraMinutes ?? 0) > 0 ||
			detail.largeOrder === true ? (
				<section
					aria-label={_(t`Packing`)}
					className="flex flex-col gap-1 text-sm font-medium"
				>
					{detail.utensilsRequested === true ? (
						<p>
							<Trans>Utensils: yes</Trans>
						</p>
					) : detail.utensilsRequested === false ? (
						<p>
							<Trans>No utensils</Trans>
						</p>
					) : null}
					{(detail.largeOrderExtraMinutes ?? 0) > 0 ? (
						<p>
							<Trans>Large order +{detail.largeOrderExtraMinutes} min</Trans>
						</p>
					) : detail.largeOrder === true ? (
						<p>
							<Trans>Large order</Trans>
						</p>
					) : null}
				</section>
			) : null}
			{detail.pickupInstructions?.trim() && detail.fulfillment === 'pickup' ? (
				<section aria-label={_(t`Pickup instructions`)} className="text-sm">
					<h3 className="font-semibold">
						<Trans>Pickup instructions</Trans>
					</h3>
					{/* The restaurant's own text, shown as the guest saw it: plain
					    text (React escapes it) with its line breaks kept. */}
					<p className="text-muted-foreground whitespace-pre-line">
						<bdi>{detail.pickupInstructions.trim()}</bdi>
					</p>
				</section>
			) : null}
			<section aria-label={_(t`Items`)}>
				<ul className="divide-border divide-y">
					{detail.lines.map((line, index) => (
						<li key={index} className="flex gap-3 py-2">
							<span className="tnum w-8 shrink-0 font-semibold">
								{line.quantity}×
							</span>
							<div className="min-w-0 flex-1">
								<div className="font-medium">
									{menuText(line.name)}
									{line.variantNames.length > 0 ? (
										<span className="text-muted-foreground">
											{' · '}
											{line.variantNames
												.map((name) => menuText(name))
												.join(', ')}
										</span>
									) : null}
								</div>
								{line.options.length > 0 ? (
									<div className="text-muted-foreground text-sm">
										{line.options
											.map(
												(option) =>
													`${option.quantity > 1 ? `${option.quantity}× ` : ''}${menuText(option.name)}`,
											)
											.join(', ')}
									</div>
								) : null}
								{line.instructions ? (
									<div className="text-warning text-sm">
										<bdi>{line.instructions}</bdi>
									</div>
								) : null}
							</div>
							<span className="tnum shrink-0">{money(line.totalCents)}</span>
						</li>
					))}
				</ul>
			</section>
			<section aria-label={_(t`Payment`)} className="text-sm">
				<dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
					<dt>
						<Trans>Subtotal</Trans>
					</dt>
					<dd className="tnum text-end">{money(detail.subtotalCents)}</dd>
					{detail.discountCents + detail.loyaltyDiscountCents > 0 ? (
						<>
							<dt>
								<Trans>Discounts</Trans>
							</dt>
							<dd className="tnum text-end">
								−{money(detail.discountCents + detail.loyaltyDiscountCents)}
							</dd>
						</>
					) : null}
					{detail.deliveryFeeCents > 0 ? (
						<>
							<dt>
								<Trans>Delivery fee</Trans>
							</dt>
							<dd className="tnum text-end">
								{money(detail.deliveryFeeCents)}
							</dd>
						</>
					) : null}
					{(detail.serviceFeeCents ?? 0) > 0 ? (
						<>
							<dt>
								<Trans>Service fee</Trans>
							</dt>
							<dd className="tnum text-end">
								{money(detail.serviceFeeCents ?? 0)}
							</dd>
						</>
					) : null}
					{(detail.packagingFeeCents ?? 0) > 0 ? (
						<>
							<dt>
								{detail.packagingFeeLabel &&
								detail.packagingFeeLabel !== DEFAULT_PACKAGING_FEE_LABEL ? (
									<bdi>{detail.packagingFeeLabel}</bdi>
								) : (
									<Trans>Packaging fee</Trans>
								)}
							</dt>
							<dd className="tnum text-end">
								{money(detail.packagingFeeCents ?? 0)}
							</dd>
						</>
					) : null}
					{detail.taxCents > 0 ? (
						<>
							<dt>
								<Trans>Tax</Trans>
							</dt>
							<dd className="tnum text-end">{money(detail.taxCents)}</dd>
						</>
					) : null}
					{detail.tipCents > 0 ? (
						<>
							<dt>
								<Trans>Tip</Trans>
							</dt>
							<dd className="tnum text-end">{money(detail.tipCents)}</dd>
						</>
					) : null}
					<dt className="font-semibold">
						<Trans>Total</Trans>
					</dt>
					<dd className="tnum text-end font-semibold">
						{money(detail.totalCents)}
					</dd>
					{detail.refundedCents > 0 ? (
						<>
							<dt>
								<Trans>Refunded</Trans>
							</dt>
							<dd className="tnum text-end">−{money(detail.refundedCents)}</dd>
						</>
					) : null}
					{(detail.refundPendingCents ?? 0) > 0 ? (
						<>
							<dt>
								<Trans>Refund pending</Trans>
							</dt>
							<dd className="tnum text-end">
								−{money(detail.refundPendingCents ?? 0)}
							</dd>
						</>
					) : null}
				</dl>
				{detail.disputed ? (
					<p role="status" className="notice-warning mt-3 px-4 py-2">
						<Trans>
							The guest disputed this payment. It cannot be refunded here until
							the dispute is settled.
						</Trans>
					</p>
				) : null}
				{detail.refundStatus === 'pending' ? (
					<p role="status" className="text-muted-foreground mt-3">
						<Trans>
							A refund is on its way to the guest's card. It can take a few days
							to show on their statement.
						</Trans>
					</p>
				) : null}
				{detail.refundStatus === 'failed' ? (
					<p role="alert" className="notice-warning mt-3 px-4 py-2">
						<Trans>
							The last refund failed, so nothing was returned. The amount can be
							refunded again.
						</Trans>
					</p>
				) : null}
			</section>
			{detail.history.length > 0 ? (
				<section aria-label={_(t`On Station`)} className="text-sm">
					<h3 className="mb-1 font-semibold">
						<Trans>On Station</Trans>
					</h3>
					<ul className="text-muted-foreground flex flex-col gap-0.5">
						{detail.history.map((entry, index) => (
							<li key={index}>
								{time.format(entry.at)} ·{' '}
								{HISTORY[entry.action]
									? _(HISTORY[entry.action]!)
									: entry.action}
								{entry.amountCents !== null
									? ` · ${money(entry.amountCents)}`
									: ''}
								{entry.reason && entry.reason in CANCEL_REASON
									? ` · ${_(CANCEL_REASON[entry.reason as PosOnlineOrderCancelReason])}`
									: entry.action === 'rejected' && entry.reason
										? ` · ${rejectedReasonText(_, entry.reason)}`
										: ''}
								{entry.staffName ? (
									<>
										{' · '}
										<bdi>{entry.staffName}</bdi>
									</>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	)
}

const SEARCH_STATES: Record<PosOnlineOrdersSearchState, MessageDescriptor> = {
	all: msg`Any state`,
	open: msg`In progress`,
	ready: msg`Ready`,
	completed: msg`Handed over`,
	cancelled: msg`Cancelled`,
}

/**
 * "Where is my order?": today's and the last seven days' orders at this
 * location by number, guest name or, for people allowed to see contacts, the
 * phone's last digits. Results live only while this sheet is open.
 */
function SearchSheet({
	open,
	onClose,
	orders,
	reachable,
	timeZone,
	onPick,
}: {
	open: boolean
	onClose: () => void
	orders: OrdersState
	reachable: boolean
	timeZone?: string
	onPick: (order: PosOnlineOrdersSearch['results'][number]) => void
}) {
	const { _, i18n } = useLingui()
	const canPhone = orders.grants?.contact === true
	const [by, setBy] = useState<'text' | 'phone'>('text')
	const [text, setText] = useState('')
	const [state, setState] = useState<PosOnlineOrdersSearchState>('all')
	const [fulfillment, setFulfillment] = useState<
		'all' | 'pickup' | 'delivery' | 'dine_in'
	>('all')
	const [answer, setAnswer] = useState<PosOnlineOrdersSearch | null>(null)
	const [failure, setFailure] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const asked = useRef(0)
	/** Drops whatever is on screen and any answer still on its way. */
	const forget = () => {
		asked.current += 1
		setLoading(false)
		setAnswer(null)
		setFailure(null)
	}
	// Nothing found is kept once the sheet closes; the phone mode leaves with the grant.
	useEffect(() => {
		if (open) return
		asked.current += 1
		setLoading(false)
		setText('')
		setAnswer(null)
		setFailure(null)
	}, [open])
	useEffect(() => {
		if (canPhone) return
		// A phone search started by someone else never lands for this person.
		asked.current += 1
		setLoading(false)
		setAnswer(null)
		if (by === 'phone') setBy('text')
	}, [canPhone, by])
	const when = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.locale, {
				weekday: 'short',
				day: 'numeric',
				month: 'short',
				hour: 'numeric',
				minute: '2-digit',
				...(timeZone ? { timeZone } : {}),
			}),
		[i18n.locale, timeZone],
	)
	// Arabic-Indic and Persian digits read as 0-9, in both modes.
	const typed = toAsciiDigits(text).trim()
	const digits = typed.replace(/\D/g, '')
	const ready =
		by === 'phone'
			? digits.length === POS_ONLINE_ORDERS_PHONE_DIGITS
			: typed.length >= POS_ONLINE_ORDERS_SEARCH_TEXT_MIN
	const run = async () => {
		if (!ready || !reachable) return
		const ask = ++asked.current
		setLoading(true)
		setFailure(null)
		try {
			const data = await orders.search({
				...(by === 'phone' ? { phone: digits } : { q: typed }),
				state,
				fulfillment,
				since: onlineOrdersSearchSince(Date.now()),
			})
			if (ask === asked.current) setAnswer(data)
		} catch (error) {
			if (ask !== asked.current) return
			setAnswer(null)
			setFailure(
				error instanceof OrdersError && error.code === 'permission_required'
					? _(t`You do not have permission to search by phone.`)
					: error instanceof OrdersError && error.code === 'search_limit'
						? _(t`Too many phone searches this hour. Try again later.`)
						: error instanceof OrdersError && error.code === 'connection_lost'
							? _(t`Search needs a connection. Reconnect and try again.`)
							: _(t`The search did not work. Try again.`),
			)
		} finally {
			if (ask === asked.current) setLoading(false)
		}
	}
	const days = POS_ONLINE_ORDERS_SEARCH_DAYS
	return (
		<Modal open={open} onClose={onClose} title={_(t`Search orders`)} size="lg">
			<form
				className="flex flex-col gap-4 p-4 sm:p-5"
				onSubmit={(event) => {
					event.preventDefault()
					void run()
				}}
			>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Online orders at this location from today and the last {days} days.
					</Trans>
				</p>
				{canPhone ? (
					<Segmented
						label={_(t`Search by`)}
						value={by}
						onChange={(value) => {
							forget()
							setBy(value)
							setText('')
						}}
						options={[
							{ value: 'text', label: _(t`Number or name`) },
							{ value: 'phone', label: _(t`Phone`) },
						]}
					/>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<Input
						type="search"
						autoFocus
						inputMode={by === 'phone' ? 'numeric' : undefined}
						aria-label={
							by === 'phone'
								? _(t`Last 4 digits of the guest’s phone`)
								: _(t`Order number or guest name`)
						}
						placeholder={
							by === 'phone' ? _(t`Last 4 digits`) : _(t`Order number or name`)
						}
						className="h-11 min-w-0 flex-1"
						value={text}
						maxLength={60}
						onChange={(event) => setText(event.target.value)}
					/>
					<Select
						aria-label={_(t`State`)}
						className="h-11"
						containerClassName="w-40"
						value={state}
						onChange={(event) =>
							setState(event.target.value as PosOnlineOrdersSearchState)
						}
					>
						{(Object.keys(SEARCH_STATES) as PosOnlineOrdersSearchState[]).map(
							(value) => (
								<option key={value} value={value}>
									{_(SEARCH_STATES[value])}
								</option>
							),
						)}
					</Select>
					<Select
						aria-label={_(t`Order type`)}
						className="h-11"
						containerClassName="w-36"
						value={fulfillment}
						onChange={(event) =>
							setFulfillment(event.target.value as typeof fulfillment)
						}
					>
						<option value="all">{_(t`All types`)}</option>
						<option value="pickup">{_(t`Pickup`)}</option>
						<option value="delivery">{_(t`Delivery`)}</option>
						<option value="dine_in">{_(t`Dine in`)}</option>
					</Select>
					<Button
						type="submit"
						variant="primary"
						disabled={!ready || !reachable || loading}
					>
						<Icon name="search" className="size-4" />
						<Trans>Search</Trans>
					</Button>
				</div>
				{!reachable ? (
					<p role="status" className="notice-warning px-4 py-2 text-sm">
						<Trans>Search needs a connection. Reconnect and try again.</Trans>
					</p>
				) : null}
				{failure ? (
					<p role="alert" className="notice-warning px-4 py-2 text-sm">
						{failure}
					</p>
				) : null}
				{/* Mounted from the start, so screen readers announce each change. */}
				<p role="status" className="sr-only">
					{loading
						? _(t`Searching…`)
						: answer
							? answer.results.length === 0
								? _(t`No orders match.`)
								: _(
										plural(answer.results.length, {
											one: '# order found',
											other: '# orders found',
										}),
									)
							: ''}
				</p>
				{answer ? (
					<section aria-label={_(t`Search results`)}>
						{answer.results.length === 0 ? (
							<p className="text-muted-foreground py-4 text-center">
								<Trans>No orders match.</Trans>
							</p>
						) : (
							<ul className="divide-border border-border divide-y rounded-(--station-control-radius) border">
								{answer.results.map((order) => (
									<li key={order.id}>
										<button
											type="button"
											className="hover:bg-muted flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-start"
											onClick={() => onPick(order)}
										>
											<span className="tnum font-semibold">{order.number}</span>
											<bdi className="min-w-0 truncate">{order.guestName}</bdi>
											<span className="text-muted-foreground me-auto text-sm">
												{when.format(order.createdAt)}
											</span>
											<Badge
												tone={
													order.status === 'cancelled'
														? 'danger'
														: order.status === 'ready'
															? 'success'
															: 'muted'
												}
											>
												{_(STATUS[order.status])}
											</Badge>
											<span className="tnum text-sm">
												{moneyFormatter(order.currency)(order.totalCents)}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						{answer.truncated ? (
							<p role="status" className="text-muted-foreground mt-2 text-sm">
								<Trans>
									Showing the newest {answer.results.length} matches. Type more
									of the number or name to narrow it down.
								</Trans>
							</p>
						) : null}
					</section>
				) : null}
			</form>
		</Modal>
	)
}

function RejectDialog({
	open,
	number,
	paidOnline,
	busy,
	error,
	decidedElsewhere,
	onClose,
	onConfirm,
}: {
	open: boolean
	number: string
	/** Paid online: rejecting refunds the guest in full. */
	paidOnline: boolean
	busy: boolean
	/** The last failed command, shown here because this modal covers the sheet. */
	error: OrdersError | null
	decidedElsewhere: boolean
	onClose: () => void
	onConfirm: (reason: OrderRejectReason) => Promise<void>
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState<OrderRejectReason | null>(null)
	useEffect(() => {
		if (open) setReason(null)
	}, [open])
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Reject order ${number}?`)}
			footer={
				<div className="flex w-full justify-end gap-2">
					<Button onClick={onClose} disabled={busy}>
						<Trans>Keep waiting</Trans>
					</Button>
					<Button
						variant="danger"
						disabled={!reason || busy}
						onClick={() => reason && void onConfirm(reason)}
					>
						<Trans>Reject order</Trans>
					</Button>
				</div>
			}
		>
			<div className="p-4 sm:p-5">
				{error && open ? (
					<p role="alert" className="notice-warning mb-3 px-4 py-2 text-sm">
						{actionMessage(_, error, undefined, decidedElsewhere)}
					</p>
				) : null}
				<p className="mb-3 text-sm">
					{paidOnline
						? _(
								t`The kitchen never gets this order. It was paid online, so the guest is refunded in full. Card fees are usually not returned to you.`,
							)
						: _(
								t`The kitchen never gets this order and nothing is charged. It cannot be reopened.`,
							)}
				</p>
				<p className="text-muted-foreground mb-3 text-sm">
					<Trans>
						The guest only sees "out of stock" or "kitchen closed". Other
						reasons stay with you.
					</Trans>
				</p>
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-semibold">
						<Trans>Why?</Trans>
					</legend>
					{ORDER_REJECT_REASONS.map((value) => (
						<Button
							key={value}
							variant={reason === value ? 'primary' : 'outline'}
							aria-pressed={reason === value}
							onClick={() => setReason(value)}
						>
							{_(REJECT_REASON[value])}
						</Button>
					))}
				</fieldset>
			</div>
		</Modal>
	)
}

function CancelDialog({
	open,
	number,
	paid,
	canRefund,
	refundableLabel,
	busy,
	error,
	money,
	onClose,
	onConfirm,
}: {
	open: boolean
	number: string
	paid: boolean
	/** Paid online, and this person may refund: ask whether to refund the guest. */
	canRefund: boolean
	refundableLabel: string
	busy: boolean
	/** The last failed command, shown here because this modal covers the sheet. */
	error: OrdersError | null
	money: (cents: number) => string
	onClose: () => void
	onConfirm: (
		reason: PosOnlineOrderCancelReason,
		refund?: 'none' | 'full',
	) => Promise<void>
}) {
	const { _ } = useLingui()
	const [reason, setReason] = useState<PosOnlineOrderCancelReason | null>(null)
	const [refund, setRefund] = useState<'none' | 'full'>('full')
	useEffect(() => {
		if (open) {
			setReason(null)
			setRefund('full')
		}
	}, [open])
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Cancel order ${number}?`)}
			footer={
				<div className="flex w-full justify-end gap-2">
					<Button onClick={onClose} disabled={busy}>
						<Trans>Keep the order</Trans>
					</Button>
					<Button
						variant="danger"
						disabled={!reason || busy}
						onClick={() =>
							reason && void onConfirm(reason, canRefund ? refund : undefined)
						}
					>
						<Trans>Cancel order</Trans>
					</Button>
				</div>
			}
		>
			<div className="p-4 sm:p-5">
				{error && open ? (
					<p role="alert" className="notice-warning mb-3 px-4 py-2 text-sm">
						{actionMessage(_, error, money)}
					</p>
				) : null}
				<p className="mb-3 text-sm">
					{paid
						? canRefund
							? _(
									t`It was paid online. The kitchen stops preparing it and it cannot be reopened. Choose whether to refund the guest.`,
								)
							: _(
									t`It was paid online. Cancelling does not refund it: a manager can refund it afterwards from the order or in the App.`,
								)
						: _(t`The kitchen stops preparing it. It cannot be reopened.`)}
				</p>
				{canRefund ? (
					<fieldset className="mb-3 flex flex-col gap-2">
						<legend className="mb-1 text-sm font-semibold">
							<Trans>Refund the guest?</Trans>
						</legend>
						<Segmented
							label={_(t`Refund the guest?`)}
							value={refund}
							onChange={(value) =>
								setRefund(value === 'none' ? 'none' : 'full')
							}
							options={[
								{
									value: 'full',
									label: _(t`Full refund (${refundableLabel})`),
								},
								{ value: 'none', label: _(t`No refund`) },
							]}
						/>
						{refund === 'full' ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									The money goes back to the guest's card. Card fees are usually
									not returned to you.
								</Trans>
							</p>
						) : null}
					</fieldset>
				) : null}
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-semibold">
						<Trans>Why?</Trans>
					</legend>
					{POS_ONLINE_ORDER_CANCEL_REASONS.map((value) => (
						<Button
							key={value}
							variant={reason === value ? 'primary' : 'outline'}
							aria-pressed={reason === value}
							onClick={() => setReason(value)}
						>
							{_(CANCEL_REASON[value])}
						</Button>
					))}
				</fieldset>
			</div>
		</Modal>
	)
}

function RefundDialog({
	open,
	detail,
	busy,
	error,
	paidOnline,
	onClose,
	onConfirm,
}: {
	open: boolean
	detail: PosOnlineOrderDetail
	busy: boolean
	error: OrdersError | null
	/** Refunded through the payment provider, not just recorded. */
	paidOnline: boolean
	onClose: () => void
	onConfirm: (
		refund:
			{ full: true; note: string } | { amountCents: number; note: string },
		idempotencyKey: string,
	) => Promise<void>
}) {
	const { _ } = useLingui()
	const money = moneyFormatter(detail.currency)
	const [full, setFull] = useState(true)
	const [amount, setAmount] = useState('')
	const [note, setNote] = useState('')
	// One key per refund being recorded: a retry after a lost answer is the same refund.
	const key = useRef('')
	useEffect(() => {
		if (!open) return
		setFull(true)
		setAmount('')
		setNote('')
		key.current = `rf-${crypto.randomUUID()}`
	}, [open])
	const cents = full
		? detail.refundableCents
		: refundCents(amount, detail.refundableCents)
	const valid = cents !== null && note.trim().length >= 3
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={
				paidOnline
					? _(t`Refund ${detail.number}`)
					: _(t`Record a refund for ${detail.number}`)
			}
			footer={
				<div className="flex w-full justify-end gap-2">
					<Button onClick={onClose} disabled={busy}>
						<Trans>Back</Trans>
					</Button>
					<Button
						variant="primary"
						disabled={!valid || busy}
						onClick={() =>
							valid &&
							void onConfirm(
								full
									? { full: true, note: note.trim() }
									: { amountCents: cents, note: note.trim() },
								key.current,
							)
						}
					>
						{paidOnline
							? cents !== null
								? _(t`Refund ${money(cents)}`)
								: _(t`Refund`)
							: cents !== null
								? _(t`Record ${money(cents)} refund`)
								: _(t`Record refund`)}
					</Button>
				</div>
			}
		>
			<div className="p-4 sm:p-5">
				<p className="mb-3 text-sm">
					{paidOnline ? (
						<Trans>
							The money goes back to the guest's card through your payment
							provider. Card fees are usually not returned to you.
						</Trans>
					) : (
						<Trans>
							This records money you returned with your payment provider. It
							does not move money by itself.
						</Trans>
					)}{' '}
					{_(t`Up to ${money(detail.refundableCents)} can be refunded.`)}
				</p>
				{error && open ? (
					<p role="alert" className="notice-warning mb-3 px-4 py-2 text-sm">
						{actionMessage(_, error, money)}
					</p>
				) : null}
				<Segmented
					label={_(t`How much`)}
					value={full ? 'full' : 'part'}
					onChange={(value) => setFull(value === 'full')}
					options={[
						{ value: 'full', label: _(t`Everything left`) },
						{ value: 'part', label: _(t`Part of it`) },
					]}
				/>
				{!full ? (
					<label className="mt-3 flex flex-col gap-1 text-sm">
						<Trans>Amount</Trans>
						<Input
							inputMode="decimal"
							value={amount}
							onChange={(event) => setAmount(event.target.value)}
						/>
					</label>
				) : null}
				<label className="mt-3 flex flex-col gap-1 text-sm">
					<Trans>Reason</Trans>
					<Input
						value={note}
						maxLength={280}
						placeholder={_(t`For example: cold fries`)}
						onChange={(event) => setNote(event.target.value)}
					/>
				</label>
			</div>
		</Modal>
	)
}

function PrintHighlight({ highlight }: { highlight?: string }) {
	const { _ } = useLingui()
	if (
		highlight !== 'allergy' &&
		highlight !== 'attention' &&
		highlight !== 'long_prep'
	)
		return null
	const label =
		highlight === 'allergy'
			? _(t`Allergy`)
			: highlight === 'long_prep'
				? _(t`Long prep`)
				: _(t`Attention`)
	return (
		<span
			className="ms-1 inline-flex items-center gap-1 border px-1.5 text-xs font-semibold"
			data-highlight={highlight}
		>
			<Icon
				name={KITCHEN_HIGHLIGHT_ICON[highlight]}
				className="size-3.5"
				aria-hidden
			/>
			{label}
		</span>
	)
}

/**
 * The ticket `window.print()` shows: the guest ticket with items and prices,
 * or the kitchen ticket with food only. The phone is printed masked, never in
 * full, and an email never.
 */
export function PrintedTicket({
	kind,
	detail,
	businessName,
	time,
	kitchenSwitches,
	cancelled = false,
}: {
	kind: 'guest' | 'kitchen'
	/** The order was just cancelled: print the slip even before the screen shows it. */
	cancelled?: boolean
	detail: PosOnlineOrderDetail
	businessName: string
	time: Intl.DateTimeFormat
	kitchenSwitches: KitchenPrintSwitches
}) {
	const { _ } = useLingui()
	const money = moneyFormatter(detail.currency)
	// What this ticket type prints (#363): the guest ticket is the receipt type.
	const tickets = useTickets()
	const type = kind === 'guest' ? 'receipt' : 'kitchen'
	const f = (key: string) => fieldOf(tickets, type, key)
	// A cancelled order's kitchen ticket is a cancellation slip when the owner
	// asked for it, and it always says so (the title cannot be hidden then).
	const slip =
		kind === 'kitchen' &&
		tickets.cancellationSlip &&
		(cancelled || detail.status === 'cancelled')
	return createPortal(
		<div
			id="receipt"
			className="hidden print:block"
			aria-hidden
			{...(kind === 'kitchen'
				? {
						'data-kitchen-ticket': '',
						'data-order-type':
							detail.fulfillment === 'pickup' ? 'takeaway' : detail.fulfillment,
						...(kitchenSwitches.showOrderTypeColor
							? { 'data-color-order': '' }
							: {}),
					}
				: {})}
		>
			{kind === 'guest' ? (
				f('businessName').show ? (
					<div
						className={cn(
							'text-center text-sm font-semibold',
							f('businessName').cls,
						)}
					>
						{businessName}
					</div>
				) : null
			) : slip ? (
				<div className={cn('text-center font-semibold', f('ticketTitle').cls)}>
					<Trans>CANCELLED</Trans>
				</div>
			) : f('ticketTitle').show ? (
				<div className={cn('text-center font-semibold', f('ticketTitle').cls)}>
					<Trans>Kitchen ticket</Trans>
				</div>
			) : null}
			{f('dateTime').show ? (
				<div className={cn('text-center', f('dateTime').cls)}>
					{time.format(detail.createdAt)}
				</div>
			) : null}
			{f('orderNumber').show ? (
				<div
					className={cn(
						'my-1.5 text-center text-base font-semibold',
						f('orderNumber').cls,
					)}
				>
					#{detail.number}
				</div>
			) : null}
			{f('orderType').show ? (
				<div className={cn('text-center', f('orderType').cls)}>
					{detail.fulfillment === 'delivery'
						? _(t`Delivery`)
						: detail.fulfillment === 'dine_in'
							? detail.tableLabel
								? _(t`Table ${detail.tableLabel}`)
								: _(t`Dine in`)
							: _(t`Pickup`)}
					{detail.dueAt ? ` · ${time.format(detail.dueAt)}` : ''}
				</div>
			) : null}
			{kind === 'guest' && f('guestContact').show ? (
				<div className={cn('text-center', f('guestContact').cls)}>
					<bdi>{detail.guestName}</bdi> ·{' '}
					<bdi dir="ltr">{detail.phoneMasked}</bdi>
				</div>
			) : null}
			{kind === 'kitchen' &&
			detail.utensilsRequested != null &&
			f('utensils').show ? (
				<div className={cn('text-center font-semibold', f('utensils').cls)}>
					{detail.utensilsRequested ? _(t`Utensils: yes`) : _(t`No utensils`)}
				</div>
			) : null}
			{kind === 'kitchen' &&
			((detail.largeOrderExtraMinutes ?? 0) > 0 ||
				detail.largeOrder === true) &&
			f('largeOrder').show ? (
				<div className={cn('text-center', f('largeOrder').cls)}>
					{(detail.largeOrderExtraMinutes ?? 0) > 0 ? (
						<Trans>Large order +{detail.largeOrderExtraMinutes} min</Trans>
					) : (
						<Trans>Large order</Trans>
					)}
				</div>
			) : null}
			{kind === 'kitchen' && kitchenSwitches.showPaymentStatus ? (
				<div className="text-center font-semibold" data-order-head>
					{detail.paymentStatus === 'paid' ||
					detail.paymentStatus === 'not_required'
						? _(t`Paid`)
						: _(t`Unpaid`)}
				</div>
			) : null}
			<hr className="my-1.5 border-dashed border-black" />
			{(kind === 'kitchen'
				? groupLinesByCourse(detail.lines)
				: [
						{
							courseId: null,
							courseName: null,
							held: false,
							lines: detail.lines,
						},
					]
			).map((group) => (
				<div key={group.courseId ?? 'all'}>
					{kind === 'kitchen' && group.courseId && f('courses').show ? (
						<div className={cn('mt-1 font-semibold', f('courses').cls)}>
							{group.courseName}
							{group.held ? ` · ${_(t`Held`)}` : ''}
						</div>
					) : null}
					{group.lines.map((line, index) => (
						<div key={index} className={cn('mb-1', f('items').cls)}>
							<div className="flex justify-between gap-2">
								<span>
									{line.quantity}×{' '}
									{kind === 'kitchen'
										? menuText(line.kitchenName || line.name)
										: menuText(line.name)}
									{line.variantNames.length > 0
										? ` · ${line.variantNames.map((name) => menuText(name)).join(', ')}`
										: ''}
									{kind === 'kitchen' && f('highlights').show ? (
										<PrintHighlight highlight={line.highlight} />
									) : null}
								</span>
								{kind === 'guest' ? (
									<span>{money(line.totalCents)}</span>
								) : null}
							</div>
							{(f('itemOptions').show ? line.options : []).map(
								(option, optionIndex) => (
									<div
										key={optionIndex}
										className={cn('ps-3', f('itemOptions').cls)}
									>
										+{' '}
										{kind === 'kitchen' &&
										kitchenSwitches.showModifierGroups &&
										option.groupName
											? `${menuText(option.groupName)}: `
											: ''}
										{kind === 'kitchen'
											? menuText(option.kitchenName || option.name)
											: menuText(option.name)}
										{kind === 'kitchen' && f('highlights').show ? (
											<PrintHighlight highlight={option.highlight} />
										) : null}
									</div>
								),
							)}
							{line.instructions && f('itemNotes').show ? (
								<div className={cn('ps-3', f('itemNotes').cls)}>
									<bdi>{line.instructions}</bdi>
								</div>
							) : null}
						</div>
					))}
				</div>
			))}
			{kind === 'guest' ? (
				<>
					<hr className="my-1.5 border-dashed border-black" />
					<div
						className={cn('flex justify-between font-semibold', f('total').cls)}
					>
						<span>
							<Trans>Total</Trans>
						</span>
						<span>{money(detail.totalCents)}</span>
					</div>
					{f('payments').show ? (
						<div className={cn('text-center', f('payments').cls)}>
							{detail.paymentStatus === 'paid'
								? _(t`Paid`)
								: detail.onTab
									? _(t`On the tab`)
									: _(t`Pay at handoff`)}
						</div>
					) : null}
				</>
			) : null}
		</div>,
		document.body,
	)
}
