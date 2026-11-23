import { Trans, useLingui } from '@lingui/react/macro'
import {
	type CountSchedule,
	listCountListsResultSchema,
	listCountSchedulesResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useId, useMemo, useRef, useState } from 'react'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { useStaffClient } from '#app/hooks/use-staff-client.ts'
import { useStaffDirectory } from '#app/hooks/use-staff-directory.ts'
import {
	ALL_WEEKDAYS,
	assigneeValue,
	buildCreateSchedule,
	buildUpdateSchedule,
	COUNT_SLOTS,
	type CountSlot,
	emptyScheduleForm,
	formFromSchedule,
	NO_ASSIGNEE,
	SLOT_DEFAULT_TIME,
	type ScheduleFormValues,
	scheduleFormProblem,
	weekdayName,
	weekdaysText,
} from '#app/utils/inventory/count-plan.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

export type PlanPerson = { id: string; name: string }

type PanelProps = {
	orgSlug: string
	locationId: string
	canEdit: boolean
	/** Members with a login who may see inventory here (from the App). */
	members: readonly PlanPerson[]
	/** Key items need a second person's count at this location (#525). */
	secondCountRequired: boolean
	/** The location settings version, for the second-person switch. */
	locationVersion: number
	/** Whoever holds `update:settings:any` may change the second-person switch. */
	canManageSettings: boolean
	onSettingsChanged: () => void
}

/**
 * The weekly count plan of a location (#490, #491): scheduled counts (a quick
 * count of the key items at close, a full count, a count list), who is
 * responsible for each, and whether key items need a second person's count
 * (#525). A change applies from tomorrow and never to a count already started.
 * Staff on the roster are read here from the region, with their own token:
 * their names never pass through the App server.
 */
export function CountPlanPanel(props: PanelProps) {
	return (
		<StaffClientProvider orgSlug={props.orgSlug}>
			<CountPlanPanelInner {...props} />
		</StaffClientProvider>
	)
}

