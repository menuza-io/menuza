import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { useState } from 'react'
import {
	assignReservationTable,
	type DayConflictNotice,
	type DayMoveNotice,
	type DayReservationView,
} from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { type RsvTableRecord } from '#app/utils/reservations/setup-api.ts'

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
	const { t } = useLingui()
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [tablePicks, setTablePicks] = useState<Record<string, string>>({})

	const activeTables = tables.filter((tbl) => tbl.isActive)

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
				err instanceof Error ? err.message : t`Failed to resolve assignment.`,
			)
		} finally {
			setBusyId(null)
		}
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="w-full overflow-y-auto sm:max-w-lg"
				data-testid="conflict-panel"
			>
				<SheetHeader>
					<SheetTitle>
						<Trans>Unassigned, Conflicts & Reflow Notices</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>
							Resolve table overlaps, blocked-table assignments, unassigned
							parties, and review automatic turn-extension reflows.
						</Trans>
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-5 px-4 pb-6">
					{error ? (
						<Alert variant="destructive" data-testid="conflict-panel-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* Section 1: Active Conflicts */}
					<div className="flex flex-col gap-2" data-testid="conflict-list">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold">
								<Trans>Active Conflicts</Trans>
							</h3>
							<Badge
								variant={conflicts.length > 0 ? 'destructive' : 'secondary'}
							>
								{conflicts.length}
							</Badge>
						</div>

						{conflicts.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
								<Trans>No active table or schedule conflicts.</Trans>
							</div>
						) : (
							conflicts.map((conflict) => {
								const pickedTableId =
									tablePicks[conflict.reservationId] ??
									conflict.suggestedTableIds[0] ??
									''
								return (
									<div
										key={`${conflict.reservationId}-${conflict.reason}`}
										className="flex flex-col gap-2 rounded-lg border border-red-300 bg-red-50/50 p-3 text-xs dark:border-red-900 dark:bg-red-950/30"
										data-testid={`conflict-item-${conflict.reservationId}`}
									>
										<div className="flex items-center justify-between gap-2">
											<div className="font-semibold">
												{conflict.guestName} ({conflict.partySize}{' '}
												<Trans>guests</Trans>) • {conflict.hhmm}
											</div>
											<Badge variant="destructive">{conflict.reason}</Badge>
										</div>
										<p className="text-muted-foreground">{conflict.message}</p>

										{canManage ? (
											<div className="flex flex-wrap items-center gap-2 pt-1">
												{conflict.suggestedTableIds.length > 0 ? (
													<Button
														type="button"
														size="xs"
														disabled={busyId === conflict.reservationId}
														onClick={() =>
															handleAssign(
																conflict.reservationId,
																conflict.suggestedTableIds,
															)
														}
														data-testid={`conflict-reassign-suggested-${conflict.reservationId}`}
													>
														<Icon name="check" className="size-3.5" />
														<span>
															<Trans>
																Reassign to{' '}
																{conflict.suggestedTableLabels.join(', ')}
															</Trans>
														</span>
													</Button>
												) : null}

												<select
													value={pickedTableId}
													onChange={(e) =>
														setTablePicks((prev) => ({
															...prev,
															[conflict.reservationId]: e.target.value,
														}))
													}
													className="border-input bg-background h-7 rounded-md border px-2 text-xs"
													data-testid={`conflict-table-select-${conflict.reservationId}`}
												>
													<option value="">{t`Pick table...`}</option>
													{activeTables.map((tbl) => (
														<option key={tbl.id} value={tbl.id}>
															{tbl.label} ({tbl.minCovers}-{tbl.maxCovers})
														</option>
													))}
												</select>

												<Button
													type="button"
													size="xs"
													variant="outline"
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
													size="xs"
													variant="ghost"
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
					</div>

					{/* Section 2: Unassigned Parties */}
					<div className="flex flex-col gap-2" data-testid="unassigned-list">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold">
								<Trans>Unassigned Reservations</Trans>
							</h3>
							<Badge variant="secondary">{unassigned.length}</Badge>
						</div>

						{unassigned.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
								<Trans>All active reservations have assigned tables.</Trans>
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
										className="bg-card flex flex-col gap-2 rounded-lg border p-3 text-xs"
										data-testid={`unassigned-item-${rsv.id}`}
									>
										<div className="flex items-center justify-between">
											<span className="font-semibold">
												{rsv.guestName} ({rsv.partySize} <Trans>guests</Trans>)
												• {rsv.hhmm}
											</span>
											<Badge variant="outline">#{rsv.confirmationCode}</Badge>
										</div>

										{canManage ? (
											<div className="flex flex-wrap items-center gap-2">
												<select
													value={pickedTableId}
													onChange={(e) =>
														setTablePicks((prev) => ({
															...prev,
															[rsv.id]: e.target.value,
														}))
													}
													className="border-input bg-background h-7 flex-1 rounded-md border px-2 text-xs"
													data-testid={`unassigned-table-select-${rsv.id}`}
												>
													<option value="">{t`Select table...`}</option>
													{activeTables.map((tbl) => (
														<option key={tbl.id} value={tbl.id}>
															{tbl.label} ({tbl.minCovers}-{tbl.maxCovers})
														</option>
													))}
												</select>
												<Button
													type="button"
													size="xs"
													disabled={!pickedTableId || busyId === rsv.id}
													onClick={() => handleAssign(rsv.id, [pickedTableId])}
													data-testid={`unassigned-assign-btn-${rsv.id}`}
												>
													<Trans>Assign</Trans>
												</Button>
												<Button
													type="button"
													size="xs"
													variant="ghost"
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
					</div>

					{/* Section 3: Reflow Move Notices */}
					<div className="flex flex-col gap-2" data-testid="move-notices-list">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold">
								<Trans>Automatic Reflow Notices</Trans>
							</h3>
							<div className="flex items-center gap-1.5">
								<Badge variant="outline">{moveNotices.length}</Badge>
								{moveNotices.length > 0 && onClearMoveNotices ? (
									<Button
										type="button"
										size="xs"
										variant="ghost"
										onClick={onClearMoveNotices}
										data-testid="clear-move-notices-btn"
									>
										<Trans>Clear</Trans>
									</Button>
								) : null}
							</div>
						</div>

						{moveNotices.length === 0 ? (
							<div className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
								<Trans>No recent turn-extension table reflows.</Trans>
							</div>
						) : (
							moveNotices.map((notice, idx) => (
								<div
									key={`${notice.reservationId}-${idx}`}
									className="flex flex-col gap-1 rounded-lg border border-amber-300 bg-amber-50/50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30"
									data-testid={`move-notice-${notice.reservationId}`}
								>
									<div className="flex items-center justify-between">
										<span className="font-semibold">
											{notice.guestName} ({notice.partySize}{' '}
											<Trans>guests</Trans>) • {notice.hhmm}
										</span>
										<Badge variant="secondary">
											{notice.fromTableLabels.join(', ') || t`Unassigned`} →{' '}
											{notice.toTableLabels.join(', ') || t`Unassigned`}
										</Badge>
									</div>
									<p className="text-muted-foreground">{notice.reason}</p>
								</div>
							))
						)}
					</div>
				</div>
			</SheetContent>
		</Sheet>
	)
}
