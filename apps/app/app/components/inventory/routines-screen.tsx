import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	routinesSchema,
	type Routine,
	type RoutineKey,
	type RoutineRun,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'

function RoutineText({ routine }: { routine: Routine['key'] }) {
	switch (routine) {
		case 'count_low_stock':
			return (
				<>
					<span className="text-muted-foreground text-xs">
						<Trans>
							When a count is approved, draft an order for each supplier with
							low items and ask you to review it. Nothing is sent.
						</Trans>
					</span>
				</>
			)
		case 'weekly_waste':
			return (
				<>
					<span className="text-muted-foreground text-xs">
						<Trans>
							Every Monday: last week's top five wasted items and the reasons.
						</Trans>
					</span>
				</>
			)
		case 'morning_brief':
			return (
				<>
					<span className="text-muted-foreground text-xs">
						<Trans>
							Every morning: deliveries due, counts due, prep, who is working,
							what is running out, and what to use first.
						</Trans>
					</span>
				</>
			)
		case 'supplier_cutoff':
			return (
				<>
					<span className="text-muted-foreground text-xs">
						<Trans>
							A reminder when a supplier's cut-off is near and no order is
							drafted.
						</Trans>
					</span>
				</>
			)
	}
}

/** One sentence saying what a run did. */
export function RunSummary({
	run,
	canSeeCost,
	currency,
	locale,
}: {
	run: RoutineRun
	canSeeCost: boolean
	currency: string
	locale: string
}) {
	switch (run.key) {
		case 'count_low_stock': {
			const drafted = run.summary.drafted.length
			if (drafted > 0) {
				return (
					<Plural
						value={drafted}
						one="Drafted # order for you to review."
						other="Drafted # orders for you to review."
					/>
				)
			}
			if (run.summary.draftExisted.length > 0) {
				return <Trans>A draft already existed, so nothing new was made.</Trans>
			}
			return run.summary.reason === 'purchasing_off' ? (
				<Trans>Purchasing is off, so nothing was drafted.</Trans>
			) : (
				<Trans>Nothing was low.</Trans>
			)
		}
		case 'weekly_waste': {
			const summary = run.summary
			if (summary.count === 0) return <Trans>No waste last week.</Trans>
			return (
				<>
					<Plural
						value={summary.count}
						one="# waste entry last week"
						other="# waste entries last week"
					/>
					{canSeeCost && summary.valueMinor !== undefined ? (
						<>
							{' · '}
							<bdi dir="ltr">
								{formatMoney(
									summary.valueMinor,
									summary.currency ?? currency,
									locale,
								)}
							</bdi>
						</>
					) : null}
					{summary.topItems.length > 0
						? `: ${summary.topItems.map((item) => item.itemName).join(', ')}`
						: null}
				</>
			)
		}
		case 'morning_brief': {
			const s = run.summary
			return (
				<>
					<Plural
						value={s.deliveries.length}
						one="# delivery due"
						other="# deliveries due"
					/>
					{' · '}
					<Plural
						value={s.runningOut.length}
						one="# item running out"
						other="# items running out"
					/>
					{s.working.known ? (
						<>
							{' · '}
							<Plural
								value={s.working.staff.length}
								one="# person working"
								other="# people working"
							/>
						</>
					) : null}
				</>
			)
		}
		case 'supplier_cutoff':
			return (
				<Trans>
					{run.summary.supplierName}: cut-off{' '}
					<bdi dir="ltr">{run.summary.cutoffTime}</bdi>, no order drafted.
				</Trans>
			)
	}
}

function runDate(run: RoutineRun, locale: string) {
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(run.createdAt))
}

/**
 * The Routines page body: the four templates, each on or off at the location,
 * with its last runs and what each one did. Turning on needs permission to
 * change inventory; the order routines also need Purchasing on.
 */
