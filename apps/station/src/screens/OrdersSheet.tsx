import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
	ArrowLeft,
	ArrowRightLeft,
	CreditCard,
	PlusCircle,
	Printer,
	ReceiptText,
	RefreshCw,
	RotateCcw,
	Search,
	X,
	XCircle,
} from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'
import { AuditSheet, useReasonLabel } from './AuditSheet.tsx'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { Receipt } from './Receipt.tsx'
import { type PosOrder, type TenderMethod } from '~/lib/db.ts'
import { moneyFormatter } from '~/lib/money.ts'
import {
	balanceCents,
	DEMO_ORIGIN,
	isSendable,
	openTabs,
	phoneOrders,
	refundableCents,
	refundOrder,
	requeueRejected,
	todaysOrders,
	voidTab,
} from '~/lib/orders.ts'
import { formatPickupAt } from '~/lib/pickup.ts'
import { lineTotalCents } from '~/lib/pricing.ts'
import { usePos, type OtherTab } from '~/lib/store.ts'
import { useIsTablet } from '~/ui/hooks.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import {
	Badge,
	Button,
	IconButton,
	Modal,
	Segmented,
	cn,
} from '~/ui/primitives.tsx'

const TENDER: Record<TenderMethod, MessageDescriptor> = {
	cash: msg`Cash`,
	card: msg`Card`,
	other: msg`Other`,
}
type View = 'open' | 'today' | 'phone' | 'others'
type Translate = I18n['_']

/** Shown to a manager for an order the server kept aside instead of applying. */
const HELD_REASON: Record<string, MessageDescriptor> = {
	order_transferred: msg`another terminal had already taken this tab over`,
	invalid_request: msg`the server could not read it (this till may need updating)`,
	order_closed: msg`the server already had this order closed`,
	payments_changed: msg`its payments differ from what the server already has`,
	paid_order_changed: msg`the bill changed after a payment was taken`,
}

/** Where an order is for: its table, dine in, the guest's name, or takeaway. */
function placeLabel(
	_: Translate,
	order: {
		orderType: string
		tableLabel: string | null
		customerName: string | null
		orderSource?: string
	},
) {
	const table = order.tableLabel
	if (order.orderSource === 'phone')
		return `${_(t`Phone`)} · ${order.customerName || _(t`Pickup`)}`
	if (order.orderType === 'dine_in')
		return table ? _(t`Table ${table}`) : _(t`Dine in`)
	return order.customerName || _(t`Takeaway`)
}

