import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	Banknote,
	CreditCard,
	Printer,
	Receipt as ReceiptIcon,
	Wallet,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { Receipt } from './Receipt.tsx'
import { quickCashAmounts } from '~/lib/cash.ts'
import { type PosOrder, type StaffRef, type TenderMethod } from '~/lib/db.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import {
	addPayment,
	closeFreeOrder,
	createFreeOrder,
	createOrder,
	paidCents,
	type OrderDraft,
} from '~/lib/orders.ts'
import { computeTotals, lineTotalCents } from '~/lib/pricing.ts'
import { shownLine } from '~/lib/store.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import {
	Badge,
	Button,
	Chip,
	Modal,
	NumberPop,
	Reveal,
	Segmented,
	cn,
	fieldClass,
} from '~/ui/primitives.tsx'

const TIP_PRESETS = [0, 10, 15, 20]
const SPLITS = [2, 3, 4]
const METHOD_LABEL: Record<TenderMethod, MessageDescriptor> = {
	cash: msg`Cash`,
	card: msg`Card`,
	other: msg`Other`,
}

type Mode =
	{ kind: 'full' } | { kind: 'split'; ways: number } | { kind: 'custom' }
type Field = 'amount' | 'cash'

/**
 * Takes payment for a new order or for an existing tab. A bill may be paid in
 * several payments (split between guests, or part cash and part card); it
 * closes when the payments cover the total. Closing this sheet part-way leaves
 * the order open as a tab.
 */
