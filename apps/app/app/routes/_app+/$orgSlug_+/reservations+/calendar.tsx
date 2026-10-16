import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating } from '@repo/auth'
import { RESERVATIONS_PERMISSIONS } from '@repo/reservations'
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLoaderData, useNavigate, useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { BookingSheet } from '#app/components/reservations/booking-sheet.tsx'
import { ConflictPanel } from '#app/components/reservations/conflict-panel.tsx'
import { DetailSheet } from '#app/components/reservations/detail-sheet.tsx'
import { HostSubnav } from '#app/components/reservations/host-subnav.tsx'
import { useHostStand } from '#app/components/reservations/use-host-stand.ts'
import { WalkInDialog } from '#app/components/reservations/walk-in-dialog.tsx'
import { requireReservationsAccess } from '#app/utils/reservations/access.server.ts'
import {
	type CalendarDaySummary,
	type CalendarMonthResponse,
	fetchBookCalendar,
} from '#app/utils/reservations/book-api.ts'
import { RESERVATIONS_SECTION_REQUIREMENTS } from '#app/utils/reservations/sections.ts'
import { type Route } from './+types/calendar.ts'
import { useReservationsLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	const [access, impersonated] = await Promise.all([
		requireReservationsAccess(
			request,
			params.orgSlug,
			RESERVATIONS_SECTION_REQUIREMENTS.book,
		),
		isImpersonating(request),
	])

	const canWriteReservation =
		!impersonated &&
		access.grants.includes(RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION)
	const canReadGuest =
		!impersonated &&
		access.grants.includes(RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST)

	return {
		orgSlug: access.organizationSlug,
		canWriteReservation,
		canReadGuest,
		isImpersonating: impersonated,
	}
}

function shiftYearMonth(ym: string, deltaMonths: number): string {
	const match = /^(\d{4})-(\d{2})$/.exec(ym)
	if (!match) return ym
	const year = Number.parseInt(match[1]!, 10)
	const monthIndex = Number.parseInt(match[2]!, 10) - 1
	const dt = new Date(Date.UTC(year, monthIndex + deltaMonths, 1))
	const nextY = dt.getUTCFullYear()
	const nextM = String(dt.getUTCMonth() + 1).padStart(2, '0')
	return `${nextY}-${nextM}`
}