export function OrdersSheet({
	timeZone,
	dayStartMinutes,
	vatNumber,
	onClose,
	businessName,
	onRetry,
	onAddItems,
	onPay,
}: {
	/** The restaurant's time zone, so "Today" is its business day. */
	timeZone?: string
	/** When the business day turns over, in minutes after midnight. */
	dayStartMinutes: number
	vatNumber: string | null
	onClose: () => void
	businessName: string
	onRetry: () => void
	onAddItems: (order: PosOrder) => void
	onPay: (order: PosOrder) => void
}) {
	const { _, i18n } = useLingui()
	const reasonLabel = useReasonLabel()
	const tabs = useLiveQuery(() => openTabs(), [], [] as PosOrder[])
	const phones = useLiveQuery(() => phoneOrders(), [], [] as PosOrder[])
	const today = useLiveQuery(
		() => todaysOrders(timeZone, dayStartMinutes),
		[timeZone, dayStartMinutes],
		[] as PosOrder[],
	)
	const [view, setView] = useState<View>('open')
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const deferredQuery = useDeferredValue(query.trim().toLowerCase())
	const [error, setError] = useState<string | null>(null)
	const [cancelling, setCancelling] = useState<PosOrder | null>(null)
	const [refunding, setRefunding] = useState<PosOrder | null>(null)
	const settings = usePos((s) => s.settings)
	const me = usePos((s) => s.session?.staff ?? null)
	const needsManager = usePos((s) => s.needsManager)
	const approve = usePos((s) => s.approve)
	const wide = useIsTablet()
	const canSeeOthers = !settings.demo && Boolean(settings.deviceToken)

	const sourceOrders =
		view === 'open' ? tabs : view === 'phone' ? phones : today
	const orders = deferredQuery
		? sourceOrders.filter((order) =>
				[
					order.number,
					order.tableLabel,
					order.customerName,
					order.customerPhone,
					order.orderSource === 'phone' ? _(t`Phone`) : '',
					order.staff?.name,
				].some((value) => value?.toLowerCase().includes(deferredQuery)),
			)
		: sourceOrders
	// On a phone the list and the detail take turns; on a tablet they sit side by side.
	const selected =
		view === 'others'
			? null
			: (orders.find((o) => o.id === selectedId) ??
				(wide ? (orders[0] ?? null) : null))
	const currency = sourceOrders[0]?.currency ?? 'USD'
	const takenToday = today.reduce(
		(s, o) =>
			s +
			Math.min(
				o.totals.totalCents,
				o.payments.reduce((a, p) => a + p.amountCents, 0),
			) -
			(o.refunds ?? []).reduce((a, r) => a + r.amountCents, 0),
		0,
	)
	const money = moneyFormatter(selected?.currency ?? currency)
	const openCount = tabs.length
	const todayCount = today.length
	// Plain values for the messages below (translations interpolate names, not expressions).
	const takenBy = selected?.staff?.name ?? ''
	const cancelledBy = selected?.voidedBy?.name ?? ''
	const voidReason = selected?.voidReason
		? reasonLabel(selected.voidReason)
		: ''
	const voidApprover = selected?.voidApprovedBy?.name ?? null
	const transferredTo = selected?.transferredTo ?? ''
	const heldBecause = selected?.heldReason
		? HELD_REASON[selected.heldReason]
			? _(HELD_REASON[selected.heldReason]!)
			: selected.heldReason.replace(/_/g, ' ')
		: ''
	const takenFor = selected?.origin ?? ''
	const renumberedFrom = selected?.renumberedFrom ?? ''
	const balanceDue = selected ? money(balanceCents(selected)) : ''
	const cancellingNumber = cancelling?.number ?? ''

	return (
		<Modal
			open
			onClose={onClose}
			title={_(t`Orders`)}
			size="full"
			scrollable={false}
		>
			<div className="border-border bg-card flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-6">
				<div className="max-w-full min-w-0 overflow-x-auto p-1">
					<Segmented
						label={_(t`Orders view`)}
						wrap={false}
						value={view}
						onChange={(v) => {
							setView(v)
							setSelectedId(null)
							setQuery('')
							setError(null)
						}}
						options={[
							{ value: 'open', label: _(t`Open tabs · ${openCount}`) },
							{ value: 'today', label: _(t`Today · ${todayCount}`) },
							{ value: 'phone', label: _(t`Phone orders`) },
							...(canSeeOthers
								? [{ value: 'others' as const, label: _(t`Other terminals`) }]
								: []),
						]}
					/>
				</div>
				{view !== 'others' ? (
					<label className="relative ms-auto block w-full sm:w-72">
						<span className="sr-only">
							<Trans>Search orders</Trans>
						</span>
						<Search className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={_(t`Search orders`)}
							autoComplete="off"
							className="border-input bg-background h-11 w-full rounded-lg border ps-10 pe-11 text-base sm:text-sm"
						/>
						{query ? (
							<IconButton
								label={_(t`Clear search`)}
								className="absolute end-0 top-0"
								onClick={() => setQuery('')}
							>
								<X className="size-4" />
							</IconButton>
						) : null}
					</label>
				) : null}
			</div>
			{view === 'others' ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<OtherTerminalsTabs
						onTaken={() => {
							setView('open')
							setSelectedId(null)
						}}
					/>
				</div>
			) : orders.length === 0 ? (
				<div className="bg-background flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-8 text-center">
					<ReceiptText className="text-muted-foreground size-10" />
					<p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
						{deferredQuery ? (
							<Trans>No orders match your search.</Trans>
						) : view === 'phone' ? (
							<Trans>
								No phone orders yet. Choose “Phone order” in the current order
								to take a pickup request.
							</Trans>
						) : view === 'open' ? (
							<Trans>
								No open tabs. Use “Pay later” on an order and it waits here
								until the guest settles up.
							</Trans>
						) : (
							<Trans>
								No orders yet today. They appear the moment you save them, even
								offline.
							</Trans>
						)}
					</p>
					{deferredQuery ? (
						<Button variant="outline" onClick={() => setQuery('')}>
							<Trans>Clear search</Trans>
						</Button>
					) : null}
				</div>
			) : (
				<div className="bg-background grid min-h-0 flex-1 gap-4 p-3 sm:p-4 md:grid-cols-[20rem_minmax(0,1fr)] lg:gap-6 lg:p-6">
					<ul
						aria-label={_(t`Orders`)}
						className={cn(
							'border-border bg-card min-h-0 overflow-y-auto rounded-xl border',
							selected && !wide && 'hidden',
						)}
					>
						{orders.map((o) => {
							const owed = balanceCents(o)
							return (
								<li key={o.id}>
									<button
										type="button"
										onClick={() => {
											setSelectedId(o.id)
											setError(null)
										}}
										aria-current={selected?.id === o.id}
										className={cn(
											'border-border hover:bg-muted/60 flex w-full flex-col gap-2 border-b p-4 text-start transition',
											selected?.id === o.id && 'bg-muted/60',
										)}
									>
										<div className="flex w-full flex-wrap items-center justify-between gap-2">
											<span className="font-semibold">#{o.number}</span>
											<StatusBadge order={o} />
										</div>
										<div className="flex w-full items-baseline justify-between gap-3 text-sm">
											<span className="min-w-0 truncate">
												{placeLabel(_, o)}
											</span>
											<span className="tnum shrink-0 font-medium whitespace-nowrap">
												{moneyFormatter(o.currency)(
													o.status === 'open' ? owed : o.totals.totalCents,
												)}
											</span>
										</div>
										<span className="text-muted-foreground text-xs">
											{new Date(o.createdAt).toLocaleTimeString(i18n.locale, {
												hour: 'numeric',
												minute: '2-digit',
											})}
											{o.staff ? ` · ${o.staff.name}` : ''}
										</span>
										{o.orderSource === 'phone' ? (
											<span className="text-muted-foreground text-xs">
												{o.pickupAt == null
													? _(t`Pickup ASAP`)
													: formatPickupAt(
															o.pickupAt,
															i18n.locale,
															o.pickupTimeZone,
														)}
											</span>
										) : null}
									</button>
								</li>
							)
						})}
						{view === 'today' ? (
							<li className="tnum bg-muted sticky bottom-0 flex justify-between px-4 py-3 text-sm font-semibold">
								<span>
									<Trans>Taken today</Trans>
								</span>
								<span>{moneyFormatter(currency)(takenToday)}</span>
							</li>
						) : null}
					</ul>

					{selected ? (
						<section
							aria-label={_(t`Order details`)}
							className="border-border bg-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border"
						>
							<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
								{!wide ? (
									<button
										type="button"
										onClick={() => setSelectedId(null)}
										className="text-muted-foreground hover:bg-muted -ms-1 inline-flex h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold"
									>
										<ArrowLeft className="size-4 rtl:rotate-180" />{' '}
										<Trans>All orders</Trans>
									</button>
								) : null}
								<div className="flex items-start justify-between gap-3">
									<div>
										<h3 className="text-xl font-semibold">
											#{selected.number}
										</h3>
										<p className="text-muted-foreground mt-1 text-sm">
											{new Date(selected.createdAt).toLocaleString(i18n.locale)}
											{' · '}
											{selected.orderSource === 'phone'
												? placeLabel(_, selected)
												: selected.orderType === 'dine_in'
													? placeLabel(_, selected)
													: selected.customerName
														? `${_(t`Takeaway`)} · ${selected.customerName}`
														: _(t`Takeaway`)}
										</p>
									</div>
									<StatusBadge order={selected} />
								</div>
								{selected.orderSource === 'phone' ? (
									<PhonePickupDetails order={selected} />
								) : null}
								{selected.staff || selected.voidedBy ? (
									<p className="text-muted-foreground text-sm">
										{selected.staff ? (
											<>
												<Trans>
													Taken by{' '}
													<span className="text-foreground font-semibold">
														{takenBy}
													</span>
												</Trans>
												{selected.signIn === 'offline' ? (
													<>
														{' '}
														<Trans>(signed in without a connection)</Trans>
													</>
												) : null}
											</>
										) : null}
										{selected.voidedBy ? (
											<>
												{selected.staff ? ' · ' : ''}
												<Trans>
													Cancelled by{' '}
													<span className="text-foreground font-semibold">
														{cancelledBy}
													</span>
												</Trans>
											</>
										) : null}
									</p>
								) : null}
								{selected.status === 'void' && selected.voidReason ? (
									<p className="text-muted-foreground text-sm">
										<Trans>Cancelled: {voidReason}</Trans>
										{voidApprover ? (
											<>
												{' · '}
												<Trans>approved by {voidApprover}</Trans>
											</>
										) : null}
									</p>
								) : null}
								{selected.transferredTo ? (
									<p className="bg-muted text-muted-foreground rounded-xl p-3 text-sm">
										<Trans>
											Terminal {transferredTo} took this tab over. It is kept
											here as history only.
										</Trans>
									</p>
								) : null}
								{selected.heldReason ? (
									<p className="bg-warning/12 text-warning rounded-xl p-3 text-sm">
										<Trans>
											The server kept the last change for a manager to look at,
											because {heldBecause}. Nothing is lost.
										</Trans>
									</p>
								) : null}
								{!isSendable(selected, settings) ? (
									<p className="bg-warning/12 text-warning rounded-xl p-3 text-sm">
										{selected.origin === DEMO_ORIGIN ? (
											<Trans>
												This order was taken in demo mode, so it is kept here
												and never sent to a restaurant.
											</Trans>
										) : (
											<Trans>
												This order was taken for “{takenFor}”, so it is held
												here and not sent to the restaurant this till is set up
												for now.
											</Trans>
										)}
									</p>
								) : null}
								{selected.renumberedFrom ? (
									<p className="bg-muted text-muted-foreground rounded-xl p-3 text-sm">
										<Trans>
											This order was first shown as #{renumberedFrom}. It was
											renumbered because that number was already taken.
										</Trans>
									</p>
								) : null}
								{selected.lastError && selected.sync !== 'synced' ? (
									<div
										className={cn(
											'rounded-xl p-3 text-sm',
											selected.sync === 'rejected'
												? 'bg-destructive/10 text-destructive'
												: 'bg-warning/12 text-warning',
										)}
									>
										{selected.sync === 'rejected' ? (
											<Trans>The server refused this order:</Trans>
										) : (
											<Trans>Will retry automatically. Last problem:</Trans>
										)}{' '}
										{selected.lastError}
									</div>
								) : null}
								<ul className="divide-border border-border divide-y border-y">
									{selected.lines.map((l) => (
										<li
											key={l.id}
											className="flex items-start justify-between gap-4 py-4"
										>
											<div className="min-w-0 flex-1 break-words">
												<div className="font-medium">
													{l.quantity} × {l.name}
												</div>
												{l.variantLabel ? (
													<div className="text-muted-foreground text-sm">
														{l.variantLabel}
													</div>
												) : null}
												{l.options.map((o) => (
													<div
														key={o.groupId + o.optionId}
														className="text-muted-foreground text-sm"
													>
														{o.quantity > 1 ? `${o.quantity} × ` : ''}
														{o.optionName}
													</div>
												))}
												{l.instructions ? (
													<div className="text-muted-foreground text-sm italic">
														“{l.instructions}”
													</div>
												) : null}
											</div>
											<span className="tnum shrink-0 text-sm font-medium whitespace-nowrap">
												{money(lineTotalCents(l))}
											</span>
										</li>
									))}
								</ul>
								{(selected.lineVoids ?? []).length > 0 ? (
									<div className="border-border rounded-xl border border-dashed p-3 text-sm">
										<p className="mb-1 font-semibold">
											<Trans>Taken off</Trans>
										</p>
										<ul className="text-muted-foreground space-y-1">
											{selected.lineVoids.map((v) => (
												<li key={v.id} className="flex justify-between gap-3">
													<span>
														<s>
															{v.quantity} × {v.name}
														</s>{' '}
														· {reasonLabel(v.reason)}
														{v.by ? ` · ${v.by.name}` : ''}
														{v.approvedBy
															? ` (${_(t`approved by ${v.approvedBy.name}`)})`
															: ''}
													</span>
													<span className="tnum shrink-0 whitespace-nowrap">
														{money(v.unitCents * v.quantity)}
													</span>
												</li>
											))}
										</ul>
									</div>
								) : null}
								<dl className="tnum space-y-2 text-sm [&_dd]:shrink-0 [&_dd]:whitespace-nowrap [&>div]:gap-4">
									<div className="text-muted-foreground flex justify-between">
										<dt>
											<Trans>Subtotal</Trans>
										</dt>
										<dd>{money(selected.totals.subtotalCents)}</dd>
									</div>
									{selected.adjustments.map((a) => (
										<div
											key={a.id}
											className="text-muted-foreground flex justify-between"
										>
											<dt>{a.label}</dt>
											<dd>-{money(a.amountCents)}</dd>
										</div>
									))}
									<div className="text-muted-foreground flex justify-between">
										<dt>
											{selected.taxInclusive ? (
												<Trans>Includes tax</Trans>
											) : (
												<Trans>Tax</Trans>
											)}
										</dt>
										<dd>{money(selected.totals.taxCents)}</dd>
									</div>
									{selected.totals.tipCents > 0 ? (
										<div className="text-muted-foreground flex justify-between">
											<dt>
												<Trans>Tip</Trans>
											</dt>
											<dd>{money(selected.totals.tipCents)}</dd>
										</div>
									) : null}
									<div className="border-border flex justify-between border-t pt-3 text-lg font-semibold">
										<dt>
											<Trans>Total</Trans>
										</dt>
										<dd>{money(selected.totals.totalCents)}</dd>
									</div>
									{selected.payments.map((p) => (
										<div
											key={p.id}
											className="text-success flex justify-between"
										>
											<dt>
												{_(t`Paid`)} · {_(TENDER[p.method])}
												{p.reference ? ` · ${p.reference}` : ''}
												{p.staff && p.staff.id !== selected.staff?.id
													? ` · ${p.staff.name}`
													: ''}
											</dt>
											<dd>{money(p.amountCents)}</dd>
										</div>
									))}
									{(selected.refunds ?? []).map((r) => (
										<div
											key={r.id}
											className="text-destructive flex justify-between"
										>
											<dt>
												{_(t`Refunded`)} · {_(TENDER[r.method])} ·{' '}
												{reasonLabel(r.reason)}
												{r.approvedBy
													? ` · ${_(t`approved by ${r.approvedBy.name}`)}`
													: ''}
											</dt>
											<dd>-{money(r.amountCents)}</dd>
										</div>
									))}
									{selected.status === 'open' ? (
										<div className="flex justify-between text-lg font-semibold">
											<dt>
												<Trans>Balance due</Trans>
											</dt>
											<dd>{money(balanceCents(selected))}</dd>
										</div>
									) : null}
								</dl>
								<Receipt
									order={selected}
									businessName={businessName}
									vatNumber={vatNumber}
								/>
							</div>
							<div className="border-border bg-card shrink-0 space-y-3 border-t p-4">
								{error ? (
									<p
										role="alert"
										className="text-destructive text-sm font-medium"
									>
										{error}
									</p>
								) : null}
								<div className="flex flex-wrap items-center gap-2">
									{selected.status === 'open' && !selected.transferredTo ? (
										<>
											<Button variant="primary" onClick={() => onPay(selected)}>
												<CreditCard className="size-4" />{' '}
												<Trans>Pay {balanceDue}</Trans>
											</Button>
											{selected.payments.length === 0 ? (
												<Button
													variant="outline"
													onClick={() => onAddItems(selected)}
												>
													<PlusCircle className="size-4" />{' '}
													<Trans>Add items</Trans>
												</Button>
											) : null}
											{selected.payments.length === 0 ? (
												<Button
													variant="ghost"
													className="text-destructive"
													onClick={() => setCancelling(selected)}
												>
													<XCircle className="size-4" />{' '}
													<Trans>Cancel tab</Trans>
												</Button>
											) : null}
										</>
									) : null}
									{refundableCents(selected) > 0 ? (
										<Button
											variant="ghost"
											className="text-destructive"
											onClick={() => setRefunding(selected)}
										>
											<RotateCcw className="size-4" /> <Trans>Refund</Trans>
										</Button>
									) : null}
									<Button variant="outline" onClick={() => window.print()}>
										<Printer className="size-4" />{' '}
										{selected.status === 'open' ? (
											<Trans>Print bill</Trans>
										) : (
											<Trans>Print receipt</Trans>
										)}
									</Button>
									{selected.sync !== 'synced' ? (
										<Button
											variant="outline"
											onClick={() => {
												void requeueRejected(selected.id).then(onRetry)
											}}
										>
											<RefreshCw className="size-4" />{' '}
											{selected.sync === 'rejected' ? (
												<Trans>Try again</Trans>
											) : (
												<Trans>Send now</Trans>
											)}
										</Button>
									) : null}
								</div>
							</div>
						</section>
					) : null}
				</div>
			)}

			{cancelling ? (
				<AuditSheet
					title={_(t`Cancel tab #${cancellingNumber}?`)}
					description={_(
						t`The tab is kept, marked cancelled, with who cancelled it and why.`,
					)}
					confirmLabel={_(t`Cancel the tab`)}
					reasons={[
						'mistake',
						'guest_request',
						'out_of_stock',
						'quality',
						'other',
					]}
					me={me}
					needsManager={needsManager()}
					onApprove={approve}
					onClose={() => setCancelling(null)}
					onConfirm={async (audit) => {
						try {
							await voidTab(cancelling.id, audit)
							setCancelling(null)
							setSelectedId(null)
							setError(null)
							onRetry()
							return null
						} catch (e) {
							return e instanceof Error
								? e.message
								: _(t`Could not cancel the tab`)
						}
					}}
				/>
			) : null}
			{refunding ? (
				<RefundSheet
					order={refunding}
					onClose={() => setRefunding(null)}
					onDone={() => {
						setRefunding(null)
						onRetry()
					}}
				/>
			) : null}
		</Modal>
	)
}

