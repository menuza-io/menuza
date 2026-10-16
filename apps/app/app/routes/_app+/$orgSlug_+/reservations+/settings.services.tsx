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
import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	checkTurnTimeContiguity,
	createPacingRule,
	createService,
	createServiceAvailability,
	createTurnTime,
	deletePacingRule,
	deleteService,
	deleteServiceAvailability,
	deleteTurnTime,
	type DiningAreaDto,
	extractApiErrorMessage,
	fetchAreas,
	fetchCombinations,
	fetchLocationSettings,
	fetchPacingRules,
	fetchServiceAvailability,
	fetchServices,
	fetchTables,
	fetchTurnTimes,
	formatMinutesLabel,
	isVersionConflictError,
	minutesToTimeString,
	type PacingChannel,
	type PacingRuleDto,
	type ServiceAvailabilityDto,
	type ServiceAvailabilityMode,
	type ServiceDto,
	type TableCombinationDto,
	type TableDto,
	timeStringToMinutes,
	type TurnTimeRuleDto,
	updateService,
	WEEKDAY_OPTIONS,
} from '#app/utils/reservations/setup-api.ts'
import { type Route } from './+types/settings.services.ts'
import { useReservationsSetupContext } from './settings.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)
	return null
}

type AvailabilityTargetType = 'area' | 'table' | 'combo'

const AVAILABILITY_MODE_LABELS: Record<string, MessageDescriptor> = {
	online: msg`Online & In-house`,
	staff_only: msg`Staff only`,
	walk_in_only: msg`Walk-in only`,
	unavailable: msg`Unavailable`,
}

function formatDaysOfWeek(
	days: number[],
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (!days || days.length === 0) return '—'
	if (days.length === 7) return translate(msg`Every day`)
	return WEEKDAY_OPTIONS.filter((d) => days.includes(d.value))
		.map((d) => translate(d.shortLabel))
		.join(', ')
}

