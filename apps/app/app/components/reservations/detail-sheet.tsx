import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { formatHhmm, parseHhmm } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { Link, useInRouterContext, useOutletContext } from 'react-router'
import { toast } from 'sonner'
import { PaymentBadge } from '#app/components/reservations/payment-badge.tsx'
import { PaymentPanel } from '#app/components/reservations/payment-panel.tsx'
import { ReservationsClientContext } from '#app/components/reservations/reservations-client-provider.tsx'
import {
	CheckRow,
	PartyStepper,
	SheetSection,
} from '#app/components/reservations/sheet-parts.tsx'
import { StatusLabel } from '#app/components/reservations/status-style.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import {
	assignReservationTable,
	type DayMoveNotice,
	type DayReservationView,
	fetchReservationDetail,
	fetchReservationEvents,
	markReservationRunningLate,
	type ReservationAuditEntry,
	type ReservationDetailResponse,
	resendReservationConfirmation,
	transitionReservationStatus,
	undoReservationTransition,
	updateReservation,
	updateReservationContactStatus,
	updateReservationCourseStage,
} from '#app/utils/reservations/book-api.ts'
import { formatBusinessDate } from '#app/utils/reservations/business-date.ts'
import { hostErrorMessage } from '#app/utils/reservations/host-errors.ts'
import {
	ACTOR_KIND_LABELS,
	CHANNEL_LABELS,
	clientLabel,
	DIETARY_LABELS,
	enumLabel,
	MOVE_NOTICE_REASON_LABELS,
	EVENT_TYPE_LABELS,
	OCCASION_LABELS,
	RESERVATION_STATUS_LABELS,
	VIP_TIER_LABELS,
} from '#app/utils/reservations/labels.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	extractApiErrorCode,
	type RsvAreaRecord,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'
import { waitlistErrorInfo } from '#app/utils/reservations/waitlist-errors.ts'

const COURSE_STAGES = [
	{ value: 'seated', label: msg`Seated` },
	{ value: 'appetizer', label: msg`Appetizer` },
	{ value: 'entree', label: msg`Entree` },
	{ value: 'dessert', label: msg`Dessert` },
	{ value: 'check_dropped', label: msg`Check Dropped` },
	{ value: 'bussing', label: msg`Bussing` },
] as const

const CONTACT_STATUSES = [
	{ value: 'none', label: msg`Not reached yet` },
	{ value: 'left_message', label: msg`Left a message` },
	{ value: 'no_answer', label: msg`No answer` },
	{ value: 'wrong_number', label: msg`Wrong number` },
] as const

/** The backend only re-sends a confirmation for an upcoming booking. */
const RESENDABLE_STATUSES = new Set(['booked', 'confirmed'])

type EditableField =
	| 'table'
	| 'lock'
	| 'server'
	| 'guestNotes'
	| 'internalNotes'
	| 'partySize'
	| 'time'
	| 'duration'

/** Select items cannot carry an empty value, so "no table" travels as this. */
const NO_TABLE = '__none'