function CountPlanPanelInner({
	locationId,
	canEdit,
	members,
	secondCountRequired,
	locationVersion,
	canManageSettings,
	onSettingsChanged,
}: PanelProps) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const schedules = useInventoryQuery(
		`/count-schedules?locationId=${encodeURIComponent(locationId)}`,
		listCountSchedulesResultSchema,
	)
	const lists = useInventoryQuery(
		`/count-lists?locationId=${encodeURIComponent(locationId)}`,
		listCountListsResultSchema,
	)
	const { client, ready } = useStaffClient('staff')
	const roster = useStaffDirectory(client, ready, i18n.locale)
	const staff = useMemo<PlanPerson[]>(
		() =>
			(roster.people ?? [])
				.filter((person) => person.terminatedAt === null)
				.map((person) => ({
					id: person.id,
					name: roster.nameOf(person.id) || person.id,
				})),
		[roster],
	)
	const nameOfAssignee = (schedule: CountSchedule): string | null => {
		const assignee = schedule.assignee
		if (!assignee) return null
		const list = assignee.kind === 'staff' ? staff : members
		return list.find((person) => person.id === assignee.id)?.name ?? null
	}

	const [editing, setEditing] = useState<CountSchedule | 'new' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [secondBusy, setSecondBusy] = useState(false)

	async function setSecond(next: boolean) {
		setSecondBusy(true)
		setError(null)
		try {
			await request(
				`/settings/locations/${encodeURIComponent(locationId)}/count-controls`,
				{
					method: 'PUT',
					body: JSON.stringify({
						expectedVersion: locationVersion,
						secondCountRequired: next,
					}),
				},
			)
			onSettingsChanged()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSecondBusy(false)
		}
	}

	async function archive(schedule: CountSchedule) {
		setError(null)
		try {
			await request(
				`/count-schedules/${encodeURIComponent(schedule.id)}/archive`,
				{
					method: 'POST',
					body: JSON.stringify({ expectedVersion: schedule.version }),
				},
			)
			schedules.reload()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		}
	}

	const list = schedules.data?.schedules ?? []

	return (
		<div className="flex flex-col gap-4" data-testid="count-plan">
			{error ? (
				<Alert variant="destructive" data-testid="count-plan-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{schedules.error && !schedules.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(schedules.error))}
					</AlertDescription>
				</Alert>
			) : schedules.loading && !schedules.data ? (
				<Skeleton className="h-16 w-full" />
			) : list.length === 0 ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="count-plan-empty"
				>
					<Trans>
						No counts are scheduled. Add a quick count of your key items at
						close, or a weekly count.
					</Trans>
				</p>
			) : (
				<ul className="flex flex-col gap-2" data-testid="count-plan-list">
					{list.map((schedule) => {
						const days = weekdaysText(schedule.weekdays, i18n.locale)
						const who = nameOfAssignee(schedule)
						const listName = schedule.listName ?? ''
						return (
							<li
								key={schedule.id}
								className="flex flex-wrap items-center gap-3 rounded-md border p-3"
								data-testid={`count-plan-row-${schedule.id}`}
							>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex flex-wrap items-center gap-2 font-medium">
										{schedule.listId !== null ? (
											<span className="wrap-anywhere">
												<Trans>Count list: {listName}</Trans>
											</span>
										) : schedule.kind === 'quick' ? (
											<Trans>Quick count of key items</Trans>
										) : (
											<Trans>Full count</Trans>
										)}
										<Badge variant="secondary">
											{schedule.slot === 'opening' ? (
												<Trans>At opening</Trans>
											) : schedule.slot === 'close' ? (
												<Trans>At close</Trans>
											) : (
												<Trans>At a set time</Trans>
											)}
										</Badge>
									</span>
									<span className="text-muted-foreground text-sm">
										<bdi dir="ltr" className="tabular-nums">
											{schedule.timeLocal}
										</bdi>
										{' · '}
										{days ?? <Trans>Every day</Trans>}
									</span>
									<span className="text-sm" data-testid="count-plan-assignee">
										{schedule.assignee ? (
											who ? (
												<Trans>Responsible: {who}</Trans>
											) : (
												<Trans>
													Responsible: someone who is no longer listed
												</Trans>
											)
										) : (
											<span className="text-muted-foreground">
												<Trans>Nobody is responsible yet</Trans>
											</span>
										)}
									</span>
								</div>
								{canEdit ? (
									<div className="flex items-center gap-2">
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setEditing(schedule)}
											data-testid={`count-plan-edit-${schedule.id}`}
										>
											<Trans>Change</Trans>
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => void archive(schedule)}
											data-testid={`count-plan-remove-${schedule.id}`}
										>
											<Trans>Remove</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			)}
			<p className="text-muted-foreground text-xs">
				<Trans>
					A change applies from tomorrow. A count that has already started is
					not touched.
				</Trans>
			</p>
			{canEdit ? (
				<div>
					<Button
						type="button"
						variant="outline"
						onClick={() => setEditing('new')}
						data-testid="count-plan-add"
					>
						<Icon name="plus" />
						<Trans>Add a count</Trans>
					</Button>
				</div>
			) : null}

			<div className="flex items-start gap-2.5">
				<Checkbox
					id="count-plan-second"
					checked={secondCountRequired}
					disabled={!canManageSettings || secondBusy}
					onCheckedChange={(checked) => void setSecond(Boolean(checked))}
					data-testid="count-plan-second"
				/>
				<div className="flex flex-col gap-0.5">
					<Label htmlFor="count-plan-second" className="font-normal">
						<Trans>Key items need a second person to count them again</Trans>
					</Label>
					<p className="text-muted-foreground text-xs">
						<Trans>
							After the count, a different person signs in with their own PIN or
							login and counts only the key items. You see both counts side by
							side and settle any difference before review. A manager can skip
							it with a reason.
						</Trans>
					</p>
				</div>
			</div>

			{editing ? (
				<ScheduleDialog
					key={editing === 'new' ? 'new' : editing.id}
					schedule={editing === 'new' ? null : editing}
					locationId={locationId}
					lists={lists.data?.lists ?? []}
					staff={staff}
					members={members}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null)
						schedules.reload()
					}}
				/>
			) : null}
			<span className="sr-only">{t`Weekly count plan`}</span>
		</div>
	)
}

