import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	doneTaskSchema,
	type PrepPlan,
	type PrepTask,
	prepPlanSchema,
	prepTaskSchema,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { RecordBatchDialog } from '#app/components/inventory/record-batch-dialog.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { levelText } from '#app/utils/inventory/item-form.ts'
import {
	demandIsNotable,
	demandPercent,
	doneBody,
	openTaskCount,
	prepColumns,
} from '#app/utils/inventory/prep-view.ts'

const ALL = 'all'

/** `YYYY-MM-DD` plus a number of days, in UTC so the calendar never shifts. */
function addDays(date: string, days: number): string {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return new Date(Date.UTC(year, month - 1, day + days))
		.toISOString()
		.slice(0, 10)
}

/**
 * Today's prep: the made-in-house items to make, as a list or a board (To do,
 * In progress, Done), with the numbers behind every amount. A cook starts a
 * task and, when it is made, says how much came out; that records a batch. The
 * region plans the day (`/prep/generate`) from the weekday levels, what is on
 * hand and how busy the weekday usually is; the tick plans it each morning, and
 * this screen plans it on opening when nobody has.
 */
export function PrepScreen({
	locationId,
	canEdit,
	view,
	onViewChange,
}: {
	locationId: string
	canEdit: boolean
	view: 'list' | 'board'
	onViewChange: (view: 'list' | 'board') => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const [when, setWhen] = useState<'today' | 'tomorrow'>('today')
	const [today, setToday] = useState<string | null>(null)
	const [station, setStation] = useState(ALL)
	const [busy, setBusy] = useState<string | null>(null)
	const [finishing, setFinishing] = useState<PrepTask | null>(null)

	const date = when === 'tomorrow' && today ? addDays(today, 1) : null
	const params = new URLSearchParams({ locationId })
	if (date) params.set('date', date)
	if (station !== ALL) params.set('stationId', station)
	const plan = useInventoryQuery(`/prep?${params}`, prepPlanSchema)
	const { reload } = plan

	useEffect(() => {
		if (plan.data && when === 'today') setToday(plan.data.date)
	}, [plan.data, when])

	const revision = useInventoryRevision()
	const seen = useRef(revision)
	useEffect(() => {
		if (revision !== seen.current) {
			seen.current = revision
			reload()
		}
	}, [revision, reload])

	const generate = useCallback(
		async (quiet = false) => {
			setBusy('generate')
			try {
				await request('/prep/generate', {
					method: 'POST',
					body: JSON.stringify({
						locationId,
						...(date ? { date } : {}),
					}),
				})
				reload()
			} catch (caught) {
				if (!quiet) toast.error(i18n._(inventorySaveErrorMessage(caught)))
			} finally {
				setBusy(null)
			}
		},
		[request, locationId, date, reload, i18n],
	)

	// The first time a day is opened with nothing planned, plan it.
	const planned = useRef(new Set<string>())
	useEffect(() => {
		const data = plan.data
		if (!data || data.generated || !data.canGenerate || !canEdit) return
		const key = `${data.locationId}:${data.date}`
		if (planned.current.has(key)) return
		planned.current.add(key)
		void generate(true)
	}, [plan.data, canEdit, generate])

	async function act(task: PrepTask, action: 'start' | 'skip'): Promise<void> {
		setBusy(task.id)
		try {
			await request(`/prep/tasks/${encodeURIComponent(task.id)}/${action}`, {
				method: 'POST',
				body: JSON.stringify({ expectedVersion: task.version }),
			})
			notifyChanged()
			reload()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
			reload()
		} finally {
			setBusy(null)
		}
	}

	if (plan.loading && !plan.data) {
		return <Skeleton className="h-64 w-full rounded-xl" />
	}
	if (plan.error && !plan.data) {
		return (
			<Alert variant="destructive" data-testid="prep-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(plan.error))}
				</AlertDescription>
				<AlertAction>
					<Button type="button" variant="outline" onClick={plan.reload}>
						<Trans>Try again</Trans>
					</Button>
				</AlertAction>
			</Alert>
		)
	}
	const data = plan.data
	if (!data) return null

	const stationOptions = [
		{ value: ALL, label: t`All stations` },
		...data.stations.map((entry) => ({ value: entry.id, label: entry.name })),
	]
	const open = openTaskCount(data.tasks)

	return (
		<div className="flex flex-col gap-4" data-testid="prep-screen">
			<div
				role="group"
				aria-label={t`Prep filters`}
				className="flex flex-col gap-2 md:flex-row md:items-center"
			>
				<ToggleGroup
					aria-label={t`Day`}
					variant="segmented"
					value={[when]}
					onValueChange={(next) => {
						if (next[0] === 'today' || next[0] === 'tomorrow') {
							setWhen(next[0])
						}
					}}
				>
					<ToggleGroupItem
						value="today"
						className="h-11 md:h-7"
						data-testid="prep-day-today"
					>
						<Trans>Today</Trans>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="tomorrow"
						className="h-11 md:h-7"
						data-testid="prep-day-tomorrow"
					>
						<Trans>Tomorrow</Trans>
					</ToggleGroupItem>
				</ToggleGroup>
				{data.stations.length > 1 ? (
					<FilterSelect
						label={t`Station`}
						options={stationOptions}
						value={station}
						onValueChange={setStation}
						testId="prep-filter-station"
					/>
				) : null}
				<ToggleGroup
					aria-label={t`View`}
					variant="segmented"
					value={[view]}
					onValueChange={(next) => {
						if (next[0] === 'list' || next[0] === 'board') onViewChange(next[0])
					}}
					className="md:ms-auto"
				>
					<ToggleGroupItem
						value="list"
						className="h-11 md:h-7"
						data-testid="prep-view-list"
					>
						<Trans>List</Trans>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="board"
						className="h-11 md:h-7"
						data-testid="prep-view-board"
					>
						<Trans>Board</Trans>
					</ToggleGroupItem>
				</ToggleGroup>
				{canEdit && data.canGenerate ? (
					<Button
						variant="outline"
						size="sm"
						disabled={busy !== null}
						onClick={() => void generate()}
						data-testid="prep-refresh"
					>
						<Icon name="refresh-cw" />
						<Trans>Update the plan</Trans>
					</Button>
				) : null}
			</div>

			<DemandNote plan={data} />

			{!data.canGenerate ? (
				<EmptyState
					icons={['chef-hat']}
					title={<Trans>Say how much of each made item to keep.</Trans>}
					description={
						<Trans>
							Set a “fill up to” level for the things you make in house (sauces,
							dough, marinades). The plan then tells you each morning how much
							to make.
						</Trans>
					}
				/>
			) : data.tasks.length === 0 ? (
				<EmptyState
					icons={['check-circle']}
					title={
						data.generated ? (
							<Trans>Nothing to make.</Trans>
						) : (
							<Trans>This day is not planned yet.</Trans>
						)
					}
					description={
						data.generated ? (
							<Trans>
								You have enough of everything you make. If that changes, update
								the plan.
							</Trans>
						) : canEdit ? (
							<Trans>Planning it now.</Trans>
						) : (
							<Trans>Someone who can change stock will plan it.</Trans>
						)
					}
				/>
			) : view === 'board' ? (
				<PrepBoard
					plan={data}
					canEdit={canEdit}
					busy={busy}
					onStart={(task) => void act(task, 'start')}
					onSkip={(task) => void act(task, 'skip')}
					onDone={setFinishing}
				/>
			) : (
				<WorkspacePanel
					title={
						<Plural
							value={open}
							one="# thing left to make"
							other="# things left to make"
						/>
					}
				>
					<ul
						className="flex flex-col divide-y rounded-xl border"
						data-testid="prep-list"
					>
						{data.tasks.map((task) => (
							<PrepRow
								key={task.id}
								task={task}
								plan={data}
								canEdit={canEdit}
								busy={busy}
								onStart={() => void act(task, 'start')}
								onSkip={() => void act(task, 'skip')}
								onDone={() => setFinishing(task)}
							/>
						))}
					</ul>
				</WorkspacePanel>
			)}

			{finishing ? (
				<DoneDialog
					task={finishing}
					locationId={locationId}
					onClose={() => setFinishing(null)}
					onDone={() => {
						notifyChanged()
						reload()
					}}
				/>
			) : null}
		</div>
	)
}

function DemandNote({ plan }: { plan: PrepPlan }) {
	if (!plan.generated || !demandIsNotable(plan.demand.bp)) return null
	const percent = Math.abs(demandPercent(plan.demand.bp))
	const more = plan.demand.bp > 10_000
	return (
		<p className="text-muted-foreground text-sm" data-testid="prep-demand">
			{more ? (
				<Trans>
					This day usually sells <bdi dir="ltr">{percent}%</bdi> more, so the
					plan makes a little extra.
				</Trans>
			) : (
				<Trans>
					This day usually sells <bdi dir="ltr">{percent}%</bdi> less, so the
					plan makes a little less.
				</Trans>
			)}
			{plan.demand.ramadan ? (
				<>
					{' '}
					<Trans>It follows what Ramadan days sold.</Trans>
				</>
			) : null}
		</p>
	)
}

/** "Fill up to 6 L · have 2 L" plus how busy the day is, under every task. */
function Explain({ task }: { task: PrepTask }) {
	const quantity = useQuantityFormat()
	const shape = {
		baseUnit: task.baseUnit,
		countUnit: task.countUnit,
		units: task.units,
	}
	const target = quantity.format(task.explain.target, shape)
	const have = quantity.format(Math.max(0, task.explain.onHand), shape)
	const percent = demandPercent(task.explain.demandBp)
	return (
		<span className="text-muted-foreground text-xs" data-testid="prep-explain">
			<Trans>
				Fill up to <bdi dir="ltr">{target}</bdi> · have{' '}
				<bdi dir="ltr">{have}</bdi>
			</Trans>
			{demandIsNotable(task.explain.demandBp) ? (
				<>
					{' · '}
					{percent > 0 ? (
						<Trans>
							sells <bdi dir="ltr">{percent}%</bdi> more today
						</Trans>
					) : (
						<Trans>
							sells <bdi dir="ltr">{Math.abs(percent)}%</bdi> less today
						</Trans>
					)}
				</>
			) : null}
		</span>
	)
}

function StatusBadge({ status }: { status: PrepTask['status'] }) {
	if (status === 'in_progress') {
		return (
			<Badge variant="warning">
				<Trans>In progress</Trans>
			</Badge>
		)
	}
	if (status === 'done') {
		return (
			<Badge variant="success">
				<Trans>Done</Trans>
			</Badge>
		)
	}
	if (status === 'skipped') {
		return (
			<Badge variant="outline">
				<Trans>Skipped</Trans>
			</Badge>
		)
	}
	return (
		<Badge variant="secondary">
			<Trans>To do</Trans>
		</Badge>
	)
}

function Amount({ task }: { task: PrepTask }) {
	const quantity = useQuantityFormat()
	const shape = {
		baseUnit: task.baseUnit,
		countUnit: task.countUnit,
		units: task.units,
	}
	const planned = quantity.format(task.plannedQuantity, shape)
	const batches = task.batches
	return (
		<span className="text-sm tabular-nums" data-testid="prep-amount">
			<bdi dir="ltr">{planned}</bdi>
			{batches !== null && batches > 0 ? (
				<span className="text-muted-foreground">
					{' · '}
					<Plural value={batches} one="# batch" other="# batches" />
				</span>
			) : null}
		</span>
	)
}

function TaskActions({
	task,
	canEdit,
	busy,
	onStart,
	onSkip,
	onDone,
}: {
	task: PrepTask
	canEdit: boolean
	busy: string | null
	onStart: () => void
	onSkip: () => void
	onDone: () => void
}) {
	if (!canEdit || task.status === 'done' || task.status === 'skipped') {
		return null
	}
	const disabled = busy !== null
	return (
		<div className="flex flex-wrap items-center gap-2">
			{task.status === 'todo' ? (
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					onClick={onStart}
					data-testid={`prep-start-${task.id}`}
				>
					<Trans>Start</Trans>
				</Button>
			) : null}
			<Button
				size="sm"
				disabled={disabled}
				onClick={onDone}
				data-testid={`prep-done-${task.id}`}
			>
				<Icon name="check" />
				<Trans>Done</Trans>
			</Button>
			<Button
				variant="ghost"
				size="sm"
				disabled={disabled}
				onClick={onSkip}
				data-testid={`prep-skip-${task.id}`}
			>
				<Trans>Skip</Trans>
			</Button>
		</div>
	)
}

function PrepRow({
	task,
	canEdit,
	busy,
	onStart,
	onSkip,
	onDone,
}: {
	task: PrepTask
	plan: PrepPlan
	canEdit: boolean
	busy: string | null
	onStart: () => void
	onSkip: () => void
	onDone: () => void
}) {
	return (
		<li
			className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
			data-testid={`prep-task-${task.id}`}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="flex flex-wrap items-center gap-2">
					<span className="font-medium wrap-anywhere">{task.itemName}</span>
					<StatusBadge status={task.status} />
				</span>
				<Amount task={task} />
				<Explain task={task} />
			</div>
			<TaskActions
				task={task}
				canEdit={canEdit}
				busy={busy}
				onStart={onStart}
				onSkip={onSkip}
				onDone={onDone}
			/>
		</li>
	)
}

function PrepBoard({
	plan,
	canEdit,
	busy,
	onStart,
	onSkip,
	onDone,
}: {
	plan: PrepPlan
	canEdit: boolean
	busy: string | null
	onStart: (task: PrepTask) => void
	onSkip: (task: PrepTask) => void
	onDone: (task: PrepTask) => void
}) {
	const columns = prepColumns(plan.tasks)
	const lanes: { key: string; title: React.ReactNode; tasks: PrepTask[] }[] = [
		{ key: 'todo', title: <Trans>To do</Trans>, tasks: columns.todo },
		{
			key: 'in-progress',
			title: <Trans>In progress</Trans>,
			tasks: columns.inProgress,
		},
		{
			key: 'done',
			title: <Trans>Done</Trans>,
			tasks: [...columns.done, ...columns.skipped],
		},
	]
	return (
		<div className="grid gap-4 md:grid-cols-3" data-testid="prep-board">
			{lanes.map((lane) => (
				<section
					key={lane.key}
					className="bg-muted/40 flex flex-col gap-2 rounded-xl p-3"
					aria-label={lane.key}
					data-testid={`prep-lane-${lane.key}`}
				>
					<h3 className="text-sm font-semibold">
						{lane.title}{' '}
						<span className="text-muted-foreground tabular-nums">
							{lane.tasks.length}
						</span>
					</h3>
					<ul className="flex flex-col gap-2">
						{lane.tasks.map((task) => (
							<li
								key={task.id}
								className="bg-card flex flex-col gap-2 rounded-lg border p-3"
								data-testid={`prep-task-${task.id}`}
							>
								<span className="font-medium wrap-anywhere">
									{task.itemName}
								</span>
								<Amount task={task} />
								<Explain task={task} />
								{task.status === 'skipped' ? (
									<StatusBadge status="skipped" />
								) : null}
								<TaskActions
									task={task}
									canEdit={canEdit}
									busy={busy}
									onStart={() => onStart(task)}
									onSkip={() => onSkip(task)}
									onDone={() => onDone(task)}
								/>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	)
}

/** "How much did you make?", pre-filled with the plan (the record-a-batch form). */
function DoneDialog({
	task,
	locationId,
	onClose,
	onDone,
}: {
	task: PrepTask
	locationId: string
	onClose: () => void
	onDone: () => void
}) {
	const planned =
		task.batches !== null && task.batches > 0
			? ({
					kind: 'batches',
					count: task.batches,
					amount: null,
					unit: null,
					note: '',
				} as const)
			: ({
					kind: 'amount',
					count: null,
					amount: Number(
						levelText(
							task.plannedQuantity,
							task.countUnit,
							task.baseUnit,
							task.units,
						),
					),
					unit: task.countUnit,
					note: '',
				} as const)
	return (
		<RecordBatchDialog
			item={{
				id: task.itemId,
				name: task.itemName,
				baseUnit: task.baseUnit,
				units: task.units,
				countUnit: task.countUnit,
			}}
			locationId={locationId}
			open
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
			onRecorded={onDone}
			target={{
				path: `/prep/tasks/${encodeURIComponent(task.id)}/done`,
				body: (batch) =>
					doneTaskSchema.parse(
						doneBody(task, {
							clientId: batch.clientId,
							made: batch.made,
							note: batch.note,
						}),
					),
				madeQuantity: (raw) => prepTaskSchema.parse(raw).madeQuantity ?? 0,
				title: <Trans>How much did you make?</Trans>,
				description: (
					<Trans>
						Adds it to stock and takes the ingredients out. The plan is filled
						in for you.
					</Trans>
				),
				submitLabel: <Trans>Mark as done</Trans>,
				initialDraft: planned,
			}}
		/>
	)
}
