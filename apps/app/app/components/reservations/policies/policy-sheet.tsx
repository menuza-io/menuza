import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { type FormEvent, useMemo, useState } from 'react'
import {
	LocalizedMapField,
	ReservationLocaleProvider,
	ReservationLocaleSwitcher,
	WritingLanguageNote,
} from '#app/components/reservations/localized-fields.tsx'
import { useRevealedErrors } from '#app/components/reservations/settings/use-revealed-errors.ts'
import {
	type Option,
	SelectField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import {
	POLICY_KINDS,
	POLICY_REFUND_RULES,
	type PolicyBody,
	type PolicyDto,
	type PolicyKind,
	type PolicyRefundRule,
} from '#app/utils/reservations/policies-api.ts'
import {
	emptyPolicyForm,
	POLICY_KIND_HINTS,
	POLICY_KIND_LABELS,
	POLICY_REFUND_RULE_LABELS,
	type PolicyFormErrors,
	type PolicyFormField,
	type PolicyFormValues,
	policyFormToBody,
	policyIssueFields,
	policyToForm,
	summarizePolicyForm,
	policyErrorMessage,
} from '#app/utils/reservations/policies-view.ts'
import { useReservationLocales } from '#app/utils/reservations/use-reservation-locales.ts'

/**
 * Create or edit one payment policy. The form is a local draft: nothing is
 * saved until Save, and a failed or conflicting save leaves what was typed in
 * place. Amounts are typed in the location currency and sent as integer minor
 * units.
 */
export function PolicySheet({
	open,
	onClose,
	policy,
	currency,
	region,
	onSave,
}: {
	open: boolean
	onClose: () => void
	/** The policy being edited, or null to create one. */
	policy: PolicyDto | null
	currency: string
	region: string | null
	onSave: (body: PolicyBody) => Promise<void>
}) {
	return (
		<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
			<SheetContent className="sm:max-w-lg" data-testid="policy-sheet">
				{open ? (
					<ReservationLocaleProvider>
						<Body
							policy={policy}
							currency={currency}
							region={region}
							onClose={onClose}
							onSave={onSave}
						/>
					</ReservationLocaleProvider>
				) : null}
			</SheetContent>
		</Sheet>
	)
}

function Body({
	policy,
	currency,
	region,
	onClose,
	onSave,
}: Omit<Parameters<typeof PolicySheet>[0], 'open'>) {
	const { t, i18n } = useLingui()
	const languages = useReservationLocales()
	const [form, setForm] = useState<PolicyFormValues>(() =>
		policy ? policyToForm(policy, currency) : emptyPolicyForm(),
	)
	// Errors are derived from the form on every render and revealed after a
	// save attempt or blur, so they clear as soon as the value is valid. The
	// server's own complaints are flagged separately and drop on the next edit.
	const parsed = useMemo(
		() => policyFormToBody(form, currency, languages),
		[form, currency, languages],
	)
	const { errors: revealedErrors, attempt } = useRevealedErrors<
		PolicyFormField,
		MessageDescriptor
	>(parsed.ok ? {} : parsed.errors)
	const [serverFlags, setServerFlags] = useState<PolicyFormErrors>({})
	const errors: PolicyFormErrors = { ...serverFlags, ...revealedErrors }
	const [pending, setPending] = useState(false)
	const [banner, setBanner] = useState<string | null>(null)

	const set = <K extends keyof PolicyFormValues>(
		key: K,
		value: PolicyFormValues[K],
	) => {
		setServerFlags({})
		setForm((current) => ({ ...current, [key]: value }))
	}

	const kindOptions: Option[] = useMemo(
		() =>
			POLICY_KINDS.map((value) => ({
				value,
				label: i18n._(POLICY_KIND_LABELS[value]),
			})),
		[i18n],
	)
	const refundOptions: Option[] = useMemo(
		() =>
			POLICY_REFUND_RULES.map((value) => ({
				value,
				label: i18n._(POLICY_REFUND_RULE_LABELS[value]),
			})),
		[i18n],
	)
	const summary = useMemo(
		() => summarizePolicyForm(form, currency, i18n.locale, (d) => i18n._(d)),
		[form, currency, i18n],
	)
	const takesMoney = form.kind === 'deposit' || form.kind === 'prepay'
	const message = (field: PolicyFormField) =>
		errors[field] ? i18n._(errors[field]!) : null

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		attempt()
		setBanner(null)
		if (!parsed.ok) return
		setServerFlags({})
		setPending(true)
		try {
			await onSave(parsed.body)
		} catch (error) {
			const flagged: PolicyFormErrors = {}
			for (const field of policyIssueFields(error)) {
				flagged[field] = msg`Check this value.`
			}
			setServerFlags(flagged)
			setBanner(
				policyErrorMessage(
					error,
					(descriptor) => i18n._(descriptor),
					msg`The policy could not be saved. Try again.`,
				),
			)
		} finally {
			setPending(false)
		}
	}

	return (
		<SheetForm
			title={policy ? t`Edit policy` : t`New payment policy`}
			description={t`What guests pay or guarantee to book, and what happens if they cancel or do not show.`}
			onSubmit={submit}
			headerExtra={<ReservationLocaleSwitcher />}
			footer={
				<>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={pending} data-testid="policy-save">
						{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</>
			}
		>
			{summary ? (
				<p
					className="bg-muted text-foreground rounded-lg px-3 py-2 text-sm text-pretty"
					data-testid="policy-summary"
					aria-live="polite"
				>
					{summary}
				</p>
			) : null}
			{banner ? (
				<Alert variant="destructive" data-testid="policy-error">
					<AlertDescription>{banner}</AlertDescription>
				</Alert>
			) : null}
			{region === 'ksa' && form.kind === 'card_guarantee' ? (
				<Alert data-testid="policy-ksa-note">
					<AlertDescription>
						<Trans>
							Prepaid deposits are recommended in this region. Saved-card fees
							depend on the guest&apos;s bank and may need the guest to confirm.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<TextField
				label={<Trans>Name</Trans>}
				value={form.name}
				onChange={(event) => set('name', event.target.value)}
				maxLength={80}
				error={message('name')}
				data-testid="policy-name"
			/>
			<SelectField
				label={<Trans>Type</Trans>}
				hint={i18n._(POLICY_KIND_HINTS[form.kind])}
				value={form.kind}
				options={kindOptions}
				onValueChange={(value) => set('kind', value as PolicyKind)}
				id="policy-kind"
			/>

			{takesMoney ? (
				<>
					<TextField
						label={<Trans>Amount ({currency})</Trans>}
						inputMode="decimal"
						value={form.amount}
						onChange={(event) => set('amount', event.target.value)}
						error={message('amount')}
						data-testid="policy-amount"
					/>
					<SwitchField
						label={<Trans>Charged per guest</Trans>}
						description={
							<Trans>
								Off: one amount per booking. On: the amount is multiplied by the
								party size.
							</Trans>
						}
						checked={form.perCover}
						onCheckedChange={(value) => set('perCover', value)}
					/>
				</>
			) : null}

			{form.kind !== 'none' ? (
				<>
					<TextField
						label={<Trans>Free cancellation until (hours before)</Trans>}
						inputMode="numeric"
						value={form.freeCancelHours}
						onChange={(event) => set('freeCancelHours', event.target.value)}
						hint={<Trans>0 means the booking is never free to cancel.</Trans>}
						error={message('freeCancelHours')}
						data-testid="policy-free-cancel"
					/>
					<TextField
						label={<Trans>Late-cancel fee ({currency})</Trans>}
						inputMode="decimal"
						optional
						value={form.lateCancelFee}
						onChange={(event) => set('lateCancelFee', event.target.value)}
						error={message('lateCancelFee')}
					/>
					<TextField
						label={<Trans>No-show fee ({currency})</Trans>}
						inputMode="decimal"
						optional
						value={form.noShowFee}
						onChange={(event) => set('noShowFee', event.target.value)}
						error={message('noShowFee')}
					/>
					<SwitchField
						label={<Trans>Fees are per guest</Trans>}
						checked={form.feePerCover}
						onCheckedChange={(value) => set('feePerCover', value)}
					/>
					<TextField
						label={<Trans>Fee cap ({currency})</Trans>}
						inputMode="decimal"
						optional
						value={form.feeCap}
						onChange={(event) => set('feeCap', event.target.value)}
						hint={<Trans>The most one booking can be charged in fees.</Trans>}
						error={message('feeCap')}
					/>
				</>
			) : null}

			{takesMoney ? (
				<>
					<SelectField
						label={<Trans>Refunds when the guest cancels</Trans>}
						value={form.refundRule}
						options={refundOptions}
						onValueChange={(value) =>
							set('refundRule', value as PolicyRefundRule)
						}
						id="policy-refund-rule"
					/>
					{form.refundRule === 'partial' ? (
						<TextField
							label={<Trans>Refunded after the deadline (%)</Trans>}
							inputMode="decimal"
							value={form.partialRefundPercent}
							onChange={(event) =>
								set('partialRefundPercent', event.target.value)
							}
							error={message('partialRefundPercent')}
						/>
					) : null}
				</>
			) : null}

			<TextField
				label={<Trans>Only for parties of at least</Trans>}
				inputMode="numeric"
				optional
				value={form.appliesPartyMin}
				onChange={(event) => set('appliesPartyMin', event.target.value)}
				hint={<Trans>Leave empty to apply to every party size.</Trans>}
				error={message('appliesPartyMin')}
			/>

			<div className="flex flex-col gap-3">
				<LocalizedMapField
					multiline
					label={<Trans>Terms shown to guests (guest-facing)</Trans>}
					hint={
						<Trans>
							Guests read these terms and accept them before they book. Write
							them in each language your website offers.
						</Trans>
					}
					value={form.terms}
					onChange={(terms) => set('terms', terms)}
					maxLength={4000}
					rows={5}
					data-testid="policy-terms"
				/>
				<WritingLanguageNote />
			</div>
		</SheetForm>
	)
}
