import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { TextField } from '#app/components/staff/controls.tsx'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'
import { formatMoney, type Order } from '#app/utils/orders/order-model.ts'

type Catering = NonNullable<Order['catering']>

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	balance_not_due: msg`There is no balance waiting right now.`,
	balance_voided: msg`That balance was already voided.`,
	balance_already_paid: msg`That balance is already paid.`,
	order_locked: msg`This order cannot be changed.`,
	invalid_request: msg`Check the date or the amount and try again.`,
}

/** Operator-facing catering block of an order: the event, the money and the balance actions. */
export function CateringDetails({
	order,
	catering,
	orgSlug,
	canWrite,
	canRefundLines,
	onReload,
	onRefundLines,
}: {
	order: Order
	catering: Catering
	orgSlug: string
	canWrite: boolean
	/** The member may refund through the provider: the line picker is offered. */
	canRefundLines: boolean
	onReload?: () => void
	/** Opens the refund dialog with the amount of the picked lines. */
	onRefundLines?: (amountCents: number, note: string) => void
}) {
	const { _, i18n } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/catering')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [dueDate, setDueDate] = useState('')
	const [chargeLabel, setChargeLabel] = useState('')
	const [chargeAmount, setChargeAmount] = useState('')
	const [picked, setPicked] = useState<ReadonlySet<number>>(new Set())
	const money = (cents: number) =>
		formatMoney(cents, order.currency, i18n.locale)
	const zone = order.timeZone ?? undefined
	const when = catering.eventAt
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'full',
				timeStyle: 'short',
				timeZone: zone,
			}).format(new Date(catering.eventAt))
		: null

	const run = async (path: string, body: unknown) => {
		setBusy(true)
		setError(null)
		try {
			await request(path, { method: 'POST', body: JSON.stringify(body) })
			onReload?.()
		} catch (caught) {
			const code = caught instanceof OperatorRequestError ? caught.code : ''
			setError(
				ERRORS[code] ? _(ERRORS[code]!) : _(msg`That did not work. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	const balanceWord =
		catering.balanceState === 'void'
			? _(msg`Voided`)
			: catering.balanceState === 'paid'
				? _(msg`Paid`)
				: catering.balanceCents > 0
					? catering.balanceOwedCents > 0
						? _(msg`Waiting`)
						: _(msg`Waits for the deposit`)
					: _(msg`None`)
	const dueText = catering.balanceDueAt
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'medium',
				timeZone: zone,
			}).format(new Date(new Date(catering.balanceDueAt).getTime() - 1))
		: null
	const pickedCents = [...picked].reduce(
		(sum, index) => sum + (order.lines[index]?.totalCents ?? 0),
		0,
	)
	// Each picked line comes back with its share of the tax.
	const taxShare =
		order.subtotalCents && order.taxCents
			? Math.round((order.taxCents * pickedCents) / order.subtotalCents)
			: 0
	const lineRefundCents = pickedCents + taxShare
	const refundLabel = money(lineRefundCents)
	const depositPercent = catering.depositPercent

	return (
		<section
			className="space-y-3 rounded-md border p-3"
			aria-label={_(msg`Catering`)}
			data-testid="order-catering"
		>
			<h3 className="flex items-center gap-2 text-sm font-medium">
				<Icon name="building" className="size-4" aria-hidden />
				<Trans>Catering</Trans>
			</h3>
			<dl className="grid gap-2 text-sm sm:grid-cols-2">
				{when ? (
					<div>
						<dt className="text-muted-foreground text-xs">
							<Trans>Event</Trans>
						</dt>
						<dd data-testid="catering-event">{when}</dd>
					</div>
				) : null}
				{catering.guestCount ? (
					<div>
						<dt className="text-muted-foreground text-xs">
							<Trans>Guests</Trans>
						</dt>
						<dd className="tabular-nums">{catering.guestCount}</dd>
					</div>
				) : null}
				<div>
					<dt className="text-muted-foreground text-xs">
						<Trans>Paid so far</Trans>
					</dt>
					<dd className="tabular-nums" data-testid="catering-paid">
						<bdi>
							{money(
								catering.paidCents ??
									(order.paymentStatus === 'paid' ? order.totalCents : 0),
							)}
						</bdi>
						{depositPercent ? (
							<span className="text-muted-foreground ms-2 text-xs">
								<Trans>{depositPercent}% deposit</Trans>
							</span>
						) : null}
					</dd>
				</div>
				{catering.balanceCents > 0 ? (
					<div>
						<dt className="text-muted-foreground text-xs">
							<Trans>Balance</Trans>
						</dt>
						<dd className="tabular-nums" data-testid="catering-balance">
							<bdi>
								{money(catering.balanceOwedCents || catering.balanceCents)}
							</bdi>
							<Badge variant="outline" className="ms-2">
								{balanceWord}
							</Badge>
							{dueText && catering.balanceState === 'due' ? (
								<span className="text-muted-foreground ms-2 text-xs">
									<Trans>due {dueText}</Trans>
								</span>
							) : null}
						</dd>
					</div>
				) : null}
			</dl>
			{catering.notes ? (
				<p
					dir="auto"
					className="text-muted-foreground text-sm whitespace-pre-wrap"
					data-testid="catering-notes"
				>
					{catering.notes}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			{canWrite && order.paymentStatus === 'paid' ? (
				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						{catering.balanceState === 'due' &&
						catering.balanceOwedCents > 0 ? (
							<>
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() =>
										void run(`/orders/${order.id}/balance`, {
											action: 'resend',
										})
									}
								>
									<Trans>Send the balance link again</Trans>
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									data-testid="catering-void-balance"
									onClick={() =>
										void run(`/orders/${order.id}/balance`, { action: 'void' })
									}
								>
									<Trans>Void the balance</Trans>
								</Button>
							</>
						) : null}
						{catering.balanceState === 'void' ? (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() =>
									void run(`/orders/${order.id}/balance`, { action: 'reopen' })
								}
							>
								<Trans>Reopen the balance</Trans>
							</Button>
						) : null}
					</div>
					{catering.balanceState === 'due' && catering.balanceOwedCents > 0 ? (
						<div className="flex flex-wrap items-end gap-2">
							<TextField
								id="catering-due-date"
								label={<Trans>Change the due date</Trans>}
								type="date"
								value={dueDate}
								onChange={(event) => setDueDate(event.target.value)}
							/>
							<Button
								variant="outline"
								size="sm"
								disabled={busy || !dueDate}
								onClick={() =>
									void run(`/orders/${order.id}/balance`, {
										action: 'set_due',
										dueDate,
									})
								}
							>
								<Trans>Save the date</Trans>
							</Button>
						</div>
					) : null}
					<div className="flex flex-wrap items-end gap-2">
						<TextField
							id="catering-charge-label"
							label={<Trans>Add a charge</Trans>}
							value={chargeLabel}
							maxLength={120}
							onChange={(event) => setChargeLabel(event.target.value)}
						/>
						<TextField
							id="catering-charge-amount"
							label={<Trans>Amount</Trans>}
							inputMode="decimal"
							dir="ltr"
							value={chargeAmount}
							onChange={(event) => setChargeAmount(event.target.value)}
						/>
						<Button
							variant="outline"
							size="sm"
							disabled={busy || !chargeLabel.trim() || !chargeAmount.trim()}
							onClick={() => {
								const amountCents = parseMoneyToMinor(chargeAmount, {
									min: 1,
									currency: order.currency,
								})
								if (amountCents === null) {
									setError(_(msg`Check the date or the amount and try again.`))
									return
								}
								void run(`/orders/${order.id}/charges`, {
									label: chargeLabel.trim(),
									amountCents,
								}).then(() => {
									setChargeLabel('')
									setChargeAmount('')
								})
							}}
						>
							<Trans>Add and reopen the balance</Trans>
						</Button>
					</div>
				</div>
			) : null}

			{canRefundLines && order.paymentStatus === 'paid' && onRefundLines ? (
				<fieldset className="space-y-2" data-testid="catering-refund-lines">
					<legend className="text-muted-foreground text-xs">
						<Trans>Refund line by line</Trans>
					</legend>
					<ul className="space-y-1">
						{order.lines.map((line, index) => (
							<li key={`${line.itemName}-${index}`}>
								<label className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={picked.has(index)}
										onCheckedChange={(checked) =>
											setPicked((current) => {
												const next = new Set(current)
												if (checked === true) next.add(index)
												else next.delete(index)
												return next
											})
										}
									/>
									<span className="min-w-0 flex-1 wrap-anywhere">
										{line.quantity} × {line.itemName}
									</span>
									<span className="tabular-nums">
										<bdi>{money(line.totalCents)}</bdi>
									</span>
								</label>
							</li>
						))}
					</ul>
					<Button
						variant="outline"
						size="sm"
						disabled={picked.size === 0}
						onClick={() => {
							const names = [...picked]
								.map((index) => order.lines[index]?.itemName)
								.filter(Boolean)
								.join(', ')
							onRefundLines(lineRefundCents, _(msg`Refund of: ${names}`))
						}}
					>
						<Trans>Refund {refundLabel} for these lines</Trans>
					</Button>
				</fieldset>
			) : null}
		</section>
	)
}
