import { Trans, useLingui } from '@lingui/react/macro'
import { addDays } from '@repo/reservations'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Link, useSearchParams } from 'react-router'
import { type RsvServiceNoteRow } from '#app/utils/reservations/book-api.ts'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
} from '#app/utils/reservations/setup-api.ts'

export type HostViewKey =
	'today' | 'book' | 'timeline' | 'floor' | 'calendar' | 'overview'

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

	const viewTabs: Array<{
		key: HostViewKey
		path: string
		label: string
	}> = [
		{ key: 'today', path: 'today', label: t`Today` },
		{ key: 'book', path: 'book', label: t`Book` },
		{ key: 'timeline', path: 'timeline', label: t`Timeline` },
		{ key: 'floor', path: 'floor', label: t`Floor Plan` },
		{ key: 'calendar', path: 'calendar', label: t`Calendar` },
		{ key: 'overview', path: 'overview', label: t`Overview` },
	]

	const totalAttention = unassignedCount + conflictCount + moveNoticeCount

	return (
		<div
			className="bg-card flex flex-col gap-3 rounded-xl border p-3 shadow-xs"
			data-testid="host-subnav"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{/* View switcher tabs */}
				<div
					className="bg-muted inline-flex flex-wrap items-center gap-1 rounded-lg p-1"
					role="tablist"
					aria-label={t`Host stand views`}
				>
					{viewTabs.map((tab) => {
						const isActive = activeView === tab.key
						return (
							<Button
								key={tab.key}
								variant={isActive ? 'default' : 'ghost'}
								size="sm"
								render={<Link to={buildViewHref(tab.path)} />}
								data-testid={`host-view-tab-${tab.key}`}
								aria-selected={isActive}
								role="tab"
							>
								{tab.label}
							</Button>
						)
					})}
				</div>

				{/* Action buttons */}
				<div className="flex flex-wrap items-center gap-2">
					{onOpenConflictPanel ? (
						<Button
							type="button"
							variant={conflictCount > 0 ? 'destructive' : 'outline'}
							size="sm"
							onClick={onOpenConflictPanel}
							data-testid="open-conflict-panel-btn"
						>
							<Icon name="alert-triangle" className="size-4" />
							<span>
								<Trans>Unassigned & Conflicts</Trans>
							</span>
							<Badge
								variant={totalAttention > 0 ? 'secondary' : 'outline'}
								data-testid="conflict-panel-badge"
							>
								{totalAttention}
							</Badge>
						</Button>
					) : null}

					{canManage && onOpenWalkIn ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onOpenWalkIn}
							data-testid="open-walk-in-btn"
						>
							<Icon name="user-plus" className="size-4" />
							<span>
								<Trans>Walk-in</Trans>
							</span>
						</Button>
					) : null}

					{canManage && onOpenBookingSheet ? (
						<Button
							type="button"
							size="sm"
							onClick={onOpenBookingSheet}
							data-testid="open-booking-sheet-btn"
						>
							<Icon name="plus" className="size-4" />
							<span>
								<Trans>New Reservation</Trans>
							</span>
						</Button>
					) : null}

					{onRefresh ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={onRefresh}
							aria-label={t`Refresh`}
							data-testid="host-refresh-btn"
						>
							<Icon
								name="refresh-cw"
								className={refreshing ? 'size-4 animate-spin' : 'size-4'}
							/>
						</Button>
					) : null}
				</div>
			</div>

			{/* Filters row: Date navigation, Service filter, Area filter */}
			{onDateChange || services.length > 0 || areas.length > 0 ? (
				<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
					{onDateChange ? (
						<div className="flex flex-wrap items-center gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								onClick={() => onDateChange(addDays(businessDate, -1))}
								aria-label={t`Previous day`}
								data-testid="host-prev-day-btn"
							>
								<Icon name="chevron-left" className="size-4 rtl:rotate-180" />
							</Button>
							<Input
								type="date"
								value={businessDate}
								onChange={(e) => {
									if (e.target.value) onDateChange(e.target.value)
								}}
								className="h-8 w-40 text-sm"
								aria-label={t`Business date`}
								data-testid="host-date-input"
							/>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								onClick={() => onDateChange(addDays(businessDate, 1))}
								aria-label={t`Next day`}
								data-testid="host-next-day-btn"
							>
								<Icon name="chevron-right" className="size-4 rtl:rotate-180" />
							</Button>
							{todayDate && businessDate !== todayDate ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => onDateChange(todayDate)}
									data-testid="host-today-jump-btn"
								>
									<Trans>Jump to Today</Trans>
								</Button>
							) : null}
						</div>
					) : (
						<div />
					)}

					<div className="flex flex-wrap items-center gap-2">
						{services.length > 0 && onServiceChange ? (
							<div className="flex items-center gap-1.5">
								<label
									htmlFor="host-service-filter"
									className="text-muted-foreground text-xs font-medium"
								>
									<Trans>Service</Trans>
								</label>
								<select
									id="host-service-filter"
									value={selectedServiceId ?? ''}
									onChange={(e) =>
										onServiceChange(e.target.value ? e.target.value : null)
									}
									className="border-input bg-background h-8 rounded-md border px-2.5 text-xs"
									data-testid="host-service-select"
								>
									<option value="">{t`All services`}</option>
									{services.map((svc) => (
										<option key={svc.id} value={svc.id}>
											{svc.name}
										</option>
									))}
								</select>
							</div>
						) : null}

						{areas.length > 0 && onAreaChange ? (
							<div className="flex items-center gap-1.5">
								<label
									htmlFor="host-area-filter"
									className="text-muted-foreground text-xs font-medium"
								>
									<Trans>Area</Trans>
								</label>
								<select
									id="host-area-filter"
									value={selectedAreaId ?? ''}
									onChange={(e) =>
										onAreaChange(e.target.value ? e.target.value : null)
									}
									className="border-input bg-background h-8 rounded-md border px-2.5 text-xs"
									data-testid="host-area-select"
								>
									<option value="">{t`All areas`}</option>
									{areas.map((area) => (
										<option key={area.id} value={area.id}>
											{area.name}
										</option>
									))}
								</select>
							</div>
						) : null}
					</div>
				</div>
			) : null}

			{(() => {
				const visibleNotes = selectedServiceId
					? serviceNotes.filter(
							(n) =>
								n.serviceId === selectedServiceId && n.body.trim().length > 0,
						)
					: serviceNotes.filter((n) => n.body.trim().length > 0)
				if (visibleNotes.length === 0) return null
				return (
					<div
						className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs"
						data-testid="host-subnav-service-notes"
					>
						<Icon
							name="file-text"
							className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300"
						/>
						<span className="font-semibold text-amber-900 dark:text-amber-200">
							<Trans>Service Notes:</Trans>
						</span>
						<div className="flex flex-wrap items-center gap-3">
							{visibleNotes.map((noteItem) => {
								const svcName = noteItem.serviceId
									? services.find((s) => s.id === noteItem.serviceId)?.name
									: null
								return (
									<span
										key={`${noteItem.serviceId ?? 'all'}-${noteItem.id}`}
										className="text-foreground"
										data-testid={`host-subnav-service-note-${noteItem.serviceId ?? 'all'}`}
									>
										{svcName ? (
											<strong className="me-1 font-medium">[{svcName}]</strong>
										) : null}
										{noteItem.body}
									</span>
								)
							})}
						</div>
					</div>
				)
			})()}
		</div>
	)
}
