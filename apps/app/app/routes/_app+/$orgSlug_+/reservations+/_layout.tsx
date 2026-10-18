import { isImpersonating } from '@repo/auth'
import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
import { useCallback, useState } from 'react'
import {
	Outlet,
	useLoaderData,
	useOutletContext,
	useSearchParams,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ReservationsChrome } from '#app/components/reservations/reservations-chrome.tsx'
import { ReservationsClientProvider } from '#app/components/reservations/reservations-client-provider.tsx'
import { useLiveNow } from '#app/hooks/use-live-now.ts'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import { DEFAULT_DAY_START_MIN } from '#app/utils/reservations/business-date.ts'
import {
	computeReservationsNavAccess,
	type ReservationsNavAccess,
} from '#app/utils/reservations/nav.ts'
import { RESERVATIONS_SECTION_PERMISSIONS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/_layout.ts'

export type ReservationsLayoutLocation = {
	id: string
	name: string
	slug: string
	timezone: string
	isDefault: boolean
	isActive: boolean
}

export type ReservationsLayoutContext = {
	orgSlug: string
	locations: ReservationsLayoutLocation[]
	activeLocationId: string
	selectedDate: string
	/** Business date "now" falls on for the active location (time zone and day start). */
	todayDate: string
	nav: ReservationsNavAccess
	/**
	 * Whether payment rows show in the detail sheet and whether this member may
	 * act on them. Flags and booleans only; the rows are read in the browser.
	 */
	payments: { enabled: boolean; canAct: boolean }
	/** Screens report the active location's day start once its feed has loaded. */
	reportServiceClock: (clock: {
		locationId: string
		dayStartMin: number
	}) => void
}

export function useReservationsLayoutData(): ReservationsLayoutContext {
	return useOutletContext<ReservationsLayoutContext>()
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireReservationsAccess(request, params.orgSlug, {
		feature: 'enabled',
		anyOf: RESERVATIONS_SECTION_PERMISSIONS,
	})

	const [locationRows, defaultLocale] = await Promise.all([
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

	const scopedLocations = (
		access.locationIds === null
			? locationRows
			: locationRows.filter((loc) => access.locationIds!.includes(loc.id))
	).map((loc) => ({
		...loc,
		name: displayLocationName(loc.name, defaultLocale, defaultLocale),
	}))

	const nav = computeReservationsNavAccess({
		enabled: true,
		features: access.features,
		grants: access.grants,
	})

	const impersonated = await isImpersonating(request)
	const payments = {
		enabled: access.features.payments,
		canAct:
			!impersonated &&
			access.features.payments &&
			access.grants.includes(
				RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_PAYMENT,
			),
	}

	return {
		orgSlug: access.organizationSlug,
		locations: scopedLocations,
		nav,
		payments,
		nowMs: Date.now(),
	}
}

export default function ReservationsLayout() {
	const { orgSlug, locations, nav, payments, nowMs } =
		useLoaderData<typeof loader>()
	const [searchParams, setSearchParams] = useSearchParams()

	const selectedLocationId =
		searchParams.get('locationId') ??
		searchParams.get('location') ??
		locations[0]?.id ??
		'all'
	const activeLocationId =
		selectedLocationId && selectedLocationId !== 'all'
			? selectedLocationId
			: (locations[0]?.id ?? '')
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]

	const [serviceClock, setServiceClock] = useState<{
		locationId: string
		dayStartMin: number
	} | null>(null)
	const reportServiceClock = useCallback(
		(clock: { locationId: string; dayStartMin: number }) => {
			setServiceClock((prev) =>
				prev?.locationId === clock.locationId &&
				prev.dayStartMin === clock.dayStartMin
					? prev
					: clock,
			)
		},
		[],
	)
	const liveNow = useLiveNow({
		timeZone: activeLocation?.timezone,
		dayStartMin:
			serviceClock && serviceClock.locationId === activeLocation?.id
				? serviceClock.dayStartMin
				: DEFAULT_DAY_START_MIN,
		initialNowMs: nowMs,
	})
	const todayDate = liveNow.businessDate
	const selectedDate = searchParams.get('date') ?? todayDate

	const updateParam = (key: string, value: string) => {
		const next = new URLSearchParams(searchParams)
		if (!value || value === 'all') {
			next.delete(key)
			if (key === 'locationId') next.delete('location')
		} else {
			next.set(key, value)
			if (key === 'locationId') next.set('location', value)
		}
		setSearchParams(next, { replace: true })
	}

	const layoutContext: ReservationsLayoutContext = {
		orgSlug,
		locations,
		activeLocationId,
		selectedDate,
		todayDate,
		nav,
		payments,
		reportServiceClock,
	}

	return (
		<ReservationsClientProvider orgSlug={orgSlug}>
			<ReservationsChrome
				orgSlug={orgSlug}
				nav={nav}
				locations={locations}
				selectedLocationId={selectedLocationId}
				onLocationChange={(value) => updateParam('locationId', value)}
			>
				<Outlet context={layoutContext} />
			</ReservationsChrome>
		</ReservationsClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
