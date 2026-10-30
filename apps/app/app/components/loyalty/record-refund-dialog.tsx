import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { msg } from '@lingui/core/macro'
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
import {
	LoyaltyApiError,
	loyaltyErrorInfo,
	type LoyaltyClient,
	type LoyaltyRefundResult,
	type LoyaltyRefundSource,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import { formatLoyaltyMoney } from '#app/utils/loyalty/loyalty-view.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import { refundSubmitKey } from '#app/utils/submit-key.ts'

/** What the sale paid and what already came back, when the caller knows. */
export type LoyaltyRefundAmounts = {
	currency: string
	paidMinor: number | null
	refundedMinor: number
}

type RefundKind = 'full' | 'partial'

/**
 * Records money already returned outside Menuza (payment dashboard, cash).
 * The region takes back the points the refunded part earned and, once
 * everything paid has come back, returns the reward's points. No money moves.
 */
export function RecordRefundDialog({
	client,
	source,
	amounts,
	open,
	onOpenChange,
	onRecorded,
	finalFocus,
}: {
	client: LoyaltyClient
	source: LoyaltyRefundSource
	amounts: LoyaltyRefundAmounts
	open: boolean
	onOpenChange: (open: boolean) => void
	onRecorded: (result: LoyaltyRefundResult) => void
	/** Where focus goes on close; see `useSettledFocus`. */
	finalFocus?: () => HTMLElement | boolean
}) {
	const { t, i18n } = useLingui()
	const [kind, setKind] = useState<RefundKind>('full')
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const remainingMinor =
		amounts.paidMinor === null
			? null
			: Math.max(0, amounts.paidMinor - amounts.refundedMinor)
	const paidLabel =
		amounts.paidMinor === null
			? null
			: formatLoyaltyMoney(amounts.paidMinor, amounts.currency, i18n.locale)
	const refundedLabel = amounts.refundedMinor
		? formatLoyaltyMoney(amounts.refundedMinor, amounts.currency, i18n.locale)
		: null

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
					const minor = parseMoneyToMinor(value.amount ?? '', {
						min: 1,
						currency: amounts.currency,
					})
					if (minor === null) {
						ctx.addIssue({
							code: 'custom',
							path: ['amount'],
							message: t`Enter the amount returned, for example 4.50.`,
						})
						return
					}
					if (remainingMinor !== null && minor > remainingMinor) {
						ctx.addIssue({
							code: 'custom',
							path: ['amount'],
							message: t`That is more than what is left to refund.`,
						})
					}
				}),
		[t, remainingMinor, amounts.currency],
	)

	const describeError = (err: unknown): string => {
		const { code } = loyaltyErrorInfo(err)
		if (code === 'purchase_not_found') {
			return t`No loyalty points or rewards are linked to this sale, so there is nothing to take back.`
		}
		if (code === 'refund_exceeds_payment' && err instanceof LoyaltyApiError) {
			// The region always sends what is still refundable with this code.
			const refundable = (err.body as { refundableMinor: number })
				.refundableMinor
			const most = formatLoyaltyMoney(refundable, amounts.currency, i18n.locale)
			return t`At most ${most} can still be refunded.`
		}
		return loyaltyErrorMessage(
			err,
			(descriptor) => i18n._(descriptor),
			msg`The refund could not be recorded.`,
		)
	}

	const [form, fields] = useForm({
		id: 'loyalty-refund-form',
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
			const body =
				value.kind === 'full'
					? { source, full: true, note: value.note }
					: {
							source,
							amountMinor:
								parseMoneyToMinor(value.amount ?? '', {
									min: 1,
									currency: amounts.currency,
								}) ?? 0,
							note: value.note,
						}
			// Derived from the sale, what it already refunded and the content,
			// so a retry after a lost response — even after this dialog closed
			// and reopened — replays the first attempt instead of recording twice.
			const key = refundSubmitKey('lty-refund', {
				saleId: `${source.type}:${source.id}`,
				refundedMinor: amounts.refundedMinor,
				body,
			})
			setSubmitting(true)
			setError(null)
			client
				.recordRefund(body, key)
				.then((result) => {
					onRecorded(result)
				})
				.catch((err: unknown) => {
					setError(describeError(err))
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
				data-testid="loyalty-refund-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Record a refund</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Record money you already returned, for example in your payment
							dashboard or in cash, and chargebacks you lost: neither reaches
							this tab on its own. Points earned on the refunded part are taken
							back, and the reward's points come back once everything paid is
							refunded. No money moves.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form
					{...getFormProps(form)}
					className="flex flex-col gap-4"
					data-testid="loyalty-refund-form"
				>
					<input type="hidden" name={fields.kind.name} value={kind} />

					{error ? (
						<Alert variant="destructive" data-testid="loyalty-refund-error">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{paidLabel ? (
						<dl className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
							<div className="flex flex-col gap-0.5">
								<dt className="text-muted-foreground text-xs">
									<Trans>Paid</Trans>
								</dt>
								<dd dir="ltr" data-testid="loyalty-refund-paid">
									{paidLabel}
								</dd>
							</div>
							<div className="flex flex-col gap-0.5">
								<dt className="text-muted-foreground text-xs">
									<Trans>Already refunded</Trans>
								</dt>
								<dd dir="ltr">{refundedLabel ?? '—'}</dd>
							</div>
						</dl>
					) : null}

					<SelectField
						label={<Trans>Refund</Trans>}
						id="loyalty-refund-kind"
						testId="loyalty-refund-kind"
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
							id="loyalty-refund-amount"
							name={fields.amount.name}
							defaultValue=""
							error={fields.amount.errors?.[0] ?? null}
							inputMode="decimal"
							placeholder={minorToMajorText(450, amounts.currency)}
							dir="ltr"
							data-testid="loyalty-refund-amount"
						/>
					) : null}
					<TextAreaField
						label={<Trans>Note</Trans>}
						hint={t`Saved in the audit log with your name.`}
						id="loyalty-refund-note"
						name={fields.note.name}
						defaultValue=""
						error={fields.note.errors?.[0] ?? null}
						rows={3}
						maxLength={280}
						data-testid="loyalty-refund-note"
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
							data-testid="loyalty-refund-submit"
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

/** One sentence for a recorded refund, for a notice after the dialog closes. */
export function useRefundResultMessage() {
	const { t } = useLingui()
	return (result: LoyaltyRefundResult): string => {
		const taken = result.pointsReversed
		const recorded =
			taken > 0
				? t`Refund recorded. Points taken back: ${taken}.`
				: t`Refund recorded. No points needed to be taken back.`
		return result.rewardRestored
			? `${recorded} ${t`The reward's points were returned to the customer.`}`
			: recorded
	}
}
