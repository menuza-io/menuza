import { Trans, useLingui } from '@lingui/react/macro'
import { formatHhmm, parseHhmm } from '@repo/reservations'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useState } from 'react'
import {
	assignReservationTable,
	type DayMoveNotice,
	type DayReservationView,
	fetchReservationDetail,
	markReservationRunningLate,
	type ReservationDetailResponse,
	transitionReservationStatus,
	undoReservationTransition,
	updateReservation,
	updateReservationContactStatus,
	updateReservationCourseStage,
} from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import { type RsvTableRecord } from '#app/utils/reservations/setup-api.ts'

const COURSE_STAGES = [
	{ value: 'seated', label: 'Seated' },
	{ value: 'appetizer', label: 'Appetizer' },
	{ value: 'entree', label: 'Entree' },
	{ value: 'dessert', label: 'Dessert' },
	{ value: 'check_dropped', label: 'Check Dropped' },
	{ value: 'bussing', label: 'Bussing' },
] as const

const CONTACT_STATUSES = [
	{ value: 'none', label: 'Not Contacted' },
	{ value: 'sms_sent', label: 'SMS Sent' },
	{ value: 'left_voicemail', label: 'Left Voicemail' },
	{ value: 'confirmed_by_phone', label: 'Confirmed by Phone' },
] as const

