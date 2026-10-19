import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { formatHhmm, parseHhmm } from '@repo/reservations'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	CheckRow,
	PartyStepper,
	SheetSection,
} from '#app/components/reservations/sheet-parts.tsx'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import {
	createPhoneReservation,
	type DayMoveNotice,
	type DayReservationGuestSummary,
	type DayReservationView,
	type BookingWarning,
	type OperatorAvailabilitySlot,
	type OperatorDayState,
	searchBookAvailability,
	searchBookGuests,
} from '#app/utils/reservations/book-api.ts'
import { hostErrorMessage } from '#app/utils/reservations/host-errors.ts'
import { enumLabel, VIP_TIER_LABELS } from '#app/utils/reservations/labels.ts'
import {
	ReservationsApiError,
	type ReservationsScopedClient,
} from '#app/utils/reservations/reservations-client.ts'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'
import {
	afterFailedSubmit,
	keyForSubmit,
	newSubmitKey,
} from '#app/utils/reservations/submit-key.ts'

const DIETARY_OPTIONS = [
	{ code: 'vegetarian', label: msg`Vegetarian` },
	{ code: 'vegan', label: msg`Vegan` },
	{ code: 'gluten_free', label: msg`Gluten-Free` },
	{ code: 'halal', label: msg`Halal` },
	{ code: 'nut_allergy', label: msg`Nut Allergy` },
	{ code: 'dairy_free', label: msg`Dairy-Free` },
	{ code: 'shellfish_allergy', label: msg`Shellfish Allergy` },
] as const

/** Select items cannot carry an empty value, so "no choice" travels as this. */
const ANY = '__any'

const OPEN_DAY: OperatorDayState = { state: 'open', name: null, note: null }

const WARNING_CODES = new Set<string>([
	'closed_day',
	'pacing_exceeded',
	'pacing_parties_exceeded',
])

function apiErrorCode(err: unknown): string | null {
	if (!(err instanceof ReservationsApiError)) return null
	const code = (err.body as { error?: unknown } | null)?.error
	return typeof code === 'string' ? code : null
}

const OCCASION_OPTIONS = [
	{ value: ANY, label: msg`None` },
	{ value: 'birthday', label: msg`Birthday` },
	{ value: 'anniversary', label: msg`Anniversary` },
	{ value: 'date_night', label: msg`Date Night` },
	{ value: 'business', label: msg`Business Meal` },
	{ value: 'celebration', label: msg`Celebration` },
	{ value: 'vip', label: msg`VIP` },
] as const

type PaymentPolicyMode = 'none' | 'send_link' | 'waive'

