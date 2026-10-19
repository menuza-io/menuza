import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating } from '@repo/auth'
import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	Link,
	Outlet,
	useLoaderData,
	useLocation,
	useOutletContext,
	useSearchParams,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { SetupStatusBadge } from '#app/components/reservations/settings/setup-diagnostics.tsx'
import { useSetupFlag } from '#app/components/reservations/settings/use-setup-flag.ts'
import { ReservationsHeaderMeta } from '#app/components/reservations/shell-context.tsx'
import { useReservationsClient } from '#app/hooks/use-reservations-client.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { fetchMessageSettings } from '#app/utils/reservations/messages-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	type ServiceDto,
	extractApiErrorMessage,
	fetchLocationSettings,
	fetchServices,
	fetchTables,
	fetchSetupConflicts,
	fetchSetupValidation,
	type LocationSettingsDto,
	rederiveLocationTimes,
	type SetupConflictDto,
	type SetupValidationResponse,
} from '#app/utils/reservations/setup-api.ts'
import {
	deriveSetupSteps,
	describeSetupIssues,
	type SetupStep,
	type SetupStepId,
	summarizeSetupStatus,
	type SetupIssueItem,
	type SetupStatus,
} from '#app/utils/reservations/setup-progress.ts'
import { type Route } from './+types/settings.ts'

export type SetupLocationItem = {
	id: string
	name: string
	slug: string
	timezone: string
	isDefault: boolean
	isActive: boolean
}

export type ReservationsSetupOutletContext = {
	orgSlug: string
	locations: SetupLocationItem[]
	selectedLocationId: string
	selectedLocation: SetupLocationItem | null
	canWrite: boolean
	isImpersonated: boolean
	client: ReservationsScopedClient
	settings: LocationSettingsDto | null
	validation: SetupValidationResponse | null
	conflicts: SetupConflictDto[]
	loadingSummary: boolean
	summaryError: string | null
	refreshSummary: () => Promise<void>
	/** Single source of truth for "can guests book?"; null until loaded. */
	setupStatus: SetupStatus | null
	setupIssues: SetupIssueItem[]
	setupSteps: SetupStep[]
	markSetupStep: (id: SetupStepId) => void
	setupChecklistDismissed: boolean
	dismissSetupChecklist: () => void
	setSettingsState: (next: LocationSettingsDto) => void
}

export function useReservationsSetupContext(): ReservationsSetupOutletContext {
	return useOutletContext<ReservationsSetupOutletContext>()
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(
		request,
		params.orgSlug,
		RESERVATIONS_SECTION_REQUIREMENTS.settings,
	)

	const [impersonated, locationRows, defaultLocale] = await Promise.all([
		isImpersonating(request),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				slug: OrganizationLocation.slug,
				timezone: OrganizationLocation.timezone,
				isDefault: OrganizationLocation.isDefault,
				isActive: OrganizationLocation.isActive,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, access.organizationId))
			.orderBy(
				desc(OrganizationLocation.isDefault),
				asc(OrganizationLocation.createdAt),
			),
		orgDefaultLocale(access.organizationId),
	])

	const scopedLocations: SetupLocationItem[] = (
		access.locationIds === null
			? locationRows
			: locationRows.filter((loc) => access.locationIds!.includes(loc.id))
	).map((loc) => ({
		...loc,
		name: displayLocationName(loc.name, defaultLocale, defaultLocale),
	}))

	const canWrite =
		!impersonated &&
		access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS)

	return {
		orgSlug: access.organizationSlug,
		locations: scopedLocations,
		canWrite,
		isImpersonated: impersonated,
		waitlistEnabled: access.features.waitlist,
		paymentsEnabled: access.features.payments,
	}
}