function ScheduleDialog({
	schedule,
	locationId,
	lists,
	staff,
	members,
	onClose,
	onSaved,
}: {
	schedule: CountSchedule | null
	locationId: string
	lists: ReadonlyArray<{ id: string; name: string }>
	staff: readonly PlanPerson[]
	members: readonly PlanPerson[]
	onClose: () => void
	onSaved: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const [values, setValues] = useState<ScheduleFormValues>(
		schedule ? formFromSchedule(schedule) : emptyScheduleForm(),
	)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientIdRef = useRef(newClientId('cs'))
	const kindId = useId()
	const slotId = useId()
	const timeId = useId()
	const assigneeId = useId()
	const listId = useId()
	const problem = scheduleFormProblem(values)

	const set = (patch: Partial<ScheduleFormValues>) =>
		setValues((current) => ({ ...current, ...patch }))

	async function save() {
		if (saving || problem) return
		setSaving(true)
		setError(null)
		try {
			if (schedule) {
				await request(`/count-schedules/${encodeURIComponent(schedule.id)}`, {
					method: 'PATCH',
					body: JSON.stringify(buildUpdateSchedule(values, schedule)),
				})
			} else {
				await request('/count-schedules', {
					method: 'POST',
					body: JSON.stringify(
						buildCreateSchedule(values, {
							locationId,
							clientId: clientIdRef.current,
						}),
					),
				})
			}
			onSaved()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSaving(false)
		}
	}

	const kindOptions = [
		{ value: 'quick', label: t`Quick count of key items` },
		{ value: 'full', label: t`Full count of everything` },
		{ value: 'list', label: t`A saved count list` },
	]
	const assigneeOptions = [
		{ value: NO_ASSIGNEE, label: t`Nobody yet` },
		...staff.map((person) => ({
			value: assigneeValue({ kind: 'staff', id: person.id }),
			label: person.name,
		})),
		...members.map((person) => {
			const name = person.name
			return {
				value: assigneeValue({ kind: 'member', id: person.id }),
				label: t`${name} (login)`,
			}
		}),
	]

	return (
		<Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : null)}>
			<DialogContent className="sm:max-w-md" data-testid="count-plan-dialog">
				<DialogHeader>
					<DialogTitle>
						{schedule ? (
							<Trans>Change a count</Trans>
						) : (
							<Trans>Add a count</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose what is counted, when, and who is responsible. It applies
							from tomorrow.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<div className="flex flex-col gap-4">
					{schedule === null ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={kindId}>
								<Trans>What to count</Trans>
							</Label>
							<Select
								items={kindOptions}
								value={values.kind}
								onValueChange={(value) =>
									set({ kind: value as ScheduleFormValues['kind'] })
								}
							>
								<SelectTrigger id={kindId} data-testid="count-plan-kind">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{kindOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
					{values.kind === 'list' ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={listId}>
								<Trans>Count list</Trans>
							</Label>
							<Select
								items={lists.map((list) => ({
									value: list.id,
									label: list.name,
								}))}
								value={values.listId}
								onValueChange={(value) => set({ listId: String(value ?? '') })}
							>
								<SelectTrigger id={listId} data-testid="count-plan-list-choice">
									<SelectValue placeholder={t`Pick a list`} />
								</SelectTrigger>
								<SelectContent>
									{lists.map((list) => (
										<SelectItem key={list.id} value={list.id}>
											{list.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
					<div className="grid grid-cols-2 gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={slotId}>
								<Trans>When</Trans>
							</Label>
							<Select
								items={COUNT_SLOTS.map((slot) => ({
									value: slot,
									label: slot,
								}))}
								value={values.slot}
								onValueChange={(value) => {
									const slot = value as CountSlot
									set({ slot, timeLocal: SLOT_DEFAULT_TIME[slot] })
								}}
							>
								<SelectTrigger id={slotId} data-testid="count-plan-slot">
									<SelectValue>
										{values.slot === 'opening' ? (
											<Trans>At opening</Trans>
										) : values.slot === 'close' ? (
											<Trans>At close</Trans>
										) : (
											<Trans>At a set time</Trans>
										)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="opening">
										<Trans>At opening</Trans>
									</SelectItem>
									<SelectItem value="close">
										<Trans>At close</Trans>
									</SelectItem>
									<SelectItem value="custom">
										<Trans>At a set time</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={timeId}>
								<Trans>Time (24h)</Trans>
							</Label>
							<Input
								id={timeId}
								dir="ltr"
								value={values.timeLocal}
								onChange={(event) => set({ timeLocal: event.target.value })}
								aria-invalid={problem === 'time'}
								data-testid="count-plan-time"
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">
							<Trans>Days</Trans>
						</span>
						<ToggleGroup
							variant="segmented"
							multiple
							value={values.weekdays.map(String)}
							onValueChange={(next) =>
								set({ weekdays: next.map(Number).sort((a, b) => a - b) })
							}
							aria-label={t`Days`}
							data-testid="count-plan-days"
						>
							{ALL_WEEKDAYS.map((day) => (
								<ToggleGroupItem key={day} value={String(day)}>
									{weekdayName(day, i18n.locale)}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={assigneeId}>
							<Trans>Responsible</Trans>
						</Label>
						<Select
							items={assigneeOptions}
							value={values.assignee}
							onValueChange={(value) =>
								set({ assignee: String(value ?? NO_ASSIGNEE) })
							}
						>
							<SelectTrigger
								id={assigneeId}
								data-testid="count-plan-assignee-choice"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{assigneeOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={onClose}
						disabled={saving}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void save()}
						disabled={saving || problem !== null}
						data-testid="count-plan-save"
					>
						<Trans>Save</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