export default function ReservationsCalendarRoute() {
	const { _ } = useLingui()
	const loaderData = useLoaderData<typeof loader>()
	const { activeLocationId, locations } = useReservationsLayoutData()
	const activeLocation =
		locations.find((loc) => loc.id === activeLocationId) ?? locations[0]
	const locationId = activeLocation?.id ?? ''
	const navigate = useNavigate()
	const [searchParams, setSearchParams] = useSearchParams()

	const host = useHostStand({
		orgSlug: loaderData.orgSlug,
		locationId,
		defaultTimeZone: activeLocation?.timezone ?? 'UTC',
		pollIntervalMs: 30_000,
	})

	const selectedMonth = useMemo(() => {
		const mParam = searchParams.get('month')
		if (mParam && /^\d{4}-\d{2}$/.test(mParam)) {
			return mParam
		}
		return host.businessDate.slice(0, 7)
	}, [searchParams, host.businessDate])

	const [calendarData, setCalendarData] =
		useState<CalendarMonthResponse | null>(null)
	const [loadingCalendar, setLoadingCalendar] = useState(true)
	const [calendarError, setCalendarError] = useState<string | null>(null)
	const [drillTarget, setDrillTarget] = useState<'book' | 'timeline'>('book')

	const loadCalendar = useCallback(async () => {
		if (!locationId) {
			setLoadingCalendar(false)
			return
		}
		setLoadingCalendar(true)
		setCalendarError(null)
		try {
			const res = await fetchBookCalendar(host.client, {
				locationId,
				month: selectedMonth,
			})
			setCalendarData(res)
		} catch (err) {
			setCalendarError(
				err instanceof Error
					? err.message
					: _(msg`Failed to load monthly calendar summary.`),
			)
		} finally {
			setLoadingCalendar(false)
		}
	}, [host.client, locationId, selectedMonth, _])

	useEffect(() => {
		void loadCalendar()
	}, [loadCalendar])

	const handleChangeMonth = (nextMonth: string) => {
		const next = new URLSearchParams(searchParams)
		next.set('month', nextMonth)
		next.set('date', `${nextMonth}-01`)
		setSearchParams(next)
	}

	const handleSelectDay = (dateStr: string, targetView = drillTarget) => {
		const next = new URLSearchParams()
		const locParam = searchParams.get('locationId')
		if (locParam) {
			next.set('locationId', locParam)
		}
		next.set('date', dateStr)
		void navigate(
			`/${loaderData.orgSlug}/reservations/${targetView}?${next.toString()}`,
		)
	}

	const calendarGridCells = useMemo(() => {
		const days = calendarData?.days ?? []
		if (days.length === 0) return []
		const firstDay = days[0]!
		const firstDow = firstDay.dayOfWeek ?? 0
		const leadingBlanks: Array<CalendarDaySummary | null> = Array.from(
			{ length: firstDow },
			() => null,
		)
		return [...leadingBlanks, ...days]
	}, [calendarData])

	const monthTotals = useMemo(() => {
		const days = calendarData?.days ?? []
		let totalCovers = 0
		let totalParties = 0
		let closedDays = 0
		let specialDays = 0
		for (const d of days) {
			totalCovers += d.totalCovers
			totalParties += d.totalParties
			if (d.isClosed) closedDays += 1
			if (d.specialLabel || d.specialKind) specialDays += 1
		}
		return { totalCovers, totalParties, closedDays, specialDays }
	}, [calendarData])

	const weekdayLabels = [
		_(msg`Sun`),
		_(msg`Mon`),
		_(msg`Tue`),
		_(msg`Wed`),
		_(msg`Thu`),
		_(msg`Fri`),
		_(msg`Sat`),
	]

	return (
		<div
			className="flex flex-col gap-4"
			data-testid="reservations-calendar-page"
		>
			<HostSubnav
				orgSlug={loaderData.orgSlug}
				activeView="calendar"
				businessDate={host.businessDate}
				todayDate={host.todayDate}
				onDateChange={host.setDate}
				services={host.dayFeed?.services ?? []}
				selectedServiceId={host.selectedServiceId}
				onServiceChange={host.setServiceId}
				areas={host.dayFeed?.areas ?? []}
				selectedAreaId={host.selectedAreaId}
				onAreaChange={host.setAreaId}
				unassignedCount={host.dayFeed?.unassigned.length ?? 0}
				conflictCount={host.dayFeed?.conflicts.length ?? 0}
				moveNoticeCount={host.allMoveNotices.length}
				onOpenBookingSheet={() => host.openBookingSheet()}
				onOpenWalkIn={() => host.openWalkIn()}
				onOpenConflictPanel={() => host.setConflictPanelOpen(true)}
				canManage={loaderData.canWriteReservation}
				refreshing={host.poll.refreshing || loadingCalendar}
				onRefresh={() => {
					void host.poll.refresh({ force: true })
					void loadCalendar()
				}}
				serviceNotes={host.dayFeed?.serviceNotes ?? []}
			/>

			{/* Month toolbar and summary KPIs */}
			<div className="border-border bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleChangeMonth(shiftYearMonth(selectedMonth, -1))}
						data-testid="calendar-prev-month"
					>
						<Icon name="chevron-left" className="size-4" />
						<Trans>Prev</Trans>
					</Button>

					<span
						className="min-w-28 text-center text-base font-semibold"
						dir="ltr"
						data-testid="calendar-current-month-label"
					>
						{selectedMonth}
					</span>

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleChangeMonth(shiftYearMonth(selectedMonth, 1))}
						data-testid="calendar-next-month"
					>
						<Trans>Next</Trans>
						<Icon name="chevron-right" className="size-4" />
					</Button>

					<input
						type="month"
						value={selectedMonth}
						onChange={(e) => {
							if (e.target.value) {
								handleChangeMonth(e.target.value)
							}
						}}
						className="border-input bg-background h-8 rounded-md border px-2 text-xs"
						dir="ltr"
						aria-label={_(msg`Select month`)}
						data-testid="calendar-month-input"
					/>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<div className="flex items-center gap-2 text-xs">
						<Badge
							variant="secondary"
							data-testid="calendar-month-covers-badge"
						>
							<span dir="ltr">{monthTotals.totalCovers}</span>{' '}
							<Trans>covers</Trans>
						</Badge>
						<Badge variant="outline" data-testid="calendar-month-parties-badge">
							<span dir="ltr">{monthTotals.totalParties}</span>{' '}
							<Trans>parties</Trans>
						</Badge>
						{monthTotals.specialDays > 0 ? (
							<Badge
								variant="outline"
								className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
								data-testid="calendar-month-special-badge"
							>
								<span dir="ltr">{monthTotals.specialDays}</span>{' '}
								<Trans>special / closed</Trans>
							</Badge>
						) : null}
					</div>

					<div
						className="border-border bg-muted/40 flex items-center gap-1 rounded-lg border p-0.5 text-xs"
						data-testid="calendar-drill-target-toggle"
					>
						<button
							type="button"
							onClick={() => setDrillTarget('book')}
							data-testid="calendar-drill-target-book"
							className={`rounded-md px-2.5 py-1 font-medium transition ${
								drillTarget === 'book'
									? 'bg-background text-foreground shadow-xs'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							<Trans>Open in Book</Trans>
						</button>
						<button
							type="button"
							onClick={() => setDrillTarget('timeline')}
							data-testid="calendar-drill-target-timeline"
							className={`rounded-md px-2.5 py-1 font-medium transition ${
								drillTarget === 'timeline'
									? 'bg-background text-foreground shadow-xs'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							<Trans>Open in Timeline</Trans>
						</button>
					</div>
				</div>
			</div>

			{calendarError ? (
				<div
					role="alert"
					className="border-destructive/40 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
					data-testid="calendar-error-banner"
				>
					{calendarError}
				</div>
			) : null}

			{/* Month grid card */}
			<Card data-testid="calendar-month-grid-card">
				<CardHeader className="pb-2">
					<CardTitle className="text-base">
						<Trans>Monthly Reservation Volume & Special Days</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Select any day cell to drill directly into that business date in
							Book or Timeline view.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					{loadingCalendar ? (
						<div
							className="text-muted-foreground py-12 text-center text-sm"
							data-testid="calendar-loading"
						>
							<Trans>Loading monthly calendar…</Trans>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							{/* Weekday headers */}
							<div className="grid grid-cols-7 gap-2 text-center text-xs font-semibold">
								{weekdayLabels.map((label, idx) => (
									<div key={idx} className="text-muted-foreground py-1">
										{label}
									</div>
								))}
							</div>

							{/* Calendar grid */}
							<div
								className="grid grid-cols-7 gap-2"
								data-testid="calendar-days-grid"
							>
								{calendarGridCells.map((cell, idx) => {
									if (!cell) {
										return (
											<div
												key={`blank-${idx}`}
												className="bg-muted/10 min-h-24 rounded-lg border border-dashed opacity-40"
												aria-hidden="true"
											/>
										)
									}

									const dayNum = cell.date.slice(8, 10).replace(/^0/, '')
									const isSelectedDate = cell.date === host.selectedDate
									const hasBookings =
										cell.totalParties > 0 || cell.totalCovers > 0
									const isSpecial = Boolean(
										cell.specialLabel || cell.specialKind,
									)

									return (
										<div
											key={cell.date}
											role="button"
											tabIndex={0}
											onClick={() => handleSelectDay(cell.date)}
											onKeyDown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault()
													handleSelectDay(cell.date)
												}
											}}
											data-testid={`calendar-day-cell-${cell.date}`}
											data-date={cell.date}
											data-closed={cell.isClosed ? 'true' : 'false'}
											data-covers={cell.totalCovers}
											data-parties={cell.totalParties}
											className={`group flex min-h-24 cursor-pointer flex-col justify-between rounded-lg border p-2 text-left transition ${
												isSelectedDate
													? 'border-primary bg-primary/5 ring-primary/30 ring-2'
													: cell.isClosed
														? 'border-destructive/30 bg-destructive/5 hover:border-destructive/60'
														: hasBookings
															? 'border-border bg-card hover:border-primary/60 hover:shadow-xs'
															: 'border-border/70 bg-muted/10 hover:border-border'
											}`}
										>
											<div className="flex items-start justify-between gap-1">
												<span
													className={`inline-flex size-6 items-center justify-center rounded-full text-xs font-bold ${
														isSelectedDate
															? 'bg-primary text-primary-foreground'
															: 'text-foreground'
													}`}
													dir="ltr"
												>
													{dayNum}
												</span>

												<div className="flex flex-wrap items-center justify-end gap-1">
													{cell.isClosed ? (
														<Badge
															variant="destructive"
															className="px-1.5 py-0 text-[10px]"
															data-testid={`calendar-day-closed-${cell.date}`}
														>
															<Trans>Closed</Trans>
														</Badge>
													) : null}
													{!cell.isClosed && isSpecial ? (
														<Badge
															variant="outline"
															className="border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-800 dark:text-amber-300"
															data-testid={`calendar-day-special-${cell.date}`}
														>
															{cell.specialLabel ?? cell.specialKind}
														</Badge>
													) : null}
												</div>
											</div>

											{cell.isClosed && cell.specialLabel ? (
												<p
													className="text-muted-foreground truncate text-[11px]"
													title={cell.specialLabel}
													data-testid={`calendar-day-special-${cell.date}`}
												>
													{cell.specialLabel}
												</p>
											) : null}

											<div className="mt-1 flex flex-col gap-1">
												<div className="flex items-baseline justify-between gap-1 text-xs">
													<span
														className="text-foreground font-semibold"
														data-testid={`calendar-day-covers-${cell.date}`}
													>
														<span dir="ltr">{cell.totalCovers}</span>{' '}
														<Trans>covers</Trans>
													</span>
													<span
														className="text-muted-foreground text-[11px]"
														data-testid={`calendar-day-parties-${cell.date}`}
													>
														<span dir="ltr">{cell.totalParties}</span>{' '}
														<Trans>parties</Trans>
													</span>
												</div>

												{/* Pacing bar */}
												{!cell.isClosed ? (
													<div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
														<div
															className={`h-full rounded-full transition-all ${
																cell.pacingPct >= 85
																	? 'bg-amber-500'
																	: cell.pacingPct > 0
																		? 'bg-emerald-500'
																		: 'bg-transparent'
															}`}
															style={{
																width: `${Math.min(100, Math.max(0, cell.pacingPct))}%`,
															}}
														/>
													</div>
												) : null}
											</div>
										</div>
									)
								})}
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			<BookingSheet
				open={host.bookingSheetOpen}
				onOpenChange={host.setBookingSheetOpen}
				client={host.client}
				locationId={locationId}
				defaultDate={host.businessDate}
				services={host.dayFeed?.services ?? []}
				areas={host.dayFeed?.areas ?? []}
				tables={host.dayFeed?.tables ?? []}
				initialLocalStartMin={host.bookingDefaults.localStartMin}
				initialPartySize={host.bookingDefaults.partySize}
				initialTableId={host.bookingDefaults.tableId}
				initialAreaId={host.bookingDefaults.areaId ?? host.selectedAreaId}
				initialServiceId={
					host.bookingDefaults.serviceId ?? host.selectedServiceId
				}
				onCreated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadCalendar()
				}}
			/>

			<WalkInDialog
				open={host.walkInOpen}
				onOpenChange={host.setWalkInOpen}
				client={host.client}
				locationId={locationId}
				businessDate={host.businessDate}
				localStartMin={host.liveNow.localStartMin}
				tableStates={host.dayFeed?.tableStates ?? []}
				initialTableId={host.walkInDefaults.tableId}
				initialPartySize={host.walkInDefaults.partySize}
				onCreated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadCalendar()
				}}
			/>

			<DetailSheet
				reservationId={host.detailReservationId}
				fallbackReservation={host.selectedReservation}
				onClose={host.closeDetail}
				client={host.client}
				tables={host.dayFeed?.tables ?? []}
				canManage={loaderData.canWriteReservation}
				onUpdated={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadCalendar()
				}}
			/>

			<ConflictPanel
				open={host.conflictPanelOpen}
				onOpenChange={host.setConflictPanelOpen}
				client={host.client}
				conflicts={host.dayFeed?.conflicts ?? []}
				unassigned={host.dayFeed?.unassigned ?? []}
				moveNotices={host.allMoveNotices}
				tables={host.dayFeed?.tables ?? []}
				canManage={loaderData.canWriteReservation}
				onSelectReservation={host.openDetail}
				onResolved={(rsv, notices) => {
					host.handleReservationMutated(rsv, notices)
					void loadCalendar()
				}}
				onClearMoveNotices={host.clearMoveNotices}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
