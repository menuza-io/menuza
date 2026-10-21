import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DateStepper } from '#app/components/reservations/date-stepper.tsx'
import { ReservationsHeaderControls } from '#app/components/reservations/header-controls.tsx'
import { HostFilters } from '#app/components/reservations/host-filters.tsx'
import {
	ReservationsHeaderActions,
	useReservationsShell,
} from '#app/components/reservations/shell-context.tsx'
import { type RsvServiceNoteRow } from '#app/utils/reservations/book-api.ts'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
} from '#app/utils/reservations/setup-api.ts'

export type HostViewKey =
	'today' | 'book' | 'timeline' | 'floor' | 'calendar' | 'overview'

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
	lastUpdatedAt = null,
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
	/** Epoch ms of the last successful poll; read from the refresh button, shown in text once stale. */
	lastUpdatedAt?: number | null
}) {
	const { t } = useLingui()
	const [searchParams] = useSearchParams()
	const shell = useReservationsShell()
	const [notesOpen, setNotesOpen] = useState(false)

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

	return (
		<div
			className="bg-background sticky top-0 z-20 flex flex-col gap-3 py-1 print:hidden"
			data-testid="host-subnav"
		>
			<ReservationsHeaderActions>
				{onOpenConflictPanel ? (
					<Button
						type="button"
						variant="outline"
						className="h-8 max-md:h-11 pointer-coarse:h-11"
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
						className="h-8 max-md:h-11 pointer-coarse:h-11"
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
						className="h-8 max-md:h-11 pointer-coarse:h-11"
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
				<div className="flex min-w-0 items-center gap-3 max-lg:w-full">
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
												? 'bg-background text-foreground flex h-8 items-center rounded-md px-3 text-sm font-medium shadow-xs max-md:h-11 pointer-coarse:h-11'
												: 'text-muted-foreground hover:text-foreground flex h-8 items-center rounded-md px-3 text-sm font-medium max-md:h-11 pointer-coarse:h-11'
										}
									>
										{tab.label}
									</Link>
								)
							})}
						</nav>
					) : null}
				</div>

				{dayControls ? (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-2 lg:ms-auto">
						{onDateChange ? (
							<DateStepper
								date={businessDate}
								today={todayDate}
								onChange={onDateChange}
							/>
						) : null}
						<div className="flex items-center gap-1 sm:ms-2">
							<HostFilters
								services={services}
								selectedServiceId={selectedServiceId}
								onServiceChange={onServiceChange}
								areas={areas}
								selectedAreaId={selectedAreaId}
								onAreaChange={onAreaChange}
							/>
							{onRefresh ? (
								<RefreshButton
									at={lastUpdatedAt}
									refreshing={refreshing}
									onRefresh={onRefresh}
								/>
							) : null}
						</div>
					</div>
				) : null}
			</div>

			{visibleNotes.length > 0 ? (
				<div
					className="bg-muted/50 flex items-start gap-2 rounded-lg border px-3 py-1.5 text-xs"
					data-testid="host-subnav-service-notes"
				>
					<Icon
						name="file-text"
						className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
					/>
					<span className="sr-only">
						<Trans>Service notes</Trans>
					</span>
					<div
						className={
							notesOpen
								? 'flex min-w-0 flex-1 flex-col gap-1'
								: 'flex min-w-0 flex-1 items-center gap-3 overflow-hidden'
						}
					>
						{visibleNotes.map((noteItem) => {
							const svcName = noteItem.serviceId
								? services.find((s) => s.id === noteItem.serviceId)?.name
								: null
							return (
								<span
									key={`${noteItem.serviceId ?? 'all'}-${noteItem.id}`}
									className={
										notesOpen
											? 'text-foreground flex items-start gap-1.5'
											: 'text-foreground flex min-w-0 items-center gap-1.5'
									}
									data-testid={`host-subnav-service-note-${noteItem.serviceId ?? 'all'}`}
								>
									{svcName ? <Badge variant="outline">{svcName}</Badge> : null}
									<span className={notesOpen ? 'wrap-anywhere' : 'truncate'}>
										{noteItem.body}
									</span>
								</span>
							)
						})}
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="-my-1 size-8 shrink-0 max-md:size-11 pointer-coarse:size-11"
						aria-expanded={notesOpen}
						aria-label={
							notesOpen ? t`Collapse service notes` : t`Expand service notes`
						}
						onClick={() => setNotesOpen((v) => !v)}
						data-testid="host-service-notes-toggle"
					>
						<Icon name={notesOpen ? 'chevron-up' : 'chevron-down'} />
					</Button>
				</div>
			) : null}
		</div>
	)
}

/** Seconds since the last poll, re-read every 10 seconds; null before the first one. */
function useSecondsSince(at: number | null): number | null {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		setNow(Date.now())
		const id = window.setInterval(() => setNow(Date.now()), 10_000)
		return () => window.clearInterval(id)
	}, [at])
	if (at === null) return null
	return Math.max(0, Math.round((now - at) / 1000))
}

const STALE_AFTER_SECONDS = 60

/**
 * Refresh as an icon-only ghost button. "Updated just now" / "Updated 2 min
 * ago" lives in its tooltip and accessible name; a quiet visible "Updated 3 min
 * ago" appears only once the data is more than a minute old.
 */
export function RefreshButton({
	at,
	refreshing,
	onRefresh,
}: {
	at: number | null
	refreshing: boolean
	onRefresh: () => void
}) {
	const { i18n, t } = useLingui()
	const seconds = useSecondsSince(at)
	let updated: string | null = null
	if (seconds !== null) {
		const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
		const ago =
			seconds < 90
				? rtf.format(-Math.round(seconds / 10) * 10, 'second')
				: seconds < 5400
					? rtf.format(-Math.round(seconds / 60), 'minute')
					: rtf.format(-Math.round(seconds / 3600), 'hour')
		updated = seconds < 10 ? t`Updated just now` : t`Updated ${ago}`
	}
	const stale = seconds !== null && seconds > STALE_AFTER_SECONDS
	const label = updated ?? t`Refresh`
	return (
		<div className="flex items-center gap-1">
			{stale && updated ? (
				<span
					className="text-muted-foreground hidden text-xs whitespace-nowrap tabular-nums sm:inline"
					data-testid="host-updated-ago"
				>
					{updated}
				</span>
			) : null}
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="max-md:size-11 pointer-coarse:size-11"
							onClick={onRefresh}
							aria-label={updated ? t`Refresh. ${updated}` : t`Refresh`}
							data-testid="host-refresh-btn"
						>
							<Icon
								name="refresh-cw"
								className={refreshing ? 'animate-spin' : undefined}
							/>
						</Button>
					}
				/>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
		</div>
	)
}
