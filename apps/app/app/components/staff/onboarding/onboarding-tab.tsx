import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { ItemGroup } from '@repo/ui/item'
import { Progress } from '@repo/ui/progress'
import { Skeleton } from '@repo/ui/skeleton'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { applyOnboardingTemplate } from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import {
	checklistSchema,
	templatesSchema,
} from '#app/utils/staffing/onboarding-types.ts'
import {
	checklistProgress,
	localToday,
} from '#app/utils/staffing/onboarding-view.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { SelectField } from '../controls.tsx'
import { TaskForm } from './task-form.tsx'
import { TaskRow } from './task-row.tsx'

const BUILT_IN = 'built-in'

/**
 * A person's new-hire checklist, on their profile. Progress first (one line and
 * a thin bar), then the tasks in order. Adding a task and copying a template
 * both open inline. Everything is fetched browser-direct from the regional node
 * with a `hiring` token; people outside the manager's scopes never load.
 */
export function OnboardingTab({
	staffId,
	terminated,
	onChanged,
}: {
	staffId: string
	/** A person who has left cannot be given new tasks. */
	terminated: boolean
	/** Tell the roster its progress badge may have changed. */
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const { client, can, ready } = useStaffClient('hiring')
	const canWrite = can(P.UPDATE_HIRING) && !terminated
	const query = useStaffQuery(
		client,
		ready ? `/onboarding/staff/${staffId}/tasks` : null,
		checklistSchema,
	)
	const templates = useStaffQuery(
		client,
		ready && canWrite ? '/onboarding/templates' : null,
		templatesSchema,
	)
	const today = useMemo(() => localToday(), [])
	const tasks = query.data?.tasks ?? []
	const progress = checklistProgress(tasks, today)
	const { complete, total, overdue } = progress
	const [adding, setAdding] = useState(false)
	const [choosing, setChoosing] = useState(false)
	const [templateId, setTemplateId] = useState(BUILT_IN)
	const apply = useStaffAction(describeOnboardingError)

	const liveTemplates = templates.data?.templates ?? []
	const defaultTemplate = liveTemplates.find((template) => template.isDefault)

	function changed() {
		query.reload()
		onChanged()
	}

	async function copyTemplate(chosen: string) {
		const result = await apply.run(() =>
			applyOnboardingTemplate(
				client,
				staffId,
				chosen === BUILT_IN ? {} : { templateId: chosen },
			),
		)
		if (result.ok) {
			const created = result.value.created
			setChoosing(false)
			changed()
			toast.success(
				_(plural(created, { one: '# task added.', other: '# tasks added.' })),
			)
		}
	}

	if (query.loading || !ready) {
		return (
			<div role="status" className="flex flex-col gap-3">
				<span className="sr-only">
					<Trans>Loading onboarding</Trans>
				</span>
				<Skeleton className="h-4 w-40" />
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
			</div>
		)
	}
	if (query.error && !query.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{describeStaffError(query.error, _)}
				</AlertDescription>
				<Button
					variant="outline"
					className="mt-2 h-11 justify-self-start md:h-8"
					onClick={query.reload}
				>
					<Trans>Try again</Trans>
				</Button>
			</Alert>
		)
	}

	const options = [
		defaultTemplate
			? { value: defaultTemplate.id, label: defaultTemplate.name }
			: { value: BUILT_IN, label: _(t`Starter checklist`) },
		...liveTemplates
			.filter((template) => template !== defaultTemplate)
			.map((template) => ({ value: template.id, label: template.name })),
	]
	const chosenTemplate = options.some((option) => option.value === templateId)
		? templateId
		: options[0]!.value

	const templatePicker = choosing ? (
		<div className="border-border flex flex-col gap-3 border-t pt-4">
			<SelectField
				label={<Trans>Checklist to add</Trans>}
				hint={
					<Trans>
						Its tasks are copied to this person. Later changes to the template
						do not change their list.
					</Trans>
				}
				value={chosenTemplate}
				onValueChange={setTemplateId}
				options={options}
			/>
			{apply.error ? (
				<Alert variant="destructive">
					<AlertDescription>{apply.error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					disabled={apply.pending}
					onClick={() => void copyTemplate(chosenTemplate)}
				>
					{apply.pending ? (
						<Trans>Adding…</Trans>
					) : (
						<Trans>Add checklist</Trans>
					)}
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={apply.pending}
					onClick={() => setChoosing(false)}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</div>
	) : null

	return (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle>
					<Trans>Onboarding</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>Tasks to finish when someone joins.</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="flex flex-col gap-4">
				{tasks.length === 0 ? (
					<div className="flex flex-col items-start gap-2">
						<p className="text-sm font-medium">
							<Trans>No onboarding tasks yet</Trans>
						</p>
						<p className="text-muted-foreground max-w-prose text-sm text-pretty">
							{canWrite ? (
								<Trans>
									Add a checklist for the first days, like confirming contact
									details and sharing the house rules, or add your own tasks.
								</Trans>
							) : terminated ? (
								<Trans>This person has left, so there is no checklist.</Trans>
							) : (
								<Trans>Nothing has been set up for this person.</Trans>
							)}
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
							<p className="text-sm font-medium" aria-live="polite">
								<Trans>
									{complete} of {total} done
								</Trans>
							</p>
							{overdue > 0 ? (
								<p className="text-destructive inline-flex items-center gap-1 text-sm">
									<Icon name="alert-triangle" className="size-3.5" />
									{plural(overdue, {
										one: '# overdue',
										other: '# overdue',
									})}
								</p>
							) : null}
						</div>
						<Progress
							value={progress.percent}
							aria-label={_(t`Onboarding progress`)}
						/>
					</div>
				)}

				{tasks.length > 0 ? (
					<ItemGroup>
						{tasks.map((task) => (
							<TaskRow
								key={task.id}
								task={task}
								client={client}
								staffId={staffId}
								today={today}
								canWrite={canWrite}
								onChanged={changed}
							/>
						))}
					</ItemGroup>
				) : null}

				{canWrite && !adding && !choosing ? (
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => setAdding(true)}>
							<Icon name="plus" />
							<Trans>Add task</Trans>
						</Button>
						<Button variant="ghost" onClick={() => setChoosing(true)}>
							<Trans>Add a checklist…</Trans>
						</Button>
					</div>
				) : null}

				{adding ? (
					<TaskForm
						client={client}
						staffId={staffId}
						onAdded={() => {
							setAdding(false)
							toast.success(_(t`Task added.`))
							changed()
						}}
						onCancel={() => setAdding(false)}
					/>
				) : null}
				{templatePicker}
			</FramePanel>
		</Frame>
	)
}
