import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { STAFFING_PERMISSIONS as P, type PayType } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameAction,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { PositionChip } from '@repo/ui/position-color'
import { Skeleton } from '@repo/ui/skeleton'
import { useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	minorToInput,
	parseMoneyToMinor,
	todayLocalDate,
} from '#app/utils/staffing/staff-format.ts'
import {
	staffDetailSchema,
	type CurrentRate,
	type StaffDetail,
	type StaffJobRow,
	type StaffPositionRow,
} from '#app/utils/staffing/staff-types.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { SelectField, TextField } from './controls.tsx'
import { RevealGate } from './reveal-gate.tsx'
import { PayCell } from './staff-roster.tsx'
import { useTeamContext } from './team-context.ts'

const DATE_WITH_YEAR: Intl.DateTimeFormatOptions = {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
}

/** A job row is current while today falls between its start and end dates. */
function isCurrent(job: StaffJobRow, today: string): boolean {
	return (
		job.effectiveFrom <= today &&
		(job.effectiveTo === null || job.effectiveTo >= today)
	)
}

export function PositionsTab({
	detail,
	onChanged,
}: {
	detail: StaffDetail
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const { can } = useStaffClient('staff')
	const { scopes, positions } = useTeamContext()
	const today = todayLocalDate()
	const canWrite = can(P.UPDATE_STAFF)
	const canSeePay = can(P.READ_STAFF_PAY)
	const positionMap = useMemo(
		() => new Map(positions.map((position) => [position.id, position])),
		[positions],
	)
	const scopeMap = new Map(scopes.map((scope) => [scope.id, scope]))
	const activeAssignments = detail.assignments.filter((a) => a.active)
	const terminated = detail.staff.status === 'terminated'
	const unassigned = scopes.filter(
		(scope) => !activeAssignments.some((a) => a.scopeId === scope.id),
	)

	return (
		<div className="flex flex-col gap-6">
			{activeAssignments.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{terminated
						? _(t`They no longer work at any workplace.`)
						: _(t`Not at any workplace yet. Add one below.`)}
				</p>
			) : (
				activeAssignments.map((assignment) => {
					const jobs = detail.jobs
						.filter(
							(job) =>
								job.scopeId === assignment.scopeId &&
								(job.effectiveTo === null || job.effectiveTo >= today),
						)
						.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
					return (
						<ScopeBlock
							key={assignment.id}
							staffId={detail.staff.id}
							assignmentId={assignment.id}
							name={scopeMap.get(assignment.scopeId)?.name ?? '–'}
							isPrimary={assignment.isPrimary}
							jobs={jobs}
							today={today}
							positions={positionMap}
							canWrite={canWrite && !terminated}
							onChanged={onChanged}
						/>
					)
				})
			)}

			{canWrite && !terminated ? (
				<div className="flex flex-col gap-4">
					{activeAssignments.length > 0 ? (
						<AddPositionForm detail={detail} onChanged={onChanged} />
					) : null}
					{unassigned.length > 0 ? (
						<AddScopeForm
							staffId={detail.staff.id}
							options={unassigned}
							onChanged={onChanged}
						/>
					) : null}
				</div>
			) : null}

			{canSeePay ? (
				<RevealGate
					title={<Trans>Pay and rates</Trans>}
					description={
						<Trans>
							Current rates and the full history. Each time you view these, it
							is recorded.
						</Trans>
					}
				>
					<PayPanel staffId={detail.staff.id} onChanged={onChanged} />
				</RevealGate>
			) : null}
		</div>
	)
}

