import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PAY_PERIOD_TYPES,
	payPeriodAnchorProblem,
	type PayPeriodType,
} from '@repo/staffing'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldError } from '@repo/ui/field'
import { Skeleton } from '@repo/ui/skeleton'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { describeTimesheetError } from '#app/utils/staffing/timesheet-errors.ts'
import { payPeriodSettingsSchema } from '#app/utils/staffing/timesheet-types.ts'
import { isValidDate } from '#app/utils/staffing/timesheet-view.ts'

/**
 * How often people are paid: weekly, every two weeks, twice a month or monthly,
 * and a date that fixes where periods start. Applies to the whole organization,
 * so it is only offered to someone who can change labor rules for every
 * scope. It only draws the lines a payroll file is cut on; it does not pay
 * anyone.
 */
export function PayPeriodDialog({
	client,
	onClose,
	onSaved,
}: {
	client: StaffClient
	onClose: () => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const query = useStaffQuery(
		client,
		'/timesheets/settings',
		payPeriodSettingsSchema,
	)
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Pay period</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Where one period ends and the next begins. Timesheets and the
							payroll summary are cut on these lines.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{query.data ? (
					<PayPeriodForm
						client={client}
						initialType={query.data.payPeriod}
						initialAnchor={query.data.payPeriodAnchor}
						onClose={onClose}
						onSaved={onSaved}
					/>
				) : query.error ? (
					<FieldError>{describeTimesheetError(query.error, _)}</FieldError>
				) : (
					<div role="status" className="flex flex-col gap-3">
						<span className="sr-only">
							<Trans>Loading</Trans>
						</span>
						<Skeleton className="h-11 w-full" />
						<Skeleton className="h-11 w-full" />
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}

function PayPeriodForm({
	client,
	initialType,
	initialAnchor,
	onClose,
	onSaved,
}: {
	client: StaffClient
	initialType: PayPeriodType
	initialAnchor: string | null
	onClose: () => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const [type, setType] = useState<PayPeriodType>(initialType)
	const [anchor, setAnchor] = useState(initialAnchor ?? '')
	const [error, setError] = useState<string | null>(null)
	const save = useStaffAction(describeTimesheetError)

	const typeLabels: Record<PayPeriodType, string> = {
		weekly: _(t`Every week`),
		biweekly: _(t`Every two weeks`),
		semimonthly: _(t`Twice a month`),
		monthly: _(t`Once a month`),
	}
	const hints: Record<PayPeriodType, string> = {
		weekly: _(
			t`Pick a day a period starts on. Leave empty to follow each workplace's work week.`,
		),
		biweekly: _(
			t`Pick the first day of any one period. Every second week after it starts a new one.`,
		),
		semimonthly: _(
			t`Pick a day from 1 to 14. Periods start on that day and 15 days later.`,
		),
		monthly: _(t`Pick a day from 1 to 28. Each period starts on that day.`),
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (save.pending) return
		const value = anchor.trim() === '' ? null : anchor.trim()
		if (value !== null && !isValidDate(value)) {
			setError(_(t`Enter a date.`))
			return
		}
		if (payPeriodAnchorProblem(type, value)) {
			setError(
				type === 'semimonthly'
					? _(t`Pick a day from 1 to 14.`)
					: _(t`Pick a day from 1 to 28.`),
			)
			return
		}
		setError(null)
		const result = await save.run(() =>
			client.request('/timesheets/settings', {
				method: 'PUT',
				json: { payPeriod: type, payPeriodAnchor: value },
			}),
		)
		if (result.ok) {
			toast.success(_(t`Pay period saved.`))
			onSaved()
			onClose()
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="grid gap-4"
		>
			<SelectField
				label={<Trans>How often</Trans>}
				value={type}
				onValueChange={(next) => {
					setType(next as PayPeriodType)
					setError(null)
				}}
				options={PAY_PERIOD_TYPES.map((value) => ({
					value,
					label: typeLabels[value],
				}))}
			/>
			<TextField
				label={<Trans>Starting date</Trans>}
				optional
				type="date"
				dir="ltr"
				value={anchor}
				onChange={(event) => {
					setAnchor(event.target.value)
					setError(null)
				}}
				hint={hints[type]}
				error={error}
			/>
			{save.error ? <FieldError>{save.error}</FieldError> : null}
			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					disabled={save.pending}
					onClick={onClose}
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="submit" disabled={save.pending}>
					{save.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
				</Button>
			</DialogFooter>
		</form>
	)
}
