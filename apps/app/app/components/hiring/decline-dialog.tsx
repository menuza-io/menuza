import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DECLINE_TEMPLATES,
	type DeclineReason,
	type DeclineTemplate,
} from '@repo/staffing'
import { cn } from '@repo/ui'
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
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldTitle,
} from '@repo/ui/field'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState, type FormEvent } from 'react'
import { SelectField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { declineApplicant } from '#app/utils/hiring/applicant-api.ts'
import { describeApplicantError } from '#app/utils/hiring/applicant-errors.ts'
import { type DeclineResult } from '#app/utils/hiring/applicant-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { useApplicantLabels } from './applicant-labels.ts'

/**
 * Decline a candidate: pick why (kept privately) and what, if anything, they are
 * told. The decision is saved first; if the email cannot be sent the manager is
 * told so afterwards, and the decision stands.
 */
export function DeclineDialog({
	client,
	applicationId,
	name,
	hasEmail,
	retentionDays,
	onDeclined,
	onClose,
}: {
	client: StaffClient
	applicationId: string
	name: string
	hasEmail: boolean
	retentionDays: number
	onDeclined: (result: DeclineResult) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const labels = useApplicantLabels()
	const action = useStaffAction(describeApplicantError)
	const [reason, setReason] = useState<DeclineReason>('not_a_fit')
	const [template, setTemplate] = useState<DeclineTemplate>(
		hasEmail ? 'thanks' : 'none',
	)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (action.pending) return
		const result = await action.run(() =>
			declineApplicant(client, applicationId, { reason, template }),
		)
		if (result.ok) {
			onDeclined(result.value)
			onClose()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="grid gap-4"
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Decline {name}</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								They leave the pipeline. Their details are removed after{' '}
								{retentionDays} days.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					<SelectField
						label={<Trans>Reason (only you see this)</Trans>}
						value={reason}
						onValueChange={(next) => setReason(next as DeclineReason)}
						options={labels.declineReasonOptions}
					/>

					<FieldSet>
						<FieldLegend variant="label">
							<Trans>Message to {name}</Trans>
						</FieldLegend>
						{!hasEmail ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									There is no email on file, so nothing can be sent.
								</Trans>
							</p>
						) : null}
						<RadioGroup
							value={template}
							onValueChange={(next: string) =>
								setTemplate(next as DeclineTemplate)
							}
							className="grid gap-2"
							aria-label={_(t`Message to the applicant`)}
						>
							{DECLINE_TEMPLATES.map((key) => {
								const disabled = !hasEmail && key !== 'none'
								return (
									<FieldLabel
										key={key}
										className={cn(disabled && 'cursor-not-allowed opacity-50')}
									>
										<Field orientation="horizontal">
											<RadioGroupItem value={key} disabled={disabled} />
											<FieldContent>
												<FieldTitle>
													{labels.declineTemplate[key].label}
												</FieldTitle>
												<FieldDescription>
													{labels.declineTemplate[key].description}
												</FieldDescription>
											</FieldContent>
										</Field>
									</FieldLabel>
								)
							})}
						</RadioGroup>
					</FieldSet>

					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={action.pending}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							variant="destructive"
							disabled={action.pending}
						>
							{action.pending ? (
								<Trans>Declining…</Trans>
							) : (
								<Trans>Decline</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