function ScopeBlock({
	staffId,
	assignmentId,
	name,
	isPrimary,
	jobs,
	today,
	positions,
	canWrite,
	onChanged,
}: {
	staffId: string
	assignmentId: string
	name: string
	isPrimary: boolean
	jobs: StaffJobRow[]
	today: string
	positions: ReadonlyMap<string, StaffPositionRow>
	canWrite: boolean
	onChanged: () => void
}) {
	const { _, i18n } = useLingui()
	const { client } = useStaffClient('staff')
	const { reloadRoster } = useTeamContext()
	const action = useStaffAction()
	const [confirming, setConfirming] = useState(false)

	async function remove() {
		const result = await action.run(() =>
			client.request(`/${staffId}/assignments/${assignmentId}`, {
				method: 'DELETE',
			}),
		)
		if (result.ok) {
			setConfirming(false)
			toast.success(_(t`Removed from ${name}.`))
			reloadRoster()
			onChanged()
		}
	}

	return (
		<Frame className="w-full" stackedPanels aria-label={name}>
			<FrameHeader>
				<FrameTitle className="flex items-center gap-2">
					{name}
					{isPrimary ? (
						<Badge variant="secondary">
							<Trans>Main workplace</Trans>
						</Badge>
					) : null}
				</FrameTitle>
				{canWrite ? (
					<FrameAction>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setConfirming(true)}
						>
							<Trans>Remove from workplace</Trans>
						</Button>
					</FrameAction>
				) : null}
			</FrameHeader>
			{jobs.length === 0 ? (
				<FramePanel>
					<p className="text-muted-foreground text-sm">
						<Trans>No position here yet.</Trans>
					</p>
				</FramePanel>
			) : (
				jobs.map((job) => {
					const position = positions.get(job.positionId)
					const upcoming = job.effectiveFrom > today
					const startedOn = formatDateLabel(
						job.effectiveFrom,
						i18n.locale,
						DATE_WITH_YEAR,
					)
					return (
						<FramePanel
							key={job.id}
							className="flex items-center justify-between gap-4 px-5 py-3.5"
						>
							<div className="flex min-w-0 items-center gap-3">
								<PositionChip colorKey={position?.colorKey}>
									{position?.name ?? '–'}
								</PositionChip>
								{job.isPrimary ? (
									<span className="text-muted-foreground text-xs">
										<Trans>Main position</Trans>
									</span>
								) : null}
							</div>
							<span className="text-muted-foreground shrink-0 text-xs tabular-nums">
								{upcoming ? (
									<Trans>Starts {startedOn}</Trans>
								) : (
									<Trans>Since {startedOn}</Trans>
								)}
							</span>
						</FramePanel>
					)
				})
			)}

			<AlertDialog open={confirming} onOpenChange={setConfirming}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove from {name}?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Their PIN for this workplace stops working and their positions
								here end today. Their history stays.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={action.pending}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={action.pending}
							onClick={() => void remove()}
						>
							{action.pending ? (
								<Trans>Removing…</Trans>
							) : (
								<Trans>Remove</Trans>
							)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Frame>
	)
}

