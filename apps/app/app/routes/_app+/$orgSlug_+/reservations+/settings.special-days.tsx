import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { EmptyState } from '#app/components/empty-state.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { serviceDayBusinessDate } from '#app/utils/reservations/business-date.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	type BlockDto,
	type BlockReason,
	blockLocalWindow,
	createBlock,
	createSpecialDay,
	deleteBlock,
	deleteSpecialDay,
	type DiningAreaDto,
	extractApiErrorMessage,
	fetchAreas,
	fetchBlocks,
	fetchServices,
	fetchSpecialDays,
	fetchTables,
	formatMinutesLabel,
	isVersionConflictError,
	type ReflowedMoveDto,
	type ServiceDto,
	type SetupConflictDto,
	type SpecialDayDto,
	type SpecialDayKind,
	type TableDto,
	timeStringToMinutes,
	updateSpecialDay,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings.special-days.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

const SPECIAL_DAY_KIND_LABELS: Record<string, MessageDescriptor> = {
	closed: msg`Closed (all day)`,
	online_closed: msg`Online closed (walk-ins/phone open)`,
	modified: msg`Modified hours (patch service)`,
	replace: msg`Replace with custom service`,
}

const BLOCK_REASON_LABELS: Record<string, MessageDescriptor> = {
	private_event: msg`Private event`,
	maintenance: msg`Maintenance`,
	weather: msg`Weather`,
	vip_hold: msg`VIP hold`,
	staffing: msg`Staffing`,
	other: msg`Other`,
}

