import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating } from '@repo/auth'
import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
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
import { useReservationsClient } from '#app/hooks/use-reservations-client.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import {
	extractApiErrorMessage,
	fetchLocationSettings,
	fetchSetupConflicts,
	fetchSetupValidation,
	type LocationSettingsDto,
	rederiveLocationTimes,
	type SetupConflictDto,
	type SetupValidationResponse,
} from '#app/utils/reservations/setup-api.ts'
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
	}
}

export default function ReservationsSettingsRoute() {
	const { _ } = useLingui()
	const { orgSlug, locations, canWrite, isImpersonated } =
		useLoaderData<typeof loader>()
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

	const [settings, setSettings] = useState<LocationSettingsDto | null>(null)
	const [validation, setValidation] = useState<SetupValidationResponse | null>(
		null,
	)
	const [conflicts, setConflicts] = useState<SetupConflictDto[]>([])
	const [loadingSummary, setLoadingSummary] = useState<boolean>(true)
	const [summaryError, setSummaryError] = useState<string | null>(null)
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
			const [settingsRes, validationRes, conflictsRes] = await Promise.all([
				fetchLocationSettings(client, selectedLocationId),
				fetchSetupValidation(client, selectedLocationId),
				fetchSetupConflicts(client, selectedLocationId),
			])
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
	}, [client, selectedLocationId, _])

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

	const basePath = `/${orgSlug}/reservations/settings`
	const searchSuffix = searchParams.toString()
		? `?${searchParams.toString()}`
		: selectedLocationId
			? `?location=${encodeURIComponent(selectedLocationId)}`
			: ''

	const subTabs = [
		{
			id: 'general',
			label: _(msg`General & Policies`),
			pathname: basePath,
			exact: true,
		},
		{
			id: 'tables',
			label: _(msg`Tables & Areas`),
			pathname: `${basePath}/tables`,
			exact: false,
		},
		{
			id: 'floor-plan',
			label: _(msg`Floor Plan`),
			pathname: `${basePath}/floor-plan`,
			exact: false,
		},
		{
			id: 'services',
			label: _(msg`Services & Turn Times`),
			pathname: `${basePath}/services`,
			exact: false,
		},
		{
			id: 'special-days',
			label: _(msg`Special Days & Blocks`),
			pathname: `${basePath}/special-days`,
			exact: false,
		},
		{
			id: 'sections',
			label: _(msg`Sections`),
			pathname: `${basePath}/sections`,
			exact: false,
		},
	]

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
		setSettingsState: setSettings,
	}

	return (
		<div className="flex flex-col gap-6" data-testid="reservations-setup-shell">
			{/* Sub-navigation bar */}
			<div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
				<nav
					aria-label={_(msg`Reservations setup sections`)}
					className="flex flex-wrap items-center gap-1"
					data-testid="reservations-setup-subnav"
				>
					{subTabs.map((tab) => {
						const isActive = tab.exact
							? location.pathname === tab.pathname ||
								location.pathname === `${tab.pathname}/`
							: location.pathname.startsWith(tab.pathname)
						return (
							<Link
								key={tab.id}
								to={`${tab.pathname}${searchSuffix}`}
								data-testid={`setup-tab-${tab.id}`}
								className={
									isActive
										? 'bg-secondary text-secondary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
										: 'text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm font-medium'
								}
							>
								{tab.label}
							</Link>
						)
					})}
				</nav>

				<div className="flex flex-wrap items-center gap-2">
					{selectedLocation ? (
						<Badge variant="outline" data-testid="setup-location-badge">
							{selectedLocation.name} ({selectedLocation.timezone})
						</Badge>
					) : null}

					{validation ? (
						validation.valid ? (
							<Badge
								variant="outline"
								className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
								data-testid="setup-validation-status-badge"
							>
								<Icon name="check-circle" className="mr-1 size-3.5" />
								<Trans>Configuration valid</Trans>
							</Badge>
						) : (
							<Badge
								variant="outline"
								className="border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-300"
								data-testid="setup-validation-status-badge"
							>
								<Icon name="alert-triangle" className="mr-1 size-3.5" />
								<Trans>Setup issues</Trans> ({validation.errors.length})
							</Badge>
						)
					) : null}

					{!canWrite ? (
						<Badge variant="secondary" data-testid="setup-readonly-banner">
							<Icon name="lock" className="mr-1 size-3" />
							{isImpersonated ? (
								<Trans>Read-only (impersonation)</Trans>
							) : (
								<Trans>Read-only access</Trans>
							)}
						</Badge>
					) : null}
				</div>
			</div>

			{/* Time-zone mismatch re-derive banner */}
			{hasTzMismatch ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/15 p-4 text-sm"
					data-testid="setup-tz-mismatch-banner"
				>
					<div className="flex items-start gap-3">
						<Icon
							name="alert-triangle"
							className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400"
						/>
						<div className="flex flex-col gap-1">
							<p className="text-foreground font-semibold">
								<Trans>Location time zone changed</Trans>
							</p>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Re-derive future reservation times so upcoming bookings keep
									their intended local wall-clock seating time.
								</Trans>{' '}
								({settings?.timeZone ?? 'previous'} →{' '}
								{selectedLocation?.timezone ??
									settings?.contextTimeZone ??
									'updated'}
								)
							</p>
						</div>
					</div>
					{canWrite ? (
						<Button
							type="button"
							size="sm"
							disabled={rederiving}
							onClick={() => void handleRederiveTimes()}
							data-testid="setup-rederive-times-button"
						>
							<Icon name="refresh-cw" className="size-4" />
							{rederiving ? (
								<Trans>Re-deriving…</Trans>
							) : (
								<Trans>Re-derive future reservation times</Trans>
							)}
						</Button>
					) : null}
				</div>
			) : null}

			{rederiveResult ? (
				<div
					role="status"
					className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200"
					data-testid="setup-rederive-success-banner"
				>
					<span>{rederiveResult}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setRederiveResult(null)}
					>
						<Icon name="x" className="size-4" />
					</Button>
				</div>
			) : null}

			<Outlet context={outletContext} />
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