function AddScopeForm({
	staffId,
	options,
	onChanged,
}: {
	staffId: string
	options: Array<{ id: string; name: string }>
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('staff')
	const { reloadRoster } = useTeamContext()
	const action = useStaffAction()
	const [scopeId, setScopeId] = useState(options[0]?.id ?? '')

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const result = await action.run(() =>
			client.request(`/${staffId}/assignments`, {
				method: 'POST',
				json: { scopeId },
			}),
		)
		if (result.ok) {
			toast.success(_(t`Added to the workplace.`))
			reloadRoster()
			onChanged()
		}
	}

	return (
		<form
			onSubmit={(event) => void add(event)}
			className="flex flex-col gap-3"
			aria-label={_(t`Add to a workplace`)}
		>
			<div className="flex items-end gap-3">
				{options.length > 1 ? (
					<SelectField
						className="min-w-0 flex-1"
						label={<Trans>Add to a workplace</Trans>}
						value={scopeId}
						onValueChange={setScopeId}
						options={options.map((option) => ({
							value: option.id,
							label: option.name,
						}))}
					/>
				) : (
					<p className="text-muted-foreground min-w-0 flex-1 text-sm">
						<Trans>Add them back to the workplace.</Trans>
					</p>
				)}
				<Button
					type="submit"
					variant="outline"
					disabled={action.pending || !scopeId}
				>
					{action.pending ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
				</Button>
			</div>
			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
		</form>
	)
}

function AddPositionForm({
	detail,
	onChanged,
}: {
	detail: StaffDetail
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const { client, can } = useStaffClient('staff')
	const { scopes, positions, reloadRoster } = useTeamContext()
	const action = useStaffAction()
	const canSetPay = can(P.UPDATE_STAFF_PAY)
	const today = todayLocalDate()

	const places = detail.assignments
		.filter((assignment) => assignment.active)
		.map((assignment) => ({
			assignment,
			scope: scopes.find((item) => item.id === assignment.scopeId),
		}))
		.filter((item) => item.scope)
	const [open, setOpen] = useState(false)
	const [scopeId, setScopeId] = useState(places[0]?.scope?.id ?? '')
	const [positionId, setPositionId] = useState('')
	const [payType, setPayType] = useState<PayType>('hourly')
	const [amount, setAmount] = useState('')
	const [effectiveFrom, setEffectiveFrom] = useState(today)
	const [isPrimary, setIsPrimary] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const scope = scopes.find((item) => item.id === scopeId)
	const held = new Set(
		detail.jobs
			.filter(
				(job) =>
					job.scopeId === scopeId &&
					(job.effectiveTo === null || job.effectiveTo >= today),
			)
			.map((job) => job.positionId),
	)
	const available = positions.filter(
		(position) => !position.archivedAt && !held.has(position.id),
	)
	const hasPrimaryHere = detail.jobs.some(
		(job) =>
			job.scopeId === scopeId &&
			job.isPrimary &&
			(job.effectiveTo === null || job.effectiveTo >= today),
	)

	if (positions.filter((position) => !position.archivedAt).length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Add a position on the Positions page first.</Trans>
			</p>
		)
	}

	if (!open) {
		return (
			<div>
				<Button
					type="button"
					variant="outline"
					onClick={() => {
						setOpen(true)
						setIsPrimary(!hasPrimaryHere)
					}}
				>
					<Trans>Add a position</Trans>
				</Button>
			</div>
		)
	}

	async function add(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setError(null)
		if (!positionId) {
			setError(_(t`Choose a position.`))
			return
		}
		let rateMinor: number | null = null
		if (canSetPay && amount.trim()) {
			rateMinor = parseMoneyToMinor(amount)
			if (rateMinor === null) {
				setError(_(t`Enter an amount like 15.50.`))
				return
			}
		}
		if (canSetPay && payType === 'salary' && rateMinor === null) {
			setError(_(t`Enter the yearly salary.`))
			return
		}
		const result = await action.run(() =>
			client.request(`/${detail.staff.id}/jobs`, {
				method: 'POST',
				json: {
					scopeId,
					positionId,
					currency: scope?.currency ?? 'USD',
					isPrimary,
					effectiveFrom,
					...(canSetPay
						? payType === 'salary'
							? { payType, annualSalaryMinor: rateMinor }
							: { payType, rateMinor }
						: {}),
				},
			}),
		)
		if (result.ok) {
			toast.success(_(t`Position added.`))
			setOpen(false)
			setPositionId('')
			setAmount('')
			reloadRoster()
			onChanged()
		}
	}

	return (
		<form
			onSubmit={(event) => void add(event)}
			noValidate
			className="flex flex-col gap-4"
			aria-label={_(t`Add a position`)}
		>
			<h3 className="text-sm font-medium">
				<Trans>Add a position</Trans>
			</h3>
			<div className="grid gap-4 sm:grid-cols-2">
				{places.length > 1 ? (
					<SelectField
						label={<Trans>Workplace</Trans>}
						value={scopeId}
						onValueChange={(value) => {
							setScopeId(value)
							setPositionId('')
						}}
						options={places.map((item) => ({
							value: item.scope!.id,
							label: item.scope!.name,
						}))}
					/>
				) : null}
				<SelectField
					label={<Trans>Position</Trans>}
					value={positionId}
					onValueChange={setPositionId}
					placeholder={_(t`Choose a position`)}
					options={available.map((position) => ({
						value: position.id,
						label: position.name,
					}))}
				/>
				<TextField
					label={<Trans>Starts on</Trans>}
					type="date"
					dir="ltr"
					value={effectiveFrom}
					onChange={(event) => setEffectiveFrom(event.target.value)}
				/>
				{canSetPay ? (
					<>
						<SelectField
							label={<Trans>Pay type</Trans>}
							value={payType}
							onValueChange={(value) => setPayType(value as PayType)}
							options={[
								{ value: 'hourly', label: _(t`Hourly`) },
								{ value: 'salary', label: _(t`Salary`) },
							]}
						/>
						<TextField
							label={
								payType === 'salary' ? (
									<Trans>Yearly salary</Trans>
								) : (
									<Trans>Hourly rate</Trans>
								)
							}
							optional={payType === 'hourly'}
							inputMode="decimal"
							dir="ltr"
							value={amount}
							onChange={(event) => setAmount(event.target.value)}
							hint={
								payType === 'hourly'
									? _(t`Leave empty to use the position's default rate.`)
									: undefined
							}
						/>
					</>
				) : null}
			</div>
			<Label className="flex min-h-11 items-center gap-3 text-sm">
				<Checkbox
					checked={isPrimary}
					onCheckedChange={(checked) => setIsPrimary(checked)}
				/>
				<Trans>Their main position at this workplace</Trans>
			</Label>
			{error || action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{error ?? action.error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex items-center gap-3">
				<Button type="submit" disabled={action.pending}>
					{action.pending ? (
						<Trans>Adding…</Trans>
					) : (
						<Trans>Add position</Trans>
					)}
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={action.pending}
					onClick={() => setOpen(false)}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	)
}

/**
 * Rates and their history, loaded only after "Show". A rate change never edits
 * a row: it ends the current one the day before the new date and starts a new
 * one, so earlier hours keep the rate they were worked at.
 */
function PayPanel({
	staffId,
	onChanged,
}: {
	staffId: string
	onChanged: () => void
}) {
	const { _, i18n } = useLingui()
	const { client, can } = useStaffClient('staff')
	const { positions } = useTeamContext()
	const query = useStaffQuery(
		client,
		`/${staffId}?include=pay`,
		staffDetailSchema,
	)
	const [changing, setChanging] = useState<string | null>(null)
	const today = todayLocalDate()
	const canChange = can(P.UPDATE_STAFF_PAY)
	const positionMap = new Map(
		positions.map((position) => [position.id, position]),
	)

	if (query.loading) {
		return (
			<div role="status" className="flex flex-col gap-3">
				<span className="sr-only">
					<Trans>Loading pay</Trans>
				</span>
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
			</div>
		)
	}
	if (query.error || !query.data) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					{describeStaffError(query.error, _)}
				</AlertDescription>
			</Alert>
		)
	}
	const jobs = [...query.data.jobs].sort((a, b) =>
		a.effectiveFrom < b.effectiveFrom ? 1 : -1,
	)
	if (jobs.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>No pay is set yet.</Trans>
			</p>
		)
	}

	return (
		<ItemGroup>
			{jobs.map((job) => {
				const position = positionMap.get(job.positionId)
				const current = isCurrent(job, today)
				const rate = toCurrentRate(job, position)
				const from = formatDateLabel(
					job.effectiveFrom,
					i18n.locale,
					DATE_WITH_YEAR,
				)
				const to = job.effectiveTo
					? formatDateLabel(job.effectiveTo, i18n.locale, DATE_WITH_YEAR)
					: null
				return (
					<Item
						key={job.id}
						variant={current ? 'muted' : 'default'}
						render={<li />}
					>
						<ItemContent>
							<ItemTitle>
								<PositionChip colorKey={position?.colorKey}>
									{position?.name ?? '–'}
								</PositionChip>
								<PayCell rate={rate} locale={i18n.locale} />
							</ItemTitle>
							<ItemDescription className="tabular-nums">
								{to ? (
									<Trans>
										{from} to {to}
									</Trans>
								) : (
									<Trans>From {from}</Trans>
								)}
							</ItemDescription>
						</ItemContent>
						{canChange &&
						current &&
						job.effectiveTo === null &&
						changing !== job.id ? (
							<ItemActions>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setChanging(job.id)}
								>
									<Trans>Change rate</Trans>
								</Button>
							</ItemActions>
						) : null}
						{canChange &&
						current &&
						job.effectiveTo === null &&
						changing === job.id ? (
							<ItemFooter className="items-stretch">
								<div className="w-full">
									<RateChangeForm
										staffId={staffId}
										job={job}
										onDone={() => {
											setChanging(null)
											query.reload()
											onChanged()
										}}
										onCancel={() => setChanging(null)}
									/>
								</div>
							</ItemFooter>
						) : null}
					</Item>
				)
			})}
		</ItemGroup>
	)
}