/** How much to give back, why, and (when needed) a manager's approval. */
function RefundSheet({
	order,
	onClose,
	onDone,
}: {
	order: PosOrder
	onClose: () => void
	onDone: () => void
}) {
	const { _ } = useLingui()
	const me = usePos((s) => s.session?.staff ?? null)
	const needsManager = usePos((s) => s.needsManager)
	const approve = usePos((s) => s.approve)
	const money = moneyFormatter(order.currency)
	const available = refundableCents(order)
	// Starts empty: typing on a pre-filled amount would append to it. "Full
	// amount" fills it in one tap.
	const [digits, setDigits] = useState('')
	const [reference, setReference] = useState('')
	const typed = Number(digits || 0)
	const tooMuch = typed > available
	const amount = tooMuch ? 0 : typed
	const methods = [...new Set(order.payments.map((p) => p.method))].map((m) =>
		_(TENDER[m]),
	)
	const [first = '', second = ''] = methods
	const tenders =
		methods.length === 2 ? _(t`${first} and ${second}`) : methods.join(', ')
	const number = order.number
	const amountText = money(amount)
	const upTo = money(available)
	return (
		<AuditSheet
			title={_(t`Refund #${number}`)}
			description={_(
				t`Money goes back the way it was paid (${tenders}). Card refunds are made on the card terminal first; this records them.`,
			)}
			confirmLabel={amount > 0 ? _(t`Refund ${amountText}`) : _(t`Refund`)}
			reasons={['wrong_charge', 'quality', 'guest_request', 'mistake', 'other']}
			me={me}
			needsManager={needsManager()}
			onApprove={approve}
			onClose={onClose}
			canConfirm={amount > 0}
			onConfirm={async (audit) => {
				try {
					await refundOrder(order.id, {
						...audit,
						amountCents: amount,
						reference,
					})
					onDone()
					return null
				} catch (e) {
					return e instanceof Error
						? e.message
						: _(t`Could not record the refund`)
				}
			}}
		>
			<div className="space-y-2">
				<div className="border-primary flex items-baseline justify-between rounded-xl border px-4 py-3">
					<span className="text-muted-foreground text-sm">
						<Trans>Refund (up to {upTo})</Trans>
					</span>
					<span className="tnum mono text-2xl font-bold">{money(typed)}</span>
				</div>
				<Keypad value={digits} onChange={setDigits} />
				<Button
					variant="outline"
					className="w-full"
					disabled={typed === available}
					onClick={() => setDigits(String(available))}
				>
					<Trans>Full amount ({upTo})</Trans>
				</Button>
				{tooMuch ? (
					<p role="alert" className="text-destructive text-sm font-medium">
						<Trans>That is more than can be refunded (up to {upTo}).</Trans>
					</p>
				) : null}
				{order.payments.some((p) => p.method !== 'cash') ? (
					<label className="block text-sm font-semibold">
						<Trans>Card terminal refund code (optional)</Trans>
						<input
							value={reference}
							onChange={(event) =>
								setReference(event.target.value.slice(0, 64))
							}
							autoComplete="off"
							className="border-input bg-background mt-1 h-12 w-full rounded-xl border px-3 text-base font-normal"
						/>
					</label>
				) : null}
			</div>
		</AuditSheet>
	)
}

