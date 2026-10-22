import { Plural, Trans, t } from '@lingui/macro'
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
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { FilterSelect, TextAreaField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { useStaffDirectory } from '#app/hooks/use-staff-directory.ts'
import {
	cancelTimeOff,
	decideShiftRequest,
	decideTimeOff,
} from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import {
	timeOffDays,
	timeOffWhen,
} from '#app/utils/staffing/schedule-requests.ts'
import {
	shiftRequestListSchema,
	timeOffListSchema,
	type ShiftRequestRow,
	type TimeOffRow,
} from '#app/utils/staffing/schedule-types.ts'
import { todayLocalDate } from '#app/utils/staffing/staff-format.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'
import { TimeOffSheet, useCategoryLabels } from './time-off-sheet.tsx'

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all'
const STATUSES: readonly StatusFilter[] = [
	'pending',
	'approved',
	'rejected',
	'all',
]

type Props = {
	scopes: ReadonlyArray<{ id: string; name: string }>
}

/**
 * Time-off requests for the people at your scopes: a queue of what is waiting
 * (approve or decline, with an optional note), what is coming up, and a way to
 * record time off yourself. Names are read from the roster in this tab.
 */
export function TimeOffPage({ scopes: rawScopes }: Props) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [params, setParams] = useSearchParams()
	const { client, ready, can } = useStaffClient('schedule')
	const { client: staffClient, ready: staffReady } = useStaffClient('staff')
	const directory = useStaffDirectory(staffClient, staffReady, locale)
	const canWrite = can(P.UPDATE_SCHEDULE)
	const categories = useCategoryLabels()
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
	const query = new URLSearchParams({ limit: '200' })
	if (status !== 'all') query.set('status', status)
	if (status === 'approved') query.set('from', today)
	if (scopeId !== 'all') query.set('scopeId', scopeId)
	const requests = useStaffQuery(
		client,
		ready ? `/time-off?${query.toString()}` : null,
		timeOffListSchema,
	)
	const shiftRequestQuery = new URLSearchParams({
		status: 'pending',
		limit: '100',
	})
	if (scopeId !== 'all') shiftRequestQuery.set('scopeId', scopeId)
	const shiftRequests = useStaffQuery(
		client,
		ready ? `/requests?${shiftRequestQuery.toString()}` : null,
		shiftRequestListSchema,
	)

	const [adding, setAdding] = useState(false)
	const [declining, setDeclining] = useState<
		| { kind: 'time_off'; row: TimeOffRow }
		| { kind: 'shift'; row: ShiftRequestRow }
		| null
	>(null)
	const [cancelling, setCancelling] = useState<string | null>(null)
	const [note, setNote] = useState('')

	async function decideOff(
		row: TimeOffRow,
		decision: 'approve' | 'reject',
		text?: string,
	) {
		const result = await action.run(() =>
			decideTimeOff(client, row.id, {
				decision,
				...(text ? { note: text } : {}),
			}),
		)
		if (!result.ok) return false
		toast.success(
			decision === 'approve'
				? _(t`Time off approved.`)
				: _(t`Time off declined.`),
		)
		requests.reload()
		return true
	}

	async function decideShift(
		row: ShiftRequestRow,
		decision: 'approve' | 'reject',
		text?: string,
	) {
		const result = await action.run(() =>
			decideShiftRequest(client, row.id, {
				decision,
				...(text ? { note: text } : {}),
			}),
		)
		if (!result.ok) return false
		toast.success(
			decision === 'approve'
				? _(t`Request approved.`)
				: _(t`Request declined.`),
		)
		shiftRequests.reload()
		return true
	}

	async function revoke(row: TimeOffRow) {
		const result = await action.run(() => cancelTimeOff(client, row.id))
		setCancelling(null)
		if (result.ok) {
			toast.success(_(t`Time off cancelled.`))
			requests.reload()
		}
	}

	const nameOf = (staffId: string) =>
		directory.nameOf(staffId) || _(t`Team member`)
	const statusLabels: Record<StatusFilter, string> = {
		pending: _(t`Waiting`),
		approved: _(t`Upcoming`),
		rejected: _(t`Declined`),
		all: _(t`All`),
	}
	const rows = requests.data ?? []
	const shiftRows = shiftRequests.data ?? []
	const kindLabel = {
		swap: _(t`Swap`),
		cover: _(t`Cover`),
		drop: _(t`Drop`),
	} as const

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-center gap-2">
				<Tabs
					value={status}
					onValueChange={(picked) => {
						if (picked) setFilter('status', picked, 'pending')
					}}
				>
					<TabsList aria-label={_(t`Show requests`)}>
						{STATUSES.map((value) => (
							<TabsTrigger className="h-11 md:h-7" key={value} value={value}>
								{statusLabels[value]}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
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
						<Trans>Add time off</Trans>
					</Button>
				) : null}
			</div>

			{action.error ? (
				<Alert variant="destructive">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}

			{requests.loading ? (
				<Skeleton className="h-40 w-full" />
			) : requests.error ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>We could not load time off. Try again.</Trans>
					</AlertDescription>
				</Alert>
			) : rows.length === 0 ? (
				<EmptyState
					title={
						<>
							{status === 'pending' ? (
								<Trans>Nothing is waiting</Trans>
							) : (
								<Trans>No time off to show</Trans>
							)}
						</>
					}
					description={
						<>
							<Trans>
								Time off you record, and requests your team sends, show up here.
							</Trans>
						</>
					}
					icons={['plane', 'calendar', 'sun']}
				/>
			) : (
				<ItemGroup className="gap-2">
					{rows.map((row) => (
						<Item variant="outline" size="sm" role="listitem" key={row.id}>
							<div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
								<div className="flex min-w-0 flex-col gap-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium">
											{nameOf(row.staffId)}
										</span>
										<Badge variant="secondary">
											{categories[row.category]}
										</Badge>
										{row.status !== 'pending' ? (
											<Badge
												variant={
													row.status === 'approved' ? 'outline' : 'ghost'
												}
											>
												{row.status === 'approved' ? (
													<Trans>Approved</Trans>
												) : row.status === 'rejected' ? (
													<Trans>Declined</Trans>
												) : (
													<Trans>Cancelled</Trans>
												)}
											</Badge>
										) : null}
									</div>
									<p className="text-sm tabular-nums">
										{timeOffWhen(row, locale)}
										{row.allDay && row.startDate !== row.endDate ? (
											<span className="text-muted-foreground">
												{' · '}
												<Plural
													value={timeOffDays(row)}
													one="# day"
													other="# days"
												/>
											</span>
										) : null}
									</p>
									{row.note ? (
										<p className="text-muted-foreground text-sm">{row.note}</p>
									) : null}
									{row.decisionNote ? (
										<p className="text-muted-foreground text-sm">
											<YourNote text={row.decisionNote} />
										</p>
									) : null}
									{row.warnings.length > 0 ? (
										<p className="text-sm">
											{row.warnings
												.map((warning) =>
													warning.code === 'short_notice'
														? _(t`Short notice.`)
														: warning.code === 'over_daily_limit'
															? _(t`Longer than usual.`)
															: '',
												)
												.filter(Boolean)
												.join(' ')}
										</p>
									) : null}
								</div>
								{canWrite ? (
									<div className="flex shrink-0 flex-wrap gap-2">
										{row.status === 'pending' ? (
											<>
												<Button
													size="sm"
													disabled={action.pending}
													onClick={() => void decideOff(row, 'approve')}
												>
													<Icon name="check" />
													<Trans>Approve</Trans>
												</Button>
												<Button
													size="sm"
													variant="outline"
													disabled={action.pending}
													onClick={() => {
														setNote('')
														setDeclining({ kind: 'time_off', row })
													}}
												>
													<Trans>Decline</Trans>
												</Button>
											</>
										) : row.status === 'approved' ? (
											cancelling === row.id ? (
												<Button
													size="sm"
													variant="destructive"
													disabled={action.pending}
													onClick={() => void revoke(row)}
												>
													<Trans>Yes, cancel it</Trans>
												</Button>
											) : (
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setCancelling(row.id)}
												>
													<Trans>Cancel time off</Trans>
												</Button>
											)
										) : null}
									</div>
								) : null}
							</div>
						</Item>
					))}
				</ItemGroup>
			)}

			{shiftRows.length > 0 ? (
				<section
					aria-labelledby="shift-requests"
					className="flex flex-col gap-2"
				>
					<h2 id="shift-requests" className="text-base font-semibold">
						<Trans>Swap, cover and drop requests</Trans>
					</h2>
					<ItemGroup className="gap-2">
						{shiftRows.map((row) => (
							<Item variant="outline" size="sm" role="listitem" key={row.id}>
								<div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
									<div className="flex min-w-0 flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<Badge variant="secondary">{kindLabel[row.kind]}</Badge>
											<span className="text-sm font-medium">
												{nameOf(row.requesterStaffId)}
											</span>
											{row.targetStaffId ? (
												<span className="text-muted-foreground text-sm">
													→ {nameOf(row.targetStaffId)}
												</span>
											) : null}
										</div>
										<p className="text-sm tabular-nums">
											{formatDateLabel(row.localDate, locale)}
										</p>
										{row.note ? (
											<p className="text-muted-foreground text-sm">
												{row.note}
											</p>
										) : null}
									</div>
									{canWrite ? (
										<div className="flex shrink-0 flex-wrap gap-2">
											<Button
												size="sm"
												disabled={action.pending}
												onClick={() => void decideShift(row, 'approve')}
											>
												<Icon name="check" />
												<Trans>Approve</Trans>
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={action.pending}
												onClick={() => {
													setNote('')
													setDeclining({ kind: 'shift', row })
												}}
											>
												<Trans>Decline</Trans>
											</Button>
										</div>
									) : null}
								</div>
							</Item>
						))}
					</ItemGroup>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Approving a swap or cover changes the schedule as a draft. Publish
							the week to tell your team.
						</Trans>
					</p>
				</section>
			) : null}

			<TimeOffSheet
				open={adding}
				onClose={() => setAdding(false)}
				client={client}
				directory={directory}
				locale={locale}
				onSaved={requests.reload}
			/>

			<Dialog
				open={declining !== null}
				onOpenChange={(open) => !open && setDeclining(null)}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Decline this request?</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>You can leave a note. It is kept with the request.</Trans>
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
								const text = note.trim() || undefined
								const done =
									declining.kind === 'time_off'
										? await decideOff(declining.row, 'reject', text)
										: await decideShift(declining.row, 'reject', text)
								if (done) setDeclining(null)
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

function YourNote({ text }: { text: string }) {
	return <Trans>Your note: {text}</Trans>
}
