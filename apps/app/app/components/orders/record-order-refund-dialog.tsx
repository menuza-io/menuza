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
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { ErrorList } from '#app/components/forms.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	formatMoney,
	type OrderRefundBody,
	refundableCents,
} from '#app/utils/orders/order-model.ts'
import { refundSubmitKey } from '#app/utils/submit-key.ts'

type RefundKind = 'full' | 'partial'

/**
 * Records money already returned for a paid online order, for example in the
 * payment provider's dashboard. No money moves. The order then reads
 * Refunded or Partly refunded, and loyalty takes back the points it earned.
 */
export function RecordOrderRefundDialog({
	order,
	open,
	onOpenChange,
	onSubmit,
	onRecorded,
	onStale,
	finalFocus,
}: {
	order: {
		id: string
		currency: string
		totalCents: number
		refundedCents: number
	}
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Sends the refund to the region; rejects with an `OperatorRequestError`. */
	onSubmit: (body: OrderRefundBody, idempotencyKey: string) => Promise<void>
	onRecorded: () => void
	/**
	 * Reloads the order after an answer that means the dialog's figures are
	 * out of date: already fully refunded, or the refund landed differently.
	 */
	onStale?: () => void
	/** Where focus goes on close; see `useSettledFocus`. */
	finalFocus?: () => HTMLElement | boolean
}) {
	const { t, i18n } = useLingui()
	const [kind, setKind] = useState<RefundKind>('full')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const money = (cents: number) =>
		formatMoney(cents, order.currency, i18n.locale)
	const leftCents = refundableCents(order)
	const refunded = order.refundedCents

	const schema = useMemo(
		() =>
			z
				.object({
					kind: z.enum(['full', 'partial']),
					amount: z.string().trim().optional(),
					note: z
						.string()
						.trim()
						.min(3, t`Add a short note, such as how the money went back.`)
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
							message: t`Enter the amount returned, for example 4.50.`,
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

	const describeError = (err: unknown): string => {
		if (!(err instanceof OperatorRequestError)) {
			return t`The refund could not be recorded. Check your connection and try again.`
		}
		switch (err.code) {
			case 'refund_exceeds_payment': {
				// The region always sends what is still refundable with this code.
				const label = money(err.body?.refundableCents as number)
				return t`At most ${label} can still be refunded.`
			}
			case 'refund_complete':
				return t`This order is already fully refunded.`
			case 'refund_not_paid':
				return t`Only a paid order can be refunded.`
			case 'refund_not_online':
				return t`Only orders paid online can be refunded here.`
			case 'idempotency_conflict':
				return onStale
					? t`This refund was already recorded with other details. The amounts above are now up to date.`
					: t`This refund was already recorded with other details. Reload the order to see it.`
			case 'order_not_found':
				return t`This order no longer exists.`
		}
		if (err.status === 401 || err.status === 403) {
			return t`You do not have permission to record refunds.`
		}
		return t`The refund could not be recorded. Try again.`
	}

	const [form, fields] = useForm({
		id: 'order-refund-form',
		defaultValue: { kind: 'full', amount: '', note: '' },
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success') return
			const value = submission.value
			const body: OrderRefundBody =
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
			// Derived from the order, what it already refunded and the content,
			// so a retry after a lost response — even after this dialog closed
			// and reopened — replays the first attempt instead of recording twice.
			const key = refundSubmitKey('order-refund', {
				saleId: order.id,
				refundedMinor: refunded,
				body,
			})
			setSubmitting(true)
			setError(null)
			onSubmit(body, key)
				.then(() => {
					onRecorded()
				})
				.catch((err: unknown) => {
					setError(describeError(err))
					if (
						err instanceof OperatorRequestError &&
						(err.code === 'refund_complete' ||
							err.code === 'idempotency_conflict')
					) {
						onStale?.()
					}
				})
				.finally(() => {
					setSubmitting(false)
				})
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
				data-testid="order-refund-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Record a refund</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Record money you already returned, for example in your payment
							provider's dashboard, and chargebacks you lost: neither reaches
							this order on its own. Recording it moves no money. If the order
							earned loyalty points, they are taken back.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form
					{...getFormProps(form)}
					className="flex flex-col gap-4"
					data-testid="order-refund-form"
				>
					<input type="hidden" name={fields.kind.name} value={kind} />

					{error ? (
						<Alert variant="destructive" data-testid="order-refund-error">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<dl className="grid grid-cols-3 gap-3 rounded-lg border p-3 text-sm">
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Paid</Trans>
							</dt>
							<dd className="tabular-nums" data-testid="order-refund-paid">
								<bdi>{money(order.totalCents)}</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Already refunded</Trans>
							</dt>
							<dd className="tabular-nums">
								<bdi>{refunded > 0 ? money(refunded) : '—'}</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="text-muted-foreground text-xs">
								<Trans>Left to refund</Trans>
							</dt>
							<dd className="tabular-nums" data-testid="order-refund-left">
								<bdi>{money(leftCents)}</bdi>
							</dd>
						</div>
					</dl>

					<SelectField
						label={<Trans>Refund</Trans>}
						id="order-refund-kind"
						testId="order-refund-kind"
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
							label={<Trans>Amount returned</Trans>}
							id="order-refund-amount"
							name={fields.amount.name}
							defaultValue=""
							error={fields.amount.errors?.[0] ?? null}
							inputMode="decimal"
							placeholder={minorToMajorText(450, order.currency)}
							dir="ltr"
							data-testid="order-refund-amount"
						/>
					) : null}
					<TextAreaField
						label={<Trans>Note</Trans>}
						hint={t`Saved with the refund, along with who recorded it.`}
						id="order-refund-note"
						name={fields.note.name}
						defaultValue=""
						error={fields.note.errors?.[0] ?? null}
						rows={3}
						maxLength={280}
						data-testid="order-refund-note"
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
							data-testid="order-refund-submit"
						>
							{submitting ? (
								<Trans>Saving…</Trans>
							) : (
								<Trans>Record refund</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
