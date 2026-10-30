import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	LOYALTY_ADJUSTMENT_REASONS,
	LOYALTY_MAX_ADJUSTMENT_DELTA,
	type LoyaltyAdjustmentReason,
	type LoyaltyMemberSummary,
} from '@repo/loyalty'
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
import { type LoyaltyClient } from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import { LOYALTY_ADJUSTMENT_REASON_LABELS } from '#app/utils/loyalty/loyalty-labels.ts'
import { asciiNumberText, parseWholeNumber } from '#app/utils/money-input.ts'
import { refundSubmitKey } from '#app/utils/submit-key.ts'

/**
 * The typed change as a whole number, or null. Arabic-Indic digits, a leading
 * plus and the minus sign the loyalty pages print (−) read like plain ASCII;
 * the direction marks a copied Arabic number carries are ignored.
 */
function parseDelta(input: string): number | null {
	const text = asciiNumberText(input)
	const sign = /^[-+\u2212]/.exec(text)?.[0]
	const magnitude = parseWholeNumber(sign ? text.slice(1) : text)
	if (magnitude === null) return null
	return sign && sign !== '+' ? -magnitude : magnitude
}
export function AdjustDialog({
	client,
	member,
	open,
	onOpenChange,
	onAdjusted,
}: {
	client: LoyaltyClient
	member: LoyaltyMemberSummary
	open: boolean
	onOpenChange: (open: boolean) => void
	onAdjusted: (member: LoyaltyMemberSummary) => void
}) {
	const { t } = useLingui()
	const [submitting, setSubmitting] = useState(false)
	// The ledger entry this dialog's last adjustment created, so the same
	// adjustment submitted again is a new one even before the parent reloads.
	const lastEntryRef = useRef<string | null>(null)

	const memberName = member.name ?? t`this customer`

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A close mid-request reads as a cancel but the adjustment lands.
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				data-testid="loyalty-adjust-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Adjust points</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Add or remove points for{' '}
							<span className="font-medium wrap-anywhere">{memberName}</span>.
							The reason and note go to the audit log.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{/* The popup unmounts on close, so a reopened dialog starts clean:
				    no old reason, server error or field errors. */}
				<AdjustForm
					client={client}
					member={member}
					lastEntryRef={lastEntryRef}
					submitting={submitting}
					onSubmittingChange={setSubmitting}
					onCancel={() => onOpenChange(false)}
					onAdjusted={onAdjusted}
				/>
			</DialogContent>
		</Dialog>
	)
}

function AdjustForm({
	client,
	member,
	lastEntryRef,
	submitting,
	onSubmittingChange,
	onCancel,
	onAdjusted,
}: {
	client: LoyaltyClient
	member: LoyaltyMemberSummary
	lastEntryRef: { current: string | null }
	submitting: boolean
	onSubmittingChange: (submitting: boolean) => void
	onCancel: () => void
	onAdjusted: (member: LoyaltyMemberSummary) => void
}) {
	const { t, i18n } = useLingui()
	const [reason, setReason] = useState<LoyaltyAdjustmentReason>('goodwill')
	const [error, setError] = useState<string | null>(null)

	const schema = useMemo(() => {
		const most = new Intl.NumberFormat(i18n.locale).format(
			LOYALTY_MAX_ADJUSTMENT_DELTA,
		)
		return z.object({
			delta: z
				.string()
				.trim()
				.refine(
					(value) => (parseDelta(value) ?? 0) !== 0,
					t`Enter a whole number, negative to take points away.`,
				)
				.refine(
					(value) =>
						Math.abs(parseDelta(value) ?? 0) <= LOYALTY_MAX_ADJUSTMENT_DELTA,
					t`Adjust at most ${most} points at a time.`,
				)
				.default(''),
			reason: z.enum(LOYALTY_ADJUSTMENT_REASONS),
			note: z
				.string()
				.trim()
				.min(3, t`Add a short note explaining the adjustment.`)
				.max(280, t`Keep the note under 280 characters.`)
				.default(''),
		})
	}, [t, i18n.locale])

	const [form, fields] = useForm({
		id: 'loyalty-adjust-form',
		defaultValue: { delta: '', reason: 'goodwill', note: '' },
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success') return
			const value = submission.value
			const delta = parseDelta(value.delta)
			if (delta === null) return
			const body = { delta, reason: value.reason, note: value.note }
			onSubmittingChange(true)
			setError(null)
			// Derived from the member, the balance it applies to and the content,
			// so a retry after a lost response, even after this dialog closed and
			// reopened, replays the first attempt instead of adjusting twice.
			// Once it lands the balance changes, and so does the key.
			const key = refundSubmitKey('lty-adjust', {
				memberId: member.id,
				balance: {
					points: member.balance.points,
					reserved: member.balance.reserved,
				},
				lastEntryId: lastEntryRef.current,
				body,
			})
			client
				.adjustMember(member.id, body, key)
				.then((result) => {
					lastEntryRef.current = result.entry.id
					onAdjusted({ ...member, balance: result.balance })
				})
				.catch((err: unknown) => {
					setError(
						loyaltyErrorMessage(
							err,
							(d) => i18n._(d),
							msg`The adjustment could not be saved.`,
						),
					)
				})
				.finally(() => {
					onSubmittingChange(false)
				})
		},
	})

	const currentBalance = new Intl.NumberFormat(i18n.locale).format(
		member.balance.points,
	)

	return (
		<form
			{...getFormProps(form)}
			className="flex flex-col gap-4"
			data-testid="loyalty-adjust-form"
		>
			<input type="hidden" name={fields.reason.name} value={reason} />

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-adjust-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<TextField
				label={<Trans>Points change</Trans>}
				hint={t`Positive to add, negative to remove. Current balance: ${currentBalance}.`}
				id="loyalty-adjust-delta"
				name={fields.delta.name}
				defaultValue=""
				error={fields.delta.errors?.[0] ?? null}
				// Not "numeric": the iPhone number pad has no minus key.
				inputMode="text"
				placeholder="50"
				dir="ltr"
				data-testid="loyalty-adjust-delta"
			/>
			<SelectField
				label={<Trans>Reason</Trans>}
				id="loyalty-adjust-reason"
				testId="loyalty-adjust-reason"
				options={LOYALTY_ADJUSTMENT_REASONS.map((value) => ({
					value,
					label: i18n._(LOYALTY_ADJUSTMENT_REASON_LABELS[value]),
				}))}
				value={reason}
				onValueChange={(next) => setReason(next as LoyaltyAdjustmentReason)}
				error={fields.reason.errors?.[0] ?? null}
			/>
			<TextAreaField
				label={<Trans>Note</Trans>}
				id="loyalty-adjust-note"
				name={fields.note.name}
				defaultValue=""
				error={fields.note.errors?.[0] ?? null}
				rows={3}
				maxLength={280}
				data-testid="loyalty-adjust-note"
			/>

			<ErrorList id={form.errorId} errors={form.errors} />

			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={submitting}
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button
					type="submit"
					disabled={submitting}
					data-testid="loyalty-adjust-submit"
				>
					{submitting ? <Trans>Saving…</Trans> : <Trans>Save adjustment</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
