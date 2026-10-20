import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useIsNarrow } from '#app/hooks/use-container-width.ts'
import { useVisiblePolling } from '#app/hooks/use-live-clock.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { forecastSchema } from '#app/utils/staffing/labor-types.ts'
import {
	createShifts,
	updateShift,
	type UpdateShiftInput,
} from '#app/utils/staffing/schedule-api.ts'
import {
	describeConflict,
	describeScheduleError,
	isStaleError,
} from '#app/utils/staffing/schedule-errors.ts'
import {
	demandSchema,
	weekViewSchema,
	type ScheduleShiftRow,
} from '#app/utils/staffing/schedule-types.ts'
import {
	buildGrid,
	clipFromShift,
	conflictedShifts,
	formatShiftRange,
	OPEN_ROW,
	parseScheduleSearch,
	pasteBody,
	shiftTimes,
	summarizeDemand,
	writeScheduleSearch,
	type ScheduleSearch,
	type ShiftClip,
} from '#app/utils/staffing/schedule-view.ts'
import { todayIn } from '#app/utils/staffing/timesheet-view.ts'
import { type BoardProps, type CellRef } from './board-types.ts'
import { CopyWeekDialog } from './copy-week-dialog.tsx'
import { DayList } from './day-list.tsx'
import { DayTimeline } from './day-timeline.tsx'
import { MonthView } from './month-view.tsx'
import { PublicationHistorySheet } from './publication-history.tsx'
import { PublishDialog } from './publish-dialog.tsx'
import { RecommendDialog } from './recommend-dialog.tsx'
import { ScheduleToolbar } from './schedule-toolbar.tsx'
import { ShiftEditorSheet, type EditorMode } from './shift-editor-sheet.tsx'
import { TemplatesDialog } from './templates-dialog.tsx'
import { WeekGrid } from './week-grid.tsx'

const POLL_MS = 60_000
/** Below this much room the grid gives way to the one-day list. */
const GRID_MIN_WIDTH = 760

type Props = {
	orgSlug: string
	scopes: ReadonlyArray<{ id: string; name: string; timeZone: string }>
}

type Dialog = 'copy' | 'templates' | 'recommend' | 'publish' | 'history' | null

/**
 * The schedule: week grid, day timeline, month overview and, on a phone, a
 * one-day list. Everything is fetched browser-direct from the regional node
 * with a short-lived `schedule` token, a week at a time. Changes are drafts
 * until the manager publishes the week.
 */
