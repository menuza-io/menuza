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
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Field, FieldLabel } from '@repo/ui/field'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
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
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
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
type Interval = 15 | 30 | 60
type DeleteTarget = {
	kind: 'service' | 'turn' | 'pacing' | 'avail'
	id: string
	label: string
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

type ServiceForm = {
	name: string
	nameAr: string
	days: number[]
	first: string
	last: string
	end: string
	nextDay: boolean
	interval: Interval
	online: boolean
}

const NEW_SERVICE_FORM: ServiceForm = {
	name: '',
	nameAr: '',
	days: ALL_DAYS,
	first: '17:00',
	last: '21:30',
	end: '23:00',
	nextDay: false,
	interval: 15,
	online: true,
}

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

/**
 * A collapsible settings block for the advanced rules. It opens by itself when
 * the rules already exist (or need attention) and stays folded otherwise, so
 * the common case (shifts only) is a single short screen.
 */
function RuleSection({
	testId,
	toggleTestId,
	title,
	description,
	badge,
	defaultOpen,
	children,
}: {
	testId: string
	toggleTestId: string
	title: ReactNode
	description: ReactNode
	badge?: ReactNode
	defaultOpen: boolean
	children: ReactNode
}) {
	const [override, setOverride] = useState<boolean | null>(null)
	const open = override ?? defaultOpen
	return (
		<Collapsible open={open} onOpenChange={setOverride}>
			<Frame data-testid={testId}>
				<FrameHeader>
					<FrameTitle>{title}</FrameTitle>
					<FrameDescription>{description}</FrameDescription>
					<FrameAction>
						<div className="flex items-center gap-2">
							{badge}
							<CollapsibleTrigger
								render={<Button variant="outline" size="sm" />}
								data-testid={toggleTestId}
							>
								{open ? <Trans>Hide</Trans> : <Trans>Set up</Trans>}
								<Icon
									name={open ? 'chevron-up' : 'chevron-down'}
									className="size-4"
								/>
							</CollapsibleTrigger>
						</div>
					</FrameAction>
				</FrameHeader>
				<CollapsibleContent>
					<div className="border-t">
						<FramePanel className="flex flex-col gap-4">{children}</FramePanel>
					</div>
				</CollapsibleContent>
			</Frame>
		</Collapsible>
	)
}

function RulesTable({ children }: { children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border">
			<Table variant="card">{children}</Table>
		</div>
	)
}

const READ_ONLY_CELL = (
	<span className="text-muted-foreground text-xs">
		<Trans>Read-only</Trans>
	</span>
)

export default function ReservationsSettingsServicesRoute() {
	const { _ } = useLingui()
	const { selectedLocationId, canWrite, client, refreshSummary, settings } =
		useReservationsSetupContext()
	const defaultTurnMin = settings?.defaultTurnTimeMin ?? 90

	const [services, setServices] = useState<ServiceDto[]>([])
	const [turnBuckets, setTurnBuckets] = useState<TurnTimeRuleDto[]>([])
	const [pacingRules, setPacingRules] = useState<PacingRuleDto[]>([])
	const [availRules, setAvailRules] = useState<ServiceAvailabilityDto[]>([])
	const [areas, setAreas] = useState<DiningAreaDto[]>([])
	const [tables, setTables] = useState<TableDto[]>([])
	const [combos, setCombos] = useState<TableCombinationDto[]>([])
	const [onlinePartyMax, setOnlinePartyMax] = useState(8)

	const [loading, setLoading] = useState(true)
	const [busy, setBusy] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | null>(null)
	const [conflictBanner, setConflictBanner] = useState<string | null>(null)

	// Service sheet (create or edit)
	const [sheet, setSheet] = useState<
		{ mode: 'create' } | { mode: 'edit'; svc: ServiceDto } | null
	>(null)
	const [form, setForm] = useState<ServiceForm>(NEW_SERVICE_FORM)
	const [sheetError, setSheetError] = useState<string | null>(null)
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

	// Turn-time bucket form
	const [ttServiceId, setTtServiceId] = useState('')
	const [ttPartyMin, setTtPartyMin] = useState(1)
	const [ttPartyMax, setTtPartyMax] = useState(2)
	const [ttDurationMin, setTtDurationMin] = useState(90)

	// Pacing rule form
	const [paceServiceId, setPaceServiceId] = useState('')
	const [paceBucketMin, setPaceBucketMin] = useState<Interval>(15)
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

	const refreshAll = () => Promise.all([loadAll(), refreshSummary()])

	const openCreate = () => {
		setForm(NEW_SERVICE_FORM)
		setSheetError(null)
		setSheet({ mode: 'create' })
	}

	const openEdit = (svc: ServiceDto) => {
		setForm({
			name: svc.name,
			nameAr: svc.nameI18n?.ar ?? '',
			days: svc.daysOfWeek?.length ? svc.daysOfWeek : ALL_DAYS,
			first: minutesToTimeString(svc.firstSeatingMin),
			last: minutesToTimeString(svc.lastSeatingMin),
			end: minutesToTimeString(svc.endMin),
			nextDay: svc.endMin >= 1440,
			interval: (svc.slotIntervalMin ?? 15) as Interval,
			online: svc.onlineBookable ?? svc.isBookableOnline ?? true,
		})
		setSheetError(null)
		setSheet({ mode: 'edit', svc })
	}

	const patchForm = (patch: Partial<ServiceForm>) =>
		setForm((prev) => ({ ...prev, ...patch }))

	const handleToggleDay = (dayValue: number) => {
		setForm((prev) => {
			if (prev.days.includes(dayValue)) {
				const next = prev.days.filter((d) => d !== dayValue)
				return { ...prev, days: next.length === 0 ? [dayValue] : next }
			}
			return {
				...prev,
				days: [...prev.days, dayValue].sort((a, b) => a - b),
			}
		})
	}

	const handleSubmitService = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId || !sheet) return
		setSheetError(null)
		setConflictBanner(null)

		const name = form.name.trim()
		if (!name) {
			setSheetError(_(msg`Service name is required.`))
			return
		}
		if (form.days.length === 0) {
			setSheetError(_(msg`Select at least one active day of the week.`))
			return
		}
		const firstMin = timeStringToMinutes(form.first, { nextDay: false })
		const lastMin = timeStringToMinutes(form.last, { nextDay: false })
		const endMin = timeStringToMinutes(form.end, { nextDay: form.nextDay })
		if (firstMin > lastMin || lastMin > endMin) {
			setSheetError(
				_(
					msg`Seating times must satisfy firstSeating <= lastSeating <= serviceEnd.`,
				),
			)
			return
		}
		const nameAr = form.nameAr.trim()
		const nameI18n = { en: name, ...(nameAr ? { ar: nameAr } : {}) }

		setBusy(true)
		try {
			if (sheet.mode === 'create') {
				await createService(client, selectedLocationId, {
					name,
					nameI18n,
					daysOfWeek: form.days,
					firstSeatingMin: firstMin,
					lastSeatingMin: lastMin,
					endMin,
					slotIntervalMin: form.interval,
					onlineBookable: form.online,
					sortOrder: services.length,
				})
				toast.success(_(msg`Service shift created.`))
			} else {
				await updateService(client, selectedLocationId, sheet.svc.id, {
					expectedVersion: sheet.svc.version,
					name,
					nameI18n,
					daysOfWeek: form.days,
					firstSeatingMin: firstMin,
					lastSeatingMin: lastMin,
					endMin,
					slotIntervalMin: form.interval,
					onlineBookable: form.online,
				})
				toast.success(_(msg`Service updated.`))
			}
			setSheet(null)
			await refreshAll()
		} catch (err) {
			if (sheet.mode === 'edit' && isVersionConflictError(err)) {
				setSheet(null)
				setConflictBanner(
					_(
						msg`This service was changed by someone else. We loaded the latest version. Review it and save again.`,
					),
				)
				await loadAll()
			} else {
				setSheetError(
					extractApiErrorMessage(
						err,
						sheet.mode === 'create'
							? _(msg`Failed to create service.`)
							: _(msg`Failed to update service.`),
					),
				)
			}
		} finally {
			setBusy(false)
		}
	}

	const runMutation = async (
		action: () => Promise<unknown>,
		success: string,
		failure: string,
	) => {
		if (!canWrite || !selectedLocationId) return false
		setErrorMessage(null)
		setBusy(true)
		try {
			await action()
			toast.success(success)
			await refreshAll()
			return true
		} catch (err) {
			setErrorMessage(extractApiErrorMessage(err, failure))
			return false
		} finally {
			setBusy(false)
		}
	}

	const confirmDelete = async () => {
		if (!deleteTarget || !selectedLocationId) return
		const { kind, id } = deleteTarget
		if (kind === 'service') {
			await runMutation(
				() => deleteService(client, selectedLocationId, id),
				_(msg`Service deleted.`),
				_(msg`Failed to delete service.`),
			)
		} else if (kind === 'turn') {
			await runMutation(
				() => deleteTurnTime(client, selectedLocationId, id),
				_(msg`Turn-time bucket deleted.`),
				_(msg`Failed to delete turn-time bucket.`),
			)
		} else if (kind === 'pacing') {
			await runMutation(
				() => deletePacingRule(client, selectedLocationId, id),
				_(msg`Pacing rule deleted.`),
				_(msg`Failed to delete pacing rule.`),
			)
		} else {
			await runMutation(
				() => deleteServiceAvailability(client, selectedLocationId, id),
				_(msg`Availability override removed.`),
				_(msg`Failed to delete availability override.`),
			)
		}
		setDeleteTarget(null)
	}

	const handleCreateTurnBucket = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)

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
		await runMutation(
			() =>
				createTurnTime(client, selectedLocationId, {
					serviceId: ttServiceId || null,
					partyMin: ttPartyMin,
					partyMax: ttPartyMax,
					minutes: ttDurationMin,
				}),
			_(msg`Turn-time bucket added.`),
			_(msg`Failed to create turn-time bucket.`),
		)
	}

	const handleCreatePacingRule = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canWrite || !selectedLocationId) return
		setErrorMessage(null)

		const maxCovers = paceMaxCovers.trim() ? Number(paceMaxCovers) : null
		const maxParties = paceMaxParties.trim() ? Number(paceMaxParties) : null
		if (maxCovers === null && maxParties === null) {
			setErrorMessage(
				_(msg`Specify at least max covers or max parties for pacing.`),
			)
			return
		}
		await runMutation(
			() =>
				createPacingRule(client, selectedLocationId, {
					serviceId: paceServiceId || services[0]?.id || null,
					bucketMin: paceBucketMin,
					maxCovers,
					maxParties,
					channel: paceChannel,
				}),
			_(msg`Pacing rule created.`),
			_(msg`Failed to create pacing rule.`),
		)
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

		const targetSvcId = availServiceId || services[0]?.id || ''
		const targetEntityId = availTargetId || availableTargets[0]?.id || ''
		if (!targetSvcId || !targetEntityId) {
			setErrorMessage(_(msg`Select a service and target entity.`))
			return
		}
		await runMutation(
			() =>
				createServiceAvailability(client, selectedLocationId, {
					serviceId: targetSvcId,
					areaId: availTargetType === 'area' ? targetEntityId : null,
					tableId: availTargetType === 'table' ? targetEntityId : null,
					comboId: availTargetType === 'combo' ? targetEntityId : null,
					mode: availMode,
				}),
			_(msg`Per-service availability override saved.`),
			_(msg`Failed to save availability rule.`),
		)
	}

	const gapSummaryLabel = contiguity.gaps
		.map((g) => (g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`))
		.join(', ')

	const serviceOptions = services.map((s) => ({ value: s.id, label: s.name }))
	const allServicesLabel = _(msg`All services`)
	const scopeOptions = [
		{ value: '', label: allServicesLabel },
		...serviceOptions,
	]
	const intervalOptions = [
		{ value: '15', label: _(msg`15 min`) },
		{ value: '30', label: _(msg`30 min`) },
		{ value: '60', label: _(msg`60 min`) },
	]

	const turnSummary = (svc: ServiceDto) => {
		const own = turnBuckets.filter((b) => b.serviceId === svc.id)
		const scoped =
			own.length > 0 ? own : turnBuckets.filter((b) => !b.serviceId)
		if (scoped.length === 0) return _(msg`Default`)
		const mins = scoped.map((b) => b.minutes ?? b.turnTimeMin ?? 90)
		const lo = Math.min(...mins)
		const hi = Math.max(...mins)
		return lo === hi ? _(msg`${lo} min`) : _(msg`${lo}–${hi} min`)
	}

	const targetTypeLabel = (rule: ServiceAvailabilityDto) =>
		rule.areaId
			? _(msg`Dining area`)
			: rule.tableId
				? _(msg`Table`)
				: _(msg`Table combination`)

	const deleteTitle =
		deleteTarget?.kind === 'service'
			? _(msg`Delete this service?`)
			: _(msg`Delete this rule?`)

	return (
		<div className="flex flex-col gap-6" data-testid="setup-services-page">
			{!canWrite ? (
				<p className="text-muted-foreground text-sm">
					<Trans>You can view these settings but not change them.</Trans>
				</p>
			) : null}

			{conflictBanner ? (
				<Alert data-testid="setup-services-conflict-banner">
					<Icon name="alert-triangle" />
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

			{errorMessage ? (
				<Alert variant="destructive" data-testid="setup-services-error-banner">
					<Icon name="alert-triangle" />
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			) : null}

			{/* Service shifts */}
			<Frame data-testid="setup-services-card">
				<FrameHeader>
					<FrameTitle>
						<Trans>Service shifts</Trans>
					</FrameTitle>
					<FrameDescription>
						<Trans>
							The meal periods guests can book, such as lunch or dinner. Each
							one has the days it runs and its first and last seating.
						</Trans>
					</FrameDescription>
					<FrameAction>
						{canWrite ? (
							<Button
								type="button"
								size="sm"
								onClick={openCreate}
								data-testid="setup-new-service-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add service</Trans>
							</Button>
						) : null}
					</FrameAction>
				</FrameHeader>
				<FramePanel className="p-0">
					{loading ? (
						<div className="flex flex-col gap-2 p-4" aria-busy="true">
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
							<Skeleton className="h-10 w-full" />
						</div>
					) : services.length === 0 ? (
						<div className="p-4" data-testid="setup-services-empty">
							<EmptyState
								icons={['clock', 'calendar', 'check-circle']}
								title={_(msg`No service shifts yet`)}
								description={_(
									msg`Add your first shift, for example Dinner from 17:00 to 23:00, so guests can start booking.`,
								)}
							>
								{canWrite ? (
									<Button type="button" size="sm" onClick={openCreate}>
										<Icon name="plus" className="size-4" />
										<Trans>Create a service</Trans>
									</Button>
								) : null}
							</EmptyState>
						</div>
					) : (
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Service</Trans>
									</TableHead>
									<TableHead>
										<Trans>Days</Trans>
									</TableHead>
									<TableHead>
										<Trans>Seatings</Trans>
									</TableHead>
									<TableHead>
										<Trans>Dining time</Trans>
									</TableHead>
									<TableHead>
										<Trans>Booking</Trans>
									</TableHead>
									<TableHead className="text-end">
										<span className="sr-only">
											<Trans>Actions</Trans>
										</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{services.map((svc) => {
									const onlineFlag =
										svc.onlineBookable ?? svc.isBookableOnline ?? true
									const first = formatMinutesLabel(svc.firstSeatingMin)
									const last = formatMinutesLabel(svc.lastSeatingMin)
									const end = formatMinutesLabel(svc.endMin)
									const nameLabel = svc.name
									return (
										<TableRow
											key={svc.id}
											data-testid={`setup-service-row-${svc.name}`}
											className={canWrite ? 'cursor-pointer' : undefined}
											onClick={canWrite ? () => openEdit(svc) : undefined}
										>
											<TableCell className="font-medium">
												<div className="flex min-w-0 flex-col">
													<span className="wrap-anywhere">{svc.name}</span>
													{svc.nameI18n?.ar ? (
														<span className="text-muted-foreground text-xs wrap-anywhere">
															{svc.nameI18n.ar}
														</span>
													) : null}
												</div>
											</TableCell>
											<TableCell className="text-sm">
												{formatDaysOfWeek(svc.daysOfWeek, _)}
											</TableCell>
											<TableCell className="text-sm tabular-nums">
												<div className="flex flex-col">
													<span>{_(msg`${first} to ${last}`)}</span>
													<span className="text-muted-foreground text-xs">
														{_(msg`Ends ${end}`)}
													</span>
												</div>
											</TableCell>
											<TableCell className="text-sm tabular-nums">
												{turnSummary(svc)}
											</TableCell>
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
											<TableCell className="text-end">
												{canWrite ? (
													<div className="flex items-center justify-end gap-1">
														<Button
															type="button"
															variant="ghost"
															size="icon-sm"
															aria-label={_(msg`Edit ${nameLabel}`)}
															onClick={(e) => {
																e.stopPropagation()
																openEdit(svc)
															}}
															data-testid={`setup-edit-service-${svc.name}`}
														>
															<Icon name="pencil" className="size-4" />
														</Button>
														<Button
															type="button"
															variant="ghost"
															size="icon-sm"
															aria-label={_(msg`Delete ${nameLabel}`)}
															onClick={(e) => {
																e.stopPropagation()
																setDeleteTarget({
																	kind: 'service',
																	id: svc.id,
																	label: svc.name,
																})
															}}
															data-testid={`setup-delete-service-${svc.name}`}
														>
															<Icon name="trash-2" className="size-4" />
														</Button>
													</div>
												) : (
													READ_ONLY_CELL
												)}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					)}
				</FramePanel>
			</Frame>

			{/* Turn times */}
			<RuleSection
				testId="setup-turn-times-card"
				toggleTestId="setup-section-turn-times-toggle"
				title={<Trans>Dining time by party size (advanced)</Trans>}
				description={
					<Trans>
						How long each party usually stays. The system uses this to know when
						a table is free again. Every party size from 1 to {onlinePartyMax}{' '}
						needs a time.
					</Trans>
				}
				defaultOpen={false}
				badge={
					turnBuckets.length === 0 ? (
						<Badge variant="secondary" data-testid="turn-times-default-badge">
							{_(msg`Default ${defaultTurnMin} min`)}
						</Badge>
					) : contiguity.covered ? (
						<Badge variant="success" data-testid="turn-times-contiguous-badge">
							<Icon name="check" className="size-3.5" />
							<Trans>Custom for 1–{onlinePartyMax}</Trans>
						</Badge>
					) : (
						<Badge variant="destructive" data-testid="turn-times-gap-badge">
							<Icon name="alert-triangle" className="size-3.5" />
							<Trans>Missing party sizes: {gapSummaryLabel}</Trans>
						</Badge>
					)
				}
			>
				{canWrite ? (
					<form
						onSubmit={(e) => void handleCreateTurnBucket(e)}
						className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-5"
						data-testid="setup-create-turn-time-form"
					>
						<div
							data-testid="setup-turn-time-service-select"
							className="min-w-0"
						>
							<SelectField
								label={<Trans>Applies to</Trans>}
								options={scopeOptions}
								value={ttServiceId}
								onValueChange={setTtServiceId}
							/>
						</div>
						<TextField
							label={<Trans>Smallest party</Trans>}
							type="number"
							min={1}
							max={99}
							value={ttPartyMin}
							onChange={(e) => setTtPartyMin(Number(e.target.value) || 1)}
							data-testid="setup-turn-time-party-min"
						/>
						<TextField
							label={<Trans>Largest party</Trans>}
							type="number"
							min={1}
							max={99}
							value={ttPartyMax}
							onChange={(e) => setTtPartyMax(Number(e.target.value) || 2)}
							data-testid="setup-turn-time-party-max"
						/>
						<TextField
							label={<Trans>Minutes at the table</Trans>}
							hint={<Trans>In 15-minute steps.</Trans>}
							type="number"
							min={15}
							max={720}
							step={15}
							value={ttDurationMin}
							onChange={(e) => setTtDurationMin(Number(e.target.value) || 60)}
							data-testid="setup-turn-time-duration"
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={busy}
							data-testid="setup-add-turn-time-button"
						>
							<Icon name="plus" className="size-4" />
							<Trans>Add time</Trans>
						</Button>
					</form>
				) : null}

				{turnBuckets.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							No dining times yet. Until you add them, the default time is used.
						</Trans>
					</p>
				) : (
					<RulesTable>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Applies to</Trans>
								</TableHead>
								<TableHead>
									<Trans>Party size</Trans>
								</TableHead>
								<TableHead>
									<Trans>Dining time</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{turnBuckets.map((bucket) => {
								const svcLabel = bucket.serviceId
									? (services.find((s) => s.id === bucket.serviceId)?.name ??
										bucket.serviceId)
									: allServicesLabel
								const durationVal = bucket.minutes ?? bucket.turnTimeMin ?? 90
								const range = `${bucket.partyMin}–${bucket.partyMax}`
								return (
									<TableRow
										key={bucket.id}
										data-testid={`setup-turn-bucket-row-${bucket.partyMin}-${bucket.partyMax}`}
									>
										<TableCell>{svcLabel}</TableCell>
										<TableCell className="font-medium tabular-nums">
											{_(msg`${range} guests`)}
										</TableCell>
										<TableCell className="tabular-nums">
											{_(msg`${durationVal} min`)}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={_(
														msg`Delete dining time for ${range} guests`,
													)}
													onClick={() =>
														setDeleteTarget({
															kind: 'turn',
															id: bucket.id,
															label: range,
														})
													}
													data-testid={`setup-delete-turn-bucket-${bucket.partyMin}-${bucket.partyMax}`}
												>
													<Icon name="trash-2" className="size-4" />
												</Button>
											) : (
												READ_ONLY_CELL
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</RulesTable>
				)}
			</RuleSection>

			{/* Pacing */}
			<RuleSection
				testId="setup-pacing-card"
				toggleTestId="setup-section-pacing-toggle"
				title={<Trans>Pacing (advanced)</Trans>}
				description={
					<Trans>
						Optional. Limit how many guests or parties can be seated in the same
						time window, so the kitchen is never swamped.
					</Trans>
				}
				defaultOpen={pacingRules.length > 0}
			>
				{canWrite ? (
					<form
						onSubmit={(e) => void handleCreatePacingRule(e)}
						className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-3"
						data-testid="setup-create-pacing-form"
					>
						<div data-testid="setup-pacing-service-select" className="min-w-0">
							<SelectField
								label={<Trans>Service</Trans>}
								options={scopeOptions}
								value={paceServiceId}
								onValueChange={setPaceServiceId}
							/>
						</div>
						<div data-testid="setup-pacing-window-select" className="min-w-0">
							<SelectField
								label={<Trans>Time window</Trans>}
								options={intervalOptions}
								value={String(paceBucketMin)}
								onValueChange={(v) => setPaceBucketMin(Number(v) as Interval)}
							/>
						</div>
						<div data-testid="setup-pacing-channel-select" className="min-w-0">
							<SelectField
								label={<Trans>Counts bookings from</Trans>}
								options={[
									{ value: 'all', label: _(msg`All channels`) },
									{ value: 'online', label: _(msg`Online only`) },
								]}
								value={paceChannel}
								onValueChange={(v) => setPaceChannel(v as PacingChannel)}
							/>
						</div>
						<TextField
							label={<Trans>Max guests</Trans>}
							type="number"
							min={1}
							max={999}
							value={paceMaxCovers}
							onChange={(e) => setPaceMaxCovers(e.target.value)}
							data-testid="setup-pacing-max-covers"
						/>
						<TextField
							label={<Trans>Max parties</Trans>}
							type="number"
							min={1}
							max={999}
							value={paceMaxParties}
							onChange={(e) => setPaceMaxParties(e.target.value)}
							data-testid="setup-pacing-max-parties"
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={busy}
							data-testid="setup-add-pacing-button"
						>
							<Icon name="plus" className="size-4" />
							<Trans>Add pacing rule</Trans>
						</Button>
					</form>
				) : null}

				{pacingRules.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							No pacing limits. Bookings are only limited by tables.
						</Trans>
					</p>
				) : (
					<RulesTable>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Service</Trans>
								</TableHead>
								<TableHead>
									<Trans>Time window</Trans>
								</TableHead>
								<TableHead>
									<Trans>Max guests</Trans>
								</TableHead>
								<TableHead>
									<Trans>Max parties</Trans>
								</TableHead>
								<TableHead>
									<Trans>Channel</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{pacingRules.map((rule) => {
								const svcLabel = rule.serviceId
									? (services.find((s) => s.id === rule.serviceId)?.name ??
										rule.serviceId)
									: allServicesLabel
								const bucketVal = rule.bucketMin ?? rule.windowMinutes ?? 15
								return (
									<TableRow
										key={rule.id}
										data-testid={`setup-pacing-row-${bucketVal}`}
									>
										<TableCell>{svcLabel}</TableCell>
										<TableCell className="tabular-nums">
											{_(msg`${bucketVal} min`)}
										</TableCell>
										<TableCell className="tabular-nums">
											{rule.maxCovers ?? '—'}
										</TableCell>
										<TableCell className="tabular-nums">
											{rule.maxParties ?? '—'}
										</TableCell>
										<TableCell>
											{rule.channel === 'online'
												? _(msg`Online only`)
												: _(msg`All channels`)}
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={_(msg`Delete pacing rule`)}
													onClick={() =>
														setDeleteTarget({
															kind: 'pacing',
															id: rule.id,
															label: svcLabel,
														})
													}
													data-testid={`setup-delete-pacing-${rule.id}`}
												>
													<Icon name="trash-2" className="size-4" />
												</Button>
											) : (
												READ_ONLY_CELL
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</RulesTable>
				)}
			</RuleSection>

			{/* Per-service availability */}
			<RuleSection
				testId="setup-service-availability-card"
				toggleTestId="setup-section-availability-toggle"
				title={<Trans>Where each service can seat</Trans>}
				description={
					<Trans>
						Optional. By default every area and table is open to every service.
						Add an override to keep a place staff-only, walk-in only or closed
						during one service.
					</Trans>
				}
				defaultOpen={availRules.length > 0}
			>
				{canWrite ? (
					services.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Add a service first to set overrides.</Trans>
						</p>
					) : (
						<form
							onSubmit={(e) => void handleCreateAvailabilityRule(e)}
							className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2 lg:grid-cols-3"
							data-testid="setup-create-availability-form"
						>
							<div data-testid="setup-avail-service-select" className="min-w-0">
								<SelectField
									label={<Trans>Service</Trans>}
									options={serviceOptions}
									value={availServiceId || services[0]?.id || ''}
									onValueChange={setAvailServiceId}
								/>
							</div>
							<div
								data-testid="setup-avail-target-type-select"
								className="min-w-0"
							>
								<SelectField
									label={<Trans>Applies to a</Trans>}
									options={[
										{ value: 'area', label: _(msg`Dining area`) },
										{ value: 'table', label: _(msg`Table`) },
										{ value: 'combo', label: _(msg`Table combination`) },
									]}
									value={availTargetType}
									onValueChange={(v) => {
										setAvailTargetType(v as AvailabilityTargetType)
										setAvailTargetId('')
									}}
								/>
							</div>
							<div
								data-testid="setup-avail-target-id-select"
								className="min-w-0"
							>
								<SelectField
									label={<Trans>Which one</Trans>}
									options={availableTargets.map((item) => ({
										value: item.id,
										label: item.label,
									}))}
									value={availTargetId || availableTargets[0]?.id || ''}
									onValueChange={setAvailTargetId}
								/>
							</div>
							<div data-testid="setup-avail-mode-select" className="min-w-0">
								<SelectField
									label={<Trans>During this service</Trans>}
									options={[
										{ value: 'online', label: _(msg`Online & In-house`) },
										{ value: 'staff_only', label: _(msg`Staff only`) },
										{ value: 'walk_in_only', label: _(msg`Walk-in only`) },
										{ value: 'unavailable', label: _(msg`Unavailable`) },
									]}
									value={availMode}
									onValueChange={(v) =>
										setAvailMode(v as ServiceAvailabilityMode)
									}
								/>
							</div>
							<Button
								type="submit"
								variant="outline"
								disabled={busy}
								data-testid="setup-add-avail-button"
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add override</Trans>
							</Button>
						</form>
					)
				) : null}

				{availRules.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No overrides. Every service can use every table.</Trans>
					</p>
				) : (
					<RulesTable>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Service</Trans>
								</TableHead>
								<TableHead>
									<Trans>Type</Trans>
								</TableHead>
								<TableHead>
									<Trans>Place</Trans>
								</TableHead>
								<TableHead>
									<Trans>Mode</Trans>
								</TableHead>
								<TableHead className="text-end">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{availRules.map((rule) => {
								const svcLabel =
									services.find((s) => s.id === rule.serviceId)?.name ??
									rule.serviceId
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
										<TableCell>{targetTypeLabel(rule)}</TableCell>
										<TableCell className="font-medium">{targetLabel}</TableCell>
										<TableCell>
											<Badge variant="outline">
												{AVAILABILITY_MODE_LABELS[rule.mode]
													? _(AVAILABILITY_MODE_LABELS[rule.mode]!)
													: rule.mode}
											</Badge>
										</TableCell>
										<TableCell className="text-end">
											{canWrite ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={_(msg`Remove availability override`)}
													onClick={() =>
														setDeleteTarget({
															kind: 'avail',
															id: rule.id,
															label: targetLabel,
														})
													}
													data-testid={`setup-delete-avail-${rule.id}`}
												>
													<Icon name="trash-2" className="size-4" />
												</Button>
											) : (
												READ_ONLY_CELL
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</RulesTable>
				)}
			</RuleSection>

			{/* Create / edit service */}
			<Sheet
				open={sheet !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setSheet(null)
				}}
			>
				<SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
					{sheet ? (
						<SheetForm
							title={
								sheet.mode === 'create' ? (
									<Trans>Add a service</Trans>
								) : (
									<Trans>Edit service</Trans>
								)
							}
							description={
								<Trans>
									Guests can book between the first and last seating. The
									service ends at the time you set.
								</Trans>
							}
							onSubmit={(e) => void handleSubmitService(e)}
							footer={
								<>
									<Button
										type="button"
										variant="outline"
										disabled={busy}
										onClick={() => setSheet(null)}
									>
										<Trans>Cancel</Trans>
									</Button>
									<Button
										type="submit"
										disabled={busy}
										data-testid={
											sheet.mode === 'create'
												? 'setup-add-service-button'
												: 'setup-save-service-edit-button'
										}
									>
										{sheet.mode === 'create' ? (
											<Trans>Add service</Trans>
										) : (
											<Trans>Save changes</Trans>
										)}
									</Button>
								</>
							}
						>
							{sheetError ? (
								<Alert
									variant="destructive"
									data-testid="setup-service-form-error"
								>
									<AlertDescription>{sheetError}</AlertDescription>
								</Alert>
							) : null}
							<TextField
								label={<Trans>Name</Trans>}
								placeholder={_(msg`e.g. Late Dinner`)}
								value={form.name}
								onChange={(e) => patchForm({ name: e.target.value })}
								data-testid="setup-service-name-input"
							/>
							<TextField
								label={<Trans>Arabic name</Trans>}
								optional
								dir="rtl"
								placeholder={_(msg`Arabic service name`)}
								value={form.nameAr}
								onChange={(e) => patchForm({ nameAr: e.target.value })}
								data-testid="setup-service-name-ar-input"
							/>
							<Field>
								<FieldLabel>
									<Trans>Runs on</Trans>
								</FieldLabel>
								<div className="flex flex-wrap gap-1.5">
									{WEEKDAY_OPTIONS.map((day) => {
										const active = form.days.includes(day.value)
										return (
											<Button
												key={day.value}
												type="button"
												size="sm"
												className="h-11 md:h-7"
												variant={active ? 'default' : 'outline'}
												aria-pressed={active}
												onClick={() => handleToggleDay(day.value)}
												data-testid={`setup-service-day-${day.code}`}
											>
												{_(day.shortLabel)}
											</Button>
										)
									})}
								</div>
							</Field>
							<div className="grid grid-cols-2 gap-4">
								<TextField
									label={<Trans>First seating</Trans>}
									type="time"
									value={form.first}
									onChange={(e) => patchForm({ first: e.target.value })}
									data-testid="setup-service-first-time-input"
								/>
								<TextField
									label={<Trans>Last seating</Trans>}
									type="time"
									value={form.last}
									onChange={(e) => patchForm({ last: e.target.value })}
									data-testid="setup-service-last-time-input"
								/>
								<TextField
									label={<Trans>Service ends</Trans>}
									type="time"
									value={form.end}
									onChange={(e) => patchForm({ end: e.target.value })}
									data-testid="setup-service-end-time-input"
								/>
								<div className="flex items-end pb-2">
									<Field orientation="horizontal">
										<Checkbox
											id="svc-next-day"
											checked={form.nextDay}
											onCheckedChange={(v) =>
												patchForm({ nextDay: Boolean(v) })
											}
											data-testid="setup-service-next-day-checkbox"
										/>
										<FieldLabel htmlFor="svc-next-day" className="font-normal">
											<Trans>Ends after midnight</Trans>
										</FieldLabel>
									</Field>
								</div>
							</div>
							<SelectField
								label={<Trans>Booking times every</Trans>}
								hint={
									<Trans>
										How far apart the times guests can pick are, for example
										18:00, 18:15, 18:30.
									</Trans>
								}
								options={intervalOptions}
								value={String(form.interval)}
								onValueChange={(v) =>
									patchForm({ interval: Number(v) as Interval })
								}
							/>
							<SwitchField
								label={<Trans>Bookable online</Trans>}
								description={
									<Trans>
										Turn off to keep this service for staff bookings only.
									</Trans>
								}
								checked={form.online}
								onCheckedChange={(online) => patchForm({ online })}
							/>
						</SheetForm>
					) : null}
				</SheetContent>
			</Sheet>

			{/* Delete confirm */}
			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setDeleteTarget(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{deleteTitle}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget?.kind === 'service' ? (
								<Trans>
									Guests will no longer be able to book this service. Existing
									reservations are not cancelled.
								</Trans>
							) : (
								<Trans>
									This rule stops applying right away. You can add it again
									later.
								</Trans>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => void confirmDelete()}
							data-testid="setup-confirm-delete-button"
						>
							<Trans>Delete</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