/** Open tabs held by this location's other terminals, which this one can take over. */
function OtherTerminalsTabs({ onTaken }: { onTaken: () => void }) {
	const { _ } = useLingui()
	const otherTabs = usePos((s) => s.otherTabs)
	const takeOverTab = usePos((s) => s.takeOverTab)
	const [state, setState] = useState<{
		loading: boolean
		tabs: OtherTab[]
		error: string | null
	}>({ loading: true, tabs: [], error: null })
	const [busyId, setBusyId] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		void otherTabs().then((result) => {
			if (!live) return
			setState(
				result.ok
					? { loading: false, tabs: result.tabs, error: null }
					: { loading: false, tabs: [], error: result.error },
			)
		})
		return () => {
			live = false
		}
	}, [otherTabs])

	if (state.loading) {
		return (
			<p className="text-muted-foreground p-10 text-center">
				<Trans>Asking the other terminals…</Trans>
			</p>
		)
	}
	if (state.error)
		return (
			<p role="alert" className="text-destructive p-10 text-center">
				{state.error}
			</p>
		)
	if (state.tabs.length === 0) {
		return (
			<p className="text-muted-foreground p-10 text-center">
				<Trans>No other terminal has an open tab right now.</Trans>
			</p>
		)
	}
	return (
		<ul className="divide-border divide-y">
			{state.tabs.map(({ terminal, order }) => {
				const money = moneyFormatter(order.currency)
				const paid = order.payments.reduce((s, p) => s + p.amountCents, 0)
				return (
					<li key={order.id} className="flex items-center gap-3 px-4 py-3">
						<div className="min-w-0 flex-1">
							<div className="font-semibold">#{order.number}</div>
							<div className="text-muted-foreground truncate text-sm">
								{terminal.label} ({terminal.code})
								{terminal.removed ? (
									<>
										{' · '}
										<Trans>terminal removed</Trans>
									</>
								) : null}
								{' · '}
								{placeLabel(_, order)}
								{order.staff ? ` · ${order.staff.name}` : ''}
							</div>
						</div>
						<span className="tnum mono font-semibold">
							{money(order.totals.totalCents - paid)}
						</span>
						<Button
							variant="outline"
							disabled={busyId !== null}
							onClick={() => {
								setBusyId(order.id)
								void takeOverTab({ terminal, order }).then((failed) => {
									setBusyId(null)
									if (failed) setState((s) => ({ ...s, error: failed }))
									else onTaken()
								})
							}}
						>
							<ArrowRightLeft className="size-4" />{' '}
							{busyId === order.id ? (
								<Trans>Taking over…</Trans>
							) : (
								<Trans>Take over</Trans>
							)}
						</Button>
					</li>
				)
			})}
		</ul>
	)
}