export function SchedulePage({ orgSlug, scopes: rawScopes }: Props) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const rtl = useDirection() === 'rtl'
	const [params, setParams] = useSearchParams()
	const containerRef = useRef<HTMLDivElement>(null)
	const narrow = useIsNarrow(containerRef, GRID_MIN_WIDTH)
	const { client, ready, unavailable, can } = useStaffClient('schedule')
	const canWrite = can(P.UPDATE_SCHEDULE)
	const canLabor = can(P.READ_LABOR)

	const scopes = useMemo(
		() =>
			rawScopes.map((scope) => ({
				value: scope.id,
				label: pickLocalized(scope.name, locale, 'en') || scope.name,
				timeZone: scope.timeZone,
			})),
		[rawScopes, locale],
	)
	const defaultScopeId = scopes[0]?.value ?? ''

	// ---- Address bar ---------------------------------------------------------
	const [now] = useState(() => Date.now())
	const rawSearch = parseScheduleSearch(params, '0000-00-00', defaultScopeId)
	const scope =
		scopes.find((entry) => entry.value === rawSearch.scopeId) ?? scopes[0]
	const today = todayIn(now, scope?.timeZone ?? 'UTC')
	const search = parseScheduleSearch(params, today, defaultScopeId)
	const scopeId = scope?.value ?? ''
	const update = useCallback(
		(patch: Partial<ScheduleSearch>) => {
			setParams(writeScheduleSearch(params, patch, today, defaultScopeId), {
				replace: true,
				preventScrollReset: true,
			})
		},
		[params, setParams, today, defaultScopeId],
	)
	const pickDate = useCallback(
		(date: string, view: 'week' | 'day') => update({ date, view }),
		[update],
	)

	// ---- Data ---------------------------------------------------------------
	const view = search.view
	// Picking another day of the week on screen must not fetch the week again.
	const [loaded, setLoaded] = useState<{
		scopeId: string
		dates: readonly string[]
		weekStart: string
	} | null>(null)
	const queryDate =
		loaded && loaded.scopeId === scopeId && loaded.dates.includes(search.date)
			? loaded.weekStart
			: search.date
	const weekPath =
		ready && scopeId && view !== 'month'
			? `/week?${new URLSearchParams({ scopeId, date: queryDate }).toString()}`
			: null
	const weekQuery = useStaffQuery(client, weekPath, weekViewSchema)
	const week = weekQuery.data
	if (
		week &&
		(loaded?.weekStart !== week.weekStart || loaded.scopeId !== week.scopeId)
	) {
		setLoaded({
			scopeId: week.scopeId,
			dates: week.dates,
			weekStart: week.weekStart,
		})
	}
	const demandQuery = useStaffQuery(
		client,
		weekPath ? weekPath.replace('/week?', '/demand?') : null,
		demandSchema,
	)
	const demand = useMemo(
		() =>
			demandQuery.data && demandQuery.data.daysWithOrders > 0
				? summarizeDemand(demandQuery.data)
				: null,
		[demandQuery.data],
	)
	// Coverage against the orders you usually get: part of the labor feature, so
	// the request is only made when the token carries the labor grant.
	const forecastQuery = useStaffQuery(
		client,
		canLabor && weekPath ? weekPath.replace('/week?', '/forecast?') : null,
		forecastSchema,
	)
	const [monthReload, setMonthReload] = useState(0)
	const reloadWeek = weekQuery.reload
	const reloadDemand = demandQuery.reload
	const reloadForecast = forecastQuery.reload
	const reload = useCallback(() => {
		reloadWeek()
		reloadForecast()
		setMonthReload((value) => value + 1)
	}, [reloadWeek, reloadForecast])

	const [editor, setEditor] = useState<EditorMode | null>(null)
	const [dialog, setDialog] = useState<Dialog>(null)
	const [templatesTab, setTemplatesTab] = useState<'apply' | 'save'>('apply')
	const [clip, setClip] = useState<ShiftClip | null>(null)
	const [busyShiftId, setBusyShiftId] = useState<string | null>(null)
	const [startBlank, setStartBlank] = useState(false)
	const [lastTimes, setLastTimes] = useState<{
		startTime: string
		endTime: string
	} | null>(null)

	useVisiblePolling(
		useCallback(() => {
			if (!editor && dialog === null && busyShiftId === null) reloadWeek()
		}, [editor, dialog, busyShiftId, reloadWeek]),
		POLL_MS,
	)

	const positions = useMemo(
		() =>
			new Map(
				(week?.positions ?? []).map((position) => [position.id, position]),
			),
		[week?.positions],
	)
	const grid = useMemo(
		() => (week ? buildGrid(week, { group: search.group, locale }) : null),
		[week, search.group, locale],
	)
	const conflicts = useMemo(() => (week ? conflictedShifts(week) : []), [week])
	const showCost =
		canLabor &&
		Boolean(week?.footers.some((footer) => footer.costMinorByCurrency))

	// ---- Changes -------------------------------------------------------------
	const reportFailure = useCallback(
		(error: unknown) => {
			toast.error(describeScheduleError(error, _))
			if (isStaleError(error)) reload()
		},
		[_, reload],
	)

	const changeShift = useCallback(
		async (shift: ScheduleShiftRow, body: UpdateShiftInput) => {
			setBusyShiftId(shift.id)
			try {
				const result = await updateShift(client, shift.id, body)
				const flagged = result.shifts.flatMap((written) => written.conflicts)
				const first = flagged[0]
				if (first && search.conflicts) {
					toast.warning(
						`${plural(flagged.length, { one: '# warning:', other: '# warnings:' })} ${describeConflict(first.code, _)}`,
					)
				}
				if (body.startTime && body.endTime) {
					setLastTimes({ startTime: body.startTime, endTime: body.endTime })
				}
			} catch (error) {
				reportFailure(error)
			} finally {
				reload()
				setBusyShiftId(null)
			}
		},
		[client, _, reload, reportFailure, search.conflicts],
	)

	const copyShift = useCallback(
		(shift: ScheduleShiftRow) => {
			setClip(clipFromShift(shift))
			const range = formatShiftRange(shift, locale)
			toast.message(_(t`Copied ${range}. Paste it on any day or person.`))
		},
		[_, locale],
	)

	const paste = useCallback(
		async (cell: CellRef) => {
			if (!clip || !scopeId) return
			try {
				const result = await createShifts(
					client,
					pasteBody(clip, cell, scopeId),
				)
				const flagged = result.shifts.flatMap((written) => written.conflicts)
				const first = flagged[0]
				if (first && search.conflicts) {
					const why = describeConflict(first.code, _)
					toast.warning(_(t`Pasted. Warning: ${why}`))
				} else toast.success(_(t`Pasted.`))
			} catch (error) {
				reportFailure(error)
			} finally {
				reload()
			}
		},
		[clip, client, scopeId, _, reload, reportFailure, search.conflicts],
	)

	const openAdd = useCallback(
		(cell?: CellRef) => {
			const date =
				cell?.date ??
				(week && week.dates.includes(search.date)
					? search.date
					: week && week.dates.includes(today)
						? today
						: (week?.dates[0] ?? search.date))
			setEditor({
				kind: 'create',
				cell: { rowKey: cell?.rowKey ?? OPEN_ROW, date },
			})
		},
		[search.date, today, week],
	)

	// After a reload the editor works from the newest copy of its shift, so a
	// retry after "someone else changed this" carries the current version.
	const liveEditor = useMemo<EditorMode | null>(() => {
		if (editor?.kind !== 'edit') return editor
		const fresh = week?.shifts.find((entry) => entry.id === editor.shift.id)
		return fresh ? { kind: 'edit', shift: fresh } : editor
	}, [editor, week?.shifts])

	const closeEditor = useCallback(() => setEditor(null), [])
	const onChanged = useCallback(
		(shifts: ScheduleShiftRow[]) => {
			const first = shifts[0]
			if (first && editor?.kind === 'create') setLastTimes(shiftTimes(first))
			reload()
		},
		[editor?.kind, reload],
	)

	// ---- Layout ---------------------------------------------------------------
	const selectedDate =
		week && week.dates.includes(search.date)
			? search.date
			: (week?.dates[0] ?? search.date)
	const board: BoardProps | null =
		week && grid
			? {
					week,
					scopeName: scope?.label ?? '',
					grid,
					positions,
					locale,
					rtl,
					today,
					group: search.group,
					canWrite,
					showConflicts: search.conflicts,
					showCost,
					demand,
					forecast: forecastQuery.data,
					clip,
					busyShiftId,
					onOpenShift: (shift) => setEditor({ kind: 'edit', shift }),
					onAddShift: openAdd,
					onPaste: (cell) => void paste(cell),
					onCopyShift: copyShift,
					onChangeShift: (shift, body) => void changeShift(shift, body),
					onPickDate: pickDate,
				}
			: null

	const empty = week !== null && week.shifts.length === 0 && !startBlank

	let content: React.ReactNode
	if (!scopeId) {
		content = (
			<EmptyState
				title={
					<>
						<Trans>No workplaces yet</Trans>
					</>
				}
				description={
					<>
						<Trans>
							Add a workplace in settings, then plan its shifts here.
						</Trans>
					</>
				}
				icons={['calendar', 'users', 'clock']}
			/>
		)
	} else if (unavailable) {
		content = (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>
						We could not confirm your access to the schedule. Reload the page.
					</Trans>
				</AlertDescription>
			</Alert>
		)
	} else if (view === 'month') {
		content = (
			<MonthView
				client={client}
				ready={ready}
				scopeId={scopeId}
				date={search.date}
				weekStartsOn={week?.weekStartsOn ?? 1}
				today={today}
				locale={locale}
				showCost={canLabor}
				reloadKey={monthReload}
				onPickDate={pickDate}
			/>
		)
	} else if (weekQuery.error && !week) {
		content = (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>
						We could not load this week. Check your connection and try again.
					</Trans>
				</AlertDescription>
				<div className="pt-2">
					<Button variant="outline" onClick={reloadWeek}>
						<Icon name="refresh-cw" />
						<Trans>Try again</Trans>
					</Button>
				</div>
			</Alert>
		)
	} else if (!board || weekQuery.loading) {
		content = (
			<div className="flex flex-col gap-2" aria-busy="true">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-96 w-full" />
			</div>
		)
	} else if (empty) {
		content = (
			<EmptyState
				title={
					<>
						<Trans>Nothing scheduled this week</Trans>
					</>
				}
				description={
					<>
						{canWrite ? (
							<Trans>
								Start from a week you already have, or build it shift by shift.
							</Trans>
						) : (
							<Trans>No shifts have been planned for this week.</Trans>
						)}
					</>
				}
				icons={['calendar', 'users', 'clock']}
			>
				{canWrite ? (
					<>
						<div className="flex flex-col gap-2 sm:flex-row">
							<Button onClick={() => setDialog('copy')}>
								<Icon name="copy" />
								<Trans>Copy a past week</Trans>
							</Button>
							<Button
								variant="outline"
								onClick={() => {
									setTemplatesTab('apply')
									setDialog('templates')
								}}
							>
								<Icon name="layout-grid" />
								<Trans>Use a template</Trans>
							</Button>
							<Button variant="outline" onClick={() => setDialog('recommend')}>
								<Icon name="sparkles" />
								<Trans>Recommend a schedule</Trans>
							</Button>
							<Button variant="ghost" onClick={() => setStartBlank(true)}>
								<Trans>Start blank</Trans>
							</Button>
						</div>
					</>
				) : null}
			</EmptyState>
		)
	} else if (narrow || view === 'day') {
		content = narrow ? (
			<DayList {...board} date={selectedDate} />
		) : (
			<DayTimeline {...board} date={selectedDate} />
		)
	} else {
		content = <WeekGrid {...board} />
	}

	const pending = week?.pending
	const waiting = pending
		? pending.timeOff + pending.availability + pending.shiftRequests
		: 0

	return (
		<div ref={containerRef} className="flex flex-col gap-4">
			<ScheduleToolbar
				search={search}
				onChange={update}
				today={today}
				locale={locale}
				weekStart={week?.weekStart ?? null}
				weekEnd={week?.weekEnd ?? null}
				scopes={scopes}
				conflictCount={conflicts.length}
				canWrite={canWrite && Boolean(week)}
				onAdd={() => openAdd()}
				onCopyWeek={() => setDialog('copy')}
				onTemplates={() => {
					setTemplatesTab('apply')
					setDialog('templates')
				}}
				onHistory={() => week && setDialog('history')}
				onPrint={() => window.print()}
			/>

			{waiting > 0 ? (
				<p className="text-sm print:hidden">
					<Link
						to={`/${orgSlug}/staff/schedule/time-off`}
						className="text-primary underline-offset-4 hover:underline"
					>
						{pending && pending.timeOff > 0 ? (
							<Plural
								value={pending.timeOff}
								one="# time-off request waiting"
								other="# time-off requests waiting"
							/>
						) : null}
					</Link>
					{pending &&
					pending.timeOff > 0 &&
					(pending.availability > 0 || pending.shiftRequests > 0)
						? ' · '
						: null}
					{pending && pending.availability > 0 ? (
						<Link
							to={`/${orgSlug}/staff/schedule/availability`}
							className="text-primary underline-offset-4 hover:underline"
						>
							<Plural
								value={pending.availability}
								one="# availability change waiting"
								other="# availability changes waiting"
							/>
						</Link>
					) : null}
					{pending && pending.shiftRequests > 0 ? (
						<>
							{pending.availability > 0 || pending.timeOff > 0 ? ' · ' : null}
							<Plural
								value={pending.shiftRequests}
								one="# shift request waiting"
								other="# shift requests waiting"
							/>
						</>
					) : null}
				</p>
			) : null}

			{clip ? (
				<p
					className="text-muted-foreground flex items-center gap-2 text-sm print:hidden"
					role="status"
				>
					<Icon name="copy" className="size-4" aria-hidden="true" />
					<span>
						<Trans>Copied shift ready to paste</Trans>
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="h-8"
						onClick={() => setClip(null)}
					>
						<Trans>Clear</Trans>
					</Button>
				</p>
			) : null}

			{content}

			{board && !empty && view !== 'month' && !narrow ? (
				<Collapsible className="print:hidden">
					<CollapsibleTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-muted-foreground text-xs"
							/>
						}
					>
						<Trans>Keyboard shortcuts</Trans>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="text-muted-foreground pt-2 text-xs">
							<ul className="flex list-disc flex-col gap-1 ps-5">
								<li>
									<Trans>
										Enter opens a shift. Space picks it up, the arrow keys
										choose where, Space drops it.
									</Trans>
								</li>
								<li>
									<Trans>
										Shift with the up or right arrow makes a shift end later.
										Shift with the down or left arrow, earlier. Add Alt to move
										the start.
									</Trans>
								</li>
								<li>
									<Trans>
										Ctrl or Cmd with C copies the shift. With V it pastes on the
										focused shift's day and person.
									</Trans>
								</li>
							</ul>
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : null}

			{week && canWrite && week.unpublishedCount > 0 ? (
				<div className="bg-background/95 border-border sticky bottom-0 z-30 -mx-4 flex items-center justify-between gap-3 border-t px-4 py-3 backdrop-blur-sm md:mx-0 md:rounded-lg md:border print:hidden">
					<p className="text-sm" aria-live="polite">
						<Plural
							value={week.unpublishedCount}
							one="# change not published"
							other="# changes not published"
						/>
						<span className="text-muted-foreground block text-xs">
							<Trans>Your team sees none of it until you publish.</Trans>
						</span>
					</p>
					<Button
						className="h-11 shrink-0 md:h-8"
						onClick={() => setDialog('publish')}
					>
						<Icon name="paper-plane" />
						<PublishLabel count={week.unpublishedCount} />
					</Button>
				</div>
			) : null}

			{week ? (
				<>
					<ShiftEditorSheet
						mode={liveEditor}
						week={week}
						scopeId={scopeId}
						client={client}
						locale={locale}
						narrow={narrow}
						lastTimes={lastTimes}
						onClose={closeEditor}
						onChanged={onChanged}
						onReload={reload}
						onCopy={(shift) => {
							copyShift(shift)
							setEditor(null)
						}}
						onRepeat={(shift) => {
							const times = shiftTimes(shift)
							setEditor({
								kind: 'create',
								cell: {
									rowKey: shift.staffId ?? OPEN_ROW,
									date: shift.localDate,
								},
								preset: {
									staffId: shift.staffId ?? OPEN_ROW,
									positionId: shift.positionId ?? 'none',
									...times,
									unpaidBreak: String(shift.unpaidBreakMinutes),
									notes: shift.notes ?? '',
									dates: [],
									split: false,
									startTime2: '18:00',
									endTime2: '22:00',
								},
							})
						}}
					/>
					<CopyWeekDialog
						open={dialog === 'copy'}
						onClose={() => setDialog(null)}
						client={client}
						scopeId={scopeId}
						week={week}
						locale={locale}
						onDone={(weekStart) => {
							setStartBlank(false)
							// Copying elsewhere lands on that week, so the result is on screen.
							if (weekStart !== week.weekStart) update({ date: weekStart })
							else reload()
						}}
					/>
					<TemplatesDialog
						open={dialog === 'templates'}
						onClose={() => setDialog(null)}
						client={client}
						ready={ready}
						scopeId={scopeId}
						week={week}
						locale={locale}
						canWrite={canWrite}
						initialTab={templatesTab}
						onDone={() => {
							setStartBlank(false)
							reload()
						}}
					/>
					<RecommendDialog
						open={dialog === 'recommend'}
						onClose={() => setDialog(null)}
						client={client}
						scopeId={scopeId}
						week={week}
						locale={locale}
						onDone={() => {
							setStartBlank(false)
							reload()
						}}
					/>
					<PublishDialog
						open={dialog === 'publish'}
						onClose={() => setDialog(null)}
						client={client}
						scopeId={scopeId}
						week={week}
						locale={locale}
						onDone={() => {
							reload()
							reloadDemand()
						}}
						onStale={reload}
						onHistory={() => setDialog('history')}
					/>
					<PublicationHistorySheet
						open={dialog === 'history'}
						onClose={() => setDialog(null)}
						client={client}
						ready={ready}
						scopeId={scopeId}
						week={week}
						locale={locale}
						canWrite={canWrite}
					/>
				</>
			) : null}
		</div>
	)
}

function PublishLabel({ count }: { count: number }) {
	return <Trans>Publish ({count})</Trans>
}
