import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Item, ItemGroup } from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect, TextAreaField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { useStaffDirectory } from '#app/hooks/use-staff-directory.ts'
import { decideAvailability } from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import { availabilityWhen } from '#app/utils/staffing/schedule-requests.ts'
import {
	availabilityListSchema,
	type AvailabilityRow,
} from '#app/utils/staffing/schedule-types.ts'
import { todayLocalDate } from '#app/utils/staffing/staff-format.ts'
import { AvailabilitySheet } from './availability-sheet.tsx'

type StatusFilter = 'pending' | 'approved' | 'rejected'
const STATUSES: readonly StatusFilter[] = ['pending', 'approved', 'rejected']

type Group = { staffId: string; rows: AvailabilityRow[] }

/** Rows grouped by person, in the order the people first appear. */
function groupByPerson(rows: readonly AvailabilityRow[]): Group[] {
	const groups = new Map<string, Group>()
	for (const row of rows) {
		const group = groups.get(row.staffId) ?? { staffId: row.staffId, rows: [] }
		group.rows.push(row)
		groups.set(row.staffId, group)
	}
	return [...groups.values()]
}

/**
 * Availability for the people at your scopes: changes waiting for a decision
 * (approved or declined together, per person), what is in force now, and a way
 * to record availability yourself. A person's approved weekly pattern is what the
 * schedule checks shifts against.
 */