/** The rate this row pays: its own, else the position default. */
function toCurrentRate(
	job: StaffJobRow,
	position: StaffPositionRow | undefined,
): CurrentRate | null {
	if (!job.payType) return null
	return {
		payType: job.payType,
		rateMinor: job.rateMinor ?? position?.defaultRateMinor ?? null,
		annualSalaryMinor: job.annualSalaryMinor ?? null,
		currency: job.currency ?? position?.currency ?? 'USD',
	}
}

function RateChangeForm({
	staffId,
	job,
	onDone,
	onCancel,
}: {
	staffId: string
	job: StaffJobRow
	onDone: () => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('staff')
	const action = useStaffAction()
	const salary = job.payType === 'salary'
	const [amount, setAmount] = useState(
		minorToInput(salary ? job.annualSalaryMinor : job.rateMinor),
	)
	const [effectiveFrom, setEffectiveFrom] = useState(todayLocalDate())
	const [reason, setReason] = useState('')
	const [error, setError] = useState<string | null>(null)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setError(null)
		const minor = parseMoneyToMinor(amount)
		if (minor === null) {
			setError(_(t`Enter an amount like 15.50.`))
			return
		}
		if (!reason.trim()) {
			setError(_(t`Add a reason for the change.`))
			return
		}
		const result = await action.run(() =>
			client.request(`/${staffId}/jobs/${job.id}/rate-change`, {
				method: 'POST',
				json: {
					effectiveFrom,
					reason: reason.trim(),
					...(salary ? { annualSalaryMinor: minor } : { rateMinor: minor }),
				},
			}),
		)
		if (result.ok) {
			toast.success(_(t`Rate updated.`))
			onDone()
		}
	}

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-col gap-3"
			aria-label={_(t`Change rate`)}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					label={
						salary ? (
							<Trans>New yearly salary</Trans>
						) : (
							<Trans>New hourly rate</Trans>
						)
					}
					inputMode="decimal"
					dir="ltr"
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
				/>
				<TextField
					label={<Trans>Starts on</Trans>}
					type="date"
					dir="ltr"
					value={effectiveFrom}
					onChange={(event) => setEffectiveFrom(event.target.value)}
				/>
			</div>
			<TextField
				label={<Trans>Reason</Trans>}
				value={reason}
				onChange={(event) => setReason(event.target.value)}
				maxLength={300}
			/>
			{error || action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{error ?? action.error}</AlertDescription>
				</Alert>
			) : null}
			<div className="flex items-center gap-3">
				<Button type="submit" disabled={action.pending}>
					{action.pending ? <Trans>Saving…</Trans> : <Trans>Save rate</Trans>}
				</Button>
				<Button
					type="button"
					variant="ghost"
					disabled={action.pending}
					onClick={onCancel}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	)
}
