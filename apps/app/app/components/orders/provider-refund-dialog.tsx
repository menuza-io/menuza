import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	formatMoney,
	providerRefundableCents,
} from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'

type RefundKind = 'full' | 'partial'

/** What the App's refund action answered with (`RefundView`). */
export type ProviderRefundView = {
	refundId: string
	orderId: string
	amountCents: number
	currency: string
	status: 'pending' | 'succeeded' | 'failed'
	failureCode: string | null
}

export type ProviderRefundOutcome = {
	refund: ProviderRefundView
	/** The provider or the status report was unreachable: still pending. */
	delayed: boolean
}

/** Errors that mean the figures on screen are out of date. */
const STALE_CODES = new Set([
	'refund_pending',
	'payment_disputed',
	'refund_exceeds_payment',
	'refund_complete',
	'order_not_refundable',
	'idempotency_conflict',
	'order_not_found',
])

/** The failure that can come from the network: the same key may be retried. */
function isRetryable(status: number, body: Record<string, unknown> | null) {
	return status === 502 || status === 503 || body?.retryable === true
}

/**
 * Returns money to the guest's card through the payment provider, for an
 * order paid online. The answer is always followed by `onRefresh`, so the
 * region's own figures are what the page shows next.
 */
export function ProviderRefundDialog({
	order,
	orgSlug,
	open,
	onOpenChange,
	onDone,
	onRefresh,
	finalFocus,
}: {
	order: {
		id: string
		currency: string
		totalCents: number
		refundedCents: number
		refundPendingCents?: number
		refundableCents?: number
	}
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	/** The provider (or the region) took the refund; the dialog is done. */
	onDone: (outcome: ProviderRefundOutcome) => void
	/** Loads the order again after any answer. */
	onRefresh: () => void
	/** Where focus goes on close; see `useSettledFocus`. */
	finalFocus?: () => HTMLElement | boolean
}) {
	const { t, i18n } = useLingui()
	const [kind, setKind] = useState<RefundKind>('full')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// One key per submit: kept across a network retry of the same refund,
	// replaced as soon as the answer is final or the content changes.
	const keyRef = useRef<{ signature: string; key: string } | null>(null)

	const money = (cents: number) =>
		formatMoney(cents, order.currency, i18n.locale)
	const leftCents = providerRefundableCents(order)
	const pendingCents = order.refundPendingCents ?? 0

	const schema = useMemo(
		() =>
			z
				.object({
					kind: z.enum(['full', 'partial']),
					amount: z.string().trim().optional(),
					note: z
						.string()
						.trim()
						.min(3, t`Add a short note, such as why the money goes back.`)
						.max(280, t`Keep the note under 280 characters.`)
						.prefault(''),
				})
				.superRefine((value, ctx) => {
					if (value.kind !== 'partial') return
					const cents = parseMoneyToMinor(value.amount ?? '', {
						min: 1,
						currency: order.currency,
					})
					if (cents === null) {
						ctx.addIssue({
							code: 'custom',
							path: ['amount'],
							message: t`Enter the amount to return, for example 4.50.`,
						})
						return
					}
					if (cents > leftCents) {
						ctx.addIssue({
							code: 'custom',
							path: ['amount'],
							message: t`That is more than what is left to refund.`,
						})
					}
				}),
		[t, leftCents, order.currency],
	)

	const describeError = (
		status: number,
		body: Record<string, unknown> | null,
	): string => {
		switch (body?.error) {
			case 'refund_pending':
				return t`Another refund for this order is still being processed. Wait for it to finish.`
			case 'payment_disputed':
				return t`This payment is disputed with the card issuer, so it cannot be refunded.`
			case 'refund_exceeds_payment': {
				const label = money(
					typeof body.refundableCents === 'number' ? body.refundableCents : 0,
				)
				return t`At most ${label} can still be refunded.`
			}
			case 'refund_complete':
				return t`This order is already fully refunded.`
			case 'order_not_refundable':
				return t`This order cannot be refunded through the payment provider.`
			case 'refund_requires_provider':
				return t`Orders paid online are refunded through the payment provider.`
			case 'idempotency_conflict':
				return t`This refund was already started with other details. The amounts above are now up to date.`
			case 'order_not_found':
				return t`This order no longer exists.`
			case 'impersonation_forbidden':
				return t`Refunds cannot be issued while viewing as another account.`
			case 'location_scope_unsupported':
				return t`Refunds are not available to members limited to some locations.`
			case 'regional_unavailable':
				return t`The order service is not reachable right now. Wait a moment and try again.`
			case 'refund_unavailable':
				return t`The payment provider could not be reached. Try again in a moment.`
			case 'refund_forbidden':
				return t`You do not have permission to refund this order.`
		}
		if (status === 401 || status === 403 || status === 404) {
			return t`You do not have permission to refund orders.`
		}
		return t`The refund could not be started. Try again.`
	}

	const [form, fields] = useForm({
		id: 'provider-refund-form',
		defaultValue: { kind: 'full', amount: '', note: '' },
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success' || submitting) return
			const value = submission.value
			const body =
				value.kind === 'full'
					? { full: true, note: value.note }
					: {
							amountCents:
								parseMoneyToMinor(value.amount ?? '', {
									min: 1,
									currency: order.currency,
								}) ?? 0,
							note: value.note,
						}
			const signature = JSON.stringify(body)
			if (keyRef.current?.signature !== signature) {
				keyRef.current = { signature, key: crypto.randomUUID() }
			}
			const key = keyRef.current.key
			setSubmitting(true)
			setError(null)
			void (async () => {
				try {
					const response = await fetch(
						`${ordersHref(orgSlug, { orderId: order.id })}/refund`,
						{
							method: 'POST',
							credentials: 'same-origin',
							headers: {
								'Content-Type': 'application/json',
								'Idempotency-Key': key,
							},
							body: JSON.stringify(body),
						},
					)
					const answer = (await response.json().catch(() => null)) as Record<
						string,
						unknown
					> | null
					if (
						(response.status === 200 || response.status === 202) &&
						answer?.refund
					) {
						keyRef.current = null
						onRefresh()
						onDone({
							refund: answer.refund as ProviderRefundView,
							delayed: response.status === 202 || answer.delayed === true,
						})
						return
					}
					// A retryable answer keeps the key: the refund may already be
					// booked, and the same key replays it instead of paying twice.
					if (!isRetryable(response.status, answer)) keyRef.current = null
					setError(describeError(response.status, answer))
					if (
						response.status !== 401 &&
						(typeof answer?.error !== 'string' || STALE_CODES.has(answer.error))
					) {
						onRefresh()
					}
				} catch {
					setError(
						t`The refund may not have gone through. Check your connection and try again: trying again will not refund twice.`,
					)
				} finally {
					setSubmitting(false)
				}
			})()
		},
	})

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A close mid-request reads as a cancel but the refund still lands.
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				finalFocus={finalFocus}
				data-testid="provider-refund-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Refund this order</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							The money goes back to the guest's card through your payment
							provider. Card and payment provider fees are usually not returned
							to you.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form
					{...getFormProps(form)}
					className="flex flex-col gap-4"
					data-testid="provider-refund-form"
				>
					<input type="hidden" name={fields.kind.name} value={kind} />

					{error ? (
						<Alert variant="destructive" data-testid="provider-refund-error">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<dl className="grid grid-cols-3 gap-3 rounded-lg border p-3 text-sm">
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Paid</Trans>
							</dt>
							<dd className="tabular-nums" data-testid="provider-refund-paid">
								<bdi>{money(order.totalCents)}</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Already refunded</Trans>
							</dt>
							<dd className="tabular-nums">
								<bdi>
									{order.refundedCents + pendingCents > 0
										? money(order.refundedCents + pendingCents)
										: '—'}
								</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Left to refund</Trans>
							</dt>
							<dd className="tabular-nums" data-testid="provider-refund-left">
								<bdi>{money(leftCents)}</bdi>
							</dd>
						</div>
					</dl>

					<SelectField
						label={<Trans>Refund</Trans>}
						id="provider-refund-kind"
						testId="provider-refund-kind"
						options={[
							{ value: 'full', label: t`Everything that is left` },
							{ value: 'partial', label: t`Part of the payment` },
						]}
						value={kind}
						onValueChange={(next) => setKind(next as RefundKind)}
						error={fields.kind.errors?.[0] ?? null}
					/>
					{kind === 'partial' ? (
						<TextField
							label={<Trans>Amount to return</Trans>}
							id="provider-refund-amount"
							name={fields.amount.name}
							defaultValue=""
							error={fields.amount.errors?.[0] ?? null}
							inputMode="decimal"
							placeholder={minorToMajorText(450, order.currency)}
							dir="ltr"
							data-testid="provider-refund-amount"
						/>
					) : null}
					<TextAreaField
						label={<Trans>Note</Trans>}
						hint={t`Saved with the refund, along with who issued it.`}
						id="provider-refund-note"
						name={fields.note.name}
						defaultValue=""
						error={fields.note.errors?.[0] ?? null}
						rows={3}
						maxLength={280}
						data-testid="provider-refund-note"
					/>

					<ErrorList id={form.errorId} errors={form.errors} />

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={submitting}
							data-testid="provider-refund-submit"
						>
							{submitting ? (
								<Trans>Refunding…</Trans>
							) : (
								<Trans>Refund to card</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
