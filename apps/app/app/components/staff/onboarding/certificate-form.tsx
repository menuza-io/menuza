import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { useState, type FormEvent } from 'react'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import {
	addCertificate,
	updateCertificate,
} from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import { type StaffCertificate } from '#app/utils/staffing/onboarding-types.ts'
import {
	certificateFormToInput,
	validateCertificateForm,
	type CertificateFormValues,
} from '#app/utils/staffing/onboarding-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { SelectField, TextField } from '../controls.tsx'
import {
	CERTIFICATE_KIND_ORDER,
	useOnboardingLabels,
} from './onboarding-labels.ts'

function initialValues(
	existing: StaffCertificate | null,
): CertificateFormValues {
	return {
		kind: existing?.kind ?? 'food_handler',
		label: existing?.label ?? '',
		issuedOn: existing?.issuedOn ?? '',
		expiresOn: existing?.expiresOn ?? '',
		note: existing?.note ?? '',
	}
}

/**
 * Adds or edits one certificate. It records that a person holds it and when it
 * lapses: no certificate number and no scan, so there is nothing sensitive to
 * type here. Opens inline; nothing is saved until the button is pressed.
 */
export function CertificateForm({
	client,
	staffId,
	existing,
	onSaved,
	onCancel,
}: {
	client: StaffClient
	staffId: string
	existing: StaffCertificate | null
	onSaved: () => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const labels = useOnboardingLabels()
	const action = useStaffAction(describeOnboardingError)
	const [values, setValues] = useState(() => initialValues(existing))
	const [errors, setErrors] = useState<
		ReturnType<typeof validateCertificateForm>
	>({})
	const set = <K extends keyof CertificateFormValues>(
		key: K,
		value: CertificateFormValues[K],
	) => setValues((current) => ({ ...current, [key]: value }))

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found = validateCertificateForm(values, _)
		setErrors(found)
		if (Object.keys(found).length > 0) return
		const input = certificateFormToInput(values)
		const result = await action.run(() =>
			existing
				? updateCertificate(client, staffId, existing.id, input)
				: addCertificate(client, staffId, input),
		)
		if (result.ok) onSaved()
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			aria-label={existing ? _(t`Edit certificate`) : _(t`Add a certificate`)}
			className="border-border flex flex-col gap-4 border-t pt-4"
		>
			<SelectField
				label={<Trans>Certificate</Trans>}
				value={values.kind}
				onValueChange={(next) =>
					set('kind', next as CertificateFormValues['kind'])
				}
				options={CERTIFICATE_KIND_ORDER.map((kind) => ({
					value: kind,
					label: labels.certificateKind(kind),
				}))}
			/>
			{values.kind === 'other' ? (
				<TextField
					label={<Trans>What is it called</Trans>}
					value={values.label}
					onChange={(event) => set('label', event.target.value)}
					error={errors.label}
					maxLength={60}
					autoComplete="off"
				/>
			) : null}
			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>Issued</Trans>}
					optional
					type="date"
					value={values.issuedOn}
					onChange={(event) => set('issuedOn', event.target.value)}
					error={errors.issuedOn}
				/>
				<TextField
					label={<Trans>Expires</Trans>}
					optional
					hint={<Trans>Leave empty if it never expires.</Trans>}
					type="date"
					value={values.expiresOn}
					onChange={(event) => set('expiresOn', event.target.value)}
					error={errors.expiresOn}
				/>
			</div>
			<TextField
				label={<Trans>Note</Trans>}
				optional
				value={values.note}
				onChange={(event) => set('note', event.target.value)}
				error={errors.note}
				maxLength={200}
				autoComplete="off"
			/>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={action.pending}>
					{action.pending ? (
						<Trans>Saving…</Trans>
					) : existing ? (
						<Trans>Save</Trans>
					) : (
						<Trans>Add certificate</Trans>
					)}
				</Button>
				<Button
					type="button"
					variant="ghost"
					onClick={onCancel}
					disabled={action.pending}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	)
}
