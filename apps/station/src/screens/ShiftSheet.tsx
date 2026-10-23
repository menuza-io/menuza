import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PosSalesSummary } from '@repo/common/pos-reports'
import { useLiveQuery } from 'dexie-react-hooks'
import {
	ArrowDownToLine,
	ArrowUpFromLine,
	Lock,
	Printer,
	ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { db, type Shift, type StaffRef } from '~/lib/db.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import {
	addCashMovement,
	closeShift,
	openShift,
	rejectedShifts,
	requeueRejectedShifts,
	startShift,
	summarize,
} from '~/lib/shifts.ts'
import { type ApprovalOutcome } from '~/lib/signin.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import { ManagerPinPad } from '~/ui/ManagerPinPad.tsx'
import {
	Button,
	Modal,
	NumberPop,
	Reveal,
	cn,
	fieldClass,
} from '~/ui/primitives.tsx'

type Step =
	| { kind: 'overview' }
	| { kind: 'movement'; movement: 'pay_in' | 'pay_out' }
	| { kind: 'close' }
	| { kind: 'closed'; shift: Shift }

/**
 * The cash drawer: open a shift with a float, record cash put in or taken out,
 * and close with a blind count. Closing shows over or short and the Z report,
 * which can be printed.
 */
export function ShiftSheet({
	onClose,
	money,
	me,
	needsManager,
	onApprove,
	businessName,
	origin,
	timeZone,
	dayStartMinutes,
	onChanged,
}: {
	onClose: () => void
	/** A shift was opened, changed or closed: send it now. */
	onChanged: () => void
	money: MoneyFormatter
	me: StaffRef | null
	/** Sign-in is on and the person signed in is not a manager. */
	needsManager: boolean
	onApprove: (pin: string) => Promise<ApprovalOutcome>
	businessName: string
	origin: string
	timeZone?: string
	dayStartMinutes: number
}) {
	const { _, i18n } = useLingui()
	const shift = useLiveQuery(() => openShift(), [], undefined)
	const orders = useLiveQuery(() => db.orders.toArray(), [], [])
	const [step, setStep] = useState<Step>({ kind: 'overview' })
	const [digits, setDigits] = useState('')
	const [note, setNote] = useState('')
	const [approvedBy, setApprovedBy] = useState<StaffRef | null>(null)
	const [pin, setPin] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const amount = Number(digits || 0)

	const reset = (next: Step) => {
		setStep(next)
		setDigits('')
		setNote('')
		setPin('')
		setApprovedBy(null)
		setError(null)
	}
	const run = async (action: () => Promise<void>) => {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await action()
			onChanged()
		} catch (e) {
			setError(
				e instanceof Error ? e.message : _(t`Something went wrong. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	if (step.kind === 'closed') {
		const summary = summarize(step.shift, orders)
		const overShort =
			(step.shift.countedCashCents ?? 0) - (step.shift.expectedCashCents ?? 0)
		return (
			<Modal open onClose={onClose} title={_(t`Shift closed`)} size="md">
				<div key="closed" className="t-rise space-y-4 p-5">
					<div
						role="status"
						className={cn(
							'rounded-2xl p-4 text-center',
							overShort === 0
								? 'bg-success/12 text-success'
								: 'bg-warning/15 text-warning',
						)}
					>
						<p className="text-sm font-semibold">
							{overShort === 0 ? (
								<Trans>The drawer balances</Trans>
							) : overShort > 0 ? (
								<Trans>Over</Trans>
							) : (
								<Trans>Short</Trans>
							)}
						</p>
						<p className="tnum mono text-3xl font-bold">
							{money(Math.abs(overShort))}
						</p>
					</div>
					<SummaryTable
						summary={summary}
						money={money}
						counted={step.shift.countedCashCents}
					/>
					<div className="grid grid-cols-2 gap-3">
						<Button variant="outline" size="lg" onClick={() => window.print()}>
							<Printer className="size-5" /> <Trans>Print Z report</Trans>
						</Button>
						<Button variant="primary" size="lg" onClick={onClose}>
							<Trans>Done</Trans>
						</Button>
					</div>
				</div>
				<ZReport
					shift={step.shift}
					summary={summary}
					money={money}
					businessName={businessName}
				/>
			</Modal>
		)
	}

	if (!shift) {
		return (
			<Modal open onClose={onClose} title={_(t`Open a shift`)} size="md">
				<div key="open" className="t-rise space-y-4 p-5">
					<RejectedShifts onRetry={onChanged} />
					<p className="text-muted-foreground">
						<Trans>
							Count the cash in the drawer before the first sale. Every sale
							until you close the shift is counted against it.
						</Trans>
					</p>
					<Readout label={_(t`Cash in the drawer`)} value={money(amount)} />
					<Keypad value={digits} onChange={setDigits} />
					<Reveal open={Boolean(error)}>
						<p role="alert" className="text-destructive text-sm font-medium">
							{error}
						</p>
					</Reveal>
					<Button
						variant="primary"
						size="xl"
						className="w-full"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await startShift({
									openingFloatCents: amount,
									by: me,
									origin,
									timeZone,
									dayStartMinutes,
								})
								reset({ kind: 'overview' })
							})
						}
					>
						<Trans>Open shift with {money(amount)}</Trans>
					</Button>
				</div>
			</Modal>
		)
	}

	const summary = summarize(shift, orders)

	if (step.kind === 'movement') {
		const payIn = step.movement === 'pay_in'
		const needsApproval = needsManager && !payIn
		const ready =
			amount > 0 &&
			note.trim().length > 0 &&
			(!needsApproval || approvedBy !== null) &&
			!busy
		return (
			<Modal
				open
				onClose={() => reset({ kind: 'overview' })}
				title={payIn ? _(t`Put cash in`) : _(t`Take cash out`)}
				size="md"
			>
				<div key="movement" className="t-rise space-y-4 p-5">
					<Readout label={_(t`Amount`)} value={money(amount)} />
					<Keypad value={digits} onChange={setDigits} />
					<label className="block text-sm font-semibold">
						<Trans>What is it for?</Trans>
						<input
							value={note}
							onChange={(event) => setNote(event.target.value.slice(0, 200))}
							placeholder={
								payIn ? _(t`Change from the bank`) : _(t`Milk from the shop`)
							}
							className={cn(fieldClass, 'mt-1')}
						/>
					</label>
					{needsApproval ? (
						approvedBy ? (
							<p
								role="status"
								className="t-pop-in bg-success/12 text-success flex items-center gap-2 rounded-xl p-3 text-sm font-semibold"
							>
								<ShieldCheck className="size-5" />{' '}
								<Trans>Approved by {approvedBy.name}</Trans>
							</p>
						) : (
							<ManagerPinPad
								prompt={
									<Trans>
										A manager approves cash taken out with their PIN
									</Trans>
								}
								pin={pin}
								onPin={setPin}
								busy={busy}
								variant="outline"
								onApprove={() =>
									void run(async () => {
										try {
											const outcome = await onApprove(pin)
											if (outcome.ok) setApprovedBy(outcome.manager)
											else throw new Error(outcome.message)
										} finally {
											setPin('')
										}
									})
								}
							/>
						)
					) : null}
					<Reveal open={Boolean(error)}>
						<p role="alert" className="text-destructive text-sm font-medium">
							{error}
						</p>
					</Reveal>
					<Button
						variant="primary"
						size="xl"
						className="w-full"
						disabled={!ready}
						onClick={() =>
							void run(async () => {
								await addCashMovement(shift.id, {
									kind: step.movement,
									amountCents: amount,
									note,
									by: me,
									approvedBy,
								})
								reset({ kind: 'overview' })
							})
						}
					>
						{payIn ? (
							<Trans>Record {money(amount)} in</Trans>
						) : (
							<Trans>Record {money(amount)} out</Trans>
						)}
					</Button>
				</div>
			</Modal>
		)
	}

	if (step.kind === 'close') {
		return (
			<Modal
				open
				onClose={() => reset({ kind: 'overview' })}
				title={_(t`Close the shift`)}
				size="md"
			>
				<div key="close" className="t-rise space-y-4 p-5">
					<p className="text-muted-foreground">
						<Trans>
							Count all the cash in the drawer and enter it. You will see
							whether it balances after you confirm.
						</Trans>
					</p>
					<Readout label={_(t`Cash counted`)} value={money(amount)} />
					<Keypad value={digits} onChange={setDigits} />
					{summary.orders.open > 0 ? (
						<p className="bg-warning/12 text-warning rounded-xl p-3 text-sm">
							<Trans>
								{summary.orders.open} tabs from this shift are still open. They
								stay open and can be paid in the next shift.
							</Trans>
						</p>
					) : null}
					<Reveal open={Boolean(error)}>
						<p role="alert" className="text-destructive text-sm font-medium">
							{error}
						</p>
					</Reveal>
					<Button
						variant="danger"
						size="xl"
						className="w-full"
						disabled={busy || digits === ''}
						onClick={() =>
							void run(async () => {
								const closed = await closeShift(shift.id, {
									countedCashCents: amount,
									by: me,
								})
								reset({ kind: 'closed', shift: closed })
							})
						}
					>
						<Lock className="size-5" /> <Trans>Close shift</Trans>
					</Button>
				</div>
			</Modal>
		)
	}

	return (
		<Modal open onClose={onClose} title={_(t`Shift`)} size="md">
			<div key="overview" className="t-rise space-y-4 p-5">
				<RejectedShifts onRetry={onChanged} />
				<p className="text-muted-foreground text-sm">
					<Trans>
						Open since{' '}
						{new Date(shift.openedAt).toLocaleTimeString(i18n.locale, {
							hour: 'numeric',
							minute: '2-digit',
						})}
						{shift.openedBy ? ` · ${shift.openedBy.name}` : ''}
					</Trans>
				</p>
				<SummaryTable summary={summary} money={money} counted={null} />
				{shift.movements.length > 0 ? (
					<ul className="border-border space-y-1 rounded-xl border p-3 text-sm">
						{shift.movements.map((m) => (
							<li key={m.id} className="flex justify-between gap-3">
								<span>
									{m.kind === 'pay_in' ? <Trans>In</Trans> : <Trans>Out</Trans>}{' '}
									· {m.note}
									{m.approvedBy ? ` · ${m.approvedBy.name}` : ''}
								</span>
								<span className="tnum mono">
									{m.kind === 'pay_in'
										? money(m.amountCents)
										: `-${money(m.amountCents)}`}
								</span>
							</li>
						))}
					</ul>
				) : null}
				<div className="grid grid-cols-2 gap-3">
					<Button
						variant="outline"
						size="lg"
						onClick={() => reset({ kind: 'movement', movement: 'pay_in' })}
					>
						<ArrowDownToLine className="size-5" /> <Trans>Cash in</Trans>
					</Button>
					<Button
						variant="outline"
						size="lg"
						onClick={() => reset({ kind: 'movement', movement: 'pay_out' })}
					>
						<ArrowUpFromLine className="size-5" /> <Trans>Cash out</Trans>
					</Button>
				</div>
				<Button
					variant="danger"
					size="lg"
					className="w-full"
					onClick={() => reset({ kind: 'close' })}
				>
					<Lock className="size-5" /> <Trans>Close shift</Trans>
				</Button>
			</div>
		</Modal>
	)
}

/**
 * Shifts the server refused for good: their Z figures never reached the
 * restaurant. Shown until someone sends them again (after an app update or a
 * manager's fix), never dropped.
 */
function RejectedShifts({ onRetry }: { onRetry: () => void }) {
	const refused = useLiveQuery(() => rejectedShifts(), [], [])
	if (refused.length === 0) return null
	const count = refused.length
	const reason = refused[0]?.lastError ?? ''
	return (
		<div
			role="alert"
			className="bg-destructive/10 text-destructive space-y-2 rounded-xl p-3 text-sm"
		>
			<p className="font-semibold">
				{plural(count, {
					one: 'The server refused # shift. Its figures have not reached the restaurant.',
					other:
						'The server refused # shifts. Their figures have not reached the restaurant.',
				})}
			</p>
			{reason ? <p>{reason}</p> : null}
			<Button
				variant="outline"
				onClick={() => void requeueRejectedShifts().then(onRetry)}
			>
				<Trans>Send again</Trans>
			</Button>
		</div>
	)
}

function Readout({ label, value }: { label: string; value: string }) {
	return (
		<div className="border-primary flex min-h-24 min-w-0 flex-col items-start justify-center gap-1 rounded-xl border px-4 py-3 text-start">
			<span className="text-muted-foreground text-sm">{label}</span>
			<span className="tnum no-scrollbar max-w-full overflow-x-auto text-2xl font-semibold whitespace-nowrap">
				<NumberPop value={value} />
			</span>
		</div>
	)
}

function SummaryTable({
	summary,
	money,
	counted,
}: {
	summary: PosSalesSummary
	money: MoneyFormatter
	counted: number | null
}) {
	const { _ } = useLingui()
	const rows: Array<[string, number, boolean?]> = [
		[_(t`Sales`), summary.grossSalesCents],
		[_(t`Refunds`), -summary.refundsCents],
		[_(t`Net sales`), summary.netSalesCents, true],
		[_(t`Tax`), summary.taxCents],
		[_(t`Tips`), summary.tipsCents],
		[_(t`Card`), summary.byTender.card.netCents],
		[_(t`Other`), summary.byTender.other.netCents],
		[_(t`Cash taken`), summary.byTender.cash.netCents],
		[_(t`Opening float`), summary.cash.openingFloatCents],
		[_(t`Cash in`), summary.cash.payInsCents],
		[_(t`Cash out`), -summary.cash.payOutsCents],
		[_(t`Expected in drawer`), summary.cash.expectedCents, true],
	]
	if (counted !== null) rows.push([_(t`Counted`), counted, true])
	return (
		<dl className="tnum space-y-1 text-sm">
			{rows.map(([label, value, strong]) => (
				<div
					key={label}
					className={cn(
						'flex justify-between',
						strong ? 'font-bold' : 'text-muted-foreground',
					)}
				>
					<dt>{label}</dt>
					<dd>{value < 0 ? `-${money(-value)}` : money(value)}</dd>
				</div>
			))}
			<div className="text-muted-foreground flex justify-between">
				<dt>
					<Trans>Cancelled · items taken off</Trans>
				</dt>
				<dd>
					{summary.voids.cancelledOrders} · {summary.voids.removedItems} (
					{money(summary.voids.cancelledCents + summary.voids.removedCents)})
				</dd>
			</div>
		</dl>
	)
}

/** The printed Z report (72 mm), shown only by `window.print()`. */
function ZReport({
	shift,
	summary,
	money,
	businessName,
}: {
	shift: Shift
	summary: PosSalesSummary
	money: MoneyFormatter
	businessName: string
}) {
	const { i18n } = useLingui()
	const overShort =
		(shift.countedCashCents ?? 0) - (shift.expectedCashCents ?? 0)
	return createPortal(
		<div id="receipt" className="hidden print:block" aria-hidden>
			<div className="text-center text-sm font-bold">{businessName}</div>
			<div className="text-center font-bold">
				<Trans>Z report</Trans> · {shift.businessDate}
			</div>
			<div className="text-center">
				{new Date(shift.openedAt).toLocaleString(i18n.locale)} –{' '}
				{shift.closedAt
					? new Date(shift.closedAt).toLocaleString(i18n.locale)
					: ''}
			</div>
			{shift.closedBy ? (
				<div className="text-center">
					<Trans>Closed by {shift.closedBy.name}</Trans>
				</div>
			) : null}
			<hr />
			<Line
				label={<Trans>Paid orders</Trans>}
				value={String(summary.orders.paid + summary.orders.refunded)}
			/>
			<Line
				label={<Trans>Sales</Trans>}
				value={money(summary.grossSalesCents)}
			/>
			<Line
				label={<Trans>Refunds</Trans>}
				value={`-${money(summary.refundsCents)}`}
			/>
			<Line
				label={<Trans>Net sales</Trans>}
				value={money(summary.netSalesCents)}
				bold
			/>
			<Line label={<Trans>Tax</Trans>} value={money(summary.taxCents)} />
			<Line label={<Trans>Tips</Trans>} value={money(summary.tipsCents)} />
			<hr />
			<Line
				label={<Trans>Cash</Trans>}
				value={money(summary.byTender.cash.netCents)}
			/>
			<Line
				label={<Trans>Card</Trans>}
				value={money(summary.byTender.card.netCents)}
			/>
			<Line
				label={<Trans>Other</Trans>}
				value={money(summary.byTender.other.netCents)}
			/>
			<hr />
			<Line
				label={<Trans>Opening float</Trans>}
				value={money(summary.cash.openingFloatCents)}
			/>
			<Line
				label={<Trans>Cash in</Trans>}
				value={money(summary.cash.payInsCents)}
			/>
			<Line
				label={<Trans>Cash out</Trans>}
				value={`-${money(summary.cash.payOutsCents)}`}
			/>
			<Line
				label={<Trans>Expected in drawer</Trans>}
				value={money(shift.expectedCashCents ?? summary.cash.expectedCents)}
				bold
			/>
			<Line
				label={<Trans>Counted</Trans>}
				value={money(shift.countedCashCents ?? 0)}
				bold
			/>
			<Line
				label={overShort >= 0 ? <Trans>Over</Trans> : <Trans>Short</Trans>}
				value={money(Math.abs(overShort))}
				bold
			/>
			<hr />
			<Line
				label={<Trans>Cancelled orders</Trans>}
				value={`${summary.voids.cancelledOrders} (${money(summary.voids.cancelledCents)})`}
			/>
			<Line
				label={<Trans>Items taken off</Trans>}
				value={`${summary.voids.removedItems} (${money(summary.voids.removedCents)})`}
			/>
			<Line
				label={<Trans>Tabs left open</Trans>}
				value={String(summary.orders.open)}
			/>
		</div>,
		document.body,
	)
}

function Line({
	label,
	value,
	bold,
}: {
	label: React.ReactNode
	value: string
	bold?: boolean
}) {
	return (
		<div className={cn('flex justify-between', bold && 'font-bold')}>
			<span>{label}</span>
			<span>{value}</span>
		</div>
	)
}

/** Shown on the till when it must have an open shift before it sells. */
export function useOpenShift() {
	return useLiveQuery(() => openShift(), [], null)
}
