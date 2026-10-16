import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	type BlockDto,
	type BlockReason,
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

function getDefaultDateString(): string {
	return new Date().toISOString().slice(0, 10)
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
	const { selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()

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

	// Special day form state
	const [sdStartDate, setSdStartDate] = useState(getDefaultDateString)
	const [sdEndDate, setSdEndDate] = useState(getDefaultDateString)
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
	const [blkDate, setBlkDate] = useState(getDefaultDateString)
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

	return (
		<div className="flex flex-col gap-6" data-testid="setup-special-days-page">
			{conflictBanner ? (
				<div
					role="alert"
					className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="setup-special-days-conflict-banner"
				>
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
			) : null}

			{errorMessage ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="setup-special-days-error-banner"
				>
					{errorMessage}
				</div>
			) : null}

			{feedbackMessage ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="setup-special-days-feedback-banner"
				>
					{feedbackMessage}
				</div>
			) : null}

			{mutationReflows.length > 0 || mutationConflicts.length > 0 ? (
				<div
					className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs"
					data-testid="setup-special-days-reflow-banner"
				>
					{mutationReflows.length > 0 ? (
						<span className="text-emerald-700 dark:text-emerald-300">
							<Trans>
								Reassigned upcoming reservations after schedule/block changes
							</Trans>{' '}
							({mutationReflows.length})
						</span>
					) : null}
					{mutationConflicts.length > 0 ? (
						<span className="text-amber-700 dark:text-amber-300">
							<Trans>
								Upcoming reservations flagged with conflicts (outside hours or
								blocked table)
							</Trans>{' '}
							({mutationConflicts.length})
						</span>
					) : null}
				</div>
			) : null}

			{/* Special Days Card */}
			<Card data-testid="setup-special-days-card">
				<CardHeader>
					<CardTitle>
						<Trans>Special Days & Holiday Schedules</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Override recurring services for holidays, Ramadan, private
							buyouts, or seasonal schedules (`closed`, `online_closed`,
							`modified`, or `replace`).
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateSpecialDay(e)}
							className="border-border bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
							data-testid="setup-create-special-day-form"
						>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-start-date">
										<Trans>Start date</Trans>
									</Label>
									<Input
										id="sd-start-date"
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
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-end-date">
										<Trans>End date</Trans>
									</Label>
									<Input
										id="sd-end-date"
										type="date"
										value={sdEndDate}
										onChange={(e) => setSdEndDate(e.target.value)}
										data-testid="setup-special-day-end-date"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-mode">
										<Trans>Schedule mode</Trans>
									</Label>
									<select
										id="sd-mode"
										value={sdKind}
										onChange={(e) =>
											setSdKind(e.target.value as SpecialDayKind)
										}
										className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
										data-testid="setup-special-day-mode-select"
									>
										<option value="closed">{_(msg`Closed (all day)`)}</option>
										<option value="online_closed">
											{_(msg`Online closed (walk-ins/phone open)`)}
										</option>
										<option value="modified">
											{_(msg`Modified hours (patch service)`)}
										</option>
										<option value="replace">
											{_(msg`Replace with custom service`)}
										</option>
									</select>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-name">
										<Trans>Occasion name</Trans>
									</Label>
									<Input
										id="sd-name"
										placeholder={_(msg`e.g. National Day / Ramadan`)}
										value={sdName}
										onChange={(e) => setSdName(e.target.value)}
										data-testid="setup-special-day-name-input"
									/>
								</div>
							</div>

							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-note-en">
										<Trans>Public guest note (EN)</Trans>
									</Label>
									<Input
										id="sd-note-en"
										placeholder={_(msg`Closed for private event`)}
										value={sdNoteEn}
										onChange={(e) => setSdNoteEn(e.target.value)}
										data-testid="setup-special-day-note-en"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="sd-note-ar">
										<Trans>Public guest note (AR)</Trans>
									</Label>
									<Input
										id="sd-note-ar"
										dir="rtl"
										placeholder={_(msg`Arabic public note`)}
										value={sdNoteAr}
										onChange={(e) => setSdNoteAr(e.target.value)}
										data-testid="setup-special-day-note-ar"
									/>
								</div>
							</div>

							{sdKind === 'modified' ? (
								<div className="border-border bg-background grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-4">
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-patch-svc">
											<Trans>Service to modify</Trans>
										</Label>
										<select
											id="sd-patch-svc"
											value={sdPatchServiceId || services[0]?.id || ''}
											onChange={(e) => setSdPatchServiceId(e.target.value)}
											className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
											data-testid="setup-special-day-patch-service"
										>
											{services.map((s) => (
												<option key={s.id} value={s.id}>
													{s.name}
												</option>
											))}
										</select>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-patch-first">
											<Trans>First seating</Trans>
										</Label>
										<Input
											id="sd-patch-first"
											type="time"
											value={sdPatchFirstTime}
											onChange={(e) => setSdPatchFirstTime(e.target.value)}
											data-testid="setup-special-day-patch-first"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-patch-last">
											<Trans>Last seating</Trans>
										</Label>
										<Input
											id="sd-patch-last"
											type="time"
											value={sdPatchLastTime}
											onChange={(e) => setSdPatchLastTime(e.target.value)}
											data-testid="setup-special-day-patch-last"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-patch-end">
											<Trans>Service end</Trans>
										</Label>
										<Input
											id="sd-patch-end"
											type="time"
											value={sdPatchEndTime}
											onChange={(e) => setSdPatchEndTime(e.target.value)}
											data-testid="setup-special-day-patch-end"
										/>
									</div>
								</div>
							) : null}

							{sdKind === 'replace' ? (
								<div className="border-border bg-background grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-4">
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-replace-name">
											<Trans>Replacement service name</Trans>
										</Label>
										<Input
											id="sd-replace-name"
											value={sdReplaceName}
											onChange={(e) => setSdReplaceName(e.target.value)}
											data-testid="setup-special-day-replace-name"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-replace-first">
											<Trans>First seating</Trans>
										</Label>
										<Input
											id="sd-replace-first"
											type="time"
											value={sdReplaceFirstTime}
											onChange={(e) => setSdReplaceFirstTime(e.target.value)}
											data-testid="setup-special-day-replace-first"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-replace-last">
											<Trans>Last seating</Trans>
										</Label>
										<Input
											id="sd-replace-last"
											type="time"
											value={sdReplaceLastTime}
											onChange={(e) => setSdReplaceLastTime(e.target.value)}
											data-testid="setup-special-day-replace-last"
										/>
									</div>
									<div className="flex flex-col gap-1">
										<Label htmlFor="sd-replace-end">
											<Trans>Service end</Trans>
										</Label>
										<Input
											id="sd-replace-end"
											type="time"
											value={sdReplaceEndTime}
											onChange={(e) => setSdReplaceEndTime(e.target.value)}
											data-testid="setup-special-day-replace-end"
										/>
									</div>
								</div>
							) : null}

							<div className="flex justify-end">
								<Button
									type="submit"
									size="sm"
									data-testid="setup-add-special-day-button"
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add special day</Trans>
								</Button>
							</div>
						</form>
					) : null}

					{loading ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Loading special days…</Trans>
						</p>
					) : specialDays.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-special-days-empty"
						>
							<Trans>No special days configured.</Trans>
						</p>
					) : (
						<Table>
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
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{specialDays.map((sd) => {
									const startStr = sd.fromDate || sd.date
									const endStr = sd.toDate || sd.date
									return (
										<TableRow
											key={sd.id}
											data-testid={`setup-special-day-row-${startStr}`}
										>
											<TableCell className="font-mono text-xs">
												{startStr === endStr
													? startStr
													: `${startStr} → ${endStr}`}
											</TableCell>
											<TableCell className="font-medium">
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
											<TableCell className="text-muted-foreground text-xs">
												{sd.publicNoteI18n?.en || sd.publicNoteI18n?.ar || '—'}
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<div className="flex items-center justify-end gap-1">
														{sd.kind !== 'closed' ? (
															<Button
																type="button"
																variant="outline"
																size="sm"
																onClick={() =>
																	void handleToggleSpecialDayKind(sd, 'closed')
																}
																data-testid={`setup-special-day-close-${startStr}`}
															>
																<Trans>Mark Closed</Trans>
															</Button>
														) : (
															<Button
																type="button"
																variant="outline"
																size="sm"
																onClick={() =>
																	void handleToggleSpecialDayKind(
																		sd,
																		'online_closed',
																	)
																}
																data-testid={`setup-special-day-online-close-${startStr}`}
															>
																<Trans>Online Closed</Trans>
															</Button>
														)}
														<Button
															type="button"
															variant="destructive"
															size="sm"
															onClick={() => void handleDeleteSpecialDay(sd.id)}
															data-testid={`setup-delete-special-day-${startStr}`}
														>
															<Trans>Delete</Trans>
														</Button>
													</div>
												) : (
													<span className="text-muted-foreground text-xs">
														<Trans>Read-only</Trans>
													</span>
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			{/* Table & Area Blocks Card */}
			<Card data-testid="setup-blocks-card">
				<CardHeader>
					<CardTitle>
						<Trans>Table & Area Blocks</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Place temporary holds on a specific table or entire dining area
							for maintenance, private events, weather, or staff holds.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateBlock(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-7"
							data-testid="setup-create-block-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-date">
									<Trans>Business date</Trans>
								</Label>
								<Input
									id="blk-date"
									type="date"
									value={blkDate}
									onChange={(e) => setBlkDate(e.target.value)}
									data-testid="setup-block-date-input"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-target-type">
									<Trans>Scope</Trans>
								</Label>
								<select
									id="blk-target-type"
									value={blkTargetType}
									onChange={(e) =>
										setBlkTargetType(e.target.value as 'table' | 'area')
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-block-target-type-select"
								>
									<option value="table">{_(msg`Table`)}</option>
									<option value="area">{_(msg`Dining area`)}</option>
								</select>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-target-id">
									<Trans>Target</Trans>
								</Label>
								{blkTargetType === 'table' ? (
									<select
										id="blk-target-id"
										value={blkTableId || tables[0]?.id || ''}
										onChange={(e) => setBlkTableId(e.target.value)}
										className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
										data-testid="setup-block-table-select"
									>
										{tables.map((t) => (
											<option key={t.id} value={t.id}>
												{t.label}
											</option>
										))}
									</select>
								) : (
									<select
										id="blk-target-id"
										value={blkAreaId || areas[0]?.id || ''}
										onChange={(e) => setBlkAreaId(e.target.value)}
										className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
										data-testid="setup-block-area-select"
									>
										{areas.map((a) => (
											<option key={a.id} value={a.id}>
												{a.name}
											</option>
										))}
									</select>
								)}
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-start">
									<Trans>Start time</Trans>
								</Label>
								<Input
									id="blk-start"
									type="time"
									value={blkStartTime}
									onChange={(e) => setBlkStartTime(e.target.value)}
									data-testid="setup-block-start-time"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-end">
									<Trans>End time</Trans>
								</Label>
								<Input
									id="blk-end"
									type="time"
									value={blkEndTime}
									onChange={(e) => setBlkEndTime(e.target.value)}
									data-testid="setup-block-end-time"
								/>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-reason">
									<Trans>Reason</Trans>
								</Label>
								<select
									id="blk-reason"
									value={blkReason}
									onChange={(e) => setBlkReason(e.target.value as BlockReason)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-block-reason-select"
								>
									<option value="private_event">{_(msg`Private event`)}</option>
									<option value="maintenance">{_(msg`Maintenance`)}</option>
									<option value="weather">{_(msg`Weather`)}</option>
									<option value="vip_hold">{_(msg`VIP hold`)}</option>
									<option value="staffing">{_(msg`Staffing`)}</option>
									<option value="other">{_(msg`Other`)}</option>
								</select>
							</div>

							<div className="flex flex-col gap-1">
								<Label htmlFor="blk-note">
									<Trans>Note</Trans>
								</Label>
								<div className="flex items-center gap-2">
									<Input
										id="blk-note"
										placeholder={_(msg`VIP / repair`)}
										value={blkNote}
										onChange={(e) => setBlkNote(e.target.value)}
										data-testid="setup-block-note-input"
									/>
									<Button
										type="submit"
										size="sm"
										data-testid="setup-add-block-button"
									>
										<Icon name="plus" className="size-4" />
										<Trans>Block</Trans>
									</Button>
								</div>
							</div>
						</form>
					) : null}

					{blocks.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-blocks-empty"
						>
							<Trans>No active table or area blocks.</Trans>
						</p>
					) : (
						<Table>
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
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{blocks.map((blk) => {
									const targetLabel = blk.tableId
										? `${_(msg`Table`)} ${tables.find((t) => t.id === blk.tableId)?.label ?? blk.tableId}`
										: `${_(msg`Area`)} ${areas.find((a) => a.id === blk.areaId)?.name ?? blk.areaId}`
									const startMinVal = blk.startMin ?? 0
									const endMinVal = blk.endMin ?? 0
									return (
										<TableRow
											key={blk.id}
											data-testid={`setup-block-row-${blk.businessDate}`}
										>
											<TableCell className="font-mono text-xs">
												{blk.businessDate}
											</TableCell>
											<TableCell className="font-medium">
												{targetLabel}
											</TableCell>
											<TableCell className="font-mono text-xs">
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
											<TableCell className="text-muted-foreground text-xs">
												{blk.note || '—'}
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => void handleDeleteBlock(blk.id)}
														data-testid={`setup-delete-block-${blk.id}`}
													>
														<Trans>Remove</Trans>
													</Button>
												) : (
													<span className="text-muted-foreground text-xs">
														<Trans>Read-only</Trans>
													</span>
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	)
}
