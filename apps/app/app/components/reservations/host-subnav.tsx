import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Link, useSearchParams } from 'react-router'
import { DateStepper } from '#app/components/reservations/date-stepper.tsx'
import { ReservationsHeaderControls } from '#app/components/reservations/header-controls.tsx'
import {
	ReservationsHeaderActions,
	useReservationsShell,
} from '#app/components/reservations/shell-context.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { type RsvServiceNoteRow } from '#app/utils/reservations/book-api.ts'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
} from '#app/utils/reservations/setup-api.ts'

export type HostViewKey =
	'today' | 'book' | 'timeline' | 'floor' | 'calendar' | 'overview'

const ALL = 'all'

/**
 * The day-view chrome under the layout's page header and section tabs.
 *
 * Actions (Needs attention, Walk-in, New reservation) go into the layout's
 * single page header through a portal; this block renders the context bar:
 * location, the day views as a segmented control, date stepper, service,
 * area and refresh. Date, service and area belong to the day views only.
 */
export function HostSubnav({
	orgSlug,
	activeView,
	businessDate,
	todayDate,
	onDateChange,
	services = [],
	selectedServiceId = null,
	onServiceChange,
	areas = [],
	selectedAreaId = null,
	onAreaChange,
	unassignedCount = 0,
	conflictCount = 0,
	moveNoticeCount = 0,
	onOpenBookingSheet,
	onOpenWalkIn,
	onOpenConflictPanel,
	canManage = true,
	refreshing = false,
	onRefresh,
	serviceNotes = [],
}: {
	orgSlug: string
	activeView: HostViewKey
	businessDate: string
	todayDate?: string
	onDateChange?: (nextDate: string) => void
	services?: RsvServiceRecord[]
	selectedServiceId?: string | null
	onServiceChange?: (serviceId: string | null) => void
	areas?: RsvAreaRecord[]
	selectedAreaId?: string | null
	onAreaChange?: (areaId: string | null) => void
	unassignedCount?: number
	conflictCount?: number
	moveNoticeCount?: number
	onOpenBookingSheet?: () => void
	onOpenWalkIn?: () => void
	onOpenConflictPanel?: () => void
	canManage?: boolean
	refreshing?: boolean
	onRefresh?: () => void
	serviceNotes?: RsvServiceNoteRow[]
}) {
	const { t } = useLingui()
	const [searchParams] = useSearchParams()
	const shell = useReservationsShell()

	const buildViewHref = (viewPath: string) => {
		const next = new URLSearchParams()
		const locId = searchParams.get('locationId')
		if (locId) next.set('locationId', locId)
		if (businessDate) next.set('date', businessDate)
		if (selectedServiceId) next.set('service', selectedServiceId)
		if (selectedAreaId) next.set('area', selectedAreaId)
		const qs = next.toString()
		return `/${orgSlug}/reservations/${viewPath}${qs ? `?${qs}` : ''}`
	}

	// Calendar is its own section tab (month level), not one of the day views.
	const viewTabs: Array<{
		key: HostViewKey
		path: string
		label: string
		visible: boolean
	}> = [
		{
			key: 'today',
			path: 'today',
			label: t`Board`,
			visible: shell ? shell.nav.today : true,
		},
		{
			key: 'timeline',
			path: 'timeline',
			label: t`Timeline`,
			visible: shell ? shell.nav.book : true,
		},
		{
			key: 'floor',
			path: 'floor',
			label: t`Floor`,
			visible: shell ? shell.nav.book : true,
		},
		{
			key: 'book',
			path: 'book',
			label: t`List`,
			visible: shell ? shell.nav.book : true,
		},
		{
			key: 'overview',
			path: 'overview',
			label: t`Overview`,
			visible: shell ? shell.nav.book : true,
		},
	]
	const visibleViewTabs = viewTabs.filter((tab) => tab.visible)

	// The Calendar steps by month with its own navigation, and its month summary
	// is not filtered by service or area, so those controls do not apply there.
	const dayControls = activeView !== 'calendar'

	const totalAttention = unassignedCount + conflictCount + moveNoticeCount

	const visibleNotes = (
		selectedServiceId
			? serviceNotes.filter((n) => n.serviceId === selectedServiceId)
			: serviceNotes
	).filter((n) => n.body.trim().length > 0)

	const serviceOptions = [
		{ value: ALL, label: t`All services` },
		...services.map((svc) => ({ value: svc.id, label: svc.name })),
	]
	const areaOptions = [
		{ value: ALL, label: t`All areas` },
		...areas.map((area) => ({ value: area.id, label: area.name })),
	]

	return (
		<div
			className="bg-background sticky top-0 z-20 flex flex-col gap-3 py-2 print:hidden"
			data-testid="host-subnav"
		>
			<ReservationsHeaderActions>
				{onOpenConflictPanel ? (
					<Button
						type="button"
						variant="outline"
						className="h-11 md:h-8"
						onClick={onOpenConflictPanel}
						data-testid="open-conflict-panel-btn"
					>
						<Icon name="alert-triangle" />
						<Trans>Needs attention</Trans>
						{totalAttention > 0 ? (
							<Badge
								variant="warning"
								className="tabular-nums"
								data-testid="conflict-panel-badge"
							>
								{totalAttention}
							</Badge>
						) : null}
					</Button>
				) : null}
				{canManage && onOpenWalkIn ? (
					<Button
						type="button"
						variant="outline"
						className="h-11 md:h-8"
						onClick={onOpenWalkIn}
						data-testid="open-walk-in-btn"
					>
						<Icon name="user-plus" />
						<Trans>Walk-in</Trans>
					</Button>
				) : null}
				{canManage && onOpenBookingSheet ? (
					<Button
						type="button"
						className="h-11 md:h-8"
						onClick={onOpenBookingSheet}
						data-testid="open-booking-sheet-btn"
					>
						<Icon name="plus" />
						<Trans>New reservation</Trans>
					</Button>
				) : null}
			</ReservationsHeaderActions>

			<div
				role="toolbar"
				aria-label={t`Day controls`}
				className="flex flex-wrap items-center gap-x-3 gap-y-2"
				data-testid="host-context-bar"
			>
				{shell ? (
					<ReservationsHeaderControls
						locations={shell.locations}
						selectedLocationId={shell.selectedLocationId}
						onChange={(_key, value) => shell.onLocationChange(value)}
					/>
				) : null}

				{activeView !== 'calendar' && visibleViewTabs.length > 1 ? (
					<nav
						aria-label={t`Day views`}
						className="bg-muted inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg p-0.5"
					>
						{visibleViewTabs.map((tab) => {
							const isActive = activeView === tab.key
							return (
								<Link
									key={tab.key}
									to={buildViewHref(tab.path)}
									aria-current={isActive ? 'page' : undefined}
									data-testid={`host-view-tab-${tab.key}`}
									className={
										isActive
											? 'bg-background text-foreground flex h-11 items-center rounded-md px-3 text-sm font-medium shadow-xs md:h-7'
											: 'text-muted-foreground hover:text-foreground flex h-11 items-center rounded-md px-3 text-sm font-medium md:h-7'
									}
								>
									{tab.label}
								</Link>
							)
						})}
					</nav>
				) : null}

				{dayControls && onDateChange ? (
					<DateStepper
						date={businessDate}
						today={todayDate}
						onChange={onDateChange}
					/>
				) : null}

				<div className="flex flex-wrap items-center gap-2 sm:ms-auto">
					{dayControls && services.length > 0 && onServiceChange ? (
						<FilterSelect
							label={t`Service`}
							testId="host-service-select"
							options={serviceOptions}
							value={selectedServiceId ?? ALL}
							onValueChange={(value) =>
								onServiceChange(value === ALL ? null : value)
							}
						/>
					) : null}
					{dayControls && areas.length > 0 && onAreaChange ? (
						<FilterSelect
							label={t`Area`}
							testId="host-area-select"
							options={areaOptions}
							value={selectedAreaId ?? ALL}
							onValueChange={(value) =>
								onAreaChange(value === ALL ? null : value)
							}
						/>
					) : null}
					{onRefresh ? (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={onRefresh}
							aria-label={t`Refresh`}
							data-testid="host-refresh-btn"
						>
							<Icon
								name="refresh-cw"
								className={refreshing ? 'animate-spin' : undefined}
							/>
						</Button>
					) : null}
				</div>
			</div>

			{visibleNotes.length > 0 ? (
				<div
					className="bg-muted/50 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs"
					data-testid="host-subnav-service-notes"
				>
					<Icon
						name="file-text"
						className="text-muted-foreground size-3.5 shrink-0"
					/>
					<span className="sr-only">
						<Trans>Service notes</Trans>
					</span>
					{visibleNotes.map((noteItem) => {
						const svcName = noteItem.serviceId
							? services.find((s) => s.id === noteItem.serviceId)?.name
							: null
						return (
							<span
								key={`${noteItem.serviceId ?? 'all'}-${noteItem.id}`}
								className="text-foreground flex items-center gap-1.5"
								data-testid={`host-subnav-service-note-${noteItem.serviceId ?? 'all'}`}
							>
								{svcName ? <Badge variant="outline">{svcName}</Badge> : null}
								{noteItem.body}
							</span>
						)
					})}
				</div>
			) : null}
		</div>
	)
}