export function Checkout({
	draft,
	existing,
	businessName,
	money,
	tipsEnabled,
	staff,
	vatNumber = null,
	onSaved,
	onClose,
}: {
	draft: OrderDraft
	/** The saved tab being paid, or null for a brand-new order. */
	existing: PosOrder | null
	businessName: string
	money: MoneyFormatter
	tipsEnabled: boolean
	/** Who is taking the payment (the person signed in now), or null when sign-in is off. */
	staff: StaffRef | null
	/** The seller's VAT number, for the receipt. */
	vatNumber?: string | null
	/** Called each time a payment is safely stored, so it can start sending at once. */
	onSaved: () => void
	/** `finished` is true when the bill was fully paid. */
	onClose: (result: { order: PosOrder | null; finished: boolean }) => void
}) {
	const { _ } = useLingui()
	const [current, setCurrent] = useState<PosOrder | null>(existing)
	const [tipPercent, setTipPercent] = useState(0)
	const [method, setMethod] = useState<TenderMethod>('cash')
	const [mode, setMode] = useState<Mode>({ kind: 'full' })
	const [field, setField] = useState<Field>('cash')
	const [customDigits, setCustomDigits] = useState('')
	const [cashDigits, setCashDigits] = useState('')
	/** Approval code from the card terminal, so the sale can be matched to the processor's statement. */
	const [reference, setReference] = useState('')
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState<PosOrder | null>(null)
	/** Change owed for the payment just taken while the bill is still open. */
	const [giveChange, setGiveChange] = useState<number | null>(null)

	const hasPayments = (current?.payments.length ?? 0) > 0
	// Once a payment exists the bill is frozen at what it was. Before that, the
	// totals follow the tip being chosen, including for a saved tab being paid.
	const totals = useMemo(
		() =>
			current && hasPayments
				? current.totals
				: computeTotals({
						lines: draft.lines,
						taxRatePercent: draft.taxRatePercent,
						taxInclusive: draft.taxInclusive,
						tipPercent,
						adjustments: draft.adjustments,
					}),
		[current, hasPayments, draft, tipPercent],
	)
	// Tips are chosen once, before the first payment, so shares never drift.
	const tipLocked = hasPayments
	const paid = current ? paidCents(current) : 0
	const remaining = Math.max(0, totals.totalCents - paid)

	const applied =
		mode.kind === 'full'
			? remaining
			: mode.kind === 'split'
				? Math.min(remaining, Math.ceil(totals.totalCents / mode.ways))
				: Math.min(remaining, customDigits ? Number(customDigits) : 0)
	const cashEntered = cashDigits ? Number(cashDigits) : 0
	const tendered = method === 'cash' && cashEntered > 0 ? cashEntered : applied
	const change = method === 'cash' ? Math.max(0, tendered - applied) : 0
	const short = method === 'cash' && cashEntered > 0 && cashEntered < applied
	const quick = useMemo(() => quickCashAmounts(applied), [applied])
	// A bill that comes to nothing has no payment to take: it is simply closed.
	const free = totals.totalCents === 0 && !hasPayments
	const canConfirm = !saving && (free || (applied > 0 && !short))

	// After a payment the next one starts fresh, but a chosen split carries on:
	// the next guest pays their share, not the whole remaining balance.
	const resetEntry = () => {
		setMode((current) =>
			current.kind === 'split' ? current : { kind: 'full' },
		)
		setCustomDigits('')
		setCashDigits('')
		setReference('')
		setField('cash')
	}

	const keypadValue =
		method === 'cash' && field === 'cash' ? cashDigits : customDigits
	const onKeypad = (next: string) => {
		if (method === 'cash' && field === 'cash') setCashDigits(next)
		else {
			setCustomDigits(next)
			setMode({ kind: 'custom' })
		}
	}

	const confirm = async () => {
		if (!canConfirm) return
		setSaving(true)
		setError(null)
		try {
			if (free) {
				const closed = current
					? await closeFreeOrder(current.id)
					: await createFreeOrder({ ...draft, tipCents: 0 })
				setCurrent(closed)
				onSaved()
				setDone(closed)
				return
			}
			const payment = {
				method,
				amountCents: applied,
				tenderedCents: tendered,
				changeCents: change,
				staff,
				reference: method === 'cash' ? null : reference.trim() || null,
			}
			const next = current
				? await addPayment(
						current.id,
						payment,
						tipLocked ? undefined : totals.tipCents,
					)
				: await createOrder({ ...draft, tipCents: totals.tipCents }, payment)
			setCurrent(next)
			onSaved()
			resetEntry()
			// Change is for the payment just taken; say so now, while the guest is still there.
			setGiveChange(
				next.status !== 'paid' && payment.changeCents > 0
					? payment.changeCents
					: null,
			)
			if (next.status === 'paid') setDone(next)
		} catch (e) {
			setError(
				e instanceof Error ? e.message : _(t`Could not save the payment`),
			)
		} finally {
			setSaving(false)
		}
	}

	if (done) {
		// Change from earlier payments was handed over at the time; only the last one is owed now.
		const totalChange = done.payments.at(-1)?.changeCents ?? 0
		const doneNumber = done.number
		return (
			<Modal
				open
				onClose={() => onClose({ order: done, finished: true })}
				title={_(t`Paid`)}
				size="md"
				dismissible={false}
			>
				<div className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">
					{/* The one celebration on the till: the disc pops, the check draws itself in. */}
					<div className="t-success-disc bg-success flex size-20 items-center justify-center rounded-full text-white">
						<span className="t-success-check" data-state="in" aria-hidden>
							<svg
								viewBox="0 0 24 24"
								className="size-10"
								fill="none"
								stroke="currentColor"
								strokeWidth={3}
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
						</span>
					</div>
					<p className="text-muted-foreground text-sm font-medium">
						<Trans>Order #{doneNumber}</Trans>
					</p>
					<p className="tnum text-4xl font-semibold">
						{money(done.totals.totalCents)}
					</p>
					{done.payments.length > 1 ? (
						<ul className="tnum text-muted-foreground w-full max-w-xs space-y-1 text-sm">
							{done.payments.map((p) => (
								<li key={p.id} className="flex justify-between">
									<span>{_(METHOD_LABEL[p.method])}</span>
									<span>{money(p.amountCents)}</span>
								</li>
							))}
						</ul>
					) : null}
					{totalChange > 0 ? (
						<div className="bg-warning/15 rounded-2xl px-6 py-3">
							<p className="text-warning text-sm font-medium">
								<Trans>Change due</Trans>
							</p>
							<p className="tnum text-3xl font-semibold">
								{money(totalChange)}
							</p>
						</div>
					) : null}
					<div className="mt-4 grid w-full grid-cols-2 gap-3">
						<Button variant="outline" size="lg" onClick={() => window.print()}>
							<Printer className="size-5" /> <Trans>Receipt</Trans>
						</Button>
						<Button
							variant="primary"
							size="lg"
							onClick={() => onClose({ order: done, finished: true })}
							autoFocus
						>
							<Trans>New order</Trans>
						</Button>
					</div>
				</div>
				<Receipt
					order={done}
					businessName={businessName}
					vatNumber={vatNumber}
				/>
			</Modal>
		)
	}

	const lines = current?.lines ?? draft.lines
	const appliedText = money(applied)
	const shortBy = money(applied - cashEntered)
	const leftAfter = money(remaining - applied)
	const confirmLabel = saving
		? _(t`Saving…`)
		: free
			? _(t`Close order · nothing to pay`)
			: applied <= 0
				? _(t`Enter an amount`)
				: short
					? _(t`${shortBy} short`)
					: applied < remaining
						? _(t`Take ${appliedText} · ${leftAfter} left`)
						: _(t`Confirm ${appliedText}`)
	const currentNumber = current?.number ?? ''
	const remainingText = money(remaining)
	const shareText =
		mode.kind === 'split' ? money(Math.ceil(totals.totalCents / mode.ways)) : ''
	const changeText = money(change)
	const giveChangeText = giveChange !== null ? money(giveChange) : ''

	return (
		<Modal
			open
			onClose={() => onClose({ order: current, finished: false })}
			title={current ? _(t`Pay · #${currentNumber}`) : _(t`Charge`)}
			size="lg"
			footer={
				<Button
					variant="primary"
					size="xl"
					className="w-full"
					disabled={!canConfirm}
					onClick={confirm}
				>
					{confirmLabel}
				</Button>
			}
		>
			<div className="grid gap-0 md:grid-cols-[1fr_1.1fr]">
				<section
					aria-label={_(t`Bill`)}
					className="border-border border-b p-4 sm:p-6 md:border-e md:border-b-0"
				>
					<h3 className="mb-3 text-base font-semibold">
						<Trans>Order summary</Trans>
					</h3>
					{draft.orderSource === 'phone' ? (
						<div className="mb-4">
							<PhonePickupDetails order={draft} />
						</div>
					) : null}
					<ul className="divide-border border-border mb-4 max-h-48 divide-y overflow-y-auto border-y text-sm md:max-h-64">
						{lines.map(shownLine).map((l) => (
							<li
								key={l.id}
								className="flex items-start justify-between gap-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<p className="font-medium break-words">
										{l.quantity} × {l.name}
									</p>
									{l.variantLabel ? (
										<p className="text-muted-foreground mt-1">
											{l.variantLabel}
										</p>
									) : null}
									{l.options.length > 0 ? (
										<p className="text-muted-foreground mt-1">
											{l.options
												.map(
													(option) =>
														`${option.quantity > 1 ? `${option.quantity} × ` : ''}${option.optionName}`,
												)
												.join(', ')}
										</p>
									) : null}
									{l.instructions ? (
										<p className="text-muted-foreground mt-1 break-words">
											{l.instructions}
										</p>
									) : null}
								</div>
								<span className="tnum shrink-0 font-medium whitespace-nowrap">
									{money(lineTotalCents(l))}
								</span>
							</li>
						))}
					</ul>
					<dl className="tnum text-muted-foreground space-y-2 text-sm">
						<Row label={_(t`Subtotal`)} value={money(totals.subtotalCents)} />
						{(current?.adjustments ?? draft.adjustments).map((a) => (
							<Row
								key={a.id}
								label={a.label}
								value={`-${money(a.amountCents)}`}
							/>
						))}
						<Row
							label={draft.taxInclusive ? _(t`Includes tax`) : _(t`Tax`)}
							value={money(totals.taxCents)}
						/>
						{totals.tipCents > 0 ? (
							<Row label={_(t`Tip`)} value={money(totals.tipCents)} />
						) : null}
						{hasPayments ? (
							<Row label={_(t`Total`)} value={money(totals.totalCents)} />
						) : null}
						{current?.payments.map((p) => (
							<Row
								key={p.id}
								label={`${_(t`Paid`)} · ${_(METHOD_LABEL[p.method])}`}
								value={`-${money(p.amountCents)}`}
								tone="success"
							/>
						))}
					</dl>
					<div className="border-border mt-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t pt-4">
						<span className="text-lg font-semibold">
							{hasPayments ? <Trans>Balance</Trans> : <Trans>Total due</Trans>}
						</span>
						<NumberPop
							value={money(remaining)}
							className="tnum text-2xl font-semibold whitespace-nowrap"
						/>
					</div>
					{tipsEnabled && !tipLocked ? (
						<div className="mt-4">
							<p className="mb-2 text-sm font-semibold">
								<Trans>Tip</Trans>
							</p>
							<div className="grid grid-cols-4 gap-2">
								{TIP_PRESETS.map((p) => (
									<Chip
										key={p}
										selected={tipPercent === p}
										aria-pressed={tipPercent === p}
										onClick={() => setTipPercent(p)}
										className="tnum px-2"
									>
										{p === 0 ? <Trans>None</Trans> : `${p}%`}
									</Chip>
								))}
							</div>
						</div>
					) : null}
				</section>

				<section aria-label={_(t`Payment`)} className="space-y-4 p-4 sm:p-5">
					<div>
						<p className="mb-2 text-sm font-semibold">
							<Trans>How much now?</Trans>
						</p>
						<div className="flex flex-wrap gap-2">
							<Chip
								selected={mode.kind === 'full'}
								aria-pressed={mode.kind === 'full'}
								className="tnum px-4"
								onClick={() => {
									setMode({ kind: 'full' })
									setCustomDigits('')
									setField('cash')
								}}
							>
								<Trans>Full · {remainingText}</Trans>
							</Chip>
							{SPLITS.map((n) => (
								<Chip
									key={n}
									selected={mode.kind === 'split' && mode.ways === n}
									aria-pressed={mode.kind === 'split' && mode.ways === n}
									className="tnum px-4"
									onClick={() => {
										setMode({ kind: 'split', ways: n })
										setCustomDigits('')
										setField('cash')
									}}
								>
									<Trans>Split {n}</Trans>
								</Chip>
							))}
							<Chip
								selected={mode.kind === 'custom'}
								aria-pressed={mode.kind === 'custom'}
								className="tnum px-4"
								onClick={() => {
									setMode({ kind: 'custom' })
									setField('amount')
								}}
							>
								<Trans>Amount</Trans>
							</Chip>
						</div>
						<Reveal open={mode.kind === 'split'}>
							<p className="tnum text-muted-foreground pt-2 text-sm">
								<Trans>
									Each share is {shareText}. The last share takes any remainder.
								</Trans>
							</p>
						</Reveal>
					</div>

					<Segmented
						size="lg"
						label={_(t`Payment method`)}
						value={method}
						onChange={(m) => {
							setMethod(m)
							setCashDigits('')
							setField(m === 'cash' ? 'cash' : 'amount')
						}}
						options={[
							{
								value: 'cash',
								label: _(METHOD_LABEL.cash),
								icon: <Banknote className="size-5" />,
							},
							{
								value: 'card',
								label: _(METHOD_LABEL.card),
								icon: <CreditCard className="size-5" />,
							},
							{
								value: 'other',
								label: _(METHOD_LABEL.other),
								icon: <Wallet className="size-5" />,
							},
						]}
					/>

					<div className="grid items-stretch gap-3 sm:grid-cols-2">
						<Readout
							label={_(t`Paying now`)}
							value={money(applied)}
							active={field === 'amount' || method !== 'cash'}
							onClick={() => setField('amount')}
						/>
						{method === 'cash' ? (
							<Readout
								label={_(t`Cash received`)}
								value={money(tendered)}
								active={field === 'cash'}
								muted={cashEntered === 0}
								onClick={() => setField('cash')}
							/>
						) : null}
					</div>

					{method === 'cash' ? (
						<div key="cash" className="t-rise flex flex-wrap gap-2">
							<Button
								variant="outline"
								onClick={() => {
									setCashDigits(String(applied))
									setField('cash')
								}}
							>
								<Trans>Exact</Trans>
							</Button>
							{quick.map((amount) => (
								<Button
									key={amount}
									variant="outline"
									onClick={() => {
										setCashDigits(String(amount))
										setField('cash')
									}}
								>
									{money(amount)}
								</Button>
							))}
						</div>
					) : (
						<div key={method} className="t-rise space-y-3">
							<div className="border-border text-muted-foreground flex items-start gap-3 rounded-2xl border border-dashed p-3 text-sm">
								<ReceiptIcon className="mt-0.5 size-5 shrink-0" />
								<p>
									{method === 'card' ? (
										<Trans>
											Take the card on your card terminal first, then confirm
											here. This till does not process cards yet.
										</Trans>
									) : (
										<Trans>
											Confirm once this amount has been collected another way.
										</Trans>
									)}
								</p>
							</div>
							<label className="block text-sm font-semibold">
								{method === 'card' ? (
									<Trans>Approval code from the card terminal (optional)</Trans>
								) : (
									<Trans>Reference (optional)</Trans>
								)}
								<input
									value={reference}
									onChange={(event) =>
										setReference(event.target.value.slice(0, 64))
									}
									autoComplete="off"
									className={cn(fieldClass, 'mt-1')}
								/>
							</label>
						</div>
					)}

					{method === 'cash' || mode.kind === 'custom' ? (
						<Keypad value={keypadValue} onChange={onKeypad} />
					) : null}
					{/* Stays mounted so the change is announced as it appears and updates. */}
					<p
						className="tnum text-warning text-center text-lg font-semibold empty:absolute"
						aria-live="polite"
					>
						{method === 'cash' && change > 0 ? (
							<Trans>Change {changeText}</Trans>
						) : null}
					</p>
					<Reveal open={giveChange !== null}>
						<p
							role="status"
							className="tnum bg-warning/15 text-warning rounded-xl p-3 text-center text-base font-semibold"
						>
							<Trans>Give {giveChangeText} change for that payment</Trans>
						</p>
					</Reveal>
					<Reveal open={Boolean(error)}>
						<p
							role="alert"
							className="text-destructive text-center text-sm font-medium"
						>
							{error}
						</p>
					</Reveal>
					{hasPayments ? (
						<Badge tone="warning" className="mx-auto flex w-fit">
							<Trans>Closing now leaves {remainingText} open on the tab</Trans>
						</Badge>
					) : null}
				</section>
			</div>
		</Modal>
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
				tone === 'success' && 'text-success',
			)}
		>
			<dt>{label}</dt>
			<dd className="shrink-0 whitespace-nowrap">{value}</dd>
		</div>
	)
}

function Readout({
	label,
	value,
	active,
	muted,
	onClick,
}: {
	label: string
	value: string
	active: boolean
	muted?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				'flex min-h-24 min-w-0 flex-col items-start justify-center gap-1 rounded-xl border-2 px-4 py-3 text-start transition',
				active
					? 'border-primary bg-primary/5'
					: 'border-input bg-card hover:bg-muted/40',
			)}
		>
			<span className="text-muted-foreground text-sm">{label}</span>
			<span
				className={cn(
					'tnum no-scrollbar max-w-full overflow-x-auto text-2xl font-semibold whitespace-nowrap transition-colors',
					muted && 'text-muted-foreground',
				)}
			>
				<NumberPop value={value} />
			</span>
		</button>
	)
}
