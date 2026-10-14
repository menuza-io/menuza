import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Item } from '@repo/ui/item'
import { useState, type FormEvent } from 'react'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import {
	removeOnboardingTask,
	updateOnboardingTask,
} from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import { type OnboardingTask } from '#app/utils/staffing/onboarding-types.ts'
import { dueLabel, formatDay } from '#app/utils/staffing/onboarding-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { TextField } from '../controls.tsx'
import { useOnboardingLabels } from './onboarding-labels.ts'
import { RemoveDialog } from './remove-dialog.tsx'

/**
 * One line of a person's checklist. The checkbox is the main action (done or
 * not), and everything else sits in the menu. Late tasks say so in words and
 * with an icon, never by colour alone.
 */
export function TaskRow({
	task,
	client,
	staffId,
	today,
	canWrite,
	onChanged,
}: {
	task: OnboardingTask
	client: StaffClient
	staffId: string
	today: string
	canWrite: boolean
	onChanged: () => void
}) {
	const { _, i18n } = useLingui()
	const labels = useOnboardingLabels()
	const change = useStaffAction(describeOnboardingError)
	const remove = useStaffAction(describeOnboardingError)
	const [editingDue, setEditingDue] = useState(false)
	const [dueValue, setDueValue] = useState(task.dueDate ?? '')
	const [confirmRemove, setConfirmRemove] = useState(false)
	const [policyOpen, setPolicyOpen] = useState(false)

	const title = labels.taskTitle(task)
	const finished = task.status !== 'todo'
	const due = dueLabel(task, today)

	async function setStatus(status: OnboardingTask['status']) {
		const result = await change.run(() =>
			updateOnboardingTask(client, staffId, task.id, { status }),
		)
		if (result.ok) onChanged()
	}

	async function saveDue(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const result = await change.run(() =>
			updateOnboardingTask(client, staffId, task.id, {
				dueDate: dueValue || null,
			}),
		)
		if (result.ok) {
			setEditingDue(false)
			onChanged()
		}
	}

	async function confirmRemoval() {
		const result = await remove.run(() =>
			removeOnboardingTask(client, staffId, task.id),
		)
		if (result.ok) {
			setConfirmRemove(false)
			onChanged()
		}
	}

	return (
		<Item variant="outline" render={<li />}>
			<div className="flex w-full items-start gap-3">
				<div className="flex size-6 shrink-0 items-center justify-center pt-0.5">
					<Checkbox
						checked={task.status === 'done'}
						disabled={!canWrite || change.pending}
						onCheckedChange={(checked) =>
							void setStatus(checked ? 'done' : 'todo')
						}
						aria-label={_(t`Mark done: ${title}`)}
					/>
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span
						className={cn(
							'text-sm font-medium text-pretty',
							finished && 'text-muted-foreground',
							task.status === 'skipped' && 'line-through',
						)}
					>
						{title}
					</span>
					<span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
						<span>{labels.taskType(task.type)}</span>
						<DueText
							task={task}
							state={due.state}
							days={due.days}
							locale={i18n.locale}
						/>
						{task.assignee !== 'manager' ? (
							<span>{labels.assignee(task.assignee)}</span>
						) : null}
					</span>
					{task.type === 'form_link' && task.linkUrl ? (
						<a
							href={task.linkUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary focus-visible:ring-ring/50 inline-flex w-fit items-center gap-1 rounded-sm text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3"
						>
							<Trans>Open the form</Trans>
							<Icon name="external-link" className="size-3.5" />
						</a>
					) : null}
					{task.type === 'acknowledge_policy' && task.instructions ? (
						<Collapsible open={policyOpen} onOpenChange={setPolicyOpen}>
							<CollapsibleTrigger
								render={
									<Button
										type="button"
										variant="link"
										className="h-11 w-fit px-0"
									/>
								}
							>
								<Trans>Read the policy</Trans>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<p className="text-muted-foreground mt-2 max-w-prose text-sm whitespace-pre-wrap">
									{task.instructions}
								</p>
							</CollapsibleContent>
						</Collapsible>
					) : null}
					{editingDue ? (
						<form
							onSubmit={(event) => void saveDue(event)}
							className="mt-2 flex flex-wrap items-end gap-2"
							aria-label={_(t`Change the due date`)}
						>
							<TextField
								label={<Trans>Due</Trans>}
								optional
								type="date"
								value={dueValue}
								onChange={(event) => setDueValue(event.target.value)}
								className="w-44"
							/>
							<Button size="sm" type="submit" disabled={change.pending}>
								<Trans>Save</Trans>
							</Button>
							<Button
								size="sm"
								type="button"
								variant="ghost"
								onClick={() => {
									setEditingDue(false)
									setDueValue(task.dueDate ?? '')
								}}
							>
								<Trans>Cancel</Trans>
							</Button>
						</form>
					) : null}
					{change.error ? (
						<Alert variant="destructive">
							<AlertDescription>{change.error}</AlertDescription>
						</Alert>
					) : null}
				</div>
				{canWrite ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="ghost"
									size="icon"
									className="-me-2"
									aria-label={_(t`More actions for ${title}`)}
								>
									<Icon name="more-horizontal" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end">
							{task.status === 'todo' ? (
								<DropdownMenuItem onClick={() => void setStatus('skipped')}>
									<Icon name="x" />
									<Trans>Skip this task</Trans>
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem onClick={() => void setStatus('todo')}>
									<Icon name="check" />
									<Trans>Mark as not done</Trans>
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onClick={() => setEditingDue(true)}>
								<Icon name="calendar" />
								<Trans>Change due date</Trans>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								variant="destructive"
								onClick={() => setConfirmRemove(true)}
							>
								<Icon name="trash-2" />
								<Trans>Remove</Trans>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				<RemoveDialog
					open={confirmRemove}
					title={<Trans>Remove this task?</Trans>}
					description={
						<Trans>
							It is taken off their checklist. This is recorded in the staff
							log.
						</Trans>
					}
					pending={remove.pending}
					error={remove.error}
					onConfirm={() => void confirmRemoval()}
					onClose={() => setConfirmRemove(false)}
				/>
			</div>
		</Item>
	)
}

function DueText({
	task,
	state,
	days,
	locale,
}: {
	task: OnboardingTask
	state: ReturnType<typeof dueLabel>['state']
	days: number | null
	locale: string
}) {
	if (state === 'done') {
		if (task.completedAt === null) return <span>{<Trans>Done</Trans>}</span>
		const when = new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
		}).format(task.completedAt)
		return (
			<span>
				<Trans>Done {when}</Trans>
			</span>
		)
	}
	if (state === 'skipped') {
		return (
			<span>
				<Trans>Skipped</Trans>
			</span>
		)
	}
	if (!task.dueDate || days === null) return null
	if (state === 'overdue') {
		const late = Math.abs(days)
		return (
			<span className="text-destructive inline-flex items-center gap-1 font-medium">
				<Icon name="alert-triangle" className="size-3.5" />
				{plural(late, {
					one: 'Overdue by # day',
					other: 'Overdue by # days',
				})}
			</span>
		)
	}
	if (state === 'due_today') {
		return (
			<span className="text-foreground font-medium">
				<Trans>Due today</Trans>
			</span>
		)
	}
	const when = formatDay(task.dueDate, locale)
	return (
		<span>
			<Trans>Due {when}</Trans>
		</span>
	)
}