export default function ReservationsSettingsRoute() {
	const { _ } = useLingui()
	const {
		orgSlug,
		locations,
		canWrite,
		isImpersonated,
		waitlistEnabled,
		paymentsEnabled,
	} = useLoaderData<typeof loader>()
	const location = useLocation()
	const [searchParams] = useSearchParams()

	const selectedLocationId =
		searchParams.get('location') ??
		searchParams.get('locationId') ??
		locations[0]?.id ??
		''

	const selectedLocation = useMemo(
		() =>
			locations.find((loc) => loc.id === selectedLocationId) ??
			locations[0] ??
			null,
		[locations, selectedLocationId],
	)

	const client = useReservationsClient(
		'setup',
		selectedLocationId ? [selectedLocationId] : undefined,
	)

	// Booking details (code, party size) need the book scope, not setup.
	const bookClient = useReservationsClient(
		'book',
		selectedLocationId ? [selectedLocationId] : undefined,
	)

	const [settings, setSettings] = useState<LocationSettingsDto | null>(null)
	const [validation, setValidation] = useState<SetupValidationResponse | null>(
		null,
	)
	const [conflicts, setConflicts] = useState<SetupConflictDto[]>([])
	const [loadingSummary, setLoadingSummary] = useState<boolean>(true)
	const [summaryError, setSummaryError] = useState<string | null>(null)
	const [serviceList, setServiceList] = useState<ServiceDto[] | null>(null)
	const [tableCount, setTableCount] = useState<number | null>(null)
	const [enabledMessages, setEnabledMessages] = useState<number | null>(null)
	const flagKey = (name: string) =>
		`menuza:rsv-setup:${selectedLocationId}:${name}`
	const [rulesReviewed, setRulesReviewed] = useSetupFlag(flagKey('rules'))
	const [bookingTested, setBookingTested] = useSetupFlag(flagKey('test'))
	const [checklistDismissed, setChecklistDismissed] = useSetupFlag(
		flagKey('dismissed'),
	)
	const [rederiving, setRederiving] = useState(false)
	const [rederiveResult, setRederiveResult] = useState<string | null>(null)

	const refreshSummary = useCallback(async () => {
		if (!selectedLocationId) {
			setLoadingSummary(false)
			return
		}
		setLoadingSummary(true)
		setSummaryError(null)
		try {
			// The checklist inputs reuse the clients the sub-pages already use.
			// A failure there only leaves that step "unknown"; it never blocks.
			const [
				settingsRes,
				validationRes,
				conflictsRes,
				servicesRes,
				tablesRes,
				messagesRes,
			] = await Promise.all([
				fetchLocationSettings(client, selectedLocationId),
				fetchSetupValidation(client, selectedLocationId),
				fetchSetupConflicts(client, selectedLocationId, {
					detailClient: bookClient,
				}),
				fetchServices(client, selectedLocationId).catch(() => null),
				fetchTables(client, selectedLocationId).catch(() => null),
				fetchMessageSettings(client, selectedLocationId).catch(() => null),
			])
			setServiceList(servicesRes ? servicesRes.services : null)
			setTableCount(
				tablesRes ? tablesRes.tables.filter((t) => !t.archivedAt).length : null,
			)
			setEnabledMessages(
				messagesRes ? messagesRes.kinds.filter((k) => k.enabled).length : null,
			)
			setSettings(settingsRes.settings)
			setValidation(validationRes)
			setConflicts(conflictsRes.conflicts ?? [])
		} catch (err) {
			setSummaryError(
				extractApiErrorMessage(
					err,
					_(msg`Failed to load reservation setup for this location.`),
				),
			)
		} finally {
			setLoadingSummary(false)
		}
	}, [client, bookClient, selectedLocationId, _])

	useEffect(() => {
		void refreshSummary()
	}, [refreshSummary])

	const hasTzMismatch = Boolean(
		settings &&
		(settings.tzMismatch ||
			(selectedLocation?.timezone &&
				settings.timeZone &&
				selectedLocation.timezone !== settings.timeZone)),
	)

	const handleRederiveTimes = async () => {
		if (!canWrite || !selectedLocationId || rederiving) return
		setRederiving(true)
		setRederiveResult(null)
		try {
			const res = await rederiveLocationTimes(
				client,
				selectedLocationId,
				selectedLocation?.timezone,
			)
			if (res.settings) {
				setSettings(res.settings)
			}
			const syncedTimeZone = res.timeZone
			const updatedReservationCount = res.updatedReservations
			setRederiveResult(
				_(
					msg`Time zone synchronized to ${syncedTimeZone}. Updated ${updatedReservationCount} upcoming reservation(s).`,
				),
			)
			await refreshSummary()
		} catch (err) {
			setSummaryError(
				extractApiErrorMessage(
					err,
					_(msg`Failed to re-derive reservation times.`),
				),
			)
		} finally {
			setRederiving(false)
		}
	}

	const activeServices = useMemo(
		() => (serviceList ? serviceList.filter((x) => !x.archivedAt) : null),
		[serviceList],
	)
	const setupIssueInputs = validation?.issues
	const setupStatus = useMemo(() => {
		if (loadingSummary || !validation) return null
		return summarizeSetupStatus(validation.issues, {
			noServices: activeServices !== null && activeServices.length === 0,
			noTables: tableCount === 0,
		})
	}, [loadingSummary, validation, activeServices, tableCount])
	const setupIssues = useMemo(
		() =>
			describeSetupIssues(
				setupIssueInputs ?? [],
				new Map((activeServices ?? []).map((x) => [x.id, x.name])),
				{
					noServices: activeServices !== null && activeServices.length === 0,
					noTables: tableCount === 0,
				},
			),
		[setupIssueInputs, activeServices, tableCount],
	)
	const setupSteps = useMemo(
		() =>
			deriveSetupSteps({
				serviceCount: activeServices ? activeServices.length : null,
				tableCount,
				enabledMessageCount: enabledMessages,
				settingsVersion: settings ? settings.version : null,
				rulesReviewed,
				bookingTested,
				issues: validation?.issues ?? [],
			}),
		[
			activeServices,
			tableCount,
			enabledMessages,
			settings,
			rulesReviewed,
			bookingTested,
			validation,
		],
	)
	const markSetupStep = (id: SetupStepId) => {
		if (id === 'rules') setRulesReviewed(true)
		if (id === 'test') setBookingTested(true)
	}
	const nextStepId = setupSteps.find((x) => x.next)?.id ?? null

	const basePath = `/${orgSlug}/reservations/settings`
	const searchSuffix = searchParams.toString()
		? `?${searchParams.toString()}`
		: selectedLocationId
			? `?location=${encodeURIComponent(selectedLocationId)}`
			: ''

	// Five groups instead of nine flat tabs. Every sub-section keeps its route.
	type SetupLeaf = {
		id: string
		label: string
		purpose: string
		pathname: string
		exact: boolean
	}
	const leaf = (
		id: string,
		label: string,
		purpose: string,
		suffix: string,
		exact = false,
	): SetupLeaf => ({
		id,
		label,
		purpose,
		pathname: `${basePath}${suffix}`,
		exact,
	})
	const groups: Array<{ id: string; label: string; leaves: SetupLeaf[] }> = [
		{
			id: 'rules',
			label: _(msg`Rules`),
			leaves: [
				leaf(
					'general',
					_(msg`Booking rules`),
					_(
						msg`Who can book online, how far ahead, and how bookings are confirmed.`,
					),
					'',
					true,
				),
				...(paymentsEnabled
					? [
							leaf(
								'policies',
								_(msg`Payment policies`),
								_(
									msg`Ask guests for a deposit and set when they can cancel for free.`,
								),
								'/policies',
							),
						]
					: []),
			],
		},
		{
			id: 'services',
			label: _(msg`Services`),
			leaves: [
				leaf(
					'services',
					_(msg`Services & turn times`),
					_(
						msg`The meal periods guests can book and how long they keep a table.`,
					),
					'/services',
				),
				leaf(
					'special-days',
					_(msg`Special days & blocks`),
					_(
						msg`Holidays, private events and times when tables are not available.`,
					),
					'/special-days',
				),
			],
		},
		{
			id: 'floor',
			label: _(msg`Floor`),
			leaves: [
				leaf(
					'tables',
					_(msg`Tables & areas`),
					_(msg`The tables guests sit at, grouped into dining areas.`),
					'/tables',
				),
				leaf(
					'sections',
					_(msg`Sections`),
					_(
						msg`Split the floor between servers so each one owns a group of tables.`,
					),
					'/sections',
				),
				leaf(
					'floor-plan',
					_(msg`Floor plan`),
					_(msg`Arrange tables as they are in your room.`),
					'/floor-plan',
				),
			],
		},
		{
			id: 'messages',
			label: _(msg`Messages`),
			leaves: [
				leaf(
					'messages',
					_(msg`Guest messages`),
					_(msg`The confirmations and reminders guests receive.`),
					'/messages',
				),
			],
		},
		...(waitlistEnabled
			? [
					{
						id: 'waitlist',
						label: _(msg`Waitlist`),
						leaves: [
							leaf(
								'waitlist',
								_(msg`Waitlist`),
								_(msg`Quote waits and message guests when tables are full.`),
								'/waitlist',
							),
						],
					},
				]
			: []),
	]
	const isLeafActive = (tab: SetupLeaf) =>
		tab.exact
			? location.pathname === tab.pathname ||
				location.pathname === `${tab.pathname}/`
			: location.pathname.startsWith(tab.pathname)

	const activeLeaf =
		groups.flatMap((g) => g.leaves).find((l) => isLeafActive(l)) ?? null
	const STEP_LEAF: Record<string, SetupStepId> = {
		services: 'hours',
		tables: 'tables',
		general: 'rules',
		messages: 'messages',
	}
	const isNextLeaf = (id: string) =>
		nextStepId !== null && STEP_LEAF[id] === nextStepId

	const outletContext: ReservationsSetupOutletContext = {
		orgSlug,
		locations,
		selectedLocationId,
		selectedLocation,
		canWrite,
		isImpersonated,
		client,
		settings,
		validation,
		conflicts,
		loadingSummary,
		summaryError,
		refreshSummary,
		setupStatus,
		setupIssues,
		setupSteps,
		markSetupStep,
		setupChecklistDismissed: checklistDismissed,
		dismissSetupChecklist: () => setChecklistDismissed(true),
		setSettingsState: setSettings,
	}

	const linkClass = (active: boolean) =>
		cn(
			'flex h-11 items-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap md:h-8',
			active
				? 'bg-muted text-foreground'
				: 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
		)

	return (
		<div className="flex flex-col gap-6" data-testid="reservations-setup-shell">
			<ReservationsHeaderMeta>
				{selectedLocation ? (
					<Badge variant="outline" data-testid="setup-location-badge">
						{selectedLocation.name} ({selectedLocation.timezone})
					</Badge>
				) : null}

				<SetupStatusBadge
					status={setupStatus}
					loading={loadingSummary && !validation}
				/>

				{!canWrite ? (
					<Badge variant="secondary" data-testid="setup-readonly-banner">
						<Icon name="lock" />
						{isImpersonated ? (
							<Trans>Read-only (impersonation)</Trans>
						) : (
							<Trans>Read-only access</Trans>
						)}
					</Badge>
				) : null}
			</ReservationsHeaderMeta>

			{/* Time-zone mismatch re-derive banner */}
			{hasTzMismatch ? (
				<Alert data-testid="setup-tz-mismatch-banner">
					<Icon name="alert-triangle" className="text-warning" />
					<AlertTitle>
						<Trans>Location time zone changed</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Re-derive future reservation times so upcoming bookings keep their
							intended local wall-clock seating time.
						</Trans>{' '}
						({settings?.timeZone ?? 'previous'} →{' '}
						{selectedLocation?.timezone ??
							settings?.contextTimeZone ??
							'updated'}
						)
						{canWrite ? (
							<div className="mt-2">
								<Button
									type="button"
									disabled={rederiving}
									onClick={() => void handleRederiveTimes()}
									data-testid="setup-rederive-times-button"
								>
									<Icon name="refresh-cw" />
									{rederiving ? (
										<Trans>Re-deriving…</Trans>
									) : (
										<Trans>Re-derive future reservation times</Trans>
									)}
								</Button>
							</div>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}

			{rederiveResult ? (
				<Alert role="status" data-testid="setup-rederive-success-banner">
					<Icon name="check-circle" className="text-success" />
					<AlertDescription>{rederiveResult}</AlertDescription>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="absolute end-1.5 top-1.5"
						aria-label={_(msg`Dismiss`)}
						onClick={() => setRederiveResult(null)}
					>
						<Icon name="x" />
					</Button>
				</Alert>
			) : null}

			<div className="flex flex-col gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start">
				<nav
					aria-label={_(msg`Reservations setup sections`)}
					className="lg:sticky lg:top-4"
					data-testid="reservations-setup-subnav"
				>
					<ul className="flex flex-wrap items-center gap-1 lg:flex-col lg:items-stretch">
						{groups.map((group) => {
							const groupActive = group.leaves.some(isLeafActive)
							const first = group.leaves[0]!
							const single = group.leaves.length === 1
							return (
								<li key={group.id} className="contents lg:block">
									<Link
										to={`${first.pathname}${searchSuffix}`}
										data-testid={
											single
												? `setup-tab-${first.id}`
												: `setup-group-${group.id}`
										}
										aria-current={
											single && groupActive
												? 'page'
												: groupActive
													? 'true'
													: undefined
										}
										className={cn(
											linkClass(groupActive && single),
											groupActive && !single && 'text-foreground',
										)}
									>
										{group.label}
										{group.leaves.some((l) => isNextLeaf(l.id)) &&
										!groupActive ? (
											<NextStepDot />
										) : null}
									</Link>
									{!single && groupActive ? (
										<ul className="contents lg:ms-2.5 lg:mt-0.5 lg:flex lg:flex-col lg:gap-0.5 lg:border-s lg:ps-1.5">
											{group.leaves.map((tab) => {
												const active = isLeafActive(tab)
												return (
													<li key={tab.id} className="contents lg:block">
														<Link
															to={`${tab.pathname}${searchSuffix}`}
															data-testid={`setup-tab-${tab.id}`}
															aria-current={active ? 'page' : undefined}
															className={linkClass(active)}
														>
															{tab.label}
															{isNextLeaf(tab.id) ? <NextStepDot /> : null}
														</Link>
													</li>
												)
											})}
										</ul>
									) : null}
								</li>
							)
						})}
					</ul>
				</nav>

				<div className="flex min-w-0 flex-col gap-6">
					{activeLeaf ? (
						<div
							className="flex flex-col gap-0.5"
							data-testid="setup-page-intro"
						>
							<h2 className="text-sm font-semibold">{activeLeaf.label}</h2>
							<p className="text-muted-foreground max-w-prose text-sm text-pretty">
								{activeLeaf.purpose}
							</p>
						</div>
					) : null}
					<Outlet context={outletContext} />
				</div>
			</div>
		</div>
	)
}

function NextStepDot() {
	const { _ } = useLingui()
	return (
		<span
			className="bg-primary ms-1.5 inline-block size-1.5 shrink-0 rounded-full"
			role="img"
			aria-label={_(msg`Next setup step`)}
			data-testid="setup-next-dot"
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
