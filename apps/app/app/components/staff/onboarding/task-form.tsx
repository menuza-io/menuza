import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { useState, type FormEvent } from 'react'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { addOnboardingTask } from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import {
	taskFormToInput,
	validateTaskForm,
	type TaskFormValues,
} from '#app/utils/staffing/onboarding-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { SelectField, TextAreaField, TextField } from '../controls.tsx'
import { TASK_TYPE_ORDER, useOnboardingLabels } from './onboarding-labels.ts'

const EMPTY: TaskFormValues = {
	type: 'custom',
	title: '',
	instructions: '',
	linkUrl: '',
	dueDate: '',
	assignee: 'manager',
}

/**
 * Adds one task to a person's checklist. It opens inline under the list (not in
 * a dialog), asks only for what the chosen type needs, and closes itself on
 * success. Nothing is saved until Add task is pressed.
 */
export function TaskForm({
	client,
	staffId,
	onAdded,
	onCancel,
}: {
	client: StaffClient
	staffId: string
	onAdded: () => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const labels = useOnboardingLabels()
	const action = useStaffAction(describeOnboardingError)
	const [values, setValues] = useState<TaskFormValues>(EMPTY)
	const [errors, setErrors] = useState<ReturnType<typeof validateTaskForm>>({})
	const set = <K extends keyof TaskFormValues>(
		key: K,
		value: TaskFormValues[K],
	) => setValues((current) => ({ ...current, [key]: value }))

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found = validateTaskForm(values, _)
		setErrors(found)
		if (Object.keys(found).length > 0) return
		const result = await action.run(() =>
			addOnboardingTask(client, staffId, taskFormToInput(values)),
		)
		if (result.ok) onAdded()
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			aria-label={_(t`Add a task`)}
			className="border-border flex flex-col gap-4 border-t pt-4"
		>
			<SelectField
				label={<Trans>What kind of task</Trans>}
				hint={labels.taskTypeHint(values.type)}
				value={values.type}
				onValueChange={(next) => set('type', next as TaskFormValues['type'])}
				options={TASK_TYPE_ORDER.map((type) => ({
					value: type,
					label: labels.taskType(type),
				}))}
			/>
			<TextField
				label={<Trans>Task</Trans>}
				value={values.title}
				onChange={(event) => set('title', event.target.value)}
				error={errors.title}
				maxLength={120}
				autoComplete="off"
			/>
			{values.type === 'acknowledge_policy' ? (
				<TextAreaField
					label={<Trans>Policy</Trans>}
					hint={<Trans>This is what they are asked to read and accept.</Trans>}
					value={values.instructions}
					onChange={(event) => set('instructions', event.target.value)}
					error={errors.instructions}
					rows={4}
					maxLength={2000}
				/>
			) : null}
			{values.type === 'form_link' ? (
				<TextField
					label={<Trans>Link to the form</Trans>}
					hint={
						<Trans>
							A link that starts with https://. Do not ask for ID numbers, bank
							details or tax forms here.
						</Trans>
					}
					type="url"
					inputMode="url"
					dir="ltr"
					value={values.linkUrl}
					onChange={(event) => set('linkUrl', event.target.value)}
					error={errors.linkUrl}
					maxLength={500}
					autoComplete="off"
				/>
			) : null}
			<div className="grid gap-4 sm:grid-cols-2">
				<TextField
					label={<Trans>Due</Trans>}
					optional
					type="date"
					value={values.dueDate}
					onChange={(event) => set('dueDate', event.target.value)}
					error={errors.dueDate}
				/>
				<SelectField
					label={<Trans>For</Trans>}
					value={values.assignee}
					onValueChange={(next) =>
						set('assignee', next as TaskFormValues['assignee'])
					}
					options={[
						{ value: 'manager', label: labels.assignee('manager') },
						{ value: 'staff', label: labels.assignee('staff') },
					]}
				/>
			</div>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={action.pending}>
					{action.pending ? <Trans>Adding…</Trans> : <Trans>Add task</Trans>}
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
