import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { WorkspacePage } from '@repo/ui/workspace'
import {
	Link,
	Outlet,
	useLoaderData,
	useLocation,
	useOutletContext,
	useSearchParams,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ReservationsClientProvider } from '#app/components/reservations/reservations-client-provider.tsx'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	computeReservationsNavAccess,
	type ReservationsNavAccess,
} from '#app/utils/reservations/nav.ts'
import {
	RESERVATIONS_SECTION_PERMISSIONS,
	type ReservationsSection,
} from '#app/utils/reservations/sections.ts'
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
	selectedService: string
	nav: ReservationsNavAccess
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

	return {
		orgSlug: access.organizationSlug,
		locations: scopedLocations,
		nav,
		todayDate: new Date().toISOString().slice(0, 10),
	}
}

export default function ReservationsLayout() {
	const { _ } = useLingui()
	const { orgSlug, locations, nav, todayDate } = useLoaderData<typeof loader>()
	const location = useLocation()
	const [searchParams, setSearchParams] = useSearchParams()

	const selectedLocationId =
		searchParams.get('locationId') ??
		searchParams.get('location') ??
		locations[0]?.id ??
		'all'
	const selectedDate = searchParams.get('date') ?? todayDate
	const selectedService = searchParams.get('service') ?? 'all'

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

	const sections: Array<{
		id: ReservationsSection
		label: string
		href: string
		visible: boolean
	}> = [
		{
			id: 'today',
			label: _(msg`Today`),
			href: `/${orgSlug}/reservations/today`,
			visible: nav.today,
		},
		{
			id: 'book',
			label: _(msg`Book`),
			href: `/${orgSlug}/reservations/book`,
			visible: nav.book,
		},
		{
			id: 'waitlist',
			label: _(msg`Waitlist`),
			href: `/${orgSlug}/reservations/waitlist`,
			visible: nav.waitlist,
		},
		{
			id: 'guests',
			label: _(msg`Guests`),
			href: `/${orgSlug}/reservations/guests`,
			visible: nav.guests,
		},
		{
			id: 'experiences',
			label: _(msg`Experiences`),
			href: `/${orgSlug}/reservations/experiences`,
			visible: nav.experiences,
		},
		{
			id: 'reports',
			label: _(msg`Reports`),
			href: `/${orgSlug}/reservations/reports`,
			visible: nav.reports,
		},
		{
			id: 'settings',
			label: _(msg`Settings`),
			href: `/${orgSlug}/reservations/settings`,
			visible: nav.settings,
		},
	]

	const visibleSections = sections.filter((section) => section.visible)
	const activeLocationId =
		selectedLocationId && selectedLocationId !== 'all'
			? selectedLocationId
			: (locations[0]?.id ?? '')

	const isBookSubroute =
		location.pathname.startsWith(`/${orgSlug}/reservations/book`) ||
		location.pathname.startsWith(`/${orgSlug}/reservations/timeline`) ||
		location.pathname.startsWith(`/${orgSlug}/reservations/floor`) ||
		location.pathname.startsWith(`/${orgSlug}/reservations/calendar`) ||
		location.pathname.startsWith(`/${orgSlug}/reservations/overview`)

	const layoutContext: ReservationsLayoutContext = {
		orgSlug,
		locations,
		activeLocationId,
		selectedDate,
		selectedService,
		nav,
	}

	return (
		<ReservationsClientProvider orgSlug={orgSlug}>
			<WorkspacePage>
				<div className="flex flex-col gap-6">
					<div
						className="border-border bg-card flex flex-wrap items-center justify-between gap-4 rounded-xl border p-3"
						data-testid="reservations-header-controls"
					>
						<nav
							aria-label={_(msg`Reservations navigation`)}
							className="flex flex-wrap items-center gap-1"
						>
							{visibleSections.map((section) => {
								const isActive =
									section.id === 'book'
										? isBookSubroute
										: location.pathname.startsWith(section.href)
								return (
									<Link
										key={section.id}
										to={{
											pathname: section.href,
											search: searchParams.toString(),
										}}
										className={
											isActive
												? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
												: 'text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm font-medium'
										}
									>
										{section.label}
									</Link>
								)
							})}
						</nav>

						<div className="flex flex-wrap items-center gap-3">
							{locations.length > 1 ? (
								<div className="flex items-center gap-2">
									<Label
										htmlFor="reservations-location-select"
										className="text-muted-foreground text-xs font-medium"
									>
										<Trans>Location</Trans>
									</Label>
									<select
										id="reservations-location-select"
										aria-label={_(msg`Location`)}
										value={selectedLocationId}
										onChange={(event) =>
											updateParam('locationId', event.target.value)
										}
										className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
									>
										{locations.length === 0 ? (
											<option value="all">{_(msg`Main location`)}</option>
										) : (
											locations.map((loc) => (
												<option key={loc.id} value={loc.id}>
													{loc.name}
												</option>
											))
										)}
									</select>
								</div>
							) : null}

							<div className="flex items-center gap-2">
								<Label
									htmlFor="reservations-date-input"
									className="text-muted-foreground text-xs font-medium"
								>
									<Trans>Date</Trans>
								</Label>
								<Input
									id="reservations-date-input"
									aria-label={_(msg`Date`)}
									type="date"
									value={selectedDate}
									onChange={(event) => updateParam('date', event.target.value)}
									className="h-9 w-40"
								/>
							</div>

							<div className="flex items-center gap-2">
								<Label
									htmlFor="reservations-service-select"
									className="text-muted-foreground text-xs font-medium"
								>
									<Trans>Service</Trans>
								</Label>
								<select
									id="reservations-service-select"
									aria-label={_(msg`Service`)}
									value={selectedService}
									onChange={(event) =>
										updateParam('service', event.target.value)
									}
									className="border-input bg-background text-foreground h-9 rounded-md border px-2.5 text-sm"
								>
									<option value="all">{_(msg`All services`)}</option>
									<option value="lunch">{_(msg`Lunch`)}</option>
									<option value="dinner">{_(msg`Dinner`)}</option>
									<option value="brunch">{_(msg`Brunch`)}</option>
								</select>
							</div>
						</div>
					</div>

					<Outlet context={layoutContext} />
				</div>
			</WorkspacePage>
		</ReservationsClientProvider>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
