import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PrepTask } from '@repo/inventory'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { BigStepper } from '../stock/BigStepper.tsx'
import { unitStep, unitTakesFractions } from '../stock/model.ts'
import {
	notableDemandPercent,
	plannedAnswer,
	quantityText,
	sortedTasks,
} from './prep-model.ts'
import { type PrepState } from './usePrep.ts'
import { Badge, Button, cn, Modal } from '~/ui/primitives.tsx'

/** A new id for each time the cook opens "How much did you make?". */
const newClientId = () =>
	`prep-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`

/**
 * The kitchen's prep list: what to make now at this station, with the numbers
 * behind each amount, and Start, Done and Skip. Done asks "How much did you
 * make?" with the plan filled in. Online only: a button waits for the network
 * rather than queueing a write, and the list is read again after every tap.
 */
export function PrepView({
	prep,
	online,
	canWrite = true,
}: {
	prep: PrepState
	online: boolean
	canWrite?: boolean
}) {
	const { _, i18n } = useLingui()
	const [finishing, setFinishing] = useState<PrepTask | null>(null)
	const plan = prep.plan
	if (!plan) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyTitle>
						{prep.error ? _(t`Prep unavailable`) : _(t`Loading prep…`)}
					</EmptyTitle>
					<EmptyDescription>
						{prep.error
							? _(t`We could not read today's prep. Try again in a moment.`)
							: _(t`The list comes from your regional server.`)}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}
	const tasks = sortedTasks(plan.tasks)
	const percent = notableDemandPercent(plan.demand.bp)
	const waiting = !online
	return (
		<section
			aria-label={_(t`Prep`)}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
			data-testid="kitchen-prep"
		>
			{percent !== 0 ? (
				<p className="text-muted-foreground text-sm">
					{percent > 0 ? (
						<Trans>This day usually sells {percent}% more.</Trans>
					) : (
						<Trans>This day usually sells {-percent}% less.</Trans>
					)}
				</p>
			) : null}
			{waiting ? (
				<p role="alert" className="notice-warning px-4 py-3 text-sm">
					<Trans>
						You are offline. Prep changes wait until the connection is back.
					</Trans>
				</p>
			) : null}
			{prep.error && prep.error !== 'connection_lost' ? (
				<p role="alert" className="notice-danger px-4 py-3 text-sm">
					{prep.error === 'stale_version' || prep.error === 'task_closed'
						? _(t`Someone just changed this. The list is up to date now.`)
						: prep.error === 'recipe_empty'
							? _(t`This item has no recipe yet, so it cannot be recorded.`)
							: _(t`That did not go through. Check the list and try again.`)}
				</p>
			) : null}
			{tasks.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>
							{plan.canGenerate
								? _(t`Nothing to make right now.`)
								: _(t`No prep levels are set yet.`)}
						</EmptyTitle>
						<EmptyDescription>
							{plan.canGenerate
								? _(t`You have enough of everything you make.`)
								: _(
										t`Set how much to keep in the office app and the list appears here.`,
									)}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul className="flex flex-col gap-3">
					{tasks.map((task) => {
						const closed = task.status === 'done' || task.status === 'skipped'
						const disabled = !canWrite || waiting || prep.busy !== null
						const amount = quantityText(task, task.plannedQuantity, i18n.locale)
						const target = quantityText(task, task.explain.target, i18n.locale)
						const have = quantityText(
							task,
							Math.max(0, task.explain.onHand),
							i18n.locale,
						)
						return (
							<li
								key={task.id}
								className={cn(
									'border-border bg-card flex flex-col gap-3 rounded-xl border p-4',
									closed && 'opacity-70',
								)}
								data-testid={`kitchen-prep-${task.id}`}
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="text-xl font-semibold break-words">
											{task.itemName}
										</p>
										<p className="tnum text-base">
											<bdi dir="ltr">{amount}</bdi>
										</p>
										<p className="text-muted-foreground text-sm">
											<Trans>
												Fill up to <bdi dir="ltr">{target}</bdi> · have{' '}
												<bdi dir="ltr">{have}</bdi>
											</Trans>
										</p>
									</div>
									<Badge
										tone={
											task.status === 'done'
												? 'success'
												: task.status === 'in_progress'
													? 'warning'
													: 'muted'
										}
									>
										{task.status === 'done'
											? _(t`Done`)
											: task.status === 'in_progress'
												? _(t`In progress`)
												: task.status === 'skipped'
													? _(t`Skipped`)
													: _(t`To do`)}
									</Badge>
								</div>
								{!closed ? (
									<div className="flex flex-wrap gap-2">
										{task.status === 'todo' ? (
											<Button
												variant="secondary"
												disabled={disabled}
												onClick={() => void prep.start(task)}
											>
												<Trans>Start</Trans>
											</Button>
										) : null}
										<Button
											variant="primary"
											disabled={disabled}
											onClick={() => setFinishing(task)}
										>
											<Icon name="check" className="size-4" />
											<Trans>Done</Trans>
										</Button>
										<Button
											variant="ghost"
											disabled={disabled}
											onClick={() => void prep.skip(task)}
										>
											<Trans>Skip</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			)}
			{finishing ? (
				<MadeDialog
					task={finishing}
					busy={prep.busy !== null}
					onClose={() => setFinishing(null)}
					onConfirm={async (answer, clientId) => {
						const ok = await prep.done(finishing, answer, clientId)
						if (ok) setFinishing(null)
					}}
				/>
			) : null}
		</section>
	)
}

/** "How much did you make?" with the plan filled in. */
function MadeDialog({
	task,
	busy,
	onClose,
	onConfirm,
}: {
	task: PrepTask
	busy: boolean
	onClose: () => void
	onConfirm: (
		answer: { kind: 'batches' | 'amount'; value: number },
		clientId: string,
	) => Promise<void>
}) {
	const { _ } = useLingui()
	const planned = plannedAnswer(task)
	const [value, setValue] = useState<number | null>(planned.value)
	// One id per opening: a second tap or a retry after a lost answer is the same write.
	const [clientId] = useState(newClientId)
	return (
		<Modal
			open
			onClose={() => {
				if (!busy) onClose()
			}}
			title={_(t`How much did you make?`)}
			footer={
				<>
					<Button variant="secondary" onClick={onClose} disabled={busy}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						variant="primary"
						disabled={busy || value === null || value <= 0}
						onClick={() =>
							value !== null &&
							void onConfirm({ kind: planned.kind, value }, clientId)
						}
					>
						<Trans>Mark as done</Trans>
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<p className="text-base font-medium break-words">{task.itemName}</p>
				<p className="text-muted-foreground text-sm">
					{planned.kind === 'batches' ? (
						<Trans>Number of batches (the plan is filled in).</Trans>
					) : (
						<Trans>Amount that came out (the plan is filled in).</Trans>
					)}
				</p>
				<BigStepper
					value={value}
					label={task.itemName}
					step={planned.kind === 'batches' ? 1 : unitStep(task.countUnit)}
					fractions={
						planned.kind === 'batches' || unitTakesFractions(task.countUnit)
					}
					onChange={setValue}
				/>
			</div>
		</Modal>
	)
}