export function AvailabilityPage({
	scopes: rawScopes,
}: {
	scopes: ReadonlyArray<{ id: string; name: string }>
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [params, setParams] = useSearchParams()
	const { client, ready, can } = useStaffClient('schedule')
	const { client: staffClient, ready: staffReady } = useStaffClient('staff')
	const directory = useStaffDirectory(staffClient, staffReady, locale)
	const canWrite = can(P.UPDATE_SCHEDULE)
	const action = useStaffAction(describeScheduleError)

	const status = (STATUSES as readonly string[]).includes(
		params.get('status') ?? '',
	)
		? (params.get('status') as StatusFilter)
		: 'pending'
	const scopeId = params.get('scope') ?? 'all'
	const scopes = rawScopes.map((scope) => ({
		value: scope.id,
		label: pickLocalized(scope.name, locale, 'en') || scope.name,
	}))
	const setFilter = (
		key: 'status' | 'scope',
		value: string,
		fallback: string,
	) => {
		const next = new URLSearchParams(params)
		if (value === fallback) next.delete(key)
		else next.set(key, value)
		setParams(next, { replace: true, preventScrollReset: true })
	}

	const [today] = useState(() => todayLocalDate())
	const query = new URLSearchParams({ status, limit: '500' })
	if (scopeId !== 'all') query.set('scopeId', scopeId)
	const list = useStaffQuery(
		client,
		ready ? `/availability?${query.toString()}` : null,
		availabilityListSchema,
	)
	const groups = useMemo(
		() =>
			groupByPerson(
				// A date that has passed no longer matters to the schedule.
				(list.data ?? []).filter(
					(row) =>
						status !== 'approved' ||
						row.kind === 'weekly' ||
						(row.date ?? '') >= today,
				),
			),
		[list.data, status, today],
	)

	const [adding, setAdding] = useState(false)
	const [declining, setDeclining] = useState<Group | null>(null)
	const [note, setNote] = useState('')

	async function decide(
		group: Group,
		decision: 'approve' | 'reject',
		text?: string,
	) {
		const ids = group.rows
			.filter((row) => row.status === 'pending')
			.map((row) => row.id)
		if (ids.length === 0) return false
		const result = await action.run(() =>
			decideAvailability(client, {
				ids,
				decision,
				...(text ? { note: text } : {}),
			}),
		)
		if (!result.ok) return false
		toast.success(
			decision === 'approve'
				? _(t`Availability approved.`)
				: _(t`Availability declined.`),
		)
		list.reload()
		return true
	}

	const statusLabels: Record<StatusFilter, string> = {
		pending: _(t`Waiting`),
		approved: _(t`In force`),
		rejected: _(t`Declined`),
	}
	const nameOf = (staffId: string) =>
		directory.nameOf(staffId) || _(t`Team member`)

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center gap-2">
				<ToggleGroup
					aria-label={_(t`Show availability`)}
					value={[status]}
					variant="segmented"
					onValueChange={(next) => {
						const picked = next[0]
						if (picked) setFilter('status', picked, 'pending')
					}}
				>
					{STATUSES.map((value) => (
						<ToggleGroupItem className="h-11 md:h-7" key={value} value={value}>
							{statusLabels[value]}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{scopes.length > 1 ? (
					<FilterSelect
						label={_(t`Filter by workplace`)}
						options={[{ value: 'all', label: _(t`All workplaces`) }, ...scopes]}
						value={scopeId}
						onValueChange={(value) => setFilter('scope', value, 'all')}
					/>
				) : null}
				{canWrite ? (
					<Button className="ms-auto" onClick={() => setAdding(true)}>
						<Icon name="plus" />
						<Trans>Add availability</Trans>
					</Button>
				) : null}
			</div>

			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}

			{list.loading ? (
				<Skeleton className="h-40 w-full" />
			) : list.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>We could not load availability. Try again.</Trans>
					</AlertDescription>
				</Alert>
			) : groups.length === 0 ? (
				<EmptyState
					title={
						<>
							{status === 'pending' ? (
								<Trans>Nothing is waiting</Trans>
							) : (
								<Trans>No availability to show</Trans>
							)}
						</>
					}
					description={
						<>
							<Trans>
								When people have hours they can or cannot work, the schedule
								warns you if a shift falls outside them.
							</Trans>
						</>
					}
					icons={['sun', 'calendar', 'users']}
				/>
			) : (
				<ItemGroup className="gap-2">
					{groups.map((group) => {
						const pending = group.rows.filter((row) => row.status === 'pending')
						return (
							<Item
								variant="outline"
								size="sm"
								role="listitem"
								key={group.staffId}
							>
								<div className="flex w-full flex-col gap-3 md:flex-row md:items-start md:justify-between">
									<div className="flex min-w-0 flex-col gap-2">
										<span className="text-sm font-medium">
											{nameOf(group.staffId)}
										</span>
										<ul className="flex flex-col gap-1">
											{group.rows.map((row) => {
												const when = availabilityWhen(row, locale)
												return (
													<li
														key={row.id}
														className="flex flex-wrap items-center gap-2 text-sm"
													>
														<Badge
															variant={
																row.availability === 'available'
																	? 'outline'
																	: 'secondary'
															}
														>
															{row.availability === 'available' ? (
																<Trans>Available</Trans>
															) : (
																<Trans>Unavailable</Trans>
															)}
														</Badge>
														<span className="tabular-nums">
															{when.recurring ? (
																<EveryDay day={when.day} />
															) : (
																when.day
															)}
															{' · '}
															{when.allDay ? (
																<Trans>All day</Trans>
															) : (
																when.hours
															)}
														</span>
														{row.note ? (
															<span className="text-muted-foreground">
																{row.note}
															</span>
														) : null}
													</li>
												)
											})}
										</ul>
										{group.rows.some((row) => row.decisionNote) ? (
											<p className="text-muted-foreground text-sm">
												{
													group.rows.find((row) => row.decisionNote)
														?.decisionNote
												}
											</p>
										) : null}
									</div>
									{canWrite && pending.length > 0 ? (
										<div className="flex shrink-0 flex-wrap gap-2">
											<Button
												size="sm"
												disabled={action.pending}
												onClick={() => void decide(group, 'approve')}
											>
												<Icon name="check" />
												{plural(pending.length, {
													one: 'Approve',
													other: 'Approve all',
												})}
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={action.pending}
												onClick={() => {
													setNote('')
													setDeclining(group)
												}}
											>
												<Trans>Decline</Trans>
											</Button>
										</div>
									) : null}
								</div>
							</Item>
						)
					})}
				</ItemGroup>
			)}

			<AvailabilitySheet
				open={adding}
				onClose={() => setAdding(false)}
				client={client}
				directory={directory}
				locale={locale}
				onSaved={list.reload}
			/>

			<Dialog
				open={declining !== null}
				onOpenChange={(open) => !open && setDeclining(null)}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Decline this availability?</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Their current availability stays as it is. You can leave a note.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<TextAreaField
						label={<Trans>Note</Trans>}
						optional
						rows={3}
						value={note}
						maxLength={500}
						onChange={(event) => setNote(event.target.value)}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setDeclining(null)}
						>
							<Trans>Keep waiting</Trans>
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={action.pending}
							onClick={async () => {
								if (!declining) return
								if (await decide(declining, 'reject', note.trim() || undefined))
									setDeclining(null)
							}}
						>
							<Trans>Decline</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

function EveryDay({ day }: { day: string }) {
	return <Trans>Every {day}</Trans>
}