function StatusBadge({ order }: { order: PosOrder }) {
	const movedTo = order.transferredTo
	if (movedTo)
		return (
			<Badge>
				<Trans>Moved to {movedTo}</Trans>
			</Badge>
		)
	if (order.status === 'void')
		return (
			<Badge>
				<Trans>Cancelled</Trans>
			</Badge>
		)
	if (order.status === 'refunded')
		return (
			<Badge tone="danger">
				<Trans>Refunded</Trans>
			</Badge>
		)
	if (order.status === 'open') {
		return (
			<Badge tone="warning">
				{order.payments.length > 0 ? (
					<Trans>Part paid</Trans>
				) : (
					<Trans>Open tab</Trans>
				)}
			</Badge>
		)
	}
	if (order.heldReason)
		return (
			<Badge tone="warning">
				<Trans>Paid · held for review</Trans>
			</Badge>
		)
	if (order.sync === 'rejected')
		return (
			<Badge tone="danger">
				<Trans>Refused</Trans>
			</Badge>
		)
	if ((order.refunds ?? []).length > 0)
		return (
			<Badge tone="warning">
				<Trans>Part refunded</Trans>
			</Badge>
		)
	if (order.sync === 'synced')
		return (
			<Badge tone="success">
				<Trans>Paid · sent</Trans>
			</Badge>
		)
	return (
		<Badge tone="success">
			<Trans>Paid · waiting to send</Trans>
		</Badge>
	)
}