export function DetailSheet({
	reservationId,
	fallbackReservation = null,
	onClose,
	client,
	tables,
	canManage = true,
	onUpdated,
}: {
	reservationId: string | null
	fallbackReservation?: DayReservationView | null
	onClose: () => void
	client: ReservationsScopedClient
	tables: RsvTableRecord[]
	canManage?: boolean
	onUpdated: (
		reservation: DayReservationView,
		moveNotices?: DayMoveNotice[],
	) => void
}) {
	const { t } = useLingui()
	const open = Boolean(reservationId)

	const [detail, setDetail] = useState<ReservationDetailResponse | null>(null)
	const [loading, setLoading] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// 60-second undo state
	const [undoState, setUndoState] = useState<{
		reservationId: string
		undoToken: string | null
		expiresAt: number
		previousStatus?: string
	} | null>(null)

	// Editable fields
	const [selectedTableId, setSelectedTableId] = useState<string>('')
	const [lockAssignment, setLockAssignment] = useState(false)
	const [forceOverbook, setForceOverbook] = useState(false)
	const [serverLabel, setServerLabel] = useState('')
	const [guestNotes, setGuestNotes] = useState('')
	const [internalNotes, setInternalNotes] = useState('')
	const [partySizeEdit, setPartySizeEdit] = useState<number>(2)
	const [timeEdit, setTimeEdit] = useState<string>('19:00')
	const [durationEdit, setDurationEdit] = useState<number>(90)

	const reservation = detail?.reservation ?? fallbackReservation

	const syncFormFromReservation = useCallback((rsv: DayReservationView) => {
		setSelectedTableId(rsv.assignedTableIds[0] ?? '')
		setLockAssignment(Boolean(rsv.locked))
		setServerLabel(rsv.serverLabel ?? '')
		setGuestNotes(rsv.guestNotes ?? '')
		setInternalNotes(rsv.internalNotes ?? '')
		setPartySizeEdit(rsv.partySize)
		setTimeEdit(rsv.hhmm || formatHhmm(rsv.localStartMin))
		setDurationEdit(rsv.durationMin)
	}, [])

	const loadDetail = useCallback(async () => {
		if (!reservationId) {
			setDetail(null)
			return
		}
		setLoading(true)
		setError(null)
		try {
			const res = await fetchReservationDetail(client, reservationId)
			setDetail(res)
			syncFormFromReservation(res.reservation)
		} catch (err) {
			if (fallbackReservation) {
				syncFormFromReservation(fallbackReservation)
			} else {
				setError(
					err instanceof Error
						? err.message
						: t`Failed to load reservation details.`,
				)
			}
		} finally {
			setLoading(false)
		}
	}, [client, fallbackReservation, reservationId, syncFormFromReservation, t])

	useEffect(() => {
		if (fallbackReservation) {
			syncFormFromReservation(fallbackReservation)
		}
		if (reservationId) {
			void loadDetail()
		} else {
			setDetail(null)
			setError(null)
		}
	}, [fallbackReservation, loadDetail, reservationId, syncFormFromReservation])

	const handleStatusTransition = async (toStatus: string) => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await transitionReservationStatus(client, reservation.id, {
				to: toStatus,
				expectedVersion: reservation.version,
				...(selectedTableId ? { tableIds: [selectedTableId] } : {}),
				...(serverLabel.trim() ? { serverLabel: serverLabel.trim() } : {}),
				forceOverbook,
			})
			setUndoState({
				reservationId: reservation.id,
				undoToken: res.undoToken,
				expiresAt: res.undoExpiresAt ?? Date.now() + 60_000,
				previousStatus: reservation.status,
			})
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t`Status transition failed.`,
			)
		} finally {
			setBusy(false)
		}
	}

	const handleUndo = async () => {
		if (!reservation || !undoState) return
		setBusy(true)
		setError(null)
		try {
			const res = await undoReservationTransition(
				client,
				reservation.id,
				undoState.undoToken,
				reservation.version,
			)
			setUndoState(null)
			onUpdated(res.reservation, [])
			await loadDetail()
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Failed to undo status.`)
		} finally {
			setBusy(false)
		}
	}

	const handleCourseStage = async (stage: string) => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await updateReservationCourseStage(
				client,
				reservation.id,
				stage,
				reservation.version,
			)
			onUpdated(res.reservation, [])
			await loadDetail()
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t`Failed to update course stage.`,
			)
		} finally {
			setBusy(false)
		}
	}

	const handleRunningLate = async (minutes: number) => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await markReservationRunningLate(
				client,
				reservation.id,
				minutes,
				true,
				reservation.version,
			)
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t`Failed to update late status.`,
			)
		} finally {
			setBusy(false)
		}
	}

	const handleContactStatus = async (status: string) => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await updateReservationContactStatus(
				client,
				reservation.id,
				status,
				reservation.version,
			)
			onUpdated(res.reservation, [])
			await loadDetail()
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: t`Failed to update contact status.`,
			)
		} finally {
			setBusy(false)
		}
	}

	const handleAssignTable = async () => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await assignReservationTable(client, reservation.id, {
				tableIds: selectedTableId ? [selectedTableId] : [],
				locked: lockAssignment,
				serverLabel: serverLabel.trim() || null,
				forceOverbook,
				reflowLaterParties: true,
				expectedVersion: reservation.version,
			})
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Failed to assign table.`)
		} finally {
			setBusy(false)
		}
	}

	const handleSaveEdits = async () => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			let nextStartMin = reservation.localStartMin
			try {
				nextStartMin = parseHhmm(
					timeEdit || formatHhmm(reservation.localStartMin),
				)
			} catch {
				// keep existing startMin if invalid
			}
			const res = await updateReservation(client, reservation.id, {
				partySize: partySizeEdit,
				localStartMin: nextStartMin,
				durationMin: durationEdit,
				serverLabel: serverLabel.trim() || null,
				guestNotes: guestNotes.trim() || null,
				internalNotes: internalNotes.trim() || null,
				forceOverbook,
				reflowLaterParties: true,
				expectedVersion: reservation.version,
			})
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t`Failed to update reservation.`,
			)
		} finally {
			setBusy(false)
		}
	}

	const guest = detail?.guest ?? reservation?.guest ?? null
	const activeTables = tables.filter((tbl) => tbl.isActive)

	return (
		<Sheet
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onClose()
			}}
		>
			<SheetContent
				className="w-full overflow-y-auto sm:max-w-xl"
				data-testid="reservation-detail-sheet"
			>
				<SheetHeader>
					<SheetTitle className="flex flex-wrap items-center gap-2">
						<span data-testid="detail-guest-name">
							{reservation?.guestName ?? t`Reservation Details`}
						</span>
						{reservation ? (
							<>
								<Badge variant="outline" data-testid="detail-confirmation-code">
									#{reservation.confirmationCode}
								</Badge>
								<Badge
									variant={
										reservation.status === 'seated'
											? 'default'
											: reservation.status === 'cancelled' ||
												  reservation.status === 'no_show'
												? 'destructive'
												: 'secondary'
									}
									data-testid="detail-status-badge"
								>
									{reservation.status}
								</Badge>
							</>
						) : null}
					</SheetTitle>
					<SheetDescription>
						{reservation ? (
							<span>
								{reservation.businessDate} • {reservation.hhmm} –{' '}
								{reservation.endHhmm} ({reservation.durationMin}m) •{' '}
								{reservation.partySize} <Trans>guests</Trans>
								{reservation.assignedTableLabels.length > 0
									? ` • ${reservation.assignedTableLabels.join(', ')}`
									: ` • ${t`Unassigned`}`}
							</span>
						) : (
							<Trans>Loading reservation details...</Trans>
						)}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-4 px-4 pb-6">
					{error ? (
						<Alert variant="destructive" data-testid="detail-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* 60-Second Undo Banner */}
					{undoState &&
					reservation &&
					undoState.reservationId === reservation.id ? (
						<div
							className="flex items-center justify-between gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
							data-testid="detail-undo-banner"
						>
							<span>
								<Trans>
									Status changed to {reservation.status}. You can undo within 60
									seconds.
								</Trans>
							</span>
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={busy}
								onClick={handleUndo}
								data-testid="detail-undo-btn"
							>
								<Icon name="undo-2" className="size-3.5" />
								<span>
									<Trans>Undo</Trans>
								</span>
							</Button>
						</div>
					) : null}

					{reservation ? (
						<>
							{/* Quick Status Transitions */}
							{canManage ? (
								<div className="bg-muted/30 flex flex-col gap-2 rounded-lg border p-3">
									<span className="text-xs font-semibold">
										<Trans>Host Actions & Status</Trans>
									</span>
									<div className="flex flex-wrap gap-1.5">
										{(reservation.status === 'booked' ||
											reservation.status === 'confirmed' ||
											reservation.status === 'pending_payment') && (
											<Button
												type="button"
												size="xs"
												variant="outline"
												disabled={busy}
												onClick={() => handleStatusTransition('arrived')}
												data-testid="detail-status-arrived"
											>
												<Trans>Mark Arrived</Trans>
											</Button>
										)}
										{(reservation.status === 'booked' ||
											reservation.status === 'confirmed' ||
											reservation.status === 'arrived' ||
											reservation.status === 'pending_payment') && (
											<Button
												type="button"
												size="xs"
												disabled={busy}
												onClick={() => handleStatusTransition('seated')}
												data-testid="detail-status-seated"
											>
												<Icon name="check" className="size-3.5" />
												<span>
													<Trans>Seat Party</Trans>
												</span>
											</Button>
										)}
										{reservation.status === 'seated' && (
											<Button
												type="button"
												size="xs"
												disabled={busy}
												onClick={() => handleStatusTransition('completed')}
												data-testid="detail-status-completed"
											>
												<Icon name="check" className="size-3.5" />
												<span>
													<Trans>Complete & Clear Table</Trans>
												</span>
											</Button>
										)}
										{(reservation.status === 'booked' ||
											reservation.status === 'confirmed' ||
											reservation.status === 'arrived') && (
											<Button
												type="button"
												size="xs"
												variant="destructive"
												disabled={busy}
												onClick={() => handleStatusTransition('no_show')}
												data-testid="detail-status-no_show"
											>
												<Trans>Mark No-Show</Trans>
											</Button>
										)}
										{reservation.status !== 'cancelled' &&
											reservation.status !== 'completed' &&
											reservation.status !== 'finished' &&
											reservation.status !== 'no_show' && (
												<Button
													type="button"
													size="xs"
													variant="outline"
													disabled={busy}
													onClick={() => handleStatusTransition('cancelled')}
													data-testid="detail-status-cancelled"
												>
													<Trans>Cancel Reservation</Trans>
												</Button>
											)}
									</div>

									{/* Course Stage progression when seated */}
									{reservation.status === 'seated' ? (
										<div className="flex flex-col gap-1 border-t pt-2">
											<span className="text-muted-foreground text-xs">
												<Trans>Course Progression</Trans>
											</span>
											<div className="flex flex-wrap gap-1">
												{COURSE_STAGES.map((st) => {
													const active =
														(reservation.courseStage ?? 'seated') === st.value
													return (
														<Button
															key={st.value}
															type="button"
															size="xs"
															variant={active ? 'default' : 'outline'}
															disabled={busy}
															onClick={() => handleCourseStage(st.value)}
															data-testid={`detail-course-${st.value}`}
														>
															{st.label}
														</Button>
													)
												})}
											</div>
										</div>
									) : null}
								</div>
							) : null}

							{/* Running Late & Contact Tracking (VAL-BOOK-028) */}
							{canManage ? (
								<div className="grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2">
									<div className="flex flex-col gap-1.5">
										<Label className="text-xs">
											<Trans>Running Late Hold</Trans>
											{reservation.runningLateMin ? (
												<Badge variant="secondary" className="ms-1.5">
													+{reservation.runningLateMin}m
												</Badge>
											) : null}
										</Label>
										<div className="flex flex-wrap gap-1">
											{[15, 30, 45].map((mins) => (
												<Button
													key={mins}
													type="button"
													size="xs"
													variant={
														reservation.runningLateMin === mins
															? 'default'
															: 'outline'
													}
													disabled={busy}
													onClick={() => handleRunningLate(mins)}
													data-testid={`detail-late-${mins}`}
												>
													+{mins}m
												</Button>
											))}
											{reservation.runningLateMin ? (
												<Button
													type="button"
													size="xs"
													variant="ghost"
													disabled={busy}
													onClick={() => handleRunningLate(0)}
													data-testid="detail-late-0"
												>
													<Trans>Clear</Trans>
												</Button>
											) : null}
										</div>
									</div>

									<div className="flex flex-col gap-1.5">
										<Label htmlFor="detail-contact-select" className="text-xs">
											<Trans>Contact Tracking</Trans>
										</Label>
										<select
											id="detail-contact-select"
											value={reservation.contactStatus ?? 'none'}
											onChange={(e) => handleContactStatus(e.target.value)}
											disabled={busy}
											className="border-input bg-background h-8 rounded-md border px-2 text-xs"
											data-testid="detail-contact-select"
										>
											{CONTACT_STATUSES.map((cs) => (
												<option key={cs.value} value={cs.value}>
													{cs.label}
												</option>
											))}
										</select>
									</div>
								</div>
							) : null}

							{/* Table Assignment */}
							{canManage ? (
								<div className="flex flex-col gap-2 rounded-lg border p-3">
									<span className="text-xs font-semibold">
										<Trans>Table Assignment</Trans>
									</span>
									<div className="flex flex-wrap items-center gap-2">
										<select
											value={selectedTableId}
											onChange={(e) => setSelectedTableId(e.target.value)}
											className="border-input bg-background h-8 flex-1 rounded-md border px-2 text-xs"
											data-testid="detail-table-select"
										>
											<option value="">{t`Unassigned`}</option>
											{activeTables.map((tbl) => (
												<option key={tbl.id} value={tbl.id}>
													{tbl.label} ({tbl.minCovers}-{tbl.maxCovers})
												</option>
											))}
										</select>
										<Button
											type="button"
											size="xs"
											disabled={busy}
											onClick={handleAssignTable}
											data-testid="detail-assign-table-btn"
										>
											<Trans>Assign Table</Trans>
										</Button>
									</div>
									<div className="flex flex-wrap items-center gap-4">
										<label className="flex items-center gap-1.5 text-xs">
											<input
												type="checkbox"
												checked={lockAssignment}
												onChange={(e) => setLockAssignment(e.target.checked)}
												data-testid="detail-lock-assignment"
											/>
											<span>
												<Trans>Lock table assignment</Trans>
											</span>
										</label>
										<label className="flex items-center gap-1.5 text-xs">
											<input
												type="checkbox"
												checked={forceOverbook}
												onChange={(e) => setForceOverbook(e.target.checked)}
												data-testid="detail-force-overbook"
											/>
											<span>
												<Trans>Force overbook / ignore table overlap</Trans>
											</span>
										</label>
									</div>
								</div>
							) : null}

							{/* Guest CRM Card */}
							<div
								className="bg-muted/20 flex flex-col gap-2 rounded-lg border p-3 text-xs"
								data-testid="detail-guest-crm"
							>
								<div className="flex items-center justify-between">
									<span className="font-semibold">
										<Trans>Guest CRM Profile</Trans>
									</span>
									<div className="flex flex-wrap items-center gap-1">
										{guest?.vipTier && guest.vipTier !== 'none' ? (
											<Badge variant="default" data-testid="detail-vip-badge">
												{guest.vipTier}
											</Badge>
										) : null}
										<Badge variant="outline">
											{guest?.visitCount ?? 0} <Trans>visits</Trans>
										</Badge>
										{(guest?.noShowCount ?? 0) > 0 ? (
											<Badge variant="destructive">
												{guest?.noShowCount} <Trans>no-shows</Trans>
											</Badge>
										) : null}
									</div>
								</div>
								<div className="text-muted-foreground flex flex-wrap gap-3">
									<span>{reservation.guestPhone || '—'}</span>
									{reservation.guestEmail ? (
										<span>{reservation.guestEmail}</span>
									) : null}
								</div>
								{reservation.dietaryCodes.length > 0 ? (
									<div className="flex flex-wrap gap-1">
										{reservation.dietaryCodes.map((code) => (
											<Badge key={code} variant="secondary">
												{code}
											</Badge>
										))}
									</div>
								) : null}
								{guest?.allergiesText ? (
									<div className="text-red-600 dark:text-red-400">
										<Trans>Allergies:</Trans> {guest.allergiesText}
									</div>
								) : null}
								{guest?.seatingPrefText ? (
									<div>
										<Trans>Seating Preference:</Trans> {guest.seatingPrefText}
									</div>
								) : null}
							</div>

							{/* Edit Reservation Details & Notes */}
							{canManage ? (
								<div className="flex flex-col gap-2.5 rounded-lg border p-3">
									<span className="text-xs font-semibold">
										<Trans>Modify Time, Party Size & Notes</Trans>
									</span>
									<div className="grid grid-cols-3 gap-2">
										<div className="flex flex-col gap-1">
											<Label htmlFor="detail-party-size" className="text-xs">
												<Trans>Party Size</Trans>
											</Label>
											<Input
												id="detail-party-size"
												type="number"
												min={1}
												max={40}
												value={partySizeEdit}
												onChange={(e) =>
													setPartySizeEdit(
														Math.max(1, Number(e.target.value) || 1),
													)
												}
												className="h-8 text-xs"
												data-testid="detail-party-size-input"
											/>
										</div>
										<div className="flex flex-col gap-1">
											<Label htmlFor="detail-time-edit" className="text-xs">
												<Trans>Time</Trans>
											</Label>
											<Input
												id="detail-time-edit"
												type="time"
												step={900}
												value={timeEdit}
												onChange={(e) => setTimeEdit(e.target.value)}
												className="h-8 text-xs"
												data-testid="detail-time-input"
											/>
										</div>
										<div className="flex flex-col gap-1">
											<Label htmlFor="detail-duration-edit" className="text-xs">
												<Trans>Duration (m)</Trans>
											</Label>
											<Input
												id="detail-duration-edit"
												type="number"
												min={15}
												max={360}
												step={15}
												value={durationEdit}
												onChange={(e) =>
													setDurationEdit(
														Math.max(15, Number(e.target.value) || 60),
													)
												}
												className="h-8 text-xs"
												data-testid="detail-duration-input"
											/>
										</div>
									</div>

									<div className="flex flex-col gap-1">
										<Label htmlFor="detail-server-input" className="text-xs">
											<Trans>Server / Section Label</Trans>
										</Label>
										<Input
											id="detail-server-input"
											value={serverLabel}
											onChange={(e) => setServerLabel(e.target.value)}
											className="h-8 text-xs"
											data-testid="detail-server-input"
										/>
									</div>

									<div className="flex flex-col gap-1">
										<Label htmlFor="detail-guest-notes" className="text-xs">
											<Trans>Guest Notes</Trans>
										</Label>
										<Textarea
											id="detail-guest-notes"
											rows={2}
											value={guestNotes}
											onChange={(e) => setGuestNotes(e.target.value)}
											className="text-xs"
											data-testid="detail-guest-notes-input"
										/>
									</div>

									<div className="flex flex-col gap-1">
										<Label htmlFor="detail-internal-notes" className="text-xs">
											<Trans>Internal Host Notes</Trans>
										</Label>
										<Textarea
											id="detail-internal-notes"
											rows={2}
											value={internalNotes}
											onChange={(e) => setInternalNotes(e.target.value)}
											className="text-xs"
											data-testid="detail-internal-notes-input"
										/>
									</div>

									<div className="flex justify-end">
										<Button
											type="button"
											size="xs"
											disabled={busy}
											onClick={handleSaveEdits}
											data-testid="detail-save-notes-btn"
										>
											<Trans>Save Changes</Trans>
										</Button>
									</div>
								</div>
							) : null}

							{/* Past Visit History */}
							{detail?.history && detail.history.length > 0 ? (
								<div
									className="flex flex-col gap-1.5 rounded-lg border p-3 text-xs"
									data-testid="detail-history-list"
								>
									<span className="font-semibold">
										<Trans>Past Visit History</Trans>
									</span>
									<div className="divide-y">
										{detail.history.slice(0, 5).map((h) => (
											<div
												key={h.id}
												className="flex items-center justify-between py-1.5"
											>
												<span>
													{h.businessDate} {h.hhmm} ({h.partySize}{' '}
													<Trans>guests</Trans>)
												</span>
												<Badge variant="outline">{h.status}</Badge>
											</div>
										))}
									</div>
								</div>
							) : null}

							{/* Audit Trail */}
							{detail?.audit && detail.audit.length > 0 ? (
								<div
									className="flex flex-col gap-1.5 rounded-lg border p-3 text-xs"
									data-testid="detail-audit-list"
								>
									<span className="font-semibold">
										<Trans>Audit Trail</Trans>
									</span>
									<div className="max-h-40 divide-y overflow-y-auto">
										{detail.audit.map((entry) => (
											<div
												key={entry.id}
												className="flex items-center justify-between py-1"
											>
												<div>
													<span className="font-medium">{entry.action}</span>
													{entry.reason ? (
														<span className="text-muted-foreground ms-1">
															({entry.reason})
														</span>
													) : null}
												</div>
												<span className="text-muted-foreground">
													{entry.actorType}
												</span>
											</div>
										))}
									</div>
								</div>
							) : null}
						</>
					) : loading ? (
						<div className="text-muted-foreground py-8 text-center text-sm">
							<Trans>Loading reservation...</Trans>
						</div>
					) : null}
				</div>
			</SheetContent>
		</Sheet>
	)
}
