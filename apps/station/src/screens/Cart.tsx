import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Minus,
	Pencil,
	Plus,
	ShoppingBag,
	Trash2,
	User,
	UtensilsCrossed,
	Armchair,
	Phone,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PhoneOrderSheet } from './PhoneOrderSheet.tsx'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { type OrderType } from '~/lib/db.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { type PhonePickup } from '~/lib/pickup.ts'
import {
	computeTotals,
	lineTotalCents,
	type Adjustment,
	type CartLine,
} from '~/lib/pricing.ts'
import { shownLine } from '~/lib/store.ts'
import {
	Button,
	IconButton,
	Modal,
	NumberPop,
	Reveal,
	Segmented,
	cn,
	fieldClass,
} from '~/ui/primitives.tsx'

export function Cart({
	tabNumber,
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
			<div className="border-border shrink-0 space-y-3 border-b p-4">
				{showHeading ? (
					<div className="flex items-center justify-between gap-3">
						<h2 className="text-lg font-semibold">
							<Trans>Current order</Trans>
						</h2>
						<span className="tnum mono bg-muted text-muted-foreground flex h-7 min-w-7 items-center justify-center rounded-lg px-2 text-sm">
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
									icon: <Armchair className="size-4" />,
								},
								{
									value: 'takeaway',
									label: _(t`Takeaway`),
									icon: <ShoppingBag className="size-4" />,
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
							<Trash2 className="size-5" />
						</IconButton>
					) : null}
				</div>
				{orderSource === 'phone' ? (
					<button
						type="button"
						onClick={() => setPhoneDetailsOpen(true)}
						aria-label={_(t`Edit phone order details`)}
						className="border-border hover:bg-accent flex w-full items-start justify-between gap-3 rounded-xl border p-3 text-start transition"
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
						<Pencil className="mt-1 size-4 shrink-0" />
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={() => setNaming(true)}
							className="border-border text-muted-foreground hover:bg-accent hover:text-foreground flex h-12 w-full items-center gap-3 rounded-xl border border-dashed px-3 text-start transition active:scale-[0.99]"
						>
							{orderType === 'dine_in' ? (
								<UtensilsCrossed className="size-5" />
							) : (
								<User className="size-5" />
							)}
							<span
								className={cn(
									'flex-1 truncate',
									detail && 'text-foreground font-semibold',
								)}
							>
								{detailText}
							</span>
							<Pencil className="size-4" />
						</button>
						<Button
							variant="outline"
							className="w-full"
							onClick={() => setPhoneDetailsOpen(true)}
						>
							<Phone className="size-4" />
							<Trans>Phone order</Trans>
						</Button>
					</>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{lines.length === 0 ? (
					<div className="t-rise text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
						<div className="bg-muted flex size-16 items-center justify-center rounded-full">
							<ShoppingBag className="size-7" />
						</div>
						<p className="text-foreground text-lg font-semibold">
							<Trans>No items yet</Trans>
						</p>
						<p className="text-sm">
							<Trans>Tap a dish on the menu to start the order.</Trans>
						</p>
					</div>
				) : (
					<ul className="divide-border divide-y">
						{lines.map((line) => (
							<LineItem
								key={line.id}
								line={line}
								fresh={seen.current !== null && !seen.current.has(line.id)}
								money={money}
								onEdit={onEdit}
								onQuantity={onQuantity}
								onRemove={onRemove}
							/>
						))}
					</ul>
				)}
			</div>

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
					<input
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
						className={cn(fieldClass, 'h-14 px-4 text-lg')}
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
	fresh,
	money,
	onEdit,
	onQuantity,
	onRemove,
}: {
	line: CartLine
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
		<li ref={ref} className={cn('p-4', isFresh && 't-rise')}>
			<div className="flex items-start gap-3">
				<button
					type="button"
					onClick={() => onEdit(line)}
					className="min-w-0 flex-1 text-start"
					aria-label={_(t`Edit ${shown.name}`)}
				>
					<div className="leading-tight font-semibold">{name}</div>
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
				<NumberPop
					value={money(lineTotalCents(line))}
					className="tnum shrink-0 font-semibold"
				/>
			</div>
			<div className="mt-2 flex items-center justify-between">
				<div className="bg-muted flex items-center gap-1 rounded-xl p-0.5">
					<IconButton
						label={_(t`Fewer ${shown.name}`)}
						onClick={() => onQuantity(line.id, line.quantity - 1)}
					>
						{/* At one, the minus becomes a bin: the next tap takes the line off. */}
						<span
							className="t-icon-swap"
							data-state={line.quantity === 1 ? 'b' : 'a'}
						>
							<Minus className="t-icon size-4" data-icon="a" />
							<Trash2 className="t-icon size-4" data-icon="b" />
						</span>
					</IconButton>
					<span
						className="tnum mono w-8 text-center font-bold"
						aria-live="polite"
					>
						<NumberPop value={String(line.quantity)} />
					</span>
					<IconButton
						label={_(t`More ${shown.name}`)}
						onClick={() => onQuantity(line.id, line.quantity + 1)}
					>
						<Plus className="size-4" />
					</IconButton>
				</div>
				<button
					type="button"
					className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive min-h-11 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
					onClick={() => onRemove(line.id)}
				>
					<Trans>Remove</Trans>
				</button>
			</div>
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