export default function ReservationsSettingsSpecialDaysRoute() {
	const { _ } = useLingui()
	const {
		selectedLocationId,
		selectedLocation,
		canWrite,
		client,
		refreshSummary,
		settings,
	} = useReservationsSetupContext()

	// The location's business date, not the UTC date, which is the wrong day for
	// most of the evening west of UTC.
	const locationTimeZone = settings?.timeZone ?? selectedLocation?.timezone
	const defaultDate = useMemo(
		() => serviceDayBusinessDate(Date.now(), locationTimeZone),
		[locationTimeZone],
	)

	const [specialDays, setSpecialDays] = useState<SpecialDayDto[]>([])
	const [blocks, setBlocks] = useState<BlockDto[]>([])
	const [services, setServices] = useState<ServiceDto[]>([])
	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [tables, setTables] = useState<TableDto[]>([])

	const [loading, setLoading] = useState(true)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
	const [mutationConflicts, setMutationConflicts] = useState<
		SetupConflictDto[]
	>([])
	const [mutationReflows, setMutationReflows] = useState<ReflowedMoveDto[]>([])

	const [specialDaySheetOpen, setSpecialDaySheetOpen] = useState(false)
	const [blockSheetOpen, setBlockSheetOpen] = useState(false)
	const [pendingDelete, setPendingDelete] = useState<{
		kind: 'special-day' | 'block'
		id: string
		label: string
	} | null>(null)

	// Special day form state
	// Null until the operator picks a date, so the default follows the time zone
	// once the location settings have loaded.
	const [sdStartDateEdit, setSdStartDate] = useState<string | null>(null)
	const [sdEndDateEdit, setSdEndDate] = useState<string | null>(null)
	const sdStartDate = sdStartDateEdit ?? defaultDate
	const sdEndDate = sdEndDateEdit ?? defaultDate
	const [sdKind, setSdKind] = useState<SpecialDayKind>('closed')
	const [sdName, setSdName] = useState('')
	const [sdNoteEn, setSdNoteEn] = useState('')
	const [sdNoteAr, setSdNoteAr] = useState('')
	const [sdPatchServiceId, setSdPatchServiceId] = useState('')
	const [sdPatchFirstTime, setSdPatchFirstTime] = useState('17:00')
	const [sdPatchLastTime, setSdPatchLastTime] = useState('21:00')
	const [sdPatchEndTime, setSdPatchEndTime] = useState('22:30')
	const [sdReplaceName, setSdReplaceName] = useState('Holiday Service')
	const [sdReplaceFirstTime, setSdReplaceFirstTime] = useState('12:00')
	const [sdReplaceLastTime, setSdReplaceLastTime] = useState('20:00')
	const [sdReplaceEndTime, setSdReplaceEndTime] = useState('22:00')

	// Block form state
	const [blkDateEdit, setBlkDate] = useState<string | null>(null)
	const blkDate = blkDateEdit ?? defaultDate
	const [blkTargetType, setBlkTargetType] = useState<'table' | 'area'>('table')
	const [blkTableId, setBlkTableId] = useState('')
	const [blkAreaId, setBlkAreaId] = useState('')
	const [blkStartTime, setBlkStartTime] = useState('18:00')
	const [blkEndTime, setBlkEndTime] = useState('20:00')
	const [blkReason, setBlkReason] = useState<BlockReason>('private_event')
	const [blkNote, setBlkNote] = useState('')

	const loadAll = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		try {
			const [sdRes, blkRes, svcRes, areasRes, tablesRes] = await Promise.all([
				fetchSpecialDays(client, selectedLocationId),
				fetchBlocks(client, selectedLocationId),
				fetchServices(client, selectedLocationId),
				fetchAreas(client, selectedLocationId),
				fetchTables(client, selectedLocationId),
			])
			const activeAreas = (areasRes.areas ?? []).filter(
				(a) => a.isActive && !a.archivedAt,
			)
			const activeTables = (tablesRes.tables ?? []).filter(
				(t) => t.isActive && !t.archivedAt,
			)
			const svcList = svcRes.services ?? []

			setSpecialDays(sdRes.specialDays ?? [])
			setBlocks(blkRes.blocks ?? [])
			setServices(svcList)
			setAreas(activeAreas)
			setTables(activeTables)

			if (svcList.length > 0) {
				setSdPatchServiceId((prev) =>
					prev && svcList.some((s) => s.id === prev) ? prev : svcList[0]!.id,
				)
			}
			if (activeTables.length > 0) {
				setBlkTableId((prev) =>
					prev && activeTables.some((t) => t.id === prev)
						? prev
						: activeTables[0]!.id,
				)
			}
			if (activeAreas.length > 0) {
				setBlkAreaId((prev) =>
					prev && activeAreas.some((a) => a.id === prev)
						? prev
						: activeAreas[0]!.id,
				)
			}
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to load special days and table blocks.`),
				),
			)
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadAll()
	}, [loadAll])

	const recordMutationSideEffects = (res?: {
		conflicts?: SetupConflictDto[]
		reflowedMoves?: ReflowedMoveDto[]
	}) => {
		if (res?.conflicts) setMutationConflicts(res.conflicts)
		if (res?.reflowedMoves) setMutationReflows(res.reflowedMoves)
	}

	const handleCreateSpecialDay = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setConflictBanner(null)
		setFeedbackMessage(null)

		if (sdStartDate > sdEndDate) {
			setErrorMessage(_(msg`Start date cannot be after end date.`))
			return
		}

		let serviceId: string | null = null
		let patch: SpecialDayDto['patch'] = null
		let replacementServices: SpecialDayDto['services'] = null

		if (sdKind === 'modified') {
			const targetSvcId = sdPatchServiceId || services[0]?.id || null
			const firstMin = timeStringToMinutes(sdPatchFirstTime, { nextDay: false })
			const lastMin = timeStringToMinutes(sdPatchLastTime, { nextDay: false })
			const endMin = timeStringToMinutes(sdPatchEndTime, { nextDay: false })
			if (!targetSvcId || firstMin > lastMin || lastMin > endMin) {
				setErrorMessage(
					_(msg`Select a service and valid hours for modified schedule.`),
				)
				return
			}
			serviceId = targetSvcId
			patch = {
				firstSeatingMin: firstMin,
				lastSeatingMin: lastMin,
				endMin,
				onlineBookable: true,
			}
		} else if (sdKind === 'replace') {
			const firstMin = timeStringToMinutes(sdReplaceFirstTime, {
				nextDay: false,
			})
			const lastMin = timeStringToMinutes(sdReplaceLastTime, { nextDay: false })
			const endMin = timeStringToMinutes(sdReplaceEndTime, { nextDay: false })
			if (!sdReplaceName.trim() || firstMin > lastMin || lastMin > endMin) {
				setErrorMessage(
					_(msg`Enter replacement service name and valid seating times.`),
				)
				return
			}
			replacementServices = [
				{
					name: sdReplaceName.trim(),
					nameI18n: { en: sdReplaceName.trim() },
					firstSeatingMin: firstMin,
					lastSeatingMin: lastMin,
					endMin,
					slotIntervalMin: 15,
					onlineBookable: true,
				},
			]
		}

		try {
			const res = await createSpecialDay(client, selectedLocationId, {
				fromDate: sdStartDate,
				toDate: sdEndDate,
				kind: sdKind,
				name: sdName.trim() || null,
				publicNoteI18n: {
					...(sdNoteEn.trim() ? { en: sdNoteEn.trim() } : {}),
					...(sdNoteAr.trim() ? { ar: sdNoteAr.trim() } : {}),
				},
				serviceId,
				patch,
				services: replacementServices,
			})
			recordMutationSideEffects(res)
			setSdName('')
			setSdNoteEn('')
			setSdNoteAr('')
			setSpecialDaySheetOpen(false)
			setFeedbackMessage(_(msg`Special day schedule saved.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create special day.`)),
			)
		}
	}

	const handleToggleSpecialDayKind = async (
		sd: SpecialDayDto,
		nextKind: SpecialDayKind,
	) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await updateSpecialDay(client, selectedLocationId, sd.id, {
				expectedVersion: sd.version,
				kind: nextKind,
				services:
					nextKind === 'closed' || nextKind === 'online_closed'
						? null
						: sd.services,
			})
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Special day updated.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`This special day was updated by another operator. Reloading latest data.`,
					),
				)
				await loadAll()
			} else {
				setErrorMessage(
					extractApiErrorMessage(err, _(msg`Failed to update special day.`)),
				)
			}
		}
	}

	const handleDeleteSpecialDay = async (specialDayId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await deleteSpecialDay(
				client,
				selectedLocationId,
				specialDayId,
			)
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Special day deleted.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete special day.`)),
			)
		}
	}

	const handleCreateBlock = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setFeedbackMessage(null)

		const startMin = timeStringToMinutes(blkStartTime, { nextDay: false })
		const endMin = timeStringToMinutes(blkEndTime, { nextDay: false })
		if (startMin >= endMin) {
			setErrorMessage(_(msg`Block start time must be earlier than end time.`))
			return
		}

		const targetTableId =
			blkTargetType === 'table' ? blkTableId || tables[0]?.id || null : null
		const targetAreaId =
			blkTargetType === 'area' ? blkAreaId || areas[0]?.id || null : null

		if (!targetTableId && !targetAreaId) {
			setErrorMessage(_(msg`Select a table or dining area to block.`))
			return
		}

		try {
			const res = await createBlock(client, selectedLocationId, {
				businessDate: blkDate,
				startMin,
				endMin,
				tableId: targetTableId,
				areaId: targetAreaId,
				reason: blkReason,
				note: blkNote.trim() || null,
			})
			recordMutationSideEffects(res)
			setBlkNote('')
			setBlockSheetOpen(false)
			setFeedbackMessage(_(msg`Table/area block created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create block.`)),
			)
		}
	}

	const handleDeleteBlock = async (blockId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			const res = await deleteBlock(client, selectedLocationId, blockId)
			recordMutationSideEffects(res)
			setFeedbackMessage(_(msg`Block removed.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to remove block.`)),
			)
		}
	}

	const kindOptions = (
		['closed', 'online_closed', 'modified', 'replace'] as const
	).map((value) => ({
		value,
		label: _(SPECIAL_DAY_KIND_LABELS[value]!),
	}))
	const reasonOptions = (
		[
			'private_event',
			'maintenance',
			'weather',
			'vip_hold',
			'staffing',
			'other',
		] as const
	).map((value) => ({ value, label: _(BLOCK_REASON_LABELS[value]!) }))
	const scopeOptions = [
		{ value: 'table', label: _(msg`Table`) },
		{ value: 'area', label: _(msg`Dining area`) },
	]
	const serviceOptions = services.map((s) => ({ value: s.id, label: s.name }))
	const tableOptions = tables.map((t) => ({ value: t.id, label: t.label }))
	const areaOptions = areas.map((a) => ({ value: a.id, label: a.name }))
	const sheetOpen = specialDaySheetOpen || blockSheetOpen

	const confirmDelete = () => {
		const target = pendingDelete
		setPendingDelete(null)
		if (!target) return
		void (target.kind === 'special-day'
			? handleDeleteSpecialDay(target.id)
			: handleDeleteBlock(target.id))
	}

	return (
		<div className="flex flex-col gap-6" data-testid="setup-special-days-page">
			{conflictBanner ? (
				<Alert data-testid="setup-special-days-conflict-banner">
					<Icon name="alert-triangle" aria-hidden />
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span>{conflictBanner}</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setConflictBanner(null)
									void loadAll()
								}}
							>
								<Trans>Reload</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{errorMessage && !sheetOpen ? (
				<Alert
					variant="destructive"
					data-testid="setup-special-days-error-banner"
				>
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			) : null}

			{feedbackMessage ? (
				<div
					role="status"
					className="bg-success/10 text-success flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
					data-testid="setup-special-days-feedback-banner"
				>
					<Icon name="check-circle" className="size-4 shrink-0" aria-hidden />
					{feedbackMessage}
				</div>
			) : null}

			{mutationReflows.length > 0 || mutationConflicts.length > 0 ? (
				<div
					className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm"
					data-testid="setup-special-days-reflow-banner"
				>
					{mutationReflows.length > 0 ? (
						<span className="text-success">
							<Trans>
								Reassigned upcoming reservations after schedule/block changes
							</Trans>{' '}
							({mutationReflows.length})
						</span>
					) : null}
					{mutationConflicts.length > 0 ? (
						<span className="text-warning">
							<Trans>
								Upcoming reservations flagged with conflicts (outside hours or
								blocked table)
							</Trans>{' '}
							({mutationConflicts.length})
						</span>
					) : null}
				</div>
			) : null}

			{!canWrite ? (
				<Alert>
					<Icon name="lock" aria-hidden />
					<AlertDescription>
						<Trans>
							You can view special days and blocks but not change them.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			<Frame data-testid="setup-special-days-card">
				<FrameHeader>
					<FrameTitle>
						<Trans>Special days and holiday schedules</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Close, shorten or replace your regular services on holidays,
							Ramadan, private buyouts or seasonal dates.
						</Trans>
					</FrameDescription>
					{canWrite ? (
						<FrameAction>
							<Button
								type="button"
								onClick={() => setSpecialDaySheetOpen(true)}
								data-testid="setup-open-special-day-sheet"
							>
								<Icon name="plus" className="size-4" aria-hidden />
								<Trans>Add special day</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>
				{loading ? (
					<div className="flex flex-col gap-2 p-4" role="status">
						<span className="sr-only">
							<Trans>Loading special days…</Trans>
						</span>
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : specialDays.length === 0 ? (
					<div className="p-4" data-testid="setup-special-days-empty">
						<EmptyState
							icons={['calendar', 'clock', 'sparkles']}
							title={<Trans>No special days yet</Trans>}
							description={
								<Trans>
									Your regular services apply every day until you add an
									exception.
								</Trans>
							}
						>
							{canWrite ? (
								<Button
									type="button"
									variant="outline"
									onClick={() => setSpecialDaySheetOpen(true)}
								>
									<Icon name="plus" className="size-4" aria-hidden />
									<Trans>Add special day</Trans>
								</Button>
							) : null}
						</EmptyState>
					</div>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Dates</Trans>
								</TableHead>
								<TableHead>
									<Trans>Name</Trans>
								</TableHead>
								<TableHead>
									<Trans>Mode</Trans>
								</TableHead>
								<TableHead>
									<Trans>Public note</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{specialDays.map((sd) => {
								const startStr = sd.fromDate || sd.date
								const endStr = sd.toDate || sd.date
								const rowLabel = sd.name || sd.reason || startStr
								return (
									<TableRow
										key={sd.id}
										data-testid={`setup-special-day-row-${startStr}`}
									>
										<TableCell className="tabular-nums">
											{startStr === endStr
												? startStr
												: `${startStr} → ${endStr}`}
										</TableCell>
										<TableCell className="font-medium wrap-anywhere">
											{sd.name || sd.reason || '—'}
										</TableCell>
										<TableCell>
											<Badge
												variant={
													sd.kind === 'closed' ? 'destructive' : 'outline'
												}
											>
												{SPECIAL_DAY_KIND_LABELS[sd.kind]
													? _(SPECIAL_DAY_KIND_LABELS[sd.kind]!)
													: sd.kind}
											</Badge>
										</TableCell>
										<TableCell className="text-muted-foreground max-w-56 truncate text-sm">
											{sd.publicNoteI18n?.en || sd.publicNoteI18n?.ar || '—'}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<div className="flex items-center justify-end gap-1">
													{sd.kind !== 'closed' ? (
														<Button
															type="button"
															variant="ghost"
															size="sm"
															onClick={() =>
																void handleToggleSpecialDayKind(sd, 'closed')
															}
															data-testid={`setup-special-day-close-${startStr}`}
														>
															<Trans>Mark closed</Trans>
														</Button>
													) : (
														<Button
															type="button"
															variant="ghost"
															size="sm"
															onClick={() =>
																void handleToggleSpecialDayKind(
																	sd,
																	'online_closed',
																)
															}
															data-testid={`setup-special-day-online-close-${startStr}`}
														>
															<Trans>Online closed</Trans>
														</Button>
													)}
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="text-destructive"
														onClick={() =>
															setPendingDelete({
																kind: 'special-day',
																id: sd.id,
																label: rowLabel,
															})
														}
														data-testid={`setup-delete-special-day-${startStr}`}
													>
														<Trans>Delete</Trans>
													</Button>
												</div>
											) : null}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</Frame>

			<Frame data-testid="setup-blocks-card">
				<FrameHeader>
					<FrameTitle>
						<Trans>Table and area blocks</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Hold a table or a whole dining area for a time window, for example
							for maintenance, a private event or weather.
						</Trans>
					</FrameDescription>
					{canWrite ? (
						<FrameAction>
							<Button
								type="button"
								variant="outline"
								onClick={() => setBlockSheetOpen(true)}
								data-testid="setup-open-block-sheet"
							>
								<Icon name="plus" className="size-4" aria-hidden />
								<Trans>Add block</Trans>
							</Button>
						</FrameAction>
					) : null}
				</FrameHeader>
				{loading ? (
					<div className="flex flex-col gap-2 p-4">
						<Skeleton className="h-10 w-full" />
					</div>
				) : blocks.length === 0 ? (
					<div className="p-4" data-testid="setup-blocks-empty">
						<EmptyState
							icons={['clock', 'lock', 'calendar']}
							title={<Trans>No blocks</Trans>}
							description={
								<Trans>
									All tables and areas are open for booking in their regular
									hours.
								</Trans>
							}
						/>
					</div>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Date</Trans>
								</TableHead>
								<TableHead>
									<Trans>Target</Trans>
								</TableHead>
								<TableHead>
									<Trans>Window</Trans>
								</TableHead>
								<TableHead>
									<Trans>Reason</Trans>
								</TableHead>
								<TableHead>
									<Trans>Note</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{blocks.map((blk) => {
								const targetLabel = blk.tableId
									? `${_(msg`Table`)} ${tables.find((t) => t.id === blk.tableId)?.label ?? blk.tableId}`
									: `${_(msg`Area`)} ${areas.find((a) => a.id === blk.areaId)?.name ?? blk.areaId}`
								const { startMin: startMinVal, endMin: endMinVal } =
									blockLocalWindow(blk, settings?.timeZone)
								return (
									<TableRow
										key={blk.id}
										data-testid={`setup-block-row-${blk.businessDate}`}
									>
										<TableCell className="tabular-nums">
											{blk.businessDate}
										</TableCell>
										<TableCell className="font-medium wrap-anywhere">
											{targetLabel}
										</TableCell>
										<TableCell className="tabular-nums">
											{formatMinutesLabel(startMinVal)} –{' '}
											{formatMinutesLabel(endMinVal)}
										</TableCell>
										<TableCell>
											<Badge variant="outline">
												{BLOCK_REASON_LABELS[blk.reason]
													? _(BLOCK_REASON_LABELS[blk.reason]!)
													: blk.reason}
											</Badge>
										</TableCell>
										<TableCell className="text-muted-foreground max-w-56 truncate text-sm">
											{blk.note || '—'}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													className="text-destructive"
													onClick={() =>
														setPendingDelete({
															kind: 'block',
															id: blk.id,
															label: targetLabel,
														})
													}
													data-testid={`setup-delete-block-${blk.id}`}
												>
													<Trans>Remove</Trans>
												</Button>
											) : null}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</Frame>

			<Sheet
				open={specialDaySheetOpen}
				onOpenChange={(open) => {
					setSpecialDaySheetOpen(open)
					if (!open) setErrorMessage(null)
				}}
			>
				<SheetContent
					className="sm:max-w-lg"
					data-testid="setup-special-day-sheet"
				>
					<SheetForm
						title={<Trans>Add special day</Trans>}
						description={
							<Trans>
								Pick the dates and what changes. Guests see the public note when
								they try to book.
							</Trans>
						}
						onSubmit={(e) => void handleCreateSpecialDay(e)}
						footer={
							<>
								<Button
									type="button"
									variant="ghost"
									onClick={() => setSpecialDaySheetOpen(false)}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									type="submit"
									data-testid="setup-add-special-day-button"
								>
									<Trans>Add special day</Trans>
								</Button>
							</>
						}
					>
						<div
							className="flex flex-col gap-5"
							data-testid="setup-create-special-day-form"
						>
							{errorMessage ? (
								<Alert
									variant="destructive"
									data-testid="setup-special-days-sheet-error"
								>
									<AlertDescription>{errorMessage}</AlertDescription>
								</Alert>
							) : null}
							<div className="grid grid-cols-2 gap-3">
								<TextField
									id="sd-start-date"
									label={<Trans>Start date</Trans>}
									type="date"
									value={sdStartDate}
									onChange={(e) => {
										setSdStartDate(e.target.value)
										if (sdEndDate < e.target.value) {
											setSdEndDate(e.target.value)
										}
									}}
									data-testid="setup-special-day-start-date"
								/>
								<TextField
									id="sd-end-date"
									label={<Trans>End date</Trans>}
									type="date"
									value={sdEndDate}
									onChange={(e) => setSdEndDate(e.target.value)}
									data-testid="setup-special-day-end-date"
								/>
							</div>
							<TextField
								id="sd-name"
								label={<Trans>Occasion name</Trans>}
								optional
								placeholder={_(msg`e.g. National Day / Ramadan`)}
								value={sdName}
								onChange={(e) => setSdName(e.target.value)}
								data-testid="setup-special-day-name-input"
							/>
							<SelectField
								id="sd-mode"
								label={<Trans>What happens on these days</Trans>}
								options={kindOptions}
								value={sdKind}
								onValueChange={(value) => setSdKind(value as SpecialDayKind)}
							/>

							{sdKind === 'modified' ? (
								<div className="flex flex-col gap-4 rounded-lg border p-3">
									<SelectField
										id="sd-patch-svc"
										label={<Trans>Service to modify</Trans>}
										options={serviceOptions}
										value={sdPatchServiceId || services[0]?.id || ''}
										onValueChange={setSdPatchServiceId}
									/>
									<div className="grid grid-cols-3 gap-3">
										<TextField
											id="sd-patch-first"
											label={<Trans>First seating</Trans>}
											type="time"
											value={sdPatchFirstTime}
											onChange={(e) => setSdPatchFirstTime(e.target.value)}
											data-testid="setup-special-day-patch-first"
										/>
										<TextField
											id="sd-patch-last"
											label={<Trans>Last seating</Trans>}
											type="time"
											value={sdPatchLastTime}
											onChange={(e) => setSdPatchLastTime(e.target.value)}
											data-testid="setup-special-day-patch-last"
										/>
										<TextField
											id="sd-patch-end"
											label={<Trans>Service end</Trans>}
											type="time"
											value={sdPatchEndTime}
											onChange={(e) => setSdPatchEndTime(e.target.value)}
											data-testid="setup-special-day-patch-end"
										/>
									</div>
								</div>
							) : null}

							{sdKind === 'replace' ? (
								<div className="flex flex-col gap-4 rounded-lg border p-3">
									<TextField
										id="sd-replace-name"
										label={<Trans>Replacement service name</Trans>}
										value={sdReplaceName}
										onChange={(e) => setSdReplaceName(e.target.value)}
										data-testid="setup-special-day-replace-name"
									/>
									<div className="grid grid-cols-3 gap-3">
										<TextField
											id="sd-replace-first"
											label={<Trans>First seating</Trans>}
											type="time"
											value={sdReplaceFirstTime}
											onChange={(e) => setSdReplaceFirstTime(e.target.value)}
											data-testid="setup-special-day-replace-first"
										/>
										<TextField
											id="sd-replace-last"
											label={<Trans>Last seating</Trans>}
											type="time"
											value={sdReplaceLastTime}
											onChange={(e) => setSdReplaceLastTime(e.target.value)}
											data-testid="setup-special-day-replace-last"
										/>
										<TextField
											id="sd-replace-end"
											label={<Trans>Service end</Trans>}
											type="time"
											value={sdReplaceEndTime}
											onChange={(e) => setSdReplaceEndTime(e.target.value)}
											data-testid="setup-special-day-replace-end"
										/>
									</div>
								</div>
							) : null}

							<TextField
								id="sd-note-en"
								label={<Trans>Public guest note (English)</Trans>}
								optional
								placeholder={_(msg`Closed for private event`)}
								value={sdNoteEn}
								onChange={(e) => setSdNoteEn(e.target.value)}
								data-testid="setup-special-day-note-en"
							/>
							<TextField
								id="sd-note-ar"
								label={<Trans>Public guest note (Arabic)</Trans>}
								optional
								dir="rtl"
								placeholder={_(msg`Arabic public note`)}
								value={sdNoteAr}
								onChange={(e) => setSdNoteAr(e.target.value)}
								data-testid="setup-special-day-note-ar"
							/>
						</div>
					</SheetForm>
				</SheetContent>
			</Sheet>

			<Sheet
				open={blockSheetOpen}
				onOpenChange={(open) => {
					setBlockSheetOpen(open)
					if (!open) setErrorMessage(null)
				}}
			>
				<SheetContent className="sm:max-w-lg" data-testid="setup-block-sheet">
					<SheetForm
						title={<Trans>Add block</Trans>}
						description={
							<Trans>
								The table or area cannot be booked during this window.
							</Trans>
						}
						onSubmit={(e) => void handleCreateBlock(e)}
						footer={
							<>
								<Button
									type="button"
									variant="ghost"
									onClick={() => setBlockSheetOpen(false)}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button type="submit" data-testid="setup-add-block-button">
									<Trans>Add block</Trans>
								</Button>
							</>
						}
					>
						<div
							className="flex flex-col gap-5"
							data-testid="setup-create-block-form"
						>
							{errorMessage ? (
								<Alert
									variant="destructive"
									data-testid="setup-blocks-sheet-error"
								>
									<AlertDescription>{errorMessage}</AlertDescription>
								</Alert>
							) : null}
							<TextField
								id="blk-date"
								label={<Trans>Business date</Trans>}
								type="date"
								value={blkDate}
								onChange={(e) => setBlkDate(e.target.value)}
								data-testid="setup-block-date-input"
							/>
							<div className="grid grid-cols-2 gap-3">
								<SelectField
									id="blk-target-type"
									label={<Trans>Block a</Trans>}
									options={scopeOptions}
									value={blkTargetType}
									onValueChange={(value) =>
										setBlkTargetType(value as 'table' | 'area')
									}
								/>
								{blkTargetType === 'table' ? (
									<SelectField
										id="blk-target-id"
										label={<Trans>Table</Trans>}
										options={tableOptions}
										value={blkTableId || tables[0]?.id || ''}
										onValueChange={setBlkTableId}
									/>
								) : (
									<SelectField
										id="blk-target-id"
										label={<Trans>Dining area</Trans>}
										options={areaOptions}
										value={blkAreaId || areas[0]?.id || ''}
										onValueChange={setBlkAreaId}
									/>
								)}
							</div>
							<div className="grid grid-cols-2 gap-3">
								<TextField
									id="blk-start"
									label={<Trans>Start time</Trans>}
									type="time"
									value={blkStartTime}
									onChange={(e) => setBlkStartTime(e.target.value)}
									data-testid="setup-block-start-time"
								/>
								<TextField
									id="blk-end"
									label={<Trans>End time</Trans>}
									type="time"
									value={blkEndTime}
									onChange={(e) => setBlkEndTime(e.target.value)}
									data-testid="setup-block-end-time"
								/>
							</div>
							<SelectField
								id="blk-reason"
								label={<Trans>Reason</Trans>}
								options={reasonOptions}
								value={blkReason}
								onValueChange={(value) => setBlkReason(value as BlockReason)}
							/>
							<TextField
								id="blk-note"
								label={<Trans>Note</Trans>}
								optional
								placeholder={_(msg`VIP / repair`)}
								value={blkNote}
								onChange={(e) => setBlkNote(e.target.value)}
								data-testid="setup-block-note-input"
							/>
						</div>
					</SheetForm>
				</SheetContent>
			</Sheet>

			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pendingDelete?.kind === 'block' ? (
								<Trans>Remove this block?</Trans>
							) : (
								<Trans>Delete this special day?</Trans>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingDelete?.kind === 'block' ? (
								<Trans>
									The table or area can be booked again in that window.
								</Trans>
							) : (
								<Trans>Your regular services apply again on those dates.</Trans>
							)}
							<span className="mt-2 block font-medium wrap-anywhere">
								{pendingDelete?.label}
							</span>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							onClick={confirmDelete}
							data-testid="setup-special-days-confirm-delete"
						>
							{pendingDelete?.kind === 'block' ? (
								<Trans>Remove</Trans>
							) : (
								<Trans>Delete</Trans>
							)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
