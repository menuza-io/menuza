import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { PaymentBadge } from '#app/components/reservations/payment-badge.tsx'
import { TextAreaField, TextField } from '#app/components/staff/controls.tsx'
import {
	fetchReservationPayments,
	type PaymentList,
	type PaymentRow,
	requestReservationFee,
	requestReservationRefund,
	runReservationFee,
	runReservationRefund,
} from '#app/utils/reservations/payments-api.ts'
import {
	feeKindFor,
	formatMoney,
	hasInFlightPayment,
	PAYMENT_DECLINE_LABELS,
	PAYMENT_KIND_LABELS,
	PAYMENT_ROW_STATUS_LABELS,
	paymentErrorMessage,
	parseMoneyInput,
	refundableMinor,
} from '#app/utils/reservations/payments-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const POLL_MS = 5_000

type Dialog =
	| { kind: 'fee'; feeKind: 'no_show_fee' | 'late_cancel_fee' }
	| { kind: 'refund' }
	| null

function statusOf(error: unknown): number | null {
	const status =
		error && typeof error === 'object'
			? (error as { status?: unknown }).status
			: null
	return typeof status === 'number' ? status : null
}

/**
 * Payment rows of one booking, read from the regional database through a
 * `payments` token, with the money actions (charge a no-show or late-cancel
 * fee, refund) for holders of `update:reservation_payment:any`. The panel
 * shows card display facts only (brand and last four). Deciding an action is
 * recorded regionally first and then run by the App; if the second step fails
 * the row stays visible with a retry, so an action is never repeated blindly.
 */