export function BookingSheet({
	open,
	onOpenChange,
	client,
	locationId,
	defaultDate,
	services,
	areas,
	tables,
	initialLocalStartMin,
	initialPartySize = 2,
	initialTableId = null,
	initialAreaId = null,
	initialServiceId = null,
	onCreated,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	client: ReservationsScopedClient
	locationId: string
	defaultDate: string
	services: RsvServiceRecord[]
	areas: RsvAreaRecord[]
	tables: RsvTableRecord[]
	initialLocalStartMin?: number
	initialPartySize?: number
	initialTableId?: string | null
	initialAreaId?: string | null
	initialServiceId?: string | null
	onCreated: (
		reservation: DayReservationView,
		moveNotices: DayMoveNotice[],
	) => void
}) {
	const { t, i18n } = useLingui()
	const [date, setDate] = useState(defaultDate)
	const [partySize, setPartySize] = useState(initialPartySize)
	const [localStartMin, setLocalStartMin] = useState(
		initialLocalStartMin ?? 1140,
	)
	const [timeInput, setTimeInput] = useState(() =>
		formatHhmm(initialLocalStartMin ?? 1140),
	)
	const [serviceId, setServiceId] = useState<string>(initialServiceId ?? '')
	const [areaId, setAreaId] = useState<string>(initialAreaId ?? '')
	const [tableId, setTableId] = useState<string>(initialTableId ?? '')
	const [durationMin, setDurationMin] = useState<string>('')

	// Guest CRM search & fields
	const [guestQuery, setGuestQuery] = useState('')
	const [guestResults, setGuestResults] = useState<
		DayReservationGuestSummary[]
	>([])
	const [searchingGuests, setSearchingGuests] = useState(false)
	const [selectedGuest, setSelectedGuest] =
		useState<DayReservationGuestSummary | null>(null)

	const [guestName, setGuestName] = useState('')
	const [guestPhone, setGuestPhone] = useState('')
	const [guestEmail, setGuestEmail] = useState('')
	const [occasion, setOccasion] = useState('')
	const [dietaryCodes, setDietaryCodes] = useState<string[]>([])
	const [dietaryNotes, setDietaryNotes] = useState('')
	const [guestNotes, setGuestNotes] = useState('')
	const [internalNotes, setInternalNotes] = useState('')
	const [serverLabel, setServerLabel] = useState('')

	// Operator overrides & payment policy
	const [overridePacing, setOverridePacing] = useState(false)
	const [overrideBlockedTable, setOverrideBlockedTable] = useState(false)
	const [overrideScheduleBlock, setOverrideScheduleBlock] = useState(false)
	const [overrideClosedDay, setOverrideClosedDay] = useState(false)
	const [overbookReason, setOverbookReason] = useState('')
	const [paymentPolicyMode, setPaymentPolicyMode] =
		useState<PaymentPolicyMode>('none')
	const [extrasOpen, setExtrasOpen] = useState(false)
	const [otherTimeOpen, setOtherTimeOpen] = useState(false)
	const phoneRef = useRef<HTMLInputElement>(null)

	// Availability slots
	const [slots, setSlots] = useState<OperatorAvailabilitySlot[]>([])
	const [dayState, setDayState] = useState<OperatorDayState>(OPEN_DAY)
	const [loadingSlots, setLoadingSlots] = useState(false)
	// Only the newest availability request may write state (out-of-order guard).
	const availabilityRequest = useRef(0)

	// Submission state
	const [submitting, setSubmitting] = useState(false)
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const keyRef = useRef(newSubmitKey('book'))

	// Reset defaults when opened
	useEffect(() => {
		if (!open) return
		setDate(defaultDate)
		setPartySize(initialPartySize || 2)
		const start = initialLocalStartMin ?? 1140
		setLocalStartMin(start)
		setTimeInput(formatHhmm(start))
		setServiceId(initialServiceId ?? '')
		setAreaId(initialAreaId ?? '')
		setTableId(initialTableId ?? '')
		setDurationMin('')
		setOverrideClosedDay(false)
		setOverbookReason('')
		setAttempted(false)
		setError(null)
		setOtherTimeOpen(false)
		keyRef.current = newSubmitKey('book')
	}, [
		defaultDate,
		initialAreaId,
		initialLocalStartMin,
		initialPartySize,
		initialServiceId,
		initialTableId,
		open,
	])

	// The host usually has the guest on the phone: land on the phone field, not
	// the date. Waits a tick so the sheet's own focus handling runs first.
	useEffect(() => {
		if (!open) return
		const id = window.setTimeout(() => phoneRef.current?.focus(), 60)
		return () => window.clearTimeout(id)
	}, [open])

	// Live availability search
	const loadAvailability = useCallback(async () => {
		if (!open || !locationId || !date || partySize < 1) return
		const request = ++availabilityRequest.current
		setLoadingSlots(true)
		try {
			const res = await searchBookAvailability(client, {
				locationId,
				date,
				partySize,
				serviceId: serviceId || null,
				areaId: areaId || null,
				includePacingOverride: true,
			})
			if (request !== availabilityRequest.current) return
			setSlots(res.slots ?? [])
			setDayState(res.dayState)
		} catch {
			if (request !== availabilityRequest.current) return
			setSlots([])
			setDayState(OPEN_DAY)
		} finally {
			if (request === availabilityRequest.current) setLoadingSlots(false)
		}
	}, [areaId, client, date, locationId, open, partySize, serviceId])

	useEffect(() => {
		if (!open) return
		void loadAvailability()
	}, [loadAvailability, open])

	// Guest lookup
	useEffect(() => {
		if (!open) return
		const q = guestQuery.trim()
		if (q.length < 2) {
			setGuestResults([])
			return
		}
		let cancelled = false
		setSearchingGuests(true)
		const timer = window.setTimeout(async () => {
			try {
				const res = await searchBookGuests(client, q, 6)
				if (!cancelled) {
					setGuestResults(res.guests ?? [])
				}
			} catch {
				if (!cancelled) setGuestResults([])
			} finally {
				if (!cancelled) setSearchingGuests(false)
			}
		}, 200)
		return () => {
			cancelled = true
			window.clearTimeout(timer)
		}
	}, [client, guestQuery, open])

	const handleSelectReturningGuest = (guest: DayReservationGuestSummary) => {
		setSelectedGuest(guest)
		setGuestName(guest.fullName)
		setGuestPhone(guest.phoneE164)
		setGuestEmail(guest.email ?? '')
		if (guest.dietaryCodes.length > 0) {
			setDietaryCodes(guest.dietaryCodes)
		}
		if (guest.generalNotes && !internalNotes) {
			setInternalNotes(guest.generalNotes)
		}
		setGuestQuery('')
		setGuestResults([])
	}

	const toggleDietary = (code: string) => {
		setDietaryCodes((prev) =>
			prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
		)
	}

	const handleTimeChange = (val: string) => {
		setTimeInput(val)
		try {
			const parsed = parseHhmm(val)
			setLocalStartMin(parsed)
		} catch {
			// Wait for valid HH:MM
		}
	}

	const closedDay = dayState.state === 'closed'
	const selectedSlot =
		slots.find(
			(s) =>
				s.localStartMin === localStartMin &&
				(!serviceId || s.serviceId === serviceId),
		) ?? null
	const slotHasHeldTables = Boolean(selectedSlot?.held)
	// A hold only blocks the slot when no other table is free.
	const slotIsHeld = Boolean(selectedSlot?.held && !selectedSlot.available)
	const slotIsOverPaced =
		overridePacing || selectedSlot?.status === 'pacing_full'
	const heldTableLabels = (selectedSlot?.heldTableIds ?? []).map(
		(id) => tables.find((tbl) => tbl.id === id)?.label ?? id,
	)

	const dayName = dayState.name
	const heldTables = heldTableLabels.join(', ')
	const anyOverride =
		overridePacing ||
		overrideBlockedTable ||
		overrideScheduleBlock ||
		(closedDay && overrideClosedDay) ||
		slotIsHeld

	const warningText = (code: BookingWarning['code']) => {
		switch (code) {
			case 'closed_day':
				return t`Booked on a closed day.`
			case 'pacing_exceeded':
				return t`Booked over the pacing cover limit.`
			case 'pacing_parties_exceeded':
				return t`Booked over the pacing party limit.`
		}
	}

	const errorText = (err: unknown) => {
		switch (apiErrorCode(err)) {
			case 'closed_day':
				return t`The location is closed on this date. Turn on the closed-day override to book anyway.`
			case 'pacing_exceeded':
			case 'pacing_parties_exceeded':
				return t`This time is over its pacing limit. Turn on the pacing override to book anyway.`
			default:
				return hostErrorMessage(
					err,
					(d) => i18n._(d),
					msg`Failed to create reservation.`,
				)
		}
	}

	const handleSelectSlot = (slot: OperatorAvailabilitySlot) => {
		setLocalStartMin(slot.localStartMin)
		setTimeInput(slot.hhmm)
		if (slot.serviceId && !serviceId) {
			setServiceId(slot.serviceId)
		}
		if (slot.status === 'pacing_full') {
			setOverridePacing(true)
		}
	}

	const nameMissing = !guestName.trim()
	const phoneMissing = guestPhone.replace(/\D/g, '').length < 7
	const timeMissing = (() => {
		try {
			parseHhmm(timeInput)
			return false
		} catch {
			return true
		}
	})()
	const missing: string[] = []
	if (phoneMissing) missing.push(t`phone number`)
	if (nameMissing) missing.push(t`guest name`)
	if (timeMissing) missing.push(t`a time`)
	const missingList = missing.join(', ')

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setAttempted(true)
		if (nameMissing || phoneMissing || timeMissing) {
			setError(t`Guest name, phone number and time are required.`)
			return
		}
		if (closedDay && !overrideClosedDay) {
			setError(
				t`The location is closed on this date. Turn on the closed-day override to book anyway.`,
			)
			return
		}
		setSubmitting(true)
		setError(null)
		try {
			const parsedDuration = durationMin ? Number(durationMin) : undefined
			const input = {
				locationId,
				date,
				localStartMin,
				partySize,
				serviceId: serviceId || null,
				areaId: areaId || null,
				tableIds: tableId ? [tableId] : undefined,
				durationMin:
					parsedDuration && Number.isFinite(parsedDuration)
						? parsedDuration
						: undefined,
				channel: 'phone' as const,
				guest: {
					fullName: guestName.trim(),
					phone: guestPhone.trim(),
					email: guestEmail.trim() || null,
					dietaryCodes,
				},
				occasion: occasion || null,
				dietaryCodes,
				dietaryNotes: dietaryNotes.trim() || null,
				guestNotes: guestNotes.trim() || null,
				internalNotes: internalNotes.trim() || null,
				serverLabel: serverLabel.trim() || null,
				overridePacing: overridePacing || slotIsHeld,
				overrideBlockedTable,
				overrideScheduleBlock,
				overrideClosedDay: closedDay && overrideClosedDay,
				overbookReason: overbookReason.trim() || null,
				skipPayment: paymentPolicyMode === 'waive',
				paymentPolicyMode,
			}
			// Same form, same key: a retry after a lost response replays.
			const res = await createPhoneReservation(
				client,
				input,
				keyForSubmit(keyRef, 'book', input),
			)
			onCreated(res.reservation, res.moveNotices ?? [])
			for (const warning of res.warnings) {
				if (WARNING_CODES.has(warning.code)) {
					toast.warning(warningText(warning.code))
				}
			}
			onOpenChange(false)
			// Reset guest fields for next booking
			setSelectedGuest(null)
			setGuestName('')
			setGuestPhone('')
			setGuestEmail('')
			setOccasion('')
			setDietaryCodes([])
			setDietaryNotes('')
			setGuestNotes('')
			setInternalNotes('')
			setServerLabel('')
			setOverbookReason('')
		} catch (err) {
			setError(errorText(err))
			afterFailedSubmit(keyRef, 'book', err)
		} finally {
			setSubmitting(false)
		}
	}

	const activeTables = tables.filter(
		(tbl) => tbl.isActive && (!areaId || tbl.areaId === areaId),
	)

	const dateLabel = (() => {
		const parsed = new Date(`${date}T12:00:00`)
		if (Number.isNaN(parsed.getTime())) return date
		return new Intl.DateTimeFormat(i18n.locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		}).format(parsed)
	})()

	const serviceOptions = [
		{ value: ANY, label: t`Auto / Any` },
		...services.map((svc) => ({ value: svc.id, label: svc.name })),
	]
	const areaOptions = [
		{ value: ANY, label: t`Any Area` },
		...areas.map((a) => ({ value: a.id, label: a.name })),
	]
	const tableOptions = [
		{ value: ANY, label: t`Auto-assign best table` },
		...activeTables.map((tbl) => ({
			value: tbl.id,
			label: `${tbl.label} (${tbl.minCovers}-${tbl.maxCovers})`,
		})),
	]
	const occasionOptions = OCCASION_OPTIONS.map((opt) => ({
		value: opt.value,
		label: i18n._(opt.label),
	}))
	const paymentOptions = [
		{ value: 'none', label: t`Standard policy` },
		{ value: 'send_link', label: t`Send SMS payment link` },
		{ value: 'waive', label: t`Waive deposit / card hold` },
	]

	const offeredSlots = slots
		.filter(
			(s) =>
				s.status === 'available' ||
				s.held ||
				(s.status === 'pacing_full' && s.canOverridePacing),
		)
		.slice(0, 32)
	const hasOverLimitSlot = offeredSlots.some((s) => s.status === 'pacing_full')

	const largestSeating = Math.max(
		0,
		...tables.filter((tbl) => tbl.isActive).map((tbl) => tbl.maxCovers),
		...slots.flatMap((s) =>
			(s.candidateCombinations ?? []).map((combo) => combo.maxCovers),
		),
	)
	const partyTooLarge =
		largestSeating > 0 && partySize > largestSeating && !loadingSlots

	const extrasCount =
		(occasion ? 1 : 0) +
		(dietaryCodes.length > 0 || dietaryNotes.trim() ? 1 : 0) +
		(guestNotes.trim() ? 1 : 0) +
		(internalNotes.trim() ? 1 : 0) +
		(tableId ? 1 : 0) +
		(paymentPolicyMode !== 'none' ? 1 : 0) +
		(anyOverride ? 1 : 0)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="w-full gap-0 sm:max-w-md"
				data-testid="booking-sheet"
			>
				<SheetForm
					title={<Trans>New reservation</Trans>}
					description={
						<span className="tabular-nums">
							{dateLabel} ·{' '}
							<Plural value={partySize} one="# guest" other="# guests" />
						</span>
					}
					onSubmit={handleSubmit}
					footer={
						<div className="flex w-full flex-col gap-3">
							{error ? (
								<Alert variant="destructive" data-testid="booking-sheet-error">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							) : null}
							<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
								{missing.length > 0 ? (
									<p
										role="status"
										className="text-destructive text-sm sm:me-auto"
										data-testid="booking-validation-summary"
									>
										<Trans>Still needed: {missingList}</Trans>
									</p>
								) : null}
								<Button
									type="button"
									variant="ghost"
									className="h-11 md:h-8"
									onClick={() => onOpenChange(false)}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									type="submit"
									className="h-11 md:h-8"
									disabled={
										submitting ||
										missing.length > 0 ||
										(closedDay && !overrideClosedDay)
									}
									data-testid="booking-submit-btn"
								>
									<Icon name="check" className="size-4" />
									<span>
										{submitting ? (
											<Trans>Booking...</Trans>
										) : (
											<Trans>Book</Trans>
										)}
									</span>
								</Button>
							</div>
						</div>
					}
				>
					{/* Step 1: when */}
					<SheetSection title={<Trans>When</Trans>}>
						<div className="grid grid-cols-2 items-end gap-3">
							<TextField
								label={<Trans>Date</Trans>}
								id="booking-date-input"
								type="date"
								value={date}
								onChange={(e) => setDate(e.target.value)}
								data-testid="booking-date-input"
								required
							/>
							<Field>
								<FieldLabel htmlFor="booking-party-size-input">
									<Trans>Party Size</Trans>
								</FieldLabel>
								<PartyStepper
									value={partySize}
									onChange={setPartySize}
									inputId="booking-party-size-input"
									inputTestId="booking-party-size-input"
									inputLabel={t`Party Size`}
									decreaseLabel={t`Fewer guests`}
									increaseLabel={t`More guests`}
								/>
							</Field>
						</div>

						{services.length > 0 ? (
							<SelectField
								label={<Trans>Service</Trans>}
								id="booking-service-select"
								testId="booking-service-select"
								options={serviceOptions}
								value={serviceId || ANY}
								onValueChange={(next) => setServiceId(next === ANY ? '' : next)}
							/>
						) : null}

						{closedDay ? (
							<Alert variant="destructive" data-testid="booking-closed-day">
								<AlertDescription>
									<div className="flex flex-col gap-2">
										<span>
											{dayState.name ? (
												<Trans>
													Closed on this date ({dayName}). No times are offered.
												</Trans>
											) : (
												<Trans>
													Closed on this date. No times are offered.
												</Trans>
											)}
										</span>
										<CheckRow
											label={<Trans>Book anyway (staff override)</Trans>}
											description={
												<Trans>
													The booking is marked as made on a closed day.
												</Trans>
											}
											checked={overrideClosedDay}
											onCheckedChange={setOverrideClosedDay}
											testId="booking-override-closed-day"
										/>
									</div>
								</AlertDescription>
							</Alert>
						) : null}
						{dayState.state === 'online_closed' ? (
							<Alert data-testid="booking-online-closed">
								<AlertDescription>
									<Trans>
										Closed for online bookings on this date. Staff can still
										book.
									</Trans>
								</AlertDescription>
							</Alert>
						) : null}

						<div className="flex flex-col gap-2">
							<div className="flex items-center justify-between gap-2">
								<span className="text-sm font-medium">
									<Trans>Available times</Trans>
								</span>
								{loadingSlots ? (
									<span role="status" className="text-muted-foreground text-xs">
										<Trans>Checking times...</Trans>
									</span>
								) : null}
							</div>
							{offeredSlots.length > 0 ? (
								<div
									className="flex flex-wrap gap-2"
									data-testid="booking-slots-grid"
								>
									{offeredSlots.map((slot) => {
										const isSelected = slot.localStartMin === localStartMin
										const isPacingFull = slot.status === 'pacing_full'
										return (
											<Button
												key={`${slot.serviceId}-${slot.localStartMin}`}
												type="button"
												variant={isSelected ? 'default' : 'outline'}
												className="h-11 min-w-16 tabular-nums md:h-8"
												aria-pressed={isSelected}
												onClick={() => handleSelectSlot(slot)}
												data-testid={`booking-slot-${slot.localStartMin}`}
												data-held={slot.held ? 'true' : undefined}
											>
												<span>{slot.hhmm}</span>
												{slot.held ? (
													<span
														className="inline-flex items-center gap-0.5 text-xs"
														data-testid={`booking-slot-held-${slot.localStartMin}`}
													>
														<Icon name="lock" className="size-3" />
														<Trans>Held</Trans>
													</span>
												) : isPacingFull ? (
													<span className="text-xs">
														<Trans>Over limit</Trans>
													</span>
												) : null}
											</Button>
										)
									})}
								</div>
							) : closedDay || loadingSlots ? null : (
								<p className="text-muted-foreground text-sm">
									<Trans>
										No open times for this date and party size. Enter another
										time below, or change the date.
									</Trans>
								</p>
							)}
							{hasOverLimitSlot ? (
								<p className="text-muted-foreground text-xs">
									<Trans>
										Over limit times are past their pacing limit. Picking one
										overbooks the slot.
									</Trans>
								</p>
							) : null}
						</div>

						{offeredSlots.length > 0 && !otherTimeOpen ? (
							<Button
								type="button"
								variant="link"
								className="h-auto self-start px-0 py-1"
								onClick={() => setOtherTimeOpen(true)}
								data-testid="booking-other-time-link"
							>
								<Trans>Other time</Trans>
							</Button>
						) : (
							<TextField
								label={<Trans>Other time</Trans>}
								id="booking-time-input"
								type="time"
								step={900}
								value={timeInput}
								onChange={(e) => handleTimeChange(e.target.value)}
								data-testid="booking-time-input"
								required
							/>
						)}

						{partyTooLarge ? (
							<Alert data-testid="booking-party-size-warning">
								<Icon name="alert-triangle" />
								<AlertDescription>
									<Trans>
										No single table seats {partySize}. The largest seats{' '}
										{largestSeating}, so tables need to be combined.
									</Trans>
								</AlertDescription>
							</Alert>
						) : null}

						{slotHasHeldTables ? (
							<Alert data-testid="booking-held-warning">
								<Icon name="lock" />
								<AlertDescription>
									{!slotIsHeld ? (
										<Trans>
											{heldTables} is held by a guest who is checking out. The
											booking uses another table.
										</Trans>
									) : heldTableLabels.length > 0 ? (
										<Trans>
											A guest is checking out with {heldTables} at this time.
											Booking it overrides their hold.
										</Trans>
									) : (
										<Trans>
											A guest is checking out with a table at this time. Booking
											it overrides their hold.
										</Trans>
									)}
								</AlertDescription>
							</Alert>
						) : null}
						{slotIsOverPaced ? (
							<Alert data-testid="booking-pacing-warning">
								<Icon name="alert-triangle" />
								<AlertDescription>
									<Trans>
										This time is over its pacing limit. Creating the booking
										overbooks the slot.
									</Trans>
								</AlertDescription>
							</Alert>
						) : null}
					</SheetSection>

					{/* Step 2: who */}
					<SheetSection title={<Trans>Who</Trans>}>
						<TextField
							label={<Trans>Find a returning guest</Trans>}
							id="booking-guest-search"
							value={guestQuery}
							onChange={(e) => setGuestQuery(e.target.value)}
							placeholder={t`Search by phone or name`}
							hint={searchingGuests ? <Trans>Searching...</Trans> : undefined}
							data-testid="booking-guest-search"
							optional
						/>

						{guestResults.length > 0 ? (
							<div
								className="bg-card flex flex-col divide-y rounded-lg border"
								data-testid="booking-guest-results"
							>
								{guestResults.map((g) => (
									<Button
										key={g.id}
										type="button"
										variant="ghost"
										onClick={() => handleSelectReturningGuest(g)}
										className="h-auto min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-start font-normal first:rounded-t-lg last:rounded-b-lg"
										data-testid={`booking-guest-result-${g.id}`}
									>
										<span className="flex min-w-0 flex-col">
											<span className="text-sm font-medium wrap-anywhere">
												{g.fullName}
											</span>
											<span className="text-muted-foreground text-xs tabular-nums">
												{g.phoneE164}
											</span>
										</span>
										<span className="flex flex-wrap items-center justify-end gap-1">
											{g.vipTier && g.vipTier !== 'none' ? (
												<Badge variant="default">
													{enumLabel(
														(d) => i18n._(d),
														VIP_TIER_LABELS,
														g.vipTier,
													)}
												</Badge>
											) : null}
											<Badge variant="secondary">
												<Plural
													value={g.visitCount}
													one="# visit"
													other="# visits"
												/>
											</Badge>
											{g.noShowCount > 0 ? (
												<Badge variant="destructive">
													<Plural
														value={g.noShowCount}
														one="# no-show"
														other="# no-shows"
													/>
												</Badge>
											) : null}
										</span>
									</Button>
								))}
							</div>
						) : null}

						{selectedGuest ? (
							<div
								className="bg-muted/40 flex flex-col gap-1.5 rounded-lg border p-3 text-sm"
								data-testid="booking-returning-guest-card"
							>
								<div className="flex items-start justify-between gap-2">
									<div className="flex min-w-0 flex-col">
										<span className="font-medium wrap-anywhere">
											{selectedGuest.fullName}
										</span>
										<span className="text-muted-foreground text-xs tabular-nums">
											{selectedGuest.phoneE164}
										</span>
									</div>
									<div className="flex flex-wrap items-center justify-end gap-1">
										{selectedGuest.vipTier &&
										selectedGuest.vipTier !== 'none' ? (
											<Badge variant="default">
												{enumLabel(
													(d) => i18n._(d),
													VIP_TIER_LABELS,
													selectedGuest.vipTier,
												)}
											</Badge>
										) : null}
										<Badge variant="outline">
											<Plural
												value={selectedGuest.visitCount}
												one="# visit"
												other="# visits"
											/>
										</Badge>
										{selectedGuest.noShowCount > 0 ? (
											<Badge variant="destructive">
												<Plural
													value={selectedGuest.noShowCount}
													one="# no-show"
													other="# no-shows"
												/>
											</Badge>
										) : null}
									</div>
								</div>
								{selectedGuest.allergiesText ? (
									<p className="text-destructive text-xs">
										<Trans>Allergies:</Trans> {selectedGuest.allergiesText}
									</p>
								) : null}
								{selectedGuest.seatingPrefText ? (
									<p className="text-muted-foreground text-xs">
										<Trans>Preference:</Trans> {selectedGuest.seatingPrefText}
									</p>
								) : null}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-11 self-start md:h-7"
									onClick={() => setSelectedGuest(null)}
								>
									<Trans>Not this guest</Trans>
								</Button>
							</div>
						) : null}

						<TextField
							label={<Trans>Phone Number</Trans>}
							id="booking-guest-phone"
							ref={phoneRef}
							type="tel"
							inputMode="tel"
							value={guestPhone}
							onChange={(e) => setGuestPhone(e.target.value)}
							placeholder="+14155550100"
							error={
								attempted && phoneMissing
									? t`Enter a phone number with at least 7 digits.`
									: null
							}
							data-testid="booking-guest-phone"
							required
						/>
						<TextField
							label={<Trans>Guest Name</Trans>}
							id="booking-guest-name"
							value={guestName}
							onChange={(e) => setGuestName(e.target.value)}
							placeholder={t`Full name`}
							error={
								attempted && nameMissing ? t`Enter the guest's name.` : null
							}
							data-testid="booking-guest-name"
							required
						/>
						<TextField
							label={<Trans>Email</Trans>}
							id="booking-guest-email"
							type="email"
							value={guestEmail}
							onChange={(e) => setGuestEmail(e.target.value)}
							placeholder="guest@example.com"
							data-testid="booking-guest-email"
							optional
						/>
					</SheetSection>

					{/* Step 3: extras, collapsed */}
					<Collapsible open={extrasOpen} onOpenChange={setExtrasOpen}>
						<div className="flex flex-col gap-3">
							<CollapsibleTrigger
								render={
									<Button
										type="button"
										variant="outline"
										className="h-11 justify-between md:h-8"
										data-testid="booking-extras-toggle"
									/>
								}
							>
								<span className="flex items-center gap-2">
									<Trans>Extras</Trans>
									{extrasCount > 0 ? (
										<Badge variant="secondary">{extrasCount}</Badge>
									) : null}
								</span>
								<Icon
									name="chevron-down"
									className={cn(
										'size-4 transition-transform',
										extrasOpen && 'rotate-180',
									)}
								/>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="flex flex-col gap-5">
									<SelectField
										label={<Trans>Occasion</Trans>}
										id="booking-occasion-select"
										testId="booking-occasion-select"
										options={occasionOptions}
										value={occasion || ANY}
										onValueChange={(next) =>
											setOccasion(next === ANY ? '' : next)
										}
									/>

									<div className="flex flex-col gap-2">
										<span className="text-sm font-medium">
											<Trans>Dietary Tags</Trans>
										</span>
										<div className="flex flex-wrap gap-2">
											{DIETARY_OPTIONS.map((opt) => {
												const active = dietaryCodes.includes(opt.code)
												return (
													<Button
														key={opt.code}
														type="button"
														variant={active ? 'default' : 'outline'}
														className="h-11 md:h-8"
														aria-pressed={active}
														onClick={() => toggleDietary(opt.code)}
														data-testid={`booking-dietary-${opt.code}`}
													>
														{i18n._(opt.label)}
													</Button>
												)
											})}
										</div>
										<TextField
											label={<Trans>Dietary notes</Trans>}
											id="booking-dietary-notes"
											value={dietaryNotes}
											maxLength={500}
											onChange={(e) => setDietaryNotes(e.target.value)}
											placeholder={t`No sesame, severe peanut allergy`}
											data-testid="booking-dietary-notes"
											optional
										/>
									</div>

									<TextAreaField
										label={<Trans>Guest Request / Notes</Trans>}
										id="booking-guest-notes"
										rows={2}
										value={guestNotes}
										onChange={(e) => setGuestNotes(e.target.value)}
										placeholder={t`Booth preferred, high chair...`}
										data-testid="booking-guest-notes"
										optional
									/>
									<TextAreaField
										label={<Trans>Internal Host Notes</Trans>}
										id="booking-internal-notes"
										rows={2}
										value={internalNotes}
										onChange={(e) => setInternalNotes(e.target.value)}
										placeholder={t`Friends of chef, comp welcome drink...`}
										hint={<Trans>Only staff see these notes.</Trans>}
										data-testid="booking-internal-notes"
										optional
									/>

									<SelectField
										label={<Trans>Dining Area</Trans>}
										id="booking-area-select"
										testId="booking-area-select"
										options={areaOptions}
										value={areaId || ANY}
										onValueChange={(next) => {
											setAreaId(next === ANY ? '' : next)
											setTableId('')
										}}
									/>
									<SelectField
										label={<Trans>Table preference</Trans>}
										id="booking-table-select"
										testId="booking-table-select"
										options={tableOptions}
										value={tableId || ANY}
										onValueChange={(next) =>
											setTableId(next === ANY ? '' : next)
										}
									/>
									<div className="grid grid-cols-2 gap-3">
										<TextField
											label={<Trans>Duration (min)</Trans>}
											id="booking-duration-input"
											type="number"
											min={15}
											max={360}
											step={15}
											placeholder={t`Auto`}
											value={durationMin}
											onChange={(e) => setDurationMin(e.target.value)}
											data-testid="booking-duration-input"
											optional
										/>
										<TextField
											label={<Trans>Server / Section Label</Trans>}
											id="booking-server-input"
											value={serverLabel}
											onChange={(e) => setServerLabel(e.target.value)}
											placeholder={t`Optional server name`}
											data-testid="booking-server-input"
											optional
										/>
									</div>

									<SelectField
										label={<Trans>Deposit / Card Hold Policy</Trans>}
										id="booking-payment-policy"
										testId="booking-payment-policy"
										options={paymentOptions}
										value={paymentPolicyMode}
										onValueChange={(next) =>
											setPaymentPolicyMode(next as PaymentPolicyMode)
										}
									/>

									<div className="flex flex-col gap-1 rounded-lg border p-3">
										<span className="text-sm font-medium">
											<Trans>Staff overrides</Trans>
										</span>
										<CheckRow
											label={<Trans>Book over the pacing limit</Trans>}
											checked={overridePacing}
											onCheckedChange={setOverridePacing}
											testId="booking-override-pacing"
										/>
										<CheckRow
											label={<Trans>Use a blocked table</Trans>}
											checked={overrideBlockedTable}
											onCheckedChange={setOverrideBlockedTable}
											testId="booking-override-blocked-table"
										/>
										<CheckRow
											label={<Trans>Book into a blocked time</Trans>}
											checked={overrideScheduleBlock}
											onCheckedChange={setOverrideScheduleBlock}
											testId="booking-override-schedule-block"
										/>
										{anyOverride ? (
											<TextField
												label={<Trans>Overbook reason</Trans>}
												id="booking-overbook-reason"
												value={overbookReason}
												maxLength={200}
												onChange={(e) => setOverbookReason(e.target.value)}
												hint={
													<Trans>Saved with the booking for the manager.</Trans>
												}
												data-testid="booking-overbook-reason"
												optional
											/>
										) : null}
									</div>
								</div>
							</CollapsibleContent>
						</div>
					</Collapsible>
				</SheetForm>
			</SheetContent>
		</Sheet>
	)
}
