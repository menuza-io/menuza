import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Empty,
	EmptyHeader,
	EmptyTitle,
	EmptyDescription,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Item, ItemContent, ItemActions, ItemFooter } from '@repo/ui/item'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DishStatusBadge, RoundHeading } from './KitchenRounds.tsx'
import { PhoneOrderSheet } from './PhoneOrderSheet.tsx'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { type OrderType } from '~/lib/db.ts'
import {
	dishStatuses,
	type DishStatus,
	useKitchenTickets,
} from '~/lib/kitchen-status.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { MAX_ORDER_LINES } from '~/lib/orders.ts'
import { type PhonePickup } from '~/lib/pickup.ts'
import {
	computeTotals,
	lineTotalCents,
	type Adjustment,
	type CartLine,
} from '~/lib/pricing.ts'
import { roundsOf, servedOf } from '~/lib/rounds.ts'
import { shownLine } from '~/lib/store.ts'
import {
	Button,
	IconButton,
	Modal,
	NumberPop,
	Reveal,
	Segmented,
	cn,
	Input,
} from '~/ui/primitives.tsx'

export function Cart({
	tabNumber,
	orderId = null,
	onRepeat,
	sameTableTab = null,
	onJoinTab,
	error,
	lines,
	adjustments,
	taxRatePercent,
	taxInclusive = false,
	orderType,
	customerName,
	orderSource,
	customerPhone,
	pickupAt,
	pickupTimeZone,
	timeZone,
	onPhoneOrder,
	onCounterOrder,
	tableLabel,
	money,
	onOrderType,
	onCustomer,
	onTable,
	onQuantity,
	onEdit,
	onRemove,
	onClear,
	onCharge,
	onSaveTab,
	showHeading = true,
}: {
	/** Set when the cart is an open tab being added to. */
	tabNumber: string | null
	/** That tab's order id: its sent dishes show where they are in the kitchen. */
	orderId?: string | null
	/** Ring a sent round again as new items. */
	onRepeat?: (lines: CartLine[]) => void
	/** Another open tab already has this table (its number): offer to add to it instead. */
	sameTableTab?: string | null
	onJoinTab?: () => void
	error: string | null
	lines: CartLine[]
	adjustments: Adjustment[]
	taxRatePercent: number
	/** Prices already include the tax: it is shown, not added. */
	taxInclusive?: boolean
	orderType: OrderType
	customerName: string
	orderSource: 'counter' | 'phone'
	customerPhone: string
	pickupAt: number | null
	pickupTimeZone: string | null
	timeZone?: string
	onPhoneOrder: (details: PhonePickup) => void
	onCounterOrder: () => void
	tableLabel: string
	money: MoneyFormatter
	onOrderType: (type: OrderType) => void
	onCustomer: (name: string) => void
	onTable: (label: string) => void
	onQuantity: (id: string, quantity: number) => void
	onEdit: (line: CartLine) => void
	onRemove: (id: string) => void
	onClear: () => void
	onCharge: () => void
	/** Saves the order unpaid, to be settled later (the guest pays on the way out). */
	onSaveTab: () => void
	/** The phone sheet already supplies this heading. */
	showHeading?: boolean
}) {
	const { _ } = useLingui()
	const [naming, setNaming] = useState(false)
	const [phoneDetailsOpen, setPhoneDetailsOpen] = useState(false)
	const totals = computeTotals({
		lines,
		taxRatePercent,
		taxInclusive,
		adjustments,
	})
	const count = lines.reduce((s, l) => s + l.quantity, 0)
	// A tab that already went to the kitchen shows each round, and what is not sent yet.
	const rounds = roundsOf(lines)
	const tracked = rounds.some((round) => round.sentAt !== null)
	const tickets = useKitchenTickets(Boolean(orderId))
	const statuses = dishStatuses(
		lines,
		orderId ? tickets?.get(orderId) : undefined,
	)
	// Lines on screen at first paint (opening the sheet, loading a tab) appear as
	// they are; only lines added after that rise in and scroll into view.
	const seen = useRef<Set<string> | null>(null)
	useEffect(() => {
		seen.current = new Set(lines.map((l) => l.id))
	}, [lines])
	const detail = orderType === 'dine_in' ? tableLabel : customerName
	const detailText =
		orderType === 'dine_in'
			? detail
				? _(t`Table: ${detail}`)
				: _(t`Add table`)
			: detail
				? _(t`Name: ${detail}`)
				: _(t`Add name`)
	const taxLabel = taxInclusive
		? taxRatePercent
			? _(t`Includes tax (${taxRatePercent}%)`)
			: _(t`Includes tax`)
		: taxRatePercent
			? _(t`Tax (${taxRatePercent}%)`)
			: _(t`Tax`)

	return (
		<section
			aria-label={_(t`Current order`)}
			className="bg-card @container flex min-h-0 flex-1 flex-col"
		>
			<div className="border-border shrink-0 space-y-2 border-b px-4 py-3">
				{showHeading ? (
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-base font-semibold">
							<Trans>Current order</Trans>
						</h2>
						<span className="tnum text-muted-foreground text-sm">
							<NumberPop value={String(count)} />
						</span>
					</div>
				) : null}
				<Reveal open={Boolean(tabNumber)}>
					<div className="bg-primary/10 text-primary flex items-center justify-between rounded-xl px-3 py-2 text-sm font-semibold">
						<span>
							<Trans>Adding to tab #{tabNumber}</Trans>
						</span>
					</div>
				</Reveal>
				<div className="flex items-center justify-between gap-2">
					{orderSource === 'phone' ? (
						<Button variant="outline" onClick={onCounterOrder}>
							<Trans>Switch to counter</Trans>
						</Button>
					) : (
						<Segmented
							label={_(t`Order type`)}
							value={orderType}
							onChange={onOrderType}
							options={[
								{
									value: 'dine_in',
									label: _(t`Dine in`),
									icon: <Icon name="armchair" className="size-4" />,
								},
								{
									value: 'takeaway',
									label: _(t`Takeaway`),
									icon: <Icon name="shopping-bag" className="size-4" />,
								},
							]}
						/>
					)}
					{lines.length > 0 || orderSource === 'phone' ? (
						<IconButton
							label={_(t`Clear order`)}
							onClick={onClear}
							className="text-muted-foreground"
						>
							<Icon name="trash-2" className="size-5" />
						</IconButton>
					) : null}
				</div>
				{orderSource === 'phone' ? (
					<button
						type="button"
						onClick={() => setPhoneDetailsOpen(true)}
						aria-label={_(t`Edit phone order details`)}
						className="hover:bg-accent flex min-h-11 w-full items-start justify-between gap-3 rounded-(--station-control-radius) p-3 text-start transition"
					>
						<PhonePickupDetails
							order={{
								orderSource,
								customerName,
								customerPhone,
								pickupAt,
								pickupTimeZone,
							}}
						/>
						<Icon name="pencil" className="mt-1 size-4 shrink-0 self-start" />
					</button>
				) : (
					<div className="flex min-w-0 items-center gap-1">
						<button
							type="button"
							onClick={() => setNaming(true)}
							className="text-muted-foreground hover:bg-accent hover:text-foreground flex min-h-11 w-full items-center gap-3 rounded-(--station-control-radius) px-3 text-start text-sm transition"
						>
							{orderType === 'dine_in' ? (
								<Icon name="utensils-crossed" className="size-5" />
							) : (
								<Icon name="user" className="size-5" />
							)}
							<span
								className={cn(
									'flex-1 truncate',
									detail && 'text-foreground font-semibold',
								)}
							>
								{detailText}
							</span>
							<Icon name="pencil" className="size-4" />
						</button>
						<IconButton
							label={_(t`Phone order`)}
							onClick={() => setPhoneDetailsOpen(true)}
						>
							<Icon name="phone" className="size-4" />
						</IconButton>
					</div>
				)}
			</div>

			{sameTableTab && onJoinTab ? (
				<button
					type="button"
					onClick={onJoinTab}
					className="notice-warning flex w-full items-center gap-2 px-4 py-2.5 text-start text-sm"
				>
					<Icon name="receipt-text" aria-hidden className="size-4 shrink-0" />
					<span className="min-w-0 flex-1">
						<Trans>
							This table already has tab #{sameTableTab}. Add these items to it
						</Trans>
					</span>
					<Icon
						name="chevron-right"
						aria-hidden
						className="size-4 shrink-0 rtl:rotate-180"
					/>
				</button>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{lines.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyTitle>
								<Trans>No items yet</Trans>
							</EmptyTitle>
							<EmptyDescription>
								<Trans>Tap a dish on the menu to start the order.</Trans>
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div>
						{rounds.map((round) => (
							<div key={round.sentAt ?? 'new'}>
								{tracked ? (
									<RoundHeading
										sentAt={round.sentAt}
										servedAt={servedOf(round.lines)}
										onRepeat={
											onRepeat && round.sentAt !== null
												? () => onRepeat(round.lines)
												: undefined
										}
										items={round.lines.reduce((sum, l) => sum + l.quantity, 0)}
									/>
								) : null}
								<ul className="divide-border divide-y">
									{round.lines.map((line) => (
										<LineItem
											key={line.id}
											line={line}
											status={statuses.get(line.id) ?? null}
											fresh={
												seen.current !== null && !seen.current.has(line.id)
											}
											money={money}
											onEdit={onEdit}
											onQuantity={onQuantity}
											onRemove={onRemove}
										/>
									))}
								</ul>
							</div>
						))}
					</div>
				)}
			</div>

			{lines.length >= MAX_ORDER_LINES - 5 ? (
				// Each round is new lines: a long tab nears what one order can hold.
				<p className="notice-warning px-4 py-2 text-sm">
					{lines.length > MAX_ORDER_LINES
						? _(
								t`This order has more than ${MAX_ORDER_LINES} lines and cannot be saved. Take off the newest items and ring them up as a new order.`,
							)
						: _(
								t`This order is close to the ${MAX_ORDER_LINES}-line limit. Ring many more rounds as a new order.`,
							)}
				</p>
			) : null}
			<div className="border-border bg-card shrink-0 space-y-4 border-t p-4">
				<dl className="tnum space-y-1 text-sm">
					<Row
						label={_(
							plural(count, {
								one: 'Subtotal · # item',
								other: 'Subtotal · # items',
							}),
						)}
						value={money(totals.subtotalCents)}
					/>
					{adjustments.map((a) => (
						<Row
							key={a.id}
							label={a.label}
							value={`-${money(a.amountCents)}`}
							tone="success"
						/>
					))}
					<Row label={taxLabel} value={money(totals.taxCents)} />
				</dl>
				<Reveal open={Boolean(error)}>
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				</Reveal>
				<div className="grid grid-cols-1 gap-2 @sm:grid-cols-[auto_minmax(0,1fr)]">
					<Button
						variant="outline"
						size="xl"
						className="px-5 text-base"
						disabled={lines.length === 0}
						onClick={onSaveTab}
					>
						{orderSource === 'phone' ? (
							<Trans>Pay at pickup</Trans>
						) : tabNumber ? (
							<Trans>Save tab</Trans>
						) : (
							<Trans>Pay later</Trans>
						)}
					</Button>
					<Button
						variant="primary"
						size="xl"
						className="order-first justify-between px-4 @sm:order-none"
						disabled={lines.length === 0}
						onClick={onCharge}
					>
						<span>
							{orderSource === 'phone' ? (
								<Trans>Pay now</Trans>
							) : (
								<Trans>Charge</Trans>
							)}
						</span>
						<NumberPop
							value={money(totals.totalCents)}
							className="tnum whitespace-nowrap"
						/>
					</Button>
				</div>
			</div>

			{phoneDetailsOpen ? (
				<PhoneOrderSheet
					details={{ customerName, customerPhone, pickupAt, pickupTimeZone }}
					timeZone={timeZone}
					onClose={() => setPhoneDetailsOpen(false)}
					onSave={(details) => {
						onPhoneOrder(details)
						setPhoneDetailsOpen(false)
					}}
				/>
			) : null}
			<Modal
				open={naming}
				onClose={() => setNaming(false)}
				title={orderType === 'dine_in' ? _(t`Table`) : _(t`Customer name`)}
			>
				<form
					className="space-y-4 p-5"
					onSubmit={(event) => {
						event.preventDefault()
						setNaming(false)
					}}
				>
					<Input
						autoFocus
						aria-label={
							orderType === 'dine_in' ? _(t`Table`) : _(t`Customer name`)
						}
						value={detail}
						onChange={(e) =>
							orderType === 'dine_in'
								? onTable(e.target.value)
								: onCustomer(e.target.value)
						}
						maxLength={orderType === 'dine_in' ? 20 : 60}
						placeholder={
							orderType === 'dine_in'
								? _(t`e.g. 12 or Patio 3`)
								: _(t`Name for the order`)
						}
						className="h-14 px-4"
					/>
					<Button type="submit" variant="primary" size="lg" className="w-full">
						<Trans>Done</Trans>
					</Button>
				</form>
			</Modal>
		</section>
	)
}

/** One order line: tap to edit, step the quantity, or take it off. */
function LineItem({
	line,
	status,
	fresh,
	money,
	onEdit,
	onQuantity,
	onRemove,
}: {
	line: CartLine
	/** Where it is in the kitchen, once sent (null: not sent, or no kitchen to ask). */
	status: DishStatus | null
	/** Added since the cart first showed: rise in and scroll into view. */
	fresh: boolean
	money: MoneyFormatter
	onEdit: (line: CartLine) => void
	onQuantity: (id: string, quantity: number) => void
	onRemove: (id: string) => void
}) {
	const { _ } = useLingui()
	// Its names in this till's language (lines record the restaurant's).
	const shown = shownLine(line)
	const name = shown.name
	const ref = useRef<HTMLLIElement>(null)
	const [isFresh] = useState(fresh)
	const quantity = useRef(line.quantity)

	useLayoutEffect(() => {
		if (!isFresh) return
		ref.current?.scrollIntoView({
			block: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth',
		})
	}, [isFresh])

	// The same dish tapped again grows this line: flash it so the cashier sees where.
	useLayoutEffect(() => {
		const el = ref.current
		const grew = line.quantity > quantity.current
		quantity.current = line.quantity
		if (!el || !grew) return
		el.classList.remove('t-flash')
		void el.offsetWidth
		el.classList.add('t-flash')
	}, [line.quantity])

	return (
		<li ref={ref} className={cn('px-1 py-1', isFresh && 't-rise')}>
			<Item size="sm">
				<ItemContent className="min-w-0">
					<button
						type="button"
						onClick={() => onEdit(line)}
						className="min-h-11 min-w-0 text-start"
						aria-label={_(t`Edit ${shown.name}`)}
					>
						<div className="leading-snug font-semibold break-words">{name}</div>
						{status ? (
							<div className="mt-1">
								<DishStatusBadge status={status} />
							</div>
						) : null}
						{shown.variantLabel ? (
							<div className="text-muted-foreground text-sm">
								{shown.variantLabel}
							</div>
						) : null}
						{shown.options.map((o) => (
							<div
								key={`${o.groupId}:${o.optionId}`}
								className="text-muted-foreground text-sm"
							>
								{o.quantity > 1 ? `${o.quantity}× ` : ''}
								{o.optionName}
								{o.unitCents > 0 ? ` +${money(o.unitCents * o.quantity)}` : ''}
							</div>
						))}
						{line.instructions ? (
							<div className="text-warning text-sm italic">
								“{line.instructions}”
							</div>
						) : null}
					</button>
				</ItemContent>
				<ItemActions>
					<NumberPop
						value={money(lineTotalCents(line))}
						className="tnum shrink-0 font-semibold"
					/>
				</ItemActions>
				<ItemFooter>
					<div className="flex items-center gap-1">
						<IconButton
							label={_(t`Fewer ${shown.name}`)}
							onClick={() => onQuantity(line.id, line.quantity - 1)}
						>
							{/* At one, the minus becomes a bin: the next tap takes the line off. */}
							<span
								className="t-icon-swap"
								data-state={line.quantity === 1 ? 'b' : 'a'}
							>
								<span className="t-icon inline-flex size-4" data-icon="a">
									<Icon name="minus" className="size-4" />
								</span>
								<span className="t-icon inline-flex size-4" data-icon="b">
									<Icon name="trash-2" className="size-4" />
								</span>
							</span>
						</IconButton>
						<span
							className="tnum w-8 text-center text-sm font-medium"
							aria-live="polite"
						>
							<NumberPop value={String(line.quantity)} />
						</span>
						<IconButton
							label={_(t`More ${shown.name}`)}
							onClick={() => onQuantity(line.id, line.quantity + 1)}
						>
							<Icon name="plus" className="size-4" />
						</IconButton>
					</div>
					<button
						type="button"
						className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
						onClick={() => onRemove(line.id)}
					>
						<Trans>Remove</Trans>
					</button>
				</ItemFooter>
			</Item>
		</li>
	)
}

function Row({
	label,
	value,
	tone,
}: {
	label: string
	value: string
	tone?: 'success'
}) {
	return (
		<div
			className={cn(
				'flex justify-between gap-3',
				tone === 'success' ? 'text-success' : 'text-muted-foreground',
			)}
		>
			<dt>{label}</dt>
			<dd className="shrink-0">{value}</dd>
		</div>
	)
}