export default function ReservationsSettingsServicesRoute() {
	const { _ } = useLingui()
	const { selectedLocationId, canWrite, client, refreshSummary } =
		useReservationsSetupContext()

	const [services, setServices] = useState<ServiceDto[]>([])
	const [turnBuckets, setTurnBuckets] = useState<TurnTimeRuleDto[]>([])
	const [pacingRules, setPacingRules] = useState<PacingRuleDto[]>([])
	const [availRules, setAvailRules] = useState<ServiceAvailabilityDto[]>([])
	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [combos, setCombos] = useState<TableCombinationDto[]>([])
	const [onlinePartyMax, setOnlinePartyMax] = useState(8)

	const [loading, setLoading] = useState(true)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)
	const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)

	// New service form
	const [svcName, setSvcName] = useState('')
	const [svcNameAr, setSvcNameAr] = useState('')
	const [svcDaysOfWeek, setSvcDaysOfWeek] = useState<number[]>([
		0, 1, 2, 3, 4, 5, 6,
	])
	const [svcFirstTime, setSvcFirstTime] = useState('17:00')
	const [svcLastTime, setSvcLastTime] = useState('21:30')
	const [svcEndTime, setSvcEndTime] = useState('23:00')
	const [svcNextDayEnd, setSvcNextDayEnd] = useState(false)
	const [svcSlotInterval, setSvcSlotInterval] = useState<15 | 30 | 60>(15)
	const [svcOnline, setSvcOnline] = useState(true)

	// Editing service state
	const [editingSvcId, setEditingSvcId] = useState<string | null>(null)
	const [editingSvcName, setEditingSvcName] = useState('')
	const [editingSvcFirstMin, setEditingSvcFirstMin] = useState(1020)
	const [editingSvcLastMin, setEditingSvcLastMin] = useState(1290)
	const [editingSvcEndMin, setEditingSvcEndMin] = useState(1380)

	// Turn-time bucket form
	const [ttServiceId, setTtServiceId] = useState('')
	const [ttPartyMin, setTtPartyMin] = useState(1)
	const [ttPartyMax, setTtPartyMax] = useState(2)
	const [ttDurationMin, setTtDurationMin] = useState(90)

	// Pacing rule form
	const [paceServiceId, setPaceServiceId] = useState('')
	const [paceBucketMin, setPaceBucketMin] = useState<15 | 30 | 60>(15)
	const [paceMaxCovers, setPaceMaxCovers] = useState('20')
	const [paceMaxParties, setPaceMaxParties] = useState('6')
	const [paceChannel, setPaceChannel] = useState<PacingChannel>('all')

	// Service availability rule form
	const [availServiceId, setAvailServiceId] = useState('')
	const [availTargetType, setAvailTargetType] =
		useState<AvailabilityTargetType>('area')
	const [availTargetId, setAvailTargetId] = useState('')
	const [availMode, setAvailMode] = useState<ServiceAvailabilityMode>('online')

	const loadAll = useCallback(async () => {
		if (!selectedLocationId) {
			setLoading(false)
			return
		}
		setLoading(true)
		setErrorMessage(null)
		try {
			const [
				settingsRes,
				servicesRes,
				turnRes,
				pacingRes,
				availRes,
				areasRes,
				tablesRes,
				combosRes,
			] = await Promise.all([
				fetchLocationSettings(client, selectedLocationId),
				fetchServices(client, selectedLocationId),
				fetchTurnTimes(client, selectedLocationId),
				fetchPacingRules(client, selectedLocationId),
				fetchServiceAvailability(client, selectedLocationId),
				fetchAreas(client, selectedLocationId),
				fetchTables(client, selectedLocationId),
				fetchCombinations(client, selectedLocationId),
			])

			const svcList = servicesRes.services ?? []
			const activeAreas = (areasRes.areas ?? []).filter(
				(a: DiningAreaDto) => a.isActive && !a.archivedAt,
			)
			const activeTables = (tablesRes.tables ?? []).filter(
				(t: TableDto) => t.isActive && !t.archivedAt,
			)
			setOnlinePartyMax(settingsRes.settings?.onlinePartyMax ?? 8)
			setServices(svcList)
			setTurnBuckets(turnRes.turnTimes ?? [])
			setPacingRules(pacingRes.pacing ?? [])
			setAvailRules(availRes.availability ?? [])
			setAreas(activeAreas)
			setTables(activeTables)
			setCombos(combosRes.combos ?? [])

			if (svcList.length > 0) {
				setAvailServiceId((prev) =>
					prev && svcList.some((s: ServiceDto) => s.id === prev)
						? prev
						: svcList[0]!.id,
				)
			}
			if (activeAreas.length > 0) {
				setAvailTargetId((prev) => prev || activeAreas[0]!.id)
			}
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to load services setup.`)),
			)
		} finally {
			setLoading(false)
		}
	}, [client, selectedLocationId, _])

	useEffect(() => {
		void loadAll()
	}, [loadAll])

	const contiguity = useMemo(
		() => checkTurnTimeContiguity(turnBuckets, onlinePartyMax),
		[turnBuckets, onlinePartyMax],
	)

	const handleToggleDay = (dayValue: number) => {
		setSvcDaysOfWeek((prev) => {
			if (prev.includes(dayValue)) {
				const next = prev.filter((d) => d !== dayValue)
				return next.length === 0 ? [dayValue] : next
			}
			return [...prev, dayValue].sort((a, b) => a - b)
		})
	}

	const handleCreateService = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setConflictBanner(null)
		setFeedbackMessage(null)

		if (!svcName.trim()) {
			setErrorMessage(_(msg`Service name is required.`))
			return
		}
		if (svcDaysOfWeek.length === 0) {
			setErrorMessage(_(msg`Select at least one active day of the week.`))
			return
		}

		const firstMin = timeStringToMinutes(svcFirstTime, { nextDay: false })
		const lastMin = timeStringToMinutes(svcLastTime, { nextDay: false })
		const endMin = timeStringToMinutes(svcEndTime, { nextDay: svcNextDayEnd })

		if (firstMin > lastMin || lastMin > endMin) {
			setErrorMessage(
				_(
					msg`Seating times must satisfy firstSeating <= lastSeating <= serviceEnd.`,
				),
			)
			return
		}

		try {
			await createService(client, selectedLocationId, {
				name: svcName.trim(),
				nameI18n: {
					en: svcName.trim(),
					...(svcNameAr.trim() ? { ar: svcNameAr.trim() } : {}),
				},
				daysOfWeek: svcDaysOfWeek,
				firstSeatingMin: firstMin,
				lastSeatingMin: lastMin,
				endMin,
				slotIntervalMin: svcSlotInterval,
				onlineBookable: svcOnline,
				sortOrder: services.length,
			})
			setSvcName('')
			setSvcNameAr('')
			setFeedbackMessage(_(msg`Service shift created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create service.`)),
			)
		}
	}

	const handleSaveServiceEdit = async (svc: ServiceDto) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		if (
			editingSvcFirstMin > editingSvcLastMin ||
			editingSvcLastMin > editingSvcEndMin
		) {
			setErrorMessage(
				_(
					msg`Seating times must satisfy firstSeating <= lastSeating <= serviceEnd.`,
				),
			)
			return
		}

		try {
			await updateService(client, selectedLocationId, svc.id, {
				expectedVersion: svc.version,
				name: editingSvcName.trim() || svc.name,
				firstSeatingMin: editingSvcFirstMin,
				lastSeatingMin: editingSvcLastMin,
				endMin: editingSvcEndMin,
			})
			setEditingSvcId(null)
			setFeedbackMessage(_(msg`Service updated.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			if (isVersionConflictError(err)) {
				setConflictBanner(
					_(
						msg`This service was updated by another operator. Reloading latest services.`,
					),
				)
				await loadAll()
			} else {
				setErrorMessage(
					extractApiErrorMessage(err, _(msg`Failed to update service.`)),
				)
			}
		}
	}

	const handleDeleteService = async (serviceId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			await deleteService(client, selectedLocationId, serviceId)
			setFeedbackMessage(_(msg`Service deleted.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete service.`)),
			)
		}
	}

	const handleCreateTurnBucket = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setFeedbackMessage(null)

		if (ttPartyMin > ttPartyMax) {
			setErrorMessage(_(msg`Minimum party size cannot exceed maximum.`))
			return
		}
		if (ttDurationMin < 15 || ttDurationMin > 720 || ttDurationMin % 15 !== 0) {
			setErrorMessage(
				_(msg`Duration must be between 15 and 720 minutes in 15-min steps.`),
			)
			return
		}

		try {
			await createTurnTime(client, selectedLocationId, {
				serviceId: ttServiceId || null,
				partyMin: ttPartyMin,
				partyMax: ttPartyMax,
				minutes: ttDurationMin,
			})
			setFeedbackMessage(_(msg`Turn-time bucket added.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create turn-time bucket.`)),
			)
		}
	}

	const handleDeleteTurnBucket = async (bucketId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			await deleteTurnTime(client, selectedLocationId, bucketId)
			setFeedbackMessage(_(msg`Turn-time bucket deleted.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete turn-time bucket.`)),
			)
		}
	}

	const handleCreatePacingRule = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setFeedbackMessage(null)

		const maxCovers = paceMaxCovers.trim() ? Number(paceMaxCovers) : null
		const maxParties = paceMaxParties.trim() ? Number(paceMaxParties) : null

		if (maxCovers === null && maxParties === null) {
			setErrorMessage(
				_(msg`Specify at least max covers or max parties for pacing.`),
			)
			return
		}

		try {
			await createPacingRule(client, selectedLocationId, {
				serviceId: paceServiceId || services[0]?.id || null,
				bucketMin: paceBucketMin,
				maxCovers,
				maxParties,
				channel: paceChannel,
			})
			setFeedbackMessage(_(msg`Pacing rule created.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to create pacing rule.`)),
			)
		}
	}

	const handleDeletePacingRule = async (ruleId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			await deletePacingRule(client, selectedLocationId, ruleId)
			setFeedbackMessage(_(msg`Pacing rule deleted.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to delete pacing rule.`)),
			)
		}
	}

	const availableTargets = useMemo(() => {
		if (availTargetType === 'area') {
			return areas.map((a) => ({ id: a.id, label: a.name }))
		}
		if (availTargetType === 'table') {
			return tables.map((t) => ({ id: t.id, label: t.label }))
		}
		return combos.map((c) => ({ id: c.id, label: c.name }))
	}, [availTargetType, areas, tables, combos])

	const handleCreateAvailabilityRule = async (
		event: FormEvent<HTMLFormElement>,
	) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		setFeedbackMessage(null)

		const targetSvcId = availServiceId || services[0]?.id || ''
		const targetEntityId = availTargetId || availableTargets[0]?.id || ''
		if (!targetSvcId || !targetEntityId) {
			setErrorMessage(_(msg`Select a service and target entity.`))
			return
		}

		try {
			await createServiceAvailability(client, selectedLocationId, {
				serviceId: targetSvcId,
				areaId: availTargetType === 'area' ? targetEntityId : null,
				tableId: availTargetType === 'table' ? targetEntityId : null,
				comboId: availTargetType === 'combo' ? targetEntityId : null,
				mode: availMode,
			})
			setFeedbackMessage(_(msg`Per-service availability override saved.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(err, _(msg`Failed to save availability rule.`)),
			)
		}
	}

	const handleDeleteAvailabilityRule = async (ruleId: string) => {
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)
		try {
			await deleteServiceAvailability(client, selectedLocationId, ruleId)
			setFeedbackMessage(_(msg`Availability override removed.`))
			await Promise.all([loadAll(), refreshSummary()])
		} catch (err) {
			setErrorMessage(
				extractApiErrorMessage(
					err,
					_(msg`Failed to delete availability override.`),
				),
			)
		}
	}

	const gapSummaryLabel = contiguity.gaps
		.map((g) => (g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`))
		.join(', ')

	return (
		<div className="flex flex-col gap-6" data-testid="setup-services-page">
			{conflictBanner ? (
				<div
					role="alert"
					className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="setup-services-conflict-banner"
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
					data-testid="setup-services-error-banner"
				>
					{errorMessage}
				</div>
			) : null}

			{feedbackMessage ? (
				<div
					role="status"
					className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="setup-services-feedback-banner"
				>
					{feedbackMessage}
				</div>
			) : null}

			{/* Services / Shifts Card */}
			<Card data-testid="setup-services-card">
				<CardHeader>
					<CardTitle>
						<Trans>Service Shifts</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Configure recurring weekly shifts (Lunch, Dinner, Suhoor, Brunch)
							with first seating, last seating, and service end times (supports
							next-day spillover up to 04:00 +1d).
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateService(e)}
							className="border-border bg-muted/20 flex flex-col gap-3 rounded-lg border p-3"
							data-testid="setup-create-service-form"
						>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
								<div className="flex flex-col gap-1">
									<Label htmlFor="svc-name">
										<Trans>Service name (EN)</Trans>
									</Label>
									<Input
										id="svc-name"
										placeholder={_(msg`e.g. Late Dinner`)}
										value={svcName}
										onChange={(e) => setSvcName(e.target.value)}
										data-testid="setup-service-name-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="svc-name-ar">
										<Trans>Service name (AR)</Trans>
									</Label>
									<Input
										id="svc-name-ar"
										dir="rtl"
										placeholder={_(msg`Arabic service name`)}
										value={svcNameAr}
										onChange={(e) => setSvcNameAr(e.target.value)}
										data-testid="setup-service-name-ar-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="svc-first-time">
										<Trans>First seating</Trans>
									</Label>
									<Input
										id="svc-first-time"
										type="time"
										value={svcFirstTime}
										onChange={(e) => setSvcFirstTime(e.target.value)}
										data-testid="setup-service-first-time-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="svc-last-time">
										<Trans>Last seating</Trans>
									</Label>
									<Input
										id="svc-last-time"
										type="time"
										value={svcLastTime}
										onChange={(e) => setSvcLastTime(e.target.value)}
										data-testid="setup-service-last-time-input"
									/>
								</div>
								<div className="flex flex-col gap-1">
									<Label htmlFor="svc-end-time">
										<Trans>Service end</Trans>
									</Label>
									<div className="flex items-center gap-2">
										<Input
											id="svc-end-time"
											type="time"
											value={svcEndTime}
											onChange={(e) => setSvcEndTime(e.target.value)}
											data-testid="setup-service-end-time-input"
										/>
										<label className="flex shrink-0 items-center gap-1 text-xs">
											<input
												type="checkbox"
												checked={svcNextDayEnd}
												onChange={(e) => setSvcNextDayEnd(e.target.checked)}
												data-testid="setup-service-next-day-checkbox"
											/>
											<span>+1d</span>
										</label>
									</div>
								</div>
							</div>

							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="text-muted-foreground mr-1 text-xs font-medium">
										<Trans>Days:</Trans>
									</span>
									{WEEKDAY_OPTIONS.map((day) => {
										const active = svcDaysOfWeek.includes(day.value)
										return (
											<Button
												key={day.value}
												type="button"
												size="sm"
												variant={active ? 'default' : 'outline'}
												onClick={() => handleToggleDay(day.value)}
												data-testid={`setup-service-day-${day.code}`}
											>
												{_(day.shortLabel)}
											</Button>
										)
									})}
								</div>

								<div className="flex flex-wrap items-center gap-3">
									<label className="flex items-center gap-1.5 text-xs">
										<span>
											<Trans>Interval:</Trans>
										</span>
										<select
											value={svcSlotInterval}
											onChange={(e) =>
												setSvcSlotInterval(
													Number(e.target.value) as 15 | 30 | 60,
												)
											}
											className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-xs"
										>
											<option value={15}>15m</option>
											<option value={30}>30m</option>
											<option value={60}>60m</option>
										</select>
									</label>

									<label className="flex items-center gap-1.5 text-xs">
										<input
											type="checkbox"
											checked={svcOnline}
											onChange={(e) => setSvcOnline(e.target.checked)}
										/>
										<Trans>Bookable online</Trans>
									</label>

									<Button
										type="submit"
										size="sm"
										data-testid="setup-add-service-button"
									>
										<Icon name="plus" className="size-4" />
										<Trans>Add service</Trans>
									</Button>
								</div>
							</div>
						</form>
					) : null}

					{loading ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Loading services…</Trans>
						</p>
					) : services.length === 0 ? (
						<p
							className="text-muted-foreground text-sm"
							data-testid="setup-services-empty"
						>
							<Trans>No service shifts configured yet.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Days</Trans>
									</TableHead>
									<TableHead>
										<Trans>Hours (First / Last / End)</Trans>
									</TableHead>
									<TableHead>
										<Trans>Interval</Trans>
									</TableHead>
									<TableHead>
										<Trans>Online</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{services.map((svc) => {
									const isEditing = editingSvcId === svc.id
									const onlineFlag =
										svc.onlineBookable ?? svc.isBookableOnline ?? true
									return (
										<TableRow
											key={svc.id}
											data-testid={`setup-service-row-${svc.name}`}
										>
											<TableCell className="font-medium">
												{isEditing ? (
													<Input
														value={editingSvcName}
														onChange={(e) => setEditingSvcName(e.target.value)}
														className="h-8 w-36"
														data-testid="setup-edit-service-name-input"
													/>
												) : (
													<div className="flex items-center gap-2">
														<span>{svc.name}</span>
														{svc.nameI18n?.ar ? (
															<span className="text-muted-foreground text-xs">
																({svc.nameI18n.ar})
															</span>
														) : null}
													</div>
												)}
											</TableCell>
											<TableCell className="text-xs">
												{formatDaysOfWeek(svc.daysOfWeek, _)}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{isEditing ? (
													<div className="flex items-center gap-1">
														<Input
															type="time"
															value={minutesToTimeString(editingSvcFirstMin)}
															onChange={(e) => {
																setEditingSvcFirstMin(
																	timeStringToMinutes(e.target.value, {
																		nextDay: false,
																	}),
																)
															}}
															className="h-8 w-24"
															data-testid="setup-edit-service-first-time"
														/>
														<span>–</span>
														<Input
															type="time"
															value={minutesToTimeString(editingSvcLastMin)}
															onChange={(e) => {
																setEditingSvcLastMin(
																	timeStringToMinutes(e.target.value, {
																		nextDay: false,
																	}),
																)
															}}
															className="h-8 w-24"
															data-testid="setup-edit-service-last-time"
														/>
														<span>/</span>
														<Input
															type="time"
															value={minutesToTimeString(editingSvcEndMin)}
															onChange={(e) => {
																setEditingSvcEndMin(
																	timeStringToMinutes(e.target.value, {
																		nextDay: editingSvcEndMin >= 1440,
																	}),
																)
															}}
															className="h-8 w-24"
															data-testid="setup-edit-service-end-time"
														/>
													</div>
												) : (
													`${formatMinutesLabel(svc.firstSeatingMin)} – ${formatMinutesLabel(svc.lastSeatingMin)} (ends ${formatMinutesLabel(svc.endMin)})`
												)}
											</TableCell>
											<TableCell>{svc.slotIntervalMin ?? 15}m</TableCell>
											<TableCell>
												{onlineFlag ? (
													<Badge variant="outline">
														<Trans>Online</Trans>
													</Badge>
												) : (
													<Badge variant="secondary">
														<Trans>Staff only</Trans>
													</Badge>
												)}
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													isEditing ? (
														<div className="flex items-center justify-end gap-1">
															<Button
																type="button"
																size="sm"
																onClick={() => void handleSaveServiceEdit(svc)}
																data-testid="setup-save-service-edit-button"
															>
																<Trans>Save</Trans>
															</Button>
															<Button
																type="button"
																variant="ghost"
																size="sm"
																onClick={() => setEditingSvcId(null)}
															>
																<Trans>Cancel</Trans>
															</Button>
														</div>
													) : (
														<div className="flex items-center justify-end gap-1">
															<Button
																type="button"
																variant="outline"
																size="sm"
																onClick={() => {
																	setEditingSvcId(svc.id)
																	setEditingSvcName(svc.name)
																	setEditingSvcFirstMin(svc.firstSeatingMin)
																	setEditingSvcLastMin(svc.lastSeatingMin)
																	setEditingSvcEndMin(svc.endMin)
																}}
																data-testid={`setup-edit-service-${svc.name}`}
															>
																<Trans>Edit</Trans>
															</Button>
															<Button
																type="button"
																variant="destructive"
																size="sm"
																onClick={() => void handleDeleteService(svc.id)}
																data-testid={`setup-delete-service-${svc.name}`}
															>
																<Trans>Delete</Trans>
															</Button>
														</div>
													)
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

			{/* Turn-time Buckets Card */}
			<Card data-testid="setup-turn-times-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
					<div>
						<CardTitle>
							<Trans>Turn-Time Buckets</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Define expected dining duration by party size (in 15-minute
								increments). Must contiguously cover party sizes 1 through{' '}
								{onlinePartyMax}.
							</Trans>
						</CardDescription>
					</div>
					{contiguity.covered ? (
						<Badge variant="outline" data-testid="turn-times-contiguous-badge">
							<Icon name="check" className="mr-1 size-3.5 text-emerald-500" />
							<Trans>Contiguous 1–{onlinePartyMax}p</Trans>
						</Badge>
					) : (
						<Badge variant="destructive" data-testid="turn-times-gap-badge">
							<Icon name="alert-triangle" className="mr-1 size-3.5" />
							<Trans>Missing party sizes: {gapSummaryLabel}</Trans>
						</Badge>
					)}
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateTurnBucket(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5"
							data-testid="setup-create-turn-time-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="tt-service">
									<Trans>Service scope</Trans>
								</Label>
								<select
									id="tt-service"
									value={ttServiceId}
									onChange={(e) => setTtServiceId(e.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-turn-time-service-select"
								>
									<option value="">{_(msg`All services (default)`)}</option>
									{services.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="tt-min">
									<Trans>Party min</Trans>
								</Label>
								<Input
									id="tt-min"
									type="number"
									min={1}
									max={99}
									value={ttPartyMin}
									onChange={(e) => setTtPartyMin(Number(e.target.value) || 1)}
									data-testid="setup-turn-time-party-min"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="tt-max">
									<Trans>Party max</Trans>
								</Label>
								<Input
									id="tt-max"
									type="number"
									min={1}
									max={99}
									value={ttPartyMax}
									onChange={(e) => setTtPartyMax(Number(e.target.value) || 2)}
									data-testid="setup-turn-time-party-max"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="tt-duration">
									<Trans>Duration (minutes)</Trans>
								</Label>
								<Input
									id="tt-duration"
									type="number"
									min={15}
									max={720}
									step={15}
									value={ttDurationMin}
									onChange={(e) =>
										setTtDurationMin(Number(e.target.value) || 60)
									}
									data-testid="setup-turn-time-duration"
								/>
							</div>
							<Button
								type="submit"
								size="sm"
								data-testid="setup-add-turn-time-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add bucket</Trans>
							</Button>
						</form>
					) : null}

					{turnBuckets.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No turn-time buckets configured.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Party size range</Trans>
									</TableHead>
									<TableHead>
										<Trans>Duration</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{turnBuckets.map((bucket) => {
									const svcLabel = bucket.serviceId
										? (services.find((s) => s.id === bucket.serviceId)?.name ??
											bucket.serviceId)
										: _(msg`All services`)
									const durationVal = bucket.minutes ?? bucket.turnTimeMin ?? 90
									return (
										<TableRow
											key={bucket.id}
											data-testid={`setup-turn-bucket-row-${bucket.partyMin}-${bucket.partyMax}`}
										>
											<TableCell>{svcLabel}</TableCell>
											<TableCell className="font-medium">
												{bucket.partyMin}–{bucket.partyMax} covers
											</TableCell>
											<TableCell>{durationVal} min</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() =>
															void handleDeleteTurnBucket(bucket.id)
														}
														data-testid={`setup-delete-turn-bucket-${bucket.partyMin}-${bucket.partyMax}`}
													>
														<Trans>Delete</Trans>
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

			{/* Pacing Rules Card */}
			<Card data-testid="setup-pacing-card">
				<CardHeader>
					<CardTitle>
						<Trans>Pacing Rules</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Cap maximum covers, maximum parties, and channel scope per 15, 30,
							or 60-minute seating window.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreatePacingRule(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-6"
							data-testid="setup-create-pacing-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="pace-service">
									<Trans>Service</Trans>
								</Label>
								<select
									id="pace-service"
									value={paceServiceId}
									onChange={(e) => setPaceServiceId(e.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-pacing-service-select"
								>
									<option value="">{_(msg`All services`)}</option>
									{services.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="pace-window">
									<Trans>Window</Trans>
								</Label>
								<select
									id="pace-window"
									value={paceBucketMin}
									onChange={(e) =>
										setPaceBucketMin(Number(e.target.value) as 15 | 30 | 60)
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-pacing-window-select"
								>
									<option value={15}>15 min</option>
									<option value={30}>30 min</option>
									<option value={60}>60 min</option>
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="pace-covers">
									<Trans>Max covers</Trans>
								</Label>
								<Input
									id="pace-covers"
									type="number"
									min={1}
									max={999}
									value={paceMaxCovers}
									onChange={(e) => setPaceMaxCovers(e.target.value)}
									data-testid="setup-pacing-max-covers"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="pace-parties">
									<Trans>Max parties</Trans>
								</Label>
								<Input
									id="pace-parties"
									type="number"
									min={1}
									max={999}
									value={paceMaxParties}
									onChange={(e) => setPaceMaxParties(e.target.value)}
									data-testid="setup-pacing-max-parties"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="pace-channel">
									<Trans>Channel</Trans>
								</Label>
								<select
									id="pace-channel"
									value={paceChannel}
									onChange={(e) =>
										setPaceChannel(e.target.value as PacingChannel)
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-pacing-channel-select"
								>
									<option value="all">{_(msg`All channels`)}</option>
									<option value="online">{_(msg`Online only`)}</option>
									<option value="phone">{_(msg`Phone only`)}</option>
									<option value="walk_in">{_(msg`Walk-in only`)}</option>
								</select>
							</div>
							<Button
								type="submit"
								size="sm"
								data-testid="setup-add-pacing-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add pacing rule</Trans>
							</Button>
						</form>
					) : null}

					{pacingRules.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No pacing rules configured.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Window</Trans>
									</TableHead>
									<TableHead>
										<Trans>Max covers</Trans>
									</TableHead>
									<TableHead>
										<Trans>Max parties</Trans>
									</TableHead>
									<TableHead>
										<Trans>Channel</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pacingRules.map((rule) => {
									const svcLabel = rule.serviceId
										? (services.find((s) => s.id === rule.serviceId)?.name ??
											rule.serviceId)
										: _(msg`All services`)
									const bucketVal = rule.bucketMin ?? rule.windowMinutes ?? 15
									return (
										<TableRow
											key={rule.id}
											data-testid={`setup-pacing-row-${bucketVal}`}
										>
											<TableCell>{svcLabel}</TableCell>
											<TableCell>{bucketVal} min</TableCell>
											<TableCell>{rule.maxCovers ?? '—'}</TableCell>
											<TableCell>{rule.maxParties ?? '—'}</TableCell>
											<TableCell>{rule.channel ?? 'all'}</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => void handleDeletePacingRule(rule.id)}
														data-testid={`setup-delete-pacing-${rule.id}`}
													>
														<Trans>Delete</Trans>
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

			{/* Per-Service Availability Modes Card */}
			<Card data-testid="setup-service-availability-card">
				<CardHeader>
					<CardTitle>
						<Trans>Per-Service Table & Area Availability</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Override whether specific dining areas, tables, or combinations
							are available online, staff-only, walk-in only, or unavailable
							during a given service.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{canWrite ? (
						<form
							onSubmit={(e) => void handleCreateAvailabilityRule(e)}
							className="border-border bg-muted/20 grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5"
							data-testid="setup-create-availability-form"
						>
							<div className="flex flex-col gap-1">
								<Label htmlFor="avail-service">
									<Trans>Service</Trans>
								</Label>
								<select
									id="avail-service"
									value={availServiceId || services[0]?.id || ''}
									onChange={(e) => setAvailServiceId(e.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-avail-service-select"
								>
									{services.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="avail-target-type">
									<Trans>Target type</Trans>
								</Label>
								<select
									id="avail-target-type"
									value={availTargetType}
									onChange={(e) => {
										const nextType = e.target.value as AvailabilityTargetType
										setAvailTargetType(nextType)
										setAvailTargetId('')
									}}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-avail-target-type-select"
								>
									<option value="area">{_(msg`Dining area`)}</option>
									<option value="table">{_(msg`Table`)}</option>
									<option value="combo">{_(msg`Table combination`)}</option>
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="avail-target-id">
									<Trans>Target</Trans>
								</Label>
								<select
									id="avail-target-id"
									value={availTargetId || availableTargets[0]?.id || ''}
									onChange={(e) => setAvailTargetId(e.target.value)}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-avail-target-id-select"
								>
									{availableTargets.map((item) => (
										<option key={item.id} value={item.id}>
											{item.label}
										</option>
									))}
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="avail-mode">
									<Trans>Mode</Trans>
								</Label>
								<select
									id="avail-mode"
									value={availMode}
									onChange={(e) =>
										setAvailMode(e.target.value as ServiceAvailabilityMode)
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
									data-testid="setup-avail-mode-select"
								>
									<option value="online">{_(msg`Online & In-house`)}</option>
									<option value="staff_only">{_(msg`Staff only`)}</option>
									<option value="walk_in_only">{_(msg`Walk-in only`)}</option>
									<option value="unavailable">{_(msg`Unavailable`)}</option>
								</select>
							</div>
							<Button
								type="submit"
								size="sm"
								data-testid="setup-add-avail-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add override</Trans>
							</Button>
						</form>
					) : null}

					{availRules.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>No per-service availability overrides configured.</Trans>
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Target type</Trans>
									</TableHead>
									<TableHead>
										<Trans>Target</Trans>
									</TableHead>
									<TableHead>
										<Trans>Mode</Trans>
									</TableHead>
									<TableHead className="text-right">
										<Trans>Actions</Trans>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{availRules.map((rule) => {
									const svcLabel =
										services.find((s) => s.id === rule.serviceId)?.name ??
										rule.serviceId
									const targetTypeLabel = rule.areaId
										? 'area'
										: rule.tableId
											? 'table'
											: 'combo'
									const targetLabel = rule.areaId
										? (areas.find((a) => a.id === rule.areaId)?.name ??
											rule.areaId)
										: rule.tableId
											? (tables.find((t) => t.id === rule.tableId)?.label ??
												rule.tableId)
											: (combos.find((c) => c.id === rule.comboId)?.name ??
												rule.comboId ??
												'—')

									return (
										<TableRow
											key={rule.id}
											data-testid={`setup-avail-row-${rule.mode}`}
										>
											<TableCell>{svcLabel}</TableCell>
											<TableCell className="capitalize">
												{targetTypeLabel}
											</TableCell>
											<TableCell className="font-medium">
												{targetLabel}
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{AVAILABILITY_MODE_LABELS[rule.mode]
														? _(AVAILABILITY_MODE_LABELS[rule.mode]!)
														: rule.mode}
												</Badge>
											</TableCell>
											<TableCell className="text-right">
												{canWrite ? (
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() =>
															void handleDeleteAvailabilityRule(rule.id)
														}
														data-testid={`setup-delete-avail-${rule.id}`}
													>
														<Trans>Delete</Trans>
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