export function DetailSheet({
	reservationId,
	fallbackReservation = null,
	onClose,
	client,
	tables,
	areas = [],
	timeZone,
	canManage = true,
	onUpdated,
}: {
	reservationId: string | null
	fallbackReservation?: DayReservationView | null
	onClose: () => void
	client: ReservationsScopedClient
	tables: RsvTableRecord[]
	areas?: RsvAreaRecord[]
	/** Time zone of the location, used for history timestamps. */
	timeZone?: string
	canManage?: boolean
	onUpdated: (
		reservation: DayReservationView,
		moveNotices?: DayMoveNotice[],
	) => void
}) {
	const { t, i18n } = useLingui()
	const open = Boolean(reservationId)
	const inRouter = useInRouterContext()
	const layout = useOutletContext<{
		orgSlug?: string
		nav?: { customers?: boolean }
		payments?: { enabled: boolean; canAct: boolean }
	} | null>()
	const clientPool = useContext(ReservationsClientContext)
	// Guests live in Customers: the link opens the person (`g_<id>` resolves to
	// the linked customer when there is one).
	const customersBase =
		inRouter && layout?.orgSlug && layout.nav?.customers
			? `/${layout.orgSlug}/customers`
			: null

	const [detail, setDetail] = useState<ReservationDetailResponse | null>(null)
	const [events, setEvents] = useState<ReservationAuditEntry[] | null>(null)
	const [loading, setLoading] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false)
	const [cancelOpen, setCancelOpen] = useState(false)
	const [cancelReason, setCancelReason] = useState('')
	const [noShowOpen, setNoShowOpen] = useState(false)
	const [overbookConfirmOpen, setOverbookConfirmOpen] = useState(false)
	const [advancedOpen, setAdvancedOpen] = useState(false)

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

	// A response for another booking must never paint over the open one.
	const openDetail =
		detail && detail.reservation.id === reservationId ? detail : null
	const reservation = openDetail?.reservation ?? fallbackReservation

	// Payment rows are read in the browser with a `payments` token, never through
	// the App server. The panel stays out of the way when payments are off.
	const paymentsLocationId = reservation?.locationId ?? null
	const paymentsClient = useMemo(
		() =>
			layout?.payments?.enabled && clientPool
				? clientPool.forScope(
						'payments',
						paymentsLocationId ? [paymentsLocationId] : undefined,
					)
				: null,
		[layout?.payments?.enabled, clientPool, paymentsLocationId],
	)

	const label = (
		labels: Record<string, MessageDescriptor>,
		value: string | null | undefined,
	) => enumLabel((d) => i18n._(d), labels, value)

	const formatTimestamp = (ms: number) => {
		if (!ms) return ''
		try {
			return i18n.date(new Date(ms), {
				dateStyle: 'medium',
				timeStyle: 'short',
				...(timeZone ? { timeZone } : {}),
			})
		} catch {
			return i18n.date(new Date(ms), {
				dateStyle: 'medium',
				timeStyle: 'short',
			})
		}
	}

	// Fields the operator edited and has not saved. Incoming props and polls
	// must never overwrite them.
	const dirtyFieldsRef = useRef(new Set<EditableField>())
	const markDirty = useCallback((field: EditableField) => {
		dirtyFieldsRef.current.add(field)
	}, [])
	const clearDirty = useCallback((fields: EditableField[]) => {
		for (const field of fields) dirtyFieldsRef.current.delete(field)
	}, [])

	const syncFormFromReservation = useCallback((rsv: DayReservationView) => {
		const dirty = dirtyFieldsRef.current
		if (!dirty.has('table')) setSelectedTableId(rsv.assignedTableIds[0] ?? '')
		if (!dirty.has('lock')) setLockAssignment(Boolean(rsv.locked))
		if (!dirty.has('server')) setServerLabel(rsv.serverLabel ?? '')
		if (!dirty.has('guestNotes')) setGuestNotes(rsv.guestNotes ?? '')
		if (!dirty.has('internalNotes')) setInternalNotes(rsv.internalNotes ?? '')
		if (!dirty.has('partySize')) setPartySizeEdit(rsv.partySize)
		if (!dirty.has('time')) {
			setTimeEdit(rsv.hhmm || formatHhmm(rsv.localStartMin))
		}
		if (!dirty.has('duration')) setDurationEdit(rsv.durationMin)
	}, [])

	const fallbackRef = useRef(fallbackReservation)
	fallbackRef.current = fallbackReservation

	// Only the newest detail request for the open reservation may write state:
	// a slow response for a booking that is no longer open is dropped.
	const loadSeq = useRef(0)
	const openIdRef = useRef(reservationId)
	openIdRef.current = reservationId

	const loadDetail =
		useCallback(async (): Promise<DayReservationView | null> => {
			const requestedId = reservationId
			const seq = ++loadSeq.current
			if (!requestedId) {
				setDetail(null)
				setEvents(null)
				return null
			}
			setLoading(true)
			setError(null)
			try {
				const [res, history] = await Promise.all([
					fetchReservationDetail(client, requestedId),
					fetchReservationEvents(client, requestedId).catch(() => null),
				])
				if (seq !== loadSeq.current || openIdRef.current !== requestedId) {
					return null
				}
				setDetail(res)
				setEvents(history)
				syncFormFromReservation(res.reservation)
				return res.reservation
			} catch (err) {
				if (seq !== loadSeq.current || openIdRef.current !== requestedId) {
					return null
				}
				if (fallbackRef.current) {
					syncFormFromReservation(fallbackRef.current)
				} else {
					setError(
						hostErrorMessage(
							err,
							(d) => i18n._(d),
							msg`Failed to load reservation details.`,
						),
					)
				}
				return null
			} finally {
				if (seq === loadSeq.current) setLoading(false)
			}
		}, [client, i18n, reservationId, syncFormFromReservation])

	// A refused change (someone else edited first, the booking moved on):
	// say so in plain words and pull the latest version of the booking.
	const fail = (err: unknown, fallback: MessageDescriptor) => {
		setError(hostErrorMessage(err, (d) => i18n._(d), fallback))
		const { code, status } = waitlistErrorInfo(err)
		if (
			code === 'stale_version' ||
			code === 'invalid_transition' ||
			code === 'not_found' ||
			status === 409
		) {
			void loadDetail().then((fresh) => {
				if (fresh) onUpdated(fresh)
			})
		}
	}

	const syncedReservationIdRef = useRef<string | null>(null)
	useEffect(() => {
		if (syncedReservationIdRef.current !== reservationId) {
			syncedReservationIdRef.current = reservationId
			dirtyFieldsRef.current.clear()
		}
		if (fallbackReservation) {
			syncFormFromReservation(fallbackReservation)
		}
	}, [fallbackReservation, reservationId, syncFormFromReservation])

	useEffect(() => {
		if (reservationId) {
			void loadDetail()
		} else {
			loadSeq.current++
			setDetail(null)
			setEvents(null)
			setError(null)
		}
	}, [loadDetail, reservationId])

	const handleStatusTransition = async (toStatus: string, reason?: string) => {
		if (!reservation) return
		setBusy(true)
		setError(null)
		try {
			const res = await transitionReservationStatus(client, reservation.id, {
				to: toStatus,
				expectedVersion: reservation.version,
				...(reason ? { reason } : {}),
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
			fail(err, msg`Status transition failed.`)
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
			fail(err, msg`Failed to undo status.`)
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
			fail(err, msg`Failed to update course stage.`)
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
			fail(err, msg`Failed to update late status.`)
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
			fail(err, msg`Failed to update reminder status.`)
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
			clearDirty(['table', 'lock', 'server'])
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			fail(err, msg`Failed to assign table.`)
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
			clearDirty([
				'partySize',
				'time',
				'duration',
				'server',
				'guestNotes',
				'internalNotes',
			])
			onUpdated(res.reservation, res.moveNotices)
			await loadDetail()
		} catch (err) {
			fail(err, msg`Failed to update reservation.`)
		} finally {
			setBusy(false)
		}
	}

	const handleResend = async (rotate: boolean) => {
		if (!reservation) return
		setBusy(true)
		try {
			const res = await resendReservationConfirmation(client, reservation.id, {
				rotate,
			})
			toast.success(
				rotate
					? t`Confirmation sent with a new manage link`
					: t`Confirmation sent`,
			)
			if (res.reservation) onUpdated(res.reservation, [])
			await loadDetail()
		} catch (err) {
			const code = extractApiErrorCode(err)
			toast.error(
				code === 'no_destination'
					? t`The guest has no email address or opted-in phone number to send to.`
					: code === 'invalid_state_for_resend'
						? t`Only an upcoming booking can be re-sent.`
						: t`The confirmation could not be sent.`,
			)
		} finally {
			setBusy(false)
			setRotateConfirmOpen(false)
		}
	}

	const statusLabel = label(RESERVATION_STATUS_LABELS, reservation?.status)
	const guest = openDetail?.guest ?? reservation?.guest ?? null
	const history = events ?? openDetail?.audit ?? []
	const diningAreaName =
		reservation?.areaName ??
		areas.find((area) => area.id === reservation?.areaId)?.name ??
		null
	const tableLabelById = new Map(tables.map((tbl) => [tbl.id, tbl.label]))
	const tableLabels = (value: unknown): string =>
		Array.isArray(value)
			? value
					.filter((v): v is string => typeof v === 'string')
					.map((id) => tableLabelById.get(id) ?? id)
					.join(', ')
			: ''
	const activeTables = tables.filter((tbl) => tbl.isActive)
	const unassignedLabel = t`Unassigned`
	const tableOptions = [
		{ value: NO_TABLE, label: unassignedLabel },
		...activeTables.map((tbl) => ({
			value: tbl.id,
			label: `${tbl.label} (${tbl.minCovers}-${tbl.maxCovers})`,
		})),
	]
	const contactOptions = CONTACT_STATUSES.map((cs) => ({
		value: cs.value,
		label: i18n._(cs.label),
	}))

	const status = reservation?.status ?? ''
	const nextAction: 'arrived' | 'seated' | 'completed' | null =
		status === 'booked' ||
		status === 'confirmed' ||
		status === 'pending_payment'
			? 'arrived'
			: status === 'arrived'
				? 'seated'
				: status === 'seated'
					? 'completed'
					: null
	const canSeatEarly =
		status === 'booked' ||
		status === 'confirmed' ||
		status === 'pending_payment'
	const canNoShow =
		status === 'booked' || status === 'confirmed' || status === 'arrived'
	const canCancel =
		status !== '' &&
		status !== 'cancelled' &&
		status !== 'completed' &&
		status !== 'finished' &&
		status !== 'no_show'
	const guestFirstName =
		(reservation?.guestName ?? '').trim().split(/\s+/)[0] || t`the guest`
	const showFooter = Boolean(canManage && reservation && nextAction)
	const hasPayment = Boolean(
		paymentsClient &&
		layout?.orgSlug &&
		reservation &&
		(reservation.paymentStatus !== 'none' ||
			reservation.status === 'pending_payment'),
	)
	const showMessages = Boolean(
		canManage &&
		reservation &&
		RESENDABLE_STATUSES.has(reservation.status) &&
		(reservation.guestPhone || reservation.guestEmail),
	)
	const visibleTags = (guest?.tags ?? []).filter(
		(tag) => canManage || !tag.sensitive,
	)

	const hasAlertContent = Boolean(
		reservation &&
		(reservation.dietaryCodes.length > 0 ||
			guest?.allergiesText ||
			reservation.dietaryNotes ||
			reservation.guestNotes ||
			reservation.internalNotes),
	)
	const primaryLabel =
		nextAction === 'arrived'
			? t`Mark arrived`
			: nextAction === 'seated'
				? t`Seat Party`
				: t`Complete & Clear Table`

	const whenLabel = reservation
		? formatBusinessDate(reservation.businessDate, i18n.locale, 'short')
		: ''
	const tablesText =
		reservation && reservation.assignedTableLabels.length > 0
			? reservation.assignedTableLabels.join(', ')
			: unassignedLabel

	return (
		<Sheet
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onClose()
			}}
		>
			<SheetContent
				className="w-full gap-0 sm:max-w-lg"
				data-testid="reservation-detail-sheet"
			>
				<SheetHeader className="border-b pe-12 rtl:ps-12 rtl:pe-4">
					<SheetTitle className="text-base wrap-anywhere">
						<span data-testid="detail-guest-name">
							{reservation?.guestName ?? t`Reservation Details`}
						</span>
					</SheetTitle>
					<SheetDescription className="tabular-nums">
						{reservation ? (
							<>
								{whenLabel} · {reservation.hhmm}–{reservation.endHhmm} ·{' '}
								<Plural
									value={reservation.partySize}
									one="# guest"
									other="# guests"
								/>{' '}
								· {tablesText}
							</>
						) : (
							<Trans>Loading reservation details...</Trans>
						)}
					</SheetDescription>
					{reservation ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
							<StatusLabel
								status={reservation.status}
								testId="detail-status-badge"
								className="text-sm"
							/>
							{guest?.vipTier && guest.vipTier !== 'none' ? (
								<Badge variant="default" data-testid="detail-vip-badge">
									{label(VIP_TIER_LABELS, guest.vipTier)}
								</Badge>
							) : null}
							<PaymentBadge
								paymentStatus={reservation.paymentStatus}
								experience={Boolean(reservation.experienceId)}
							/>
							{reservation.experienceId ? (
								<Badge variant="outline" data-testid="detail-experience-badge">
									<Trans>Experience</Trans>
								</Badge>
							) : null}
							<span
								className="text-muted-foreground text-xs tabular-nums"
								data-testid="detail-confirmation-code"
							>
								#{reservation.confirmationCode}
							</span>
						</div>
					) : null}
				</SheetHeader>

				<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
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
							role="status"
							className="bg-muted/50 flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
							data-testid="detail-undo-banner"
						>
							<span>
								<Trans>
									Status changed to {statusLabel}. You can undo within 60
									seconds.
								</Trans>
							</span>
							<Button
								type="button"
								variant="outline"
								className="h-11 shrink-0 md:h-8"
								disabled={busy}
								onClick={handleUndo}
								data-testid="detail-undo-btn"
							>
								<Icon name="undo-2" className="size-4" />
								<span>
									<Trans>Undo</Trans>
								</span>
							</Button>
						</div>
					) : null}

					{reservation ? (
						<>
							{/* Allergies and notes: what the host must know before seating */}
							{hasAlertContent ? (
								<SheetSection
									title={<Trans>Allergies and notes</Trans>}
									testId="detail-allergy-block"
								>
									<div className="bg-muted/30 flex flex-col gap-2.5 rounded-lg border p-3 text-sm">
										{reservation.dietaryCodes.length > 0 ? (
											<ul
												className="flex flex-wrap gap-1.5"
												aria-label={t`Dietary needs`}
												data-testid="detail-dietary-codes"
											>
												{reservation.dietaryCodes.map((code) => (
													<li key={code}>
														<Badge
															variant="warning"
															className="h-auto min-h-5 whitespace-normal"
														>
															{label(DIETARY_LABELS, code)}
														</Badge>
													</li>
												))}
											</ul>
										) : null}
										{guest?.allergiesText ? (
											<p className="text-destructive wrap-anywhere">
												<Trans>Allergies:</Trans> {guest.allergiesText}
											</p>
										) : null}
										{reservation.dietaryNotes ? (
											<p
												className="wrap-anywhere"
												data-testid="detail-dietary-notes"
											>
												<span className="text-muted-foreground">
													<Trans>Dietary notes</Trans>:{' '}
												</span>
												{reservation.dietaryNotes}
											</p>
										) : null}
										{reservation.guestNotes ? (
											<p className="wrap-anywhere whitespace-pre-wrap">
												<span className="text-muted-foreground">
													<Trans>Guest notes</Trans>:{' '}
												</span>
												{reservation.guestNotes}
											</p>
										) : null}
										{reservation.internalNotes ? (
											<p className="wrap-anywhere whitespace-pre-wrap">
												<span className="text-muted-foreground">
													<Trans>Internal notes</Trans>:{' '}
												</span>
												{reservation.internalNotes}
											</p>
										) : null}
									</div>
								</SheetSection>
							) : null}

							{/* Table, with the one next step within reach */}
							{canManage ? (
								<SheetSection title={<Trans>Table</Trans>}>
									<div className="flex items-end gap-2">
										<SelectField
											className="min-w-0 flex-1"
											label={<Trans>Table Assignment</Trans>}
											id="detail-table-select"
											testId="detail-table-select"
											options={tableOptions}
											value={selectedTableId || NO_TABLE}
											onValueChange={(next) => {
												markDirty('table')
												setSelectedTableId(next === NO_TABLE ? '' : next)
											}}
										/>
										<Button
											type="button"
											variant="outline"
											className="h-11 md:h-8"
											disabled={busy}
											onClick={handleAssignTable}
											data-testid="detail-assign-table-btn"
										>
											<Trans>Assign Table</Trans>
										</Button>
									</div>
									{showFooter && nextAction ? (
										<Button
											type="button"
											className="h-11 w-full md:h-8"
											disabled={busy}
											onClick={() => handleStatusTransition(nextAction)}
											data-testid="detail-primary-action"
										>
											<Icon name="check" className="size-4" />
											<span>{primaryLabel}</span>
										</Button>
									) : null}
								</SheetSection>
							) : null}

							{/* Overview */}
							<SheetSection title={<Trans>Overview</Trans>}>
								<dl
									className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm"
									data-testid="detail-facts"
								>
									<dt className="text-muted-foreground">
										<Trans>Source</Trans>
									</dt>
									<dd
										className="flex flex-wrap items-center gap-1.5"
										data-testid="detail-source"
									>
										<span data-testid="detail-channel">
											{label(CHANNEL_LABELS, reservation.channel) || '—'}
										</span>
										{reservation.client && reservation.client !== 'operator' ? (
											<Badge variant="outline" data-testid="detail-client">
												{clientLabel((d) => i18n._(d), reservation.client)}
											</Badge>
										) : null}
									</dd>
									<dt className="text-muted-foreground">
										<Trans>Occasion</Trans>
									</dt>
									<dd data-testid="detail-occasion">
										{label(OCCASION_LABELS, reservation.occasion) || '—'}
									</dd>
									<dt className="text-muted-foreground">
										<Trans>Dining area</Trans>
									</dt>
									<dd data-testid="detail-dining-area">
										{diningAreaName ?? '—'}
									</dd>
									<dt className="text-muted-foreground">
										<Trans>Table</Trans>
									</dt>
									<dd data-testid="detail-tables">{tablesText}</dd>
								</dl>

								{/* Course stage progression when seated */}
								{canManage && reservation.status === 'seated' ? (
									<div className="flex flex-col gap-2">
										<span className="text-muted-foreground text-xs">
											<Trans>Course Progression</Trans>
										</span>
										<div className="flex flex-wrap gap-2">
											{COURSE_STAGES.map((st) => {
												const active =
													(reservation.courseStage ?? 'seated') === st.value
												return (
													<Button
														key={st.value}
														type="button"
														variant={active ? 'default' : 'outline'}
														className="h-11 md:h-8"
														aria-pressed={active}
														disabled={busy}
														onClick={() => handleCourseStage(st.value)}
														data-testid={`detail-course-${st.value}`}
													>
														{i18n._(st.label)}
													</Button>
												)
											})}
										</div>
									</div>
								) : null}
							</SheetSection>

							{/* Guest */}
							<SheetSection title={<Trans>Guest</Trans>}>
								<div
									className="bg-muted/30 flex flex-col gap-2.5 rounded-lg border p-3 text-sm"
									data-testid="detail-guest-crm"
								>
									<div className="flex flex-wrap items-center gap-1.5">
										<Badge variant="outline">
											<Plural
												value={guest?.visitCount ?? 0}
												one="# visit"
												other="# visits"
											/>
										</Badge>
										{(guest?.noShowCount ?? 0) > 0 ? (
											<Badge variant="destructive">
												<Plural
													value={guest?.noShowCount ?? 0}
													one="# no-show"
													other="# no-shows"
												/>
											</Badge>
										) : null}
									</div>
									<div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
										<span>{reservation.guestPhone || '—'}</span>
										{reservation.guestEmail ? (
											<span className="wrap-anywhere">
												{reservation.guestEmail}
											</span>
										) : null}
									</div>
									{guest?.seatingPrefText ? (
										<p>
											<Trans>Seating Preference:</Trans> {guest.seatingPrefText}
										</p>
									) : null}
									{visibleTags.length > 0 ? (
										<ul
											className="flex flex-wrap gap-1"
											aria-label={t`Guest tags`}
											data-testid="detail-guest-tags"
										>
											{visibleTags.map((tag) => (
												<li key={tag.id}>
													<Badge variant="outline">{tag.name}</Badge>
												</li>
											))}
										</ul>
									) : null}
									{guest?.pinnedNotes && guest.pinnedNotes.length > 0 ? (
										<ul
											className="flex flex-col gap-1"
											aria-label={t`Pinned notes`}
											data-testid="detail-guest-pinned-notes"
										>
											{guest.pinnedNotes.map((note) => (
												<li
													key={note.id}
													className="bg-card flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-sm"
												>
													<Icon
														name="star"
														className="mt-0.5 size-3.5 shrink-0"
														aria-hidden="true"
													/>
													<span className="wrap-anywhere whitespace-pre-wrap">
														{note.body}
													</span>
												</li>
											))}
										</ul>
									) : null}
									{guest?.customerLinked || (guest?.id && customersBase) ? (
										<div className="flex flex-wrap items-center gap-2">
											{guest?.customerLinked ? (
												<Badge
													variant="secondary"
													data-testid="detail-guest-customer-linked"
												>
													<Trans>Linked customer</Trans>
												</Badge>
											) : null}
											{guest?.id && customersBase ? (
												<Link
													to={`${customersBase}/${encodeURIComponent(`g_${guest.id}`)}`}
													className="text-primary inline-flex min-h-11 items-center underline-offset-4 hover:underline md:min-h-0"
													data-testid="detail-guest-profile-link"
												>
													<Trans>Open customer profile</Trans>
												</Link>
											) : null}
										</div>
									) : null}
								</div>
							</SheetSection>

							{/* Table & timing */}
							{canManage ? (
								<SheetSection title={<Trans>Timing and notes</Trans>}>
									<div className="flex flex-col gap-2">
										<div className="flex items-center gap-2 text-sm font-medium">
											<Trans>Running late</Trans>
											{reservation.runningLateMin ? (
												<Badge variant="warning">
													+{reservation.runningLateMin}m
												</Badge>
											) : null}
										</div>
										<div className="flex flex-wrap gap-2">
											{[15, 30, 45].map((mins) => (
												<Button
													key={mins}
													type="button"
													variant={
														reservation.runningLateMin === mins
															? 'default'
															: 'outline'
													}
													className="h-11 md:h-8"
													aria-pressed={reservation.runningLateMin === mins}
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
													variant="ghost"
													className="h-11 md:h-8"
													disabled={busy}
													onClick={() => handleRunningLate(0)}
													data-testid="detail-late-0"
												>
													<Trans>Clear</Trans>
												</Button>
											) : null}
										</div>
									</div>

									<div className="flex flex-col gap-4 border-t pt-4">
										<div className="grid grid-cols-2 items-end gap-3">
											<div className="flex flex-col gap-1.5">
												<span className="text-sm font-medium">
													<Trans>Party Size</Trans>
												</span>
												<PartyStepper
													value={partySizeEdit}
													onChange={(next) => {
														markDirty('partySize')
														setPartySizeEdit(next)
													}}
													inputTestId="detail-party-size-input"
													inputLabel={t`Party Size`}
													decreaseLabel={t`Fewer guests`}
													increaseLabel={t`More guests`}
												/>
											</div>
											<TextField
												label={<Trans>Time</Trans>}
												id="detail-time-edit"
												type="time"
												step={900}
												value={timeEdit}
												onChange={(e) => {
													markDirty('time')
													setTimeEdit(e.target.value)
												}}
												data-testid="detail-time-input"
											/>
										</div>
										<div className="grid grid-cols-2 gap-3">
											<TextField
												label={<Trans>Duration (m)</Trans>}
												id="detail-duration-edit"
												type="number"
												min={15}
												max={360}
												step={15}
												value={durationEdit}
												onChange={(e) => {
													markDirty('duration')
													setDurationEdit(
														Math.max(15, Number(e.target.value) || 60),
													)
												}}
												data-testid="detail-duration-input"
											/>
											<TextField
												label={<Trans>Server / Section Label</Trans>}
												id="detail-server-input"
												value={serverLabel}
												onChange={(e) => {
													markDirty('server')
													setServerLabel(e.target.value)
												}}
												data-testid="detail-server-input"
											/>
										</div>
										<TextAreaField
											label={<Trans>Guest Notes</Trans>}
											id="detail-guest-notes"
											rows={2}
											value={guestNotes}
											onChange={(e) => {
												markDirty('guestNotes')
												setGuestNotes(e.target.value)
											}}
											data-testid="detail-guest-notes-input"
										/>
										<TextAreaField
											label={<Trans>Internal Host Notes</Trans>}
											id="detail-internal-notes"
											rows={2}
											value={internalNotes}
											hint={<Trans>Only staff see these notes.</Trans>}
											onChange={(e) => {
												markDirty('internalNotes')
												setInternalNotes(e.target.value)
											}}
											data-testid="detail-internal-notes-input"
										/>
										<div className="flex justify-end">
											<Button
												type="button"
												className="h-11 md:h-8"
												disabled={busy}
												onClick={handleSaveEdits}
												data-testid="detail-save-notes-btn"
											>
												<Trans>Save Changes</Trans>
											</Button>
										</div>
									</div>
								</SheetSection>
							) : null}

							{/* Advanced: rarely needed, so collapsed */}
							{canManage ? (
								<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
									<div className="flex flex-col gap-3">
										<CollapsibleTrigger
											render={
												<Button
													type="button"
													variant="outline"
													className="h-11 justify-between md:h-8"
													data-testid="detail-advanced-toggle"
												/>
											}
										>
											<span>
												<Trans>Advanced</Trans>
											</span>
											<Icon
												name="chevron-down"
												className={cn(
													'size-4 transition-transform',
													advancedOpen && 'rotate-180',
												)}
											/>
										</CollapsibleTrigger>
										<CollapsibleContent keepMounted>
											<div
												className="flex flex-col gap-4"
												data-testid="detail-advanced"
											>
												<CheckRow
													label={<Trans>Lock table assignment</Trans>}
													description={
														<Trans>
															Keeps this party on the table when the board
															reshuffles.
														</Trans>
													}
													checked={lockAssignment}
													onCheckedChange={(next) => {
														markDirty('lock')
														setLockAssignment(next)
													}}
													testId="detail-lock-assignment"
												/>
												<CheckRow
													label={<Trans>Allow double-booking a table</Trans>}
													description={
														<Trans>
															Ignores table overlap for table and time changes.
															Use only when you know the table frees up.
														</Trans>
													}
													checked={forceOverbook}
													onCheckedChange={(next) => {
														if (next) setOverbookConfirmOpen(true)
														else setForceOverbook(false)
													}}
													testId="detail-force-overbook"
												/>
												<SelectField
													label={<Trans>Reminder status</Trans>}
													id="detail-contact-select"
													testId="detail-contact-select"
													options={contactOptions}
													disabled={busy}
													hint={
														<Trans>
															Record whether you reached the guest about this
															booking.
														</Trans>
													}
													value={
														reservation.contactStatus &&
														reservation.contactStatus !== 'not_contacted'
															? reservation.contactStatus
															: 'none'
													}
													onValueChange={(next) =>
														void handleContactStatus(next)
													}
												/>
											</div>
										</CollapsibleContent>
									</div>
								</Collapsible>
							) : null}

							{/* Payment */}
							{hasPayment && paymentsClient && layout?.orgSlug ? (
								<PaymentPanel
									reservationId={reservation.id}
									client={paymentsClient}
									orgSlug={layout.orgSlug}
									canAct={Boolean(layout.payments?.canAct)}
									guestLabel={guestFirstName}
									timeZone={timeZone}
									onChanged={() => void loadDetail()}
								/>
							) : null}

							{/* Messages: resend the confirmation, optionally with a new manage link */}
							{showMessages ? (
								<SheetSection
									title={<Trans>Guest messages</Trans>}
									testId="detail-guest-messages"
								>
									<div className="flex flex-wrap gap-2">
										<Button
											type="button"
											variant="outline"
											className="h-11 md:h-8"
											disabled={busy}
											onClick={() => void handleResend(false)}
											data-testid="detail-resend-confirmation"
										>
											<Icon name="send" className="size-4" />
											<span>
												<Trans>Resend confirmation</Trans>
											</span>
										</Button>
										<Button
											type="button"
											variant="outline"
											className="h-11 md:h-8"
											disabled={busy}
											onClick={() => setRotateConfirmOpen(true)}
											data-testid="detail-rotate-link"
										>
											<Icon name="refresh-cw" className="size-4" />
											<span>
												<Trans>Rotate manage link</Trans>
											</span>
										</Button>
									</div>
								</SheetSection>
							) : null}

							{/* History */}
							{(openDetail?.history && openDetail.history.length > 0) ||
							history.length > 0 ? (
								<SheetSection title={<Trans>History</Trans>}>
									{openDetail?.history && openDetail.history.length > 0 ? (
										<div
											className="flex flex-col gap-1"
											data-testid="detail-history-list"
										>
											<span className="text-muted-foreground text-xs">
												<Trans>Past Visit History</Trans>
											</span>
											<div className="divide-y text-sm">
												{openDetail.history.slice(0, 5).map((h) => (
													<div
														key={h.id}
														className="flex items-center justify-between gap-3 py-2"
													>
														<span className="tabular-nums">
															{formatBusinessDate(h.businessDate, i18n.locale)}{' '}
															{h.hhmm} (
															<Plural
																value={h.partySize}
																one="# guest"
																other="# guests"
															/>
															)
														</span>
														<StatusLabel status={h.status} />
													</div>
												))}
											</div>
										</div>
									) : null}

									{history.length > 0 ? (
										<div
											className="flex flex-col gap-1"
											data-testid="detail-audit-list"
										>
											<span className="text-muted-foreground text-xs">
												<Trans>Change history</Trans>
											</span>
											<div className="max-h-56 divide-y overflow-y-auto text-sm">
												{history.map((entry) => {
													const data = entry.afterJson ?? {}
													const from = tableLabels(data.fromTableIds)
													const to = tableLabels(data.toTableIds)
													return (
														<div
															key={entry.id}
															className="flex items-start justify-between gap-3 py-2"
															data-testid="detail-audit-entry"
														>
															<div className="min-w-0">
																<span className="font-medium">
																	{label(EVENT_TYPE_LABELS, entry.action)}
																</span>
																{from || to ? (
																	<span className="text-muted-foreground ms-1">
																		({from || unassignedLabel} →{' '}
																		{to || unassignedLabel})
																	</span>
																) : null}
																{entry.reason ? (
																	<span className="text-muted-foreground ms-1">
																		(
																		{label(
																			MOVE_NOTICE_REASON_LABELS,
																			entry.reason,
																		)}
																		)
																	</span>
																) : null}
															</div>
															<div className="text-muted-foreground shrink-0 text-end text-xs">
																<div>
																	{label(ACTOR_KIND_LABELS, entry.actorType)}
																</div>
																<div data-testid="detail-audit-time">
																	{formatTimestamp(entry.createdAt)}
																</div>
															</div>
														</div>
													)
												})}
											</div>
										</div>
									) : null}
								</SheetSection>
							) : null}

							{/* Destructive actions, last and behind a confirm */}
							{canManage && (canNoShow || canCancel) ? (
								<SheetSection
									title={<Trans>End this booking</Trans>}
									description={
										<Trans>
											The guest is told about a cancellation. Both are recorded
											in the history.
										</Trans>
									}
									className="border-t pt-6"
									testId="detail-danger-zone"
								>
									<div className="flex flex-wrap gap-2">
										{canNoShow ? (
											<Button
												type="button"
												variant="destructive"
												className="h-11 md:h-8"
												disabled={busy}
												onClick={() => setNoShowOpen(true)}
												data-testid="detail-status-no_show"
											>
												<Trans>Mark No-Show</Trans>
											</Button>
										) : null}
										{canCancel ? (
											<Button
												type="button"
												variant="destructive"
												className="h-11 md:h-8"
												disabled={busy}
												onClick={() => {
													setCancelReason('')
													setCancelOpen(true)
												}}
												data-testid="detail-status-cancelled"
											>
												<Trans>Cancel Reservation</Trans>
											</Button>
										) : null}
									</div>
								</SheetSection>
							) : null}
						</>
					) : loading ? (
						<div
							className="flex flex-col gap-4"
							role="status"
							aria-label={t`Loading reservation...`}
						>
							<Skeleton className="h-5 w-1/3" />
							<Skeleton className="h-24 w-full" />
							<Skeleton className="h-5 w-1/4" />
							<Skeleton className="h-32 w-full" />
						</div>
					) : null}
				</div>

				{/* Sticky footer: the ONE next step, plus seating straight away */}
				{showFooter ? (
					<SheetFooter className="border-t sm:flex-row sm:justify-end">
						{nextAction === 'arrived' && canSeatEarly ? (
							<Button
								type="button"
								variant="outline"
								className="h-11 md:h-8"
								disabled={busy}
								onClick={() => handleStatusTransition('seated')}
								data-testid="detail-status-seated"
							>
								<Trans>Seat Party</Trans>
							</Button>
						) : null}
						<Button
							type="button"
							className="h-11 md:h-8"
							disabled={busy}
							onClick={() => handleStatusTransition(nextAction!)}
							data-testid={`detail-status-${nextAction}`}
						>
							<Icon name="check" className="size-4" />
							<span>{primaryLabel}</span>
						</Button>
					</SheetFooter>
				) : null}

				<AlertDialog
					open={cancelOpen}
					onOpenChange={(nextOpen) => {
						if (!busy) setCancelOpen(nextOpen)
					}}
				>
					<AlertDialogContent data-testid="detail-cancel-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Cancel this reservation?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									The guest is told it was cancelled. A reason is optional and
									stays in your records.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<TextAreaField
							label={<Trans>Reason</Trans>}
							optional
							value={cancelReason}
							onChange={(event) => setCancelReason(event.target.value)}
							maxLength={500}
							rows={3}
							data-testid="detail-cancel-reason"
						/>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={busy}>
								<Trans>Keep reservation</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="button"
								variant="destructive"
								disabled={busy}
								onClick={() => {
									const reason = cancelReason.trim()
									void handleStatusTransition(
										'cancelled',
										reason || undefined,
									).finally(() => setCancelOpen(false))
								}}
								data-testid="detail-cancel-confirm"
							>
								<Trans>Cancel reservation</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<AlertDialog
					open={noShowOpen}
					onOpenChange={(nextOpen) => {
						if (!busy) setNoShowOpen(nextOpen)
					}}
				>
					<AlertDialogContent data-testid="detail-no-show-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Mark {guestFirstName} as a no-show?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									The table is released and the visit counts toward the guest's
									no-shows. You can undo this for the next 60 seconds.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={busy}>
								<Trans>Keep reservation</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="button"
								variant="destructive"
								disabled={busy}
								onClick={() => {
									void handleStatusTransition('no_show').finally(() =>
										setNoShowOpen(false),
									)
								}}
								data-testid="detail-no-show-confirm"
							>
								<Trans>Mark No-Show</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<AlertDialog
					open={overbookConfirmOpen}
					onOpenChange={setOverbookConfirmOpen}
				>
					<AlertDialogContent data-testid="detail-overbook-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Allow double-booking this table?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									Table and time changes you save next will ignore overlaps with
									other parties. Two parties may end up on the same table at the
									same time.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>
								<Trans>Keep overlap checks</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="button"
								variant="destructive"
								onClick={() => {
									setForceOverbook(true)
									setOverbookConfirmOpen(false)
								}}
								data-testid="detail-overbook-confirm"
							>
								<Trans>Allow double-booking</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<AlertDialog
					open={rotateConfirmOpen}
					onOpenChange={(nextOpen) => {
						if (!busy) setRotateConfirmOpen(nextOpen)
					}}
				>
					<AlertDialogContent data-testid="detail-rotate-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Send a new manage link?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									The guest gets a new confirmation with a new manage link. The
									link in every earlier message stops working.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={busy}>
								<Trans>Cancel</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="button"
								disabled={busy}
								onClick={() => void handleResend(true)}
								data-testid="detail-rotate-confirm"
							>
								<Trans>Send new link</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</SheetContent>
		</Sheet>
	)
}