export function RoutinesScreen({
	locationId,
	orgSlug,
	canEdit,
	canSeeCost,
	currency,
}: {
	locationId: string
	orgSlug: string
	canEdit: boolean
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const list = useInventoryQuery(
		`/routines?${new URLSearchParams({ locationId })}`,
		routinesSchema,
	)
	const [busy, setBusy] = useState<RoutineKey | null>(null)

	async function turn(routine: Routine) {
		setBusy(routine.key)
		try {
			await request(`/routines/${routine.key}`, {
				method: 'PUT',
				body: JSON.stringify({
					locationId,
					enabled: !routine.enabled,
					expectedVersion: routine.version,
				}),
			})
			toast.success(routine.enabled ? t`Turned off.` : t`Turned on.`)
			list.reload()
		} catch (error) {
			toast.error(i18n._(inventorySaveErrorMessage(error)))
			list.reload()
		} finally {
			setBusy(null)
		}
	}

	if (list.loading && !list.data) {
		return <Skeleton className="h-40 w-full rounded-xl" />
	}
	if (list.error && !list.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>We could not load your routines.</Trans>
				</AlertDescription>
			</Alert>
		)
	}
	return (
		<div className="flex flex-col gap-4" data-testid="routines">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Routines draft and tell you. They never send anything to a supplier or
					to your staff: you decide.
				</Trans>
			</p>
			{(list.data?.routines ?? []).map((routine) => (
				<div key={routine.key} data-testid={`routine-${routine.key}`}>
					<WorkspacePanel
						title={
							<span className="flex items-center gap-2">
								<RoutineName routine={routine.key} />
								{routine.enabled ? (
									<Badge variant="success">
										<Trans>On</Trans>
									</Badge>
								) : (
									<Badge variant="outline">
										<Trans>Off</Trans>
									</Badge>
								)}
							</span>
						}
					>
						<div className="flex flex-col gap-3">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<span className="flex min-w-0 flex-col gap-0.5">
									<RoutineText routine={routine.key} />
								</span>
								{canEdit ? (
									<Button
										variant={routine.enabled ? 'outline' : 'default'}
										size="sm"
										disabled={
											busy !== null ||
											(!routine.enabled && routine.blocked !== null)
										}
										onClick={() => void turn(routine)}
										data-testid={`routine-toggle-${routine.key}`}
									>
										{routine.enabled ? (
											<Trans>Turn off</Trans>
										) : (
											<Trans>Turn on</Trans>
										)}
									</Button>
								) : null}
							</div>
							{routine.blocked === 'purchasing_off' && !routine.enabled ? (
								<p className="text-muted-foreground text-xs">
									<Trans>This one needs Purchasing, which is off.</Trans>
								</p>
							) : null}
							{routine.lastRuns.length > 0 ? (
								<ul
									className="flex flex-col divide-y rounded-xl border"
									data-testid={`routine-runs-${routine.key}`}
								>
									{routine.lastRuns.map((run) => (
										<li
											key={run.id}
											className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
										>
											<span className="flex min-w-0 flex-col gap-0.5">
												<span className="wrap-anywhere">
													<RunSummary
														run={run}
														canSeeCost={canSeeCost}
														currency={currency}
														locale={i18n.locale}
													/>
												</span>
												<span className="text-muted-foreground text-xs">
													<bdi dir="ltr">{runDate(run, i18n.locale)}</bdi>
												</span>
											</span>
											<span className="flex items-center gap-2">
												{run.status === 'failed' ? (
													<Badge variant="destructive">
														<Trans>Failed</Trans>
													</Badge>
												) : run.status === 'nothing_to_do' ? (
													<Badge variant="outline">
														<Trans>Nothing to do</Trans>
													</Badge>
												) : (
													<Badge variant="secondary">
														<Trans>Done</Trans>
													</Badge>
												)}
												{run.key === 'count_low_stock' &&
												run.summary.drafted.length > 0 ? (
													<Button
														variant="outline"
														size="sm"
														render={
															<Link
																to={`/${orgSlug}/inventory/purchasing/orders/${run.summary.drafted[0]!.orderId}`}
															/>
														}
													>
														<Trans>Review</Trans>
													</Button>
												) : null}
											</span>
										</li>
									))}
								</ul>
							) : routine.enabled ? (
								<p className="text-muted-foreground text-xs">
									<Trans>No runs yet.</Trans>
								</p>
							) : null}
						</div>
					</WorkspacePanel>
				</div>
			))}
		</div>
	)
}

function RoutineName({ routine }: { routine: RoutineKey }) {
	switch (routine) {
		case 'count_low_stock':
			return <Trans>Low stock after a count</Trans>
		case 'weekly_waste':
			return <Trans>Weekly waste summary</Trans>
		case 'morning_brief':
			return <Trans>Morning brief</Trans>
		case 'supplier_cutoff':
			return <Trans>Supplier cut-off reminder</Trans>
	}
}