export function PaymentPanel({
	reservationId,
	client,
	orgSlug,
	canAct,
	guestLabel,
	timeZone,
	onChanged,
	fetchImpl,
}: {
	reservationId: string
	client: ReservationsScopedClient
	orgSlug: string
	/** Holds `update:reservation_payment:any` and is not impersonating. */
	canAct: boolean
	/** First name only, used to restate who is charged in confirmations. */
	guestLabel: string
	timeZone?: string
	/** Called after a payment action so the sheet can reload the booking. */
	onChanged?: () => void
	fetchImpl?: typeof fetch
}) {
	const { t, i18n } = useLingui()
	const [data, setData] = useState<PaymentList | null>(null)
	const [state, setState] = useState<'loading' | 'ready' | 'hidden' | 'failed'>(
		'loading',
	)
	const [busy, setBusy] = useState(false)
	const [dialog, setDialog] = useState<Dialog>(null)
	const [amountText, setAmountText] = useState('')
	const [reason, setReason] = useState('')
	const [formError, setFormError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const requestId = useRef(0)
	const abortRef = useRef<AbortController | null>(null)
	const stoppedRef = useRef(false)

	const load = useCallback(async () => {
		if (stoppedRef.current) return
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller
		const current = (requestId.current += 1)
		try {
			const next = await fetchReservationPayments(
				client,
				reservationId,
				controller.signal,
			)
			if (current !== requestId.current) return
			setData(next)
			setState('ready')
		} catch (error) {
			if (controller.signal.aborted || current !== requestId.current) return
			const status = statusOf(error)
			// Access is decided by the answer, not by flags: stop for good on 401/403/404.
			if (status === 401 || status === 403 || status === 404) {
				stoppedRef.current = true
				setState('hidden')
				return
			}
			setState((previous) => (previous === 'ready' ? previous : 'failed'))
		}
	}, [client, reservationId])

	useEffect(() => {
		stoppedRef.current = false
		setData(null)
		setState('loading')
		void load()
		return () => {
			stoppedRef.current = true
			abortRef.current?.abort()
		}
	}, [load])

	const moving = data ? hasInFlightPayment(data.payments) : false
	useEffect(() => {
		if (!moving || busy || dialog) return
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load()
		}, POLL_MS)
		return () => clearInterval(timer)
	}, [moving, busy, dialog, load])

	if (state === 'hidden') return null
	if (state === 'loading') {
		return (
			<div
				className="flex flex-col gap-2 rounded-lg border p-3"
				data-testid="payment-panel-loading"
			>
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-8 w-full" />
			</div>
		)
	}
	if (state === 'failed' || !data) {
		return (
			<Alert variant="destructive" data-testid="payment-panel-error">
				<AlertDescription>
					<div className="flex flex-wrap items-center gap-3">
						<Trans>The payments for this booking could not be loaded.</Trans>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => {
								setState('loading')
								void load()
							}}
						>
							<Trans>Try again</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	const { reservation, policy, payments } = data
	const currency = policy?.currency ?? payments[0]?.currency ?? 'USD'
	const money = (minor: number, rowCurrency = currency) =>
		formatMoney(minor, rowCurrency, i18n.locale)
	const feeKind = feeKindFor(reservation)
	const canChargeFee =
		canAct &&
		feeKind !== null &&
		(reservation.paymentStatus === 'guaranteed' ||
			reservation.paymentStatus === 'fee_failed')
	const defaultFeeMinor =
		feeKind === 'no_show_fee'
			? (policy?.noShowFeeMinor ?? 0)
			: (policy?.lateCancelFeeMinor ?? 0)
	const refundable = refundableMinor(payments)
	const canRefund = canAct && refundable > 0

	const formatTime = (ms: number) =>
		i18n.date(new Date(ms), {
			dateStyle: 'medium',
			timeStyle: 'short',
			...(timeZone ? { timeZone } : {}),
		})

	function openFee(kind: 'no_show_fee' | 'late_cancel_fee') {
		setAmountText('')
		setFormError(null)
		setDialog({ kind: 'fee', feeKind: kind })
	}

	function openRefund() {
		setAmountText('')
		setReason('')
		setFormError(null)
		setDialog({ kind: 'refund' })
	}

	async function afterAction(summary: string | null) {
		if (summary) setNotice(summary)
		await load()
		onChanged?.()
	}

	/** Step 2 of a fee: reported with the decline reason when the card says no. */
	async function runFee(feeId: string) {
		const result = await runReservationFee(
			orgSlug,
			{ reservationId, feeId },
			fetchImpl,
		)
		if (result.status === 'succeeded') {
			toast.success(t`The fee was charged.`)
			return null
		}
		if (result.status === 'requires_action') {
			return t`The bank needs the guest to confirm this charge. The guest was sent a link to confirm it.`
		}
		const declined = result.declineCode
			? PAYMENT_DECLINE_LABELS[result.declineCode]
			: null
		return declined ? i18n._(declined) : t`The card could not be charged.`
	}

	async function confirmFee() {
		if (dialog?.kind !== 'fee') return
		let amountMinor: number | null = null
		if (amountText.trim()) {
			amountMinor = parseMoneyInput(amountText, currency)
			if (amountMinor === null) {
				setFormError(t`Enter an amount like 12.50, or leave it empty.`)
				return
			}
		}
		setBusy(true)
		setFormError(null)
		let feeId: string | null = null
		try {
			const recorded = await requestReservationFee(client, reservationId, {
				kind: dialog.feeKind,
				amountMinor,
				expectedVersion: reservation.version,
			})
			feeId = recorded.feeId
			const summary = await runFee(feeId)
			setDialog(null)
			await afterAction(summary)
		} catch (error) {
			if (feeId) {
				// Recorded but not run: the row stays with a retry button.
				setDialog(null)
				setNotice(
					paymentErrorMessage(
						error,
						i18n._.bind(i18n),
						msg`The fee is recorded but the charge did not go through. Use Retry charge.`,
					),
				)
				await load()
			} else {
				setFormError(
					paymentErrorMessage(
						error,
						i18n._.bind(i18n),
						msg`The fee could not be recorded. Try again.`,
					),
				)
				if (statusOf(error) === 409) await load()
			}
		} finally {
			setBusy(false)
		}
	}

	async function retryFee(row: PaymentRow) {
		setBusy(true)
		setNotice(null)
		try {
			const summary = await runFee(row.id)
			await afterAction(summary)
		} catch (error) {
			setNotice(
				paymentErrorMessage(
					error,
					i18n._.bind(i18n),
					msg`The charge did not go through. Try again in a moment.`,
				),
			)
		} finally {
			setBusy(false)
		}
	}

	async function runRefund(refundRequestId: string) {
		const result = await runReservationRefund(
			orgSlug,
			{ refundRequestId },
			fetchImpl,
		)
		if (result.failed > 0) return t`The provider could not issue the refund.`
		if (result.pending > 0) {
			return t`The refund was accepted and is still processing.`
		}
		toast.success(t`The refund was issued.`)
		return null
	}

	async function confirmRefund() {
		const trimmed = reason.trim()
		if (!trimmed) {
			setFormError(t`Enter a reason for the refund.`)
			return
		}
		let amountMinor: number | null = null
		if (amountText.trim()) {
			amountMinor = parseMoneyInput(amountText, currency)
			if (amountMinor === null || amountMinor > refundable) {
				setFormError(t`Enter an amount up to what is left to refund.`)
				return
			}
		}
		setBusy(true)
		setFormError(null)
		let refundId: string | null = null
		try {
			const recorded = await requestReservationRefund(client, reservationId, {
				amountMinor,
				reason: trimmed,
			})
			refundId = recorded.refundId
			const summary = await runRefund(refundId)
			setDialog(null)
			await afterAction(summary)
		} catch (error) {
			if (refundId) {
				setDialog(null)
				setNotice(
					paymentErrorMessage(
						error,
						i18n._.bind(i18n),
						msg`The refund is recorded but did not run yet. Use Process now.`,
					),
				)
				await load()
			} else {
				setFormError(
					paymentErrorMessage(
						error,
						i18n._.bind(i18n),
						msg`The refund could not be recorded. Try again.`,
					),
				)
				if (statusOf(error) === 409) await load()
			}
		} finally {
			setBusy(false)
		}
	}

	async function processRefund(row: PaymentRow) {
		setBusy(true)
		setNotice(null)
		try {
			const summary = await runRefund(row.id)
			await afterAction(summary)
		} catch (error) {
			setNotice(
				paymentErrorMessage(
					error,
					i18n._.bind(i18n),
					msg`The refund did not run. Try again in a moment.`,
				),
			)
		} finally {
			setBusy(false)
		}
	}

	const feeAmountForDialog =
		dialog?.kind === 'fee' && amountText.trim()
			? parseMoneyInput(amountText, currency)
			: defaultFeeMinor
	const refundAmountForDialog =
		dialog?.kind === 'refund' && amountText.trim()
			? parseMoneyInput(amountText, currency)
			: refundable

	return (
		<section
			className="flex flex-col gap-3 rounded-lg border p-3"
			aria-labelledby="payment-panel-title"
			data-testid="payment-panel"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 id="payment-panel-title" className="text-sm font-medium">
					<Trans>Payments</Trans>
				</h3>
				<PaymentBadge paymentStatus={reservation.paymentStatus} />
			</div>

			{notice ? (
				<Alert data-testid="payment-panel-notice" role="status">
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			) : null}

			{payments.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No payments on this booking.</Trans>
				</p>
			) : (
				<ul className="divide-y" data-testid="payment-rows">
					{payments.map((row) => {
						const kindLabel = PAYMENT_KIND_LABELS[row.kind]
						const statusLabel = PAYMENT_ROW_STATUS_LABELS[row.status]
						const isRefund = row.kind === 'refund'
						const isFee =
							row.kind === 'no_show_fee_charge' ||
							row.kind === 'cancel_fee_charge'
						const refundedAmount = money(row.refundedMinor, row.currency)
						const card =
							row.cardBrand && row.cardLast4
								? `${row.cardBrand} •••• ${row.cardLast4}`
								: null
						return (
							<li
								key={row.id}
								className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
								data-testid="payment-row"
								data-payment-kind={row.kind}
								data-payment-status={row.status}
							>
								<div className="flex items-baseline justify-between gap-3">
									<span className="text-sm font-medium">
										{kindLabel ? i18n._(kindLabel) : row.kind}
									</span>
									<span
										className={
											isRefund
												? 'text-destructive text-sm tabular-nums'
												: 'text-sm tabular-nums'
										}
										dir="ltr"
									>
										{isRefund ? '−' : ''}
										{row.kind === 'card_setup' || row.kind === 'release'
											? '—'
											: money(row.amountMinor, row.currency)}
									</span>
								</div>
								<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
									<span className="inline-flex items-center gap-1.5">
										<span
											aria-hidden="true"
											className={
												row.status === 'failed'
													? 'bg-destructive size-1.5 rounded-full'
													: row.status === 'succeeded'
														? 'bg-success size-1.5 rounded-full'
														: 'bg-muted-foreground/60 size-1.5 rounded-full'
											}
										/>
										{statusLabel ? i18n._(statusLabel) : row.status}
									</span>
									{card ? <bdi dir="ltr">{card}</bdi> : null}
									<span>{formatTime(row.updatedAt)}</span>
									{row.refundedMinor > 0 && !isRefund ? (
										<span className="tabular-nums">
											<Trans>Refunded {refundedAmount}</Trans>
										</span>
									) : null}
								</div>
								{row.disputeStatus ? (
									<p
										className="text-destructive text-xs"
										data-testid="payment-dispute-note"
									>
										<Trans>
											A dispute was opened with the card issuer. Menuza reports
											it only.
										</Trans>
									</p>
								) : null}
								{row.declineCode && PAYMENT_DECLINE_LABELS[row.declineCode] ? (
									<p className="text-destructive text-xs">
										{i18n._(PAYMENT_DECLINE_LABELS[row.declineCode]!)}
									</p>
								) : null}
								{row.status === 'requires_action' && isFee ? (
									<p className="text-muted-foreground text-xs">
										<Trans>
											The guest was sent a link to confirm this charge with
											their bank.
										</Trans>
									</p>
								) : null}
								{canAct && isFee && row.status === 'pending' ? (
									<div>
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() => void retryFee(row)}
											data-testid="payment-retry-fee"
										>
											<Trans>Retry charge</Trans>
										</Button>
									</div>
								) : null}
								{canAct && isRefund && row.status === 'requested' ? (
									<div>
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() => void processRefund(row)}
											data-testid="payment-process-refund"
										>
											<Trans>Process now</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			)}

			{canChargeFee && feeKind ? (
				<div className="flex flex-wrap gap-2" data-testid="payment-actions">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => openFee(feeKind)}
						data-testid="payment-charge-fee"
					>
						{feeKind === 'no_show_fee' ? (
							<Trans>Charge no-show fee</Trans>
						) : (
							<Trans>Charge late-cancel fee</Trans>
						)}
					</Button>
				</div>
			) : null}
			{canRefund ? (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={openRefund}
						data-testid="payment-refund"
					>
						<Trans>Refund</Trans>
					</Button>
				</div>
			) : null}

			<AlertDialog
				open={dialog !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setDialog(null)
				}}
			>
				<AlertDialogContent data-testid="payment-confirm-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							{dialog?.kind === 'refund' ? (
								<Trans>Refund this booking?</Trans>
							) : dialog?.kind === 'fee' && dialog.feeKind === 'no_show_fee' ? (
								<Trans>Charge the no-show fee?</Trans>
							) : (
								<Trans>Charge the late-cancel fee?</Trans>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription data-testid="payment-confirm-text">
							{dialog?.kind === 'refund' ? (
								<RefundText
									amount={money(refundAmountForDialog ?? 0)}
									guest={guestLabel}
								/>
							) : (
								<FeeText
									amount={money(feeAmountForDialog ?? 0)}
									guest={guestLabel}
								/>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="flex flex-col gap-4">
						<TextField
							label={
								dialog?.kind === 'refund' ? (
									<Trans>Amount to refund</Trans>
								) : (
									<Trans>Fee amount</Trans>
								)
							}
							hint={
								dialog?.kind === 'refund' ? (
									<Trans>Leave empty to refund everything that is left.</Trans>
								) : (
									<Trans>
										Leave empty to charge the policy fee. You can only lower it.
									</Trans>
								)
							}
							optional
							inputMode="decimal"
							value={amountText}
							onChange={(event) => setAmountText(event.target.value)}
							placeholder={money(
								dialog?.kind === 'refund' ? refundable : defaultFeeMinor,
							)}
							data-testid="payment-amount-input"
						/>
						{dialog?.kind === 'refund' ? (
							<TextAreaField
								label={<Trans>Reason</Trans>}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								maxLength={500}
								data-testid="payment-reason-input"
							/>
						) : null}
						{formError ? (
							<p
								role="alert"
								className="text-destructive text-sm"
								data-testid="payment-form-error"
							>
								{formError}
							</p>
						) : null}
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep as is</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant={dialog?.kind === 'refund' ? 'destructive' : 'default'}
							disabled={busy}
							onClick={() =>
								void (dialog?.kind === 'refund'
									? confirmRefund()
									: confirmFee())
							}
							data-testid="payment-confirm-btn"
						>
							{dialog?.kind === 'refund' ? (
								<Trans>Refund</Trans>
							) : (
								<Trans>Charge fee</Trans>
							)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	)
}

function FeeText({ amount, guest }: { amount: string; guest: string }) {
	return (
		<Trans>
			{amount} will be charged now to the card {guest} left on file. This cannot
			be undone from here.
		</Trans>
	)
}

function RefundText({ amount, guest }: { amount: string; guest: string }) {
	return (
		<Trans>
			{amount} will be returned to {guest}&apos;s card. The platform fee is
			reversed in proportion.
		</Trans>
	)
}
