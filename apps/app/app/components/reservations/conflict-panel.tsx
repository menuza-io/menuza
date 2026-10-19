import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { useState } from 'react'
import { SheetSection } from '#app/components/reservations/sheet-parts.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import { SheetPanel } from '#app/components/staff/sheet-frame.tsx'
import {
	assignReservationTable,
	type DayConflictNotice,
	type DayMoveNotice,
	type DayReservationView,
} from '#app/utils/reservations/book-api.ts'
import { hostErrorMessage } from '#app/utils/reservations/host-errors.ts'
import {
	DAY_CONFLICT_REASON_LABELS,
	enumLabel,
	MOVE_NOTICE_REASON_LABELS,
} from '#app/utils/reservations/labels.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { type RsvTableRecord } from '#app/utils/reservations/setup-api.ts'

/** Select items cannot carry an empty value, so "no pick" travels as this. */
const NO_TABLE = '__none'

export function ConflictPanel({
	open,
	onOpenChange,
	client,
	conflicts,
	unassigned,
	moveNotices,
	tables,
	canManage = true,
	onSelectReservation,
	onResolved,
	onClearMoveNotices,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: ReservationsScopedClient
	conflicts: DayConflictNotice[]
	unassigned: DayReservationView[]
	moveNotices: DayMoveNotice[]
	tables: RsvTableRecord[]
	canManage?: boolean
	onSelectReservation: (reservationId: string) => void
	onResolved: (
		reservation: DayReservationView,
		moveNotices: DayMoveNotice[],
	) => void
	onClearMoveNotices?: () => void
}) {
	const { t, i18n } = useLingui()
	const label = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel((d) => i18n._(d), labels, value)
	const tableLabelById = new Map(tables.map((tbl) => [tbl.id, tbl.label]))
	const conflictMessage = (conflict: DayConflictNotice): string => {
		const tableNames = conflict.tableIds
			.map((id) => tableLabelById.get(id) ?? id)
			.join(', ')
		if (conflict.reason === 'table_blocked') {
			return t`Table ${tableNames} is blocked during this booking`
		}
		if (conflict.reason === 'table_overlap') {
			return t`Overlaps with another booking on ${tableNames}`
		}
		return label(DAY_CONFLICT_REASON_LABELS, conflict.reason)
	}
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [tablePicks, setTablePicks] = useState<Record<string, string>>({})

	const activeTables = tables.filter((tbl) => tbl.isActive)
	const pickTableOptions = (placeholder: string) => [
		{ value: NO_TABLE, label: placeholder },
		...activeTables.map((tbl) => ({
			value: tbl.id,
			label: `${tbl.label} (${tbl.minCovers}-${tbl.maxCovers})`,
		})),
	]

	const handleAssign = async (reservationId: string, tableIds: string[]) => {
		if (tableIds.length === 0) return
		setBusyId(reservationId)
		setError(null)
		try {
			const match = unassigned.find((r) => r.id === reservationId)
			const res = await assignReservationTable(client, reservationId, {
				tableIds,
				reflowLaterParties: true,
				expectedVersion: match?.version ?? 1,
			})
			onResolved(res.reservation, res.moveNotices)
		} catch (err) {
			setError(
				hostErrorMessage(
					err,
					(d) => i18n._(d),
					msg`Failed to resolve assignment.`,
				),
			)
		} finally {
			setBusyId(null)
		}
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="w-full gap-0 sm:max-w-lg"
				data-testid="conflict-panel"
			>
				<SheetPanel
					title={<Trans>Needs attention</Trans>}
					description={
						<Trans>
							Fix table overlaps and unassigned parties, and review the tables
							that moved automatically.
						</Trans>
					}
				>
					{error ? (
						<Alert variant="destructive" data-testid="conflict-panel-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* Active conflicts */}
					<SheetSection
						title={<Trans>Table conflicts</Trans>}
						testId="conflict-list"
						action={
							<Badge
								variant={conflicts.length > 0 ? 'destructive' : 'secondary'}
							>
								{conflicts.length}
							</Badge>
						}
					>
						{conflicts.length === 0 ? (
							<div className="rounded-lg border border-dashed">
								<Empty>
									<EmptyHeader>
										<EmptyTitle>
											<Trans>No active table or schedule conflicts.</Trans>
										</EmptyTitle>
									</EmptyHeader>
								</Empty>
							</div>
						) : (
							conflicts.map((conflict, conflictIndex) => {
								const pickedTableId =
									tablePicks[conflict.reservationId] ??
									conflict.suggestedTableIds[0] ??
									''
								const suggestedLabels = conflict.suggestedTableLabels.join(', ')
								return (
									<div
										key={`${conflict.reservationId}-${conflict.reason}-${conflictIndex}`}
										className="border-destructive/50 bg-destructive/10 flex flex-col gap-2 rounded-lg border p-3 text-sm"
										data-testid={`conflict-item-${conflict.reservationId}`}
									>
										<div className="flex items-start justify-between gap-2">
											<div className="font-medium wrap-anywhere">
												{conflict.guestName} (
												<Plural
													value={conflict.partySize}
													one="# guest"
													other="# guests"
												/>
												) •{' '}
												<span className="tabular-nums">{conflict.hhmm}</span>
											</div>
											<Badge variant="destructive">
												{label(DAY_CONFLICT_REASON_LABELS, conflict.reason)}
											</Badge>
										</div>
										<p className="text-muted-foreground">
											{conflictMessage(conflict)}
										</p>

										{canManage ? (
											<div className="flex flex-wrap items-center gap-2 pt-1">
												{conflict.suggestedTableIds.length > 0 ? (
													<Button
														type="button"
														className="h-11 md:h-8"
														disabled={busyId === conflict.reservationId}
														onClick={() =>
															handleAssign(
																conflict.reservationId,
																conflict.suggestedTableIds,
															)
														}
														data-testid={`conflict-reassign-suggested-${conflict.reservationId}`}
													>
														<Icon name="check" className="size-4" />
														<span>
															<Trans>Reassign to {suggestedLabels}</Trans>
														</span>
													</Button>
												) : null}

												<FilterSelect
													label={t`Pick table`}
													options={pickTableOptions(t`Pick table...`)}
													value={pickedTableId || NO_TABLE}
													onValueChange={(next) =>
														setTablePicks((prev) => ({
															...prev,
															[conflict.reservationId]:
																next === NO_TABLE ? '' : next,
														}))
													}
													testId={`conflict-table-select-${conflict.reservationId}`}
												/>

												<Button
													type="button"
													variant="outline"
													className="h-11 md:h-8"
													disabled={
														!pickedTableId || busyId === conflict.reservationId
													}
													onClick={() =>
														handleAssign(conflict.reservationId, [
															pickedTableId,
														])
													}
													data-testid={`conflict-assign-btn-${conflict.reservationId}`}
												>
													<Trans>Assign</Trans>
												</Button>

												<Button
													type="button"
													variant="ghost"
													className="h-11 md:h-8"
													onClick={() => {
														onSelectReservation(conflict.reservationId)
														onOpenChange(false)
													}}
													data-testid={`conflict-inspect-${conflict.reservationId}`}
												>
													<Trans>Details</Trans>
												</Button>
											</div>
										) : null}
									</div>
								)
							})
						)}
					</SheetSection>

					{/* Unassigned parties */}
					<SheetSection
						title={<Trans>Bookings without a table</Trans>}
						testId="unassigned-list"
						action={
							<Badge variant={unassigned.length > 0 ? 'warning' : 'secondary'}>
								{unassigned.length}
							</Badge>
						}
					>
						{unassigned.length === 0 ? (
							<div className="rounded-lg border border-dashed">
								<Empty>
									<EmptyHeader>
										<EmptyTitle>
											<Trans>
												All active reservations have assigned tables.
											</Trans>
										</EmptyTitle>
									</EmptyHeader>
								</Empty>
							</div>
						) : (
							unassigned.map((rsv) => {
								const fitTables = activeTables.filter(
									(tbl) =>
										tbl.minCovers <= rsv.partySize &&
										rsv.partySize <= tbl.maxCovers,
								)
								const candidateList =
									fitTables.length > 0 ? fitTables : activeTables
								const pickedTableId =
									tablePicks[rsv.id] ?? candidateList[0]?.id ?? ''
								return (
									<div
										key={rsv.id}
										className="bg-card flex flex-col gap-2 rounded-lg border p-3 text-sm"
										data-testid={`unassigned-item-${rsv.id}`}
									>
										<div className="flex items-start justify-between gap-2">
											<span className="font-medium wrap-anywhere">
												{rsv.guestName} (
												<Plural
													value={rsv.partySize}
													one="# guest"
													other="# guests"
												/>
												) • <span className="tabular-nums">{rsv.hhmm}</span>
											</span>
											<span className="text-muted-foreground text-xs tabular-nums">
												#{rsv.confirmationCode}
											</span>
										</div>

										{canManage ? (
											<div className="flex flex-wrap items-center gap-2">
												<FilterSelect
													label={t`Select table`}
													className="flex-1"
													options={pickTableOptions(t`Select table...`)}
													value={pickedTableId || NO_TABLE}
													onValueChange={(next) =>
														setTablePicks((prev) => ({
															...prev,
															[rsv.id]: next === NO_TABLE ? '' : next,
														}))
													}
													testId={`unassigned-table-select-${rsv.id}`}
												/>
												<Button
													type="button"
													className="h-11 md:h-8"
													disabled={!pickedTableId || busyId === rsv.id}
													onClick={() => handleAssign(rsv.id, [pickedTableId])}
													data-testid={`unassigned-assign-btn-${rsv.id}`}
												>
													<Trans>Assign</Trans>
												</Button>
												<Button
													type="button"
													variant="ghost"
													className="h-11 md:h-8"
													onClick={() => {
														onSelectReservation(rsv.id)
														onOpenChange(false)
													}}
												>
													<Trans>Details</Trans>
												</Button>
											</div>
										) : null}
									</div>
								)
							})
						)}
					</SheetSection>

					{/* Automatic reflow notices */}
					<SheetSection
						title={<Trans>Tables moved automatically</Trans>}
						testId="move-notices-list"
						action={
							<div className="flex items-center gap-2">
								<Badge variant="outline">{moveNotices.length}</Badge>
								{moveNotices.length > 0 && onClearMoveNotices ? (
									<Button
										type="button"
										variant="ghost"
										className="h-11 md:h-8"
										onClick={onClearMoveNotices}
										data-testid="clear-move-notices-btn"
									>
										<Trans>Clear</Trans>
									</Button>
								) : null}
							</div>
						}
					>
						{moveNotices.length === 0 ? (
							<div className="rounded-lg border border-dashed">
								<Empty>
									<EmptyHeader>
										<EmptyTitle>
											<Trans>No tables were moved automatically.</Trans>
										</EmptyTitle>
									</EmptyHeader>
								</Empty>
							</div>
						) : (
							moveNotices.map((notice, idx) => {
								const fromLabels =
									notice.fromTableLabels.join(', ') || t`Unassigned`
								const toLabels =
									notice.toTableLabels.join(', ') || t`Unassigned`
								return (
									<div
										key={`${notice.reservationId}-${idx}`}
										className="bg-muted/50 flex flex-col gap-1 rounded-lg border p-3 text-sm"
										data-testid={`move-notice-${notice.reservationId}`}
									>
										<div className="flex items-start justify-between gap-2">
											<span className="font-medium wrap-anywhere">
												{notice.guestName} (
												<Plural
													value={notice.partySize}
													one="# guest"
													other="# guests"
												/>
												) • <span className="tabular-nums">{notice.hhmm}</span>
											</span>
											<Badge variant="secondary">
												{fromLabels} → {toLabels}
											</Badge>
										</div>
										<p className="text-muted-foreground">
											{label(MOVE_NOTICE_REASON_LABELS, notice.reason)}
										</p>
									</div>
								)
							})
						)}
					</SheetSection>
				</SheetPanel>
			</SheetContent>
		</Sheet>
	)
}
