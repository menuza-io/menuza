import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import { type ReactNode, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { ReservationsHeaderControls } from '#app/components/reservations/header-controls.tsx'
import {
	type ReservationsShell,
	type ReservationsShellLocation,
	ReservationsShellProvider,
} from '#app/components/reservations/shell-context.tsx'
import { type ReservationsNavAccess } from '#app/utils/reservations/nav.ts'
import {
	isHostRoute,
	type ReservationsRouteKey,
	reservationsRouteKey,
	reservationsSectionTab,
	SELF_HEADED_ROUTE_KEYS,
} from '#app/utils/reservations/shell-routes.ts'

/**
 * The Reservations page chrome: ONE `PageHeader` (title, description, actions),
 * ONE underline section tab bar, then the screen. Day views add their context
 * bar (location, day views, date, service, area) through `HostSubnav`. Screens
 * fill the header's actions and meta slots with a portal.
 *
 * Screens that still render their own `PageHeader` (waitlist, guests, reports,
 * experiences; see `SELF_HEADED_ROUTE_KEYS`) get no layout header, so the page
 * never shows two. Remove a key from that list once its screen drops its own.
 */
export function ReservationsChrome({
	orgSlug,
	nav,
	locations,
	selectedLocationId,
	onLocationChange,
	children,
}: {
	orgSlug: string
	nav: ReservationsNavAccess
	locations: readonly ReservationsShellLocation[]
	selectedLocationId: string
	onLocationChange: (locationId: string) => void
	children: ReactNode
}) {
	const { _ } = useLingui()
	const location = useLocation()
	const [searchParams] = useSearchParams()
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
	const [metaSlot, setMetaSlot] = useState<HTMLElement | null>(null)

	const routeKey = reservationsRouteKey(location.pathname, orgSlug)
	const activeSectionTab = reservationsSectionTab(routeKey)
	const hostRoute = isHostRoute(routeKey)
	const selfHeaded = SELF_HEADED_ROUTE_KEYS.includes(routeKey)

	// Day views and Calendar carry a date; the other sections do not read it.
	const sectionHref = (path: string, keepDate: boolean) => {
		const next = new URLSearchParams()
		for (const key of ['locationId', 'location'] as const) {
			const value = searchParams.get(key)
			if (value) next.set(key, value)
		}
		const date = searchParams.get('date')
		if (keepDate && date) next.set('date', date)
		const qs = next.toString()
		return `/${orgSlug}/reservations/${path}${qs ? `?${qs}` : ''}`
	}

	const sections = [
		{
			id: 'today',
			label: _(msg`Today`),
			href: sectionHref('today', true),
			visible: nav.today,
		},
		{
			id: 'calendar',
			label: _(msg`Calendar`),
			href: sectionHref('calendar', true),
			visible: nav.book,
		},
		{
			id: 'guests',
			label: _(msg`Guests`),
			href: sectionHref('guests', false),
			visible: nav.guests,
		},
		{
			id: 'waitlist',
			label: _(msg`Waitlist`),
			href: sectionHref('waitlist', false),
			visible: nav.waitlist,
		},
		{
			id: 'reports',
			label: _(msg`Reports`),
			href: sectionHref('reports', false),
			visible: nav.reports,
		},
		{
			id: 'experiences',
			label: _(msg`Experiences`),
			href: sectionHref('experiences', false),
			visible: nav.experiences,
		},
		{
			id: 'settings',
			label: _(msg`Settings`),
			href: sectionHref('settings', false),
			visible: nav.settings,
		},
	]
	const tabs = sections
		.filter((section) => section.visible)
		.map((section) => ({
			label: section.label,
			href: section.href,
			isActive: section.id === activeSectionTab,
		}))

	const headers: Partial<
		Record<ReservationsRouteKey, { title: string; description: string }>
	> = {
		today: {
			title: _(msg`Today`),
			description: _(
				msg`Arrivals, seated parties and everything that needs a host.`,
			),
		},
		book: {
			title: _(msg`List`),
			description: _(msg`Every reservation for the day in one list.`),
		},
		timeline: {
			title: _(msg`Timeline`),
			description: _(msg`The day by table and time.`),
		},
		floor: {
			title: _(msg`Floor`),
			description: _(msg`Live floor plan with seated and open tables.`),
		},
		calendar: {
			title: _(msg`Calendar`),
			description: _(msg`Bookings and busy days across the month.`),
		},
		overview: {
			title: _(msg`Overview`),
			description: _(msg`Covers, pacing and notes for the day.`),
		},
		settings: {
			title: _(msg`Settings`),
			description: _(
				msg`Booking rules, services, floor and guest messages for this location.`,
			),
		},
	}
	const header = headers[routeKey]

	const shell: ReservationsShell = {
		orgSlug,
		nav,
		locations,
		selectedLocationId,
		onLocationChange,
		actionsSlot,
		metaSlot,
	}
	const locationControls = (
		<ReservationsHeaderControls
			locations={locations}
			selectedLocationId={selectedLocationId}
			onChange={(_key, value) => onLocationChange(value)}
		/>
	)

	return (
		<ReservationsShellProvider value={shell}>
			<WorkspacePage>
				<div
					className="flex flex-col gap-6"
					data-testid="reservations-header-controls"
				>
					{header ? (
						<PageHeader
							title={header.title}
							description={
								<>
									{header.description}
									<span
										ref={setMetaSlot}
										className="ms-2 inline-flex flex-wrap items-center gap-1.5 align-middle"
									/>
								</>
							}
							actions={
								<>
									<div ref={setActionsSlot} className="contents" />
									{hostRoute ? null : locationControls}
								</>
							}
						/>
					) : null}

					<WorkspaceTabBar
						label={_(msg`Reservations sections`)}
						className="print:hidden"
						tabs={tabs}
					/>

					{selfHeaded && locations.length > 1 ? (
						<div className="flex justify-end">{locationControls}</div>
					) : null}

					{children}
				</div>
			</WorkspacePage>
		</ReservationsShellProvider>
	)
}
