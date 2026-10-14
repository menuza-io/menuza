import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { moveItem, ONBOARDING_LIMITS } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { useState, type FormEvent } from 'react'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { saveOnboardingTemplate } from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import {
	draftToInput,
	emptyDraftTask,
	hasDraftErrors,
	validateDraft,
	type DraftErrors,
	type DraftTask,
	type TemplateDraft,
} from '#app/utils/staffing/onboarding-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { SelectField, TextAreaField, TextField } from '../controls.tsx'
import { SheetForm } from '../sheet-frame.tsx'
import { SwitchField } from '../switch-field.tsx'
import { TASK_TYPE_ORDER, useOnboardingLabels } from './onboarding-labels.ts'

/**
 * Builds or edits a checklist template: a name, whether it is attached to new
 * hires automatically, and an ordered list of tasks. Reordering uses buttons
 * (reachable by keyboard and by touch), and nothing is saved until Save.
 * Tasks already copied onto people are never changed by editing a template.
 */
export function TemplateEditor({
	client,
	templateId,
	initial,
	onSaved,
}: {
	client: StaffClient
	/** `null` creates a new template. */
	templateId: string | null
	initial: TemplateDraft
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const action = useStaffAction(describeOnboardingError)
	const [draft, setDraft] = useState(initial)
	const [errors, setErrors] = useState<DraftErrors>({ task: {} })

	const setTask = (key: string, patch: Partial<DraftTask>) =>
		setDraft((current) => ({
			...current,
			tasks: current.tasks.map((task) =>
				task.key === key ? { ...task, ...patch } : task,
			),
		}))

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const found = validateDraft(draft, _)
		setErrors(found)
		if (hasDraftErrors(found)) return
		const result = await action.run(() =>
			saveOnboardingTemplate(client, templateId, draftToInput(draft)),
		)
		if (result.ok) onSaved()
	}

	const atLimit = draft.tasks.length >= ONBOARDING_LIMITS.tasksPerTemplate

	return (
		<SheetForm
			title={
				templateId ? <Trans>Edit template</Trans> : <Trans>New template</Trans>
			}
			description={
				<Trans>
					The tasks a new hire starts with. Due dates count from the day they
					are hired.
				</Trans>
			}
			onSubmit={(event) => void submit(event)}
			footer={
				<>
					{action.error ? (
						<Alert variant="destructive" className="me-auto">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<Button type="submit" disabled={action.pending}>
						{action.pending ? (
							<Trans>Saving…</Trans>
						) : (
							<Trans>Save template</Trans>
						)}
					</Button>
				</>
			}
		>
			<TextField
				label={<Trans>Template name</Trans>}
				value={draft.name}
				onChange={(event) =>
					setDraft((current) => ({ ...current, name: event.target.value }))
				}
				error={errors.name}
				maxLength={80}
				autoComplete="off"
			/>
			<SwitchField
				label={<Trans>Add to new hires automatically</Trans>}
				description={
					<Trans>
						Used when you hire someone from Applicants. Only one template can do
						this.
					</Trans>
				}
				checked={draft.isDefault}
				onCheckedChange={(checked) =>
					setDraft((current) => ({ ...current, isDefault: checked }))
				}
			/>

			<section
				aria-labelledby="template-tasks-heading"
				className="flex flex-col"
			>
				<div className="flex items-baseline justify-between gap-3 pb-2">
					<h3 id="template-tasks-heading" className="text-sm font-medium">
						<Trans>Tasks</Trans>
					</h3>
					<span className="text-muted-foreground text-xs" aria-live="polite">
						{plural(draft.tasks.length, {
							one: '# task',
							other: '# tasks',
						})}
					</span>
				</div>
				{errors.tasks ? (
					<Alert variant="destructive" className="mb-2">
						<AlertDescription>{errors.tasks}</AlertDescription>
					</Alert>
				) : null}
				<ItemGroup>
					{draft.tasks.map((task, index) => (
						<TemplateTaskFields
							key={task.key}
							task={task}
							index={index}
							count={draft.tasks.length}
							errors={errors.task[task.key] ?? {}}
							onChange={(patch) => setTask(task.key, patch)}
							onMove={(direction) =>
								setDraft((current) => ({
									...current,
									tasks: moveItem(current.tasks, index, direction),
								}))
							}
							onRemove={() =>
								setDraft((current) => ({
									...current,
									tasks: current.tasks.filter((item) => item.key !== task.key),
								}))
							}
						/>
					))}
				</ItemGroup>
				<div className="pt-3">
					<Button
						type="button"
						variant="outline"
						disabled={atLimit}
						onClick={() =>
							setDraft((current) => ({
								...current,
								tasks: [...current.tasks, emptyDraftTask()],
							}))
						}
					>
						<Icon name="plus" />
						<Trans>Add task</Trans>
					</Button>
				</div>
			</section>
		</SheetForm>
	)
}

function TemplateTaskFields({
	task,
	index,
	count,
	errors,
	onChange,
	onMove,
	onRemove,
}: {
	task: DraftTask
	index: number
	count: number
	errors: Partial<Record<keyof DraftTask, string>>
	onChange: (patch: Partial<DraftTask>) => void
	onMove: (direction: -1 | 1) => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const labels = useOnboardingLabels()
	const position = index + 1
	return (
		<Item variant="outline" render={<li />}>
			<div className="flex w-full flex-col gap-3">
				<div className="flex items-center justify-between gap-2">
					<h4 className="text-sm font-medium">
						<Trans>Task {position}</Trans>
					</h4>
					<div className="-me-2 flex items-center">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							disabled={index === 0}
							onClick={() => onMove(-1)}
							aria-label={_(t`Move task ${position} up`)}
						>
							<Icon name="chevron-up" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							disabled={index === count - 1}
							onClick={() => onMove(1)}
							aria-label={_(t`Move task ${position} down`)}
						>
							<Icon name="chevron-down" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={onRemove}
							aria-label={_(t`Remove task ${position}`)}
						>
							<Icon name="trash-2" />
						</Button>
					</div>
				</div>
				<TextField
					label={<Trans>Task</Trans>}
					value={task.title}
					onChange={(event) => onChange({ title: event.target.value })}
					error={errors.title}
					maxLength={120}
					autoComplete="off"
				/>
				<div className="grid gap-3 sm:grid-cols-2">
					<SelectField
						label={<Trans>Kind</Trans>}
						value={task.type}
						onValueChange={(next) =>
							onChange({ type: next as DraftTask['type'] })
						}
						options={TASK_TYPE_ORDER.map((type) => ({
							value: type,
							label: labels.taskType(type),
						}))}
					/>
					<SelectField
						label={<Trans>For</Trans>}
						value={task.assignee}
						onValueChange={(next) =>
							onChange({
								assignee: next as DraftTask['assignee'],
								assigneeUserId: next === 'member' ? task.assigneeUserId : null,
							})
						}
						options={[
							{ value: 'manager', label: labels.assignee('manager') },
							{ value: 'staff', label: labels.assignee('staff') },
							// Kept so saving never drops a member this task was given to.
							...(task.assignee === 'member'
								? [{ value: 'member', label: labels.assignee('member') }]
								: []),
						]}
					/>
				</div>
				<TextField
					label={<Trans>Due after hire</Trans>}
					hint={
						<Trans>Days after the hire date. 0 is the day they start.</Trans>
					}
					type="number"
					inputMode="numeric"
					min={0}
					max={ONBOARDING_LIMITS.maxDueInDays}
					value={task.dueInDays}
					onChange={(event) => onChange({ dueInDays: event.target.value })}
					error={errors.dueInDays}
					className="sm:w-48"
				/>
				{task.type === 'acknowledge_policy' ? (
					<TextAreaField
						label={<Trans>Policy</Trans>}
						hint={<Trans>What they are asked to read and accept.</Trans>}
						value={task.instructions}
						onChange={(event) => onChange({ instructions: event.target.value })}
						error={errors.instructions}
						rows={4}
						maxLength={2000}
					/>
				) : null}
				{task.type === 'form_link' ? (
					<TextField
						label={<Trans>Link to the form</Trans>}
						hint={
							<Trans>
								A link that starts with https://. Do not ask for ID numbers,
								bank details or tax forms here.
							</Trans>
						}
						type="url"
						inputMode="url"
						dir="ltr"
						value={task.linkUrl}
						onChange={(event) => onChange({ linkUrl: event.target.value })}
						error={errors.linkUrl}
						maxLength={500}
						autoComplete="off"
					/>
				) : null}
				{task.type !== 'acknowledge_policy' ? (
					<TextAreaField
						label={<Trans>Details</Trans>}
						optional
						value={task.instructions}
						onChange={(event) => onChange({ instructions: event.target.value })}
						error={errors.instructions}
						rows={2}
						maxLength={2000}
					/>
				) : null}
			</div>
		</Item>
	)
}
