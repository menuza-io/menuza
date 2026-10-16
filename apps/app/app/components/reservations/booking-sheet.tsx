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
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useState } from 'react'
import {
	createPhoneReservation,
	type DayMoveNotice,
	type DayReservationGuestSummary,
	type DayReservationView,
	generateIdempotencyKey,
	type OperatorAvailabilitySlot,
	searchBookAvailability,
	searchBookGuests,
} from '#app/utils/reservations/book-api.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
	type RsvTableRecord,
} from '#app/utils/reservations/setup-api.ts'

const DIETARY_OPTIONS = [
	{ code: 'vegetarian', label: 'Vegetarian' },
	{ code: 'vegan', label: 'Vegan' },
	{ code: 'gluten_free', label: 'Gluten-Free' },
	{ code: 'halal', label: 'Halal' },
	{ code: 'nut_allergy', label: 'Nut Allergy' },
	{ code: 'dairy_free', label: 'Dairy-Free' },
	{ code: 'shellfish_allergy', label: 'Shellfish Allergy' },
] as const

const OCCASION_OPTIONS = [
	{ value: '', label: 'None' },
	{ value: 'birthday', label: 'Birthday' },
	{ value: 'anniversary', label: 'Anniversary' },
	{ value: 'date_night', label: 'Date Night' },
	{ value: 'business', label: 'Business Meal' },
	{ value: 'celebration', label: 'Celebration' },
	{ value: 'vip', label: 'VIP' },
] as const

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
	const { t } = useLingui()
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
	const [guestNotes, setGuestNotes] = useState('')
	const [internalNotes, setInternalNotes] = useState('')
	const [serverLabel, setServerLabel] = useState('')

	// Operator overrides & payment policy
	const [overridePacing, setOverridePacing] = useState(false)
	const [overrideBlockedTable, setOverrideBlockedTable] = useState(false)
	const [overrideScheduleBlock, setOverrideScheduleBlock] = useState(false)
	const [paymentPolicyMode, setPaymentPolicyMode] = useState<
		'none' | 'send_link' | 'waive'
	>('none')

	// Availability slots
	const [slots, setSlots] = useState<OperatorAvailabilitySlot[]>([])
	const [loadingSlots, setLoadingSlots] = useState(false)

	// Submission state
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [idempotencyKey, setIdempotencyKey] = useState(() =>
		generateIdempotencyKey('book'),
	)

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
		setError(null)
		setIdempotencyKey(generateIdempotencyKey('book'))
	}, [
		defaultDate,
		initialAreaId,
		initialLocalStartMin,
		initialPartySize,
		initialServiceId,
		initialTableId,
		open,
	])

	// Live availability search
	const loadAvailability = useCallback(async () => {
		if (!open || !locationId || !date || partySize < 1) return
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
			setSlots(res.slots ?? [])
		} catch {
			setSlots([])
		} finally {
			setLoadingSlots(false)
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

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!guestName.trim() || !guestPhone.trim()) {
			setError(t`Guest name and phone number are required.`)
			return
		}
		setSubmitting(true)
		setError(null)
		try {
			const parsedDuration = durationMin ? Number(durationMin) : undefined
			const res = await createPhoneReservation(
				client,
				{
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
					channel: 'phone',
					guest: {
						fullName: guestName.trim(),
						phone: guestPhone.trim(),
						email: guestEmail.trim() || null,
						dietaryCodes,
					},
					occasion: occasion || null,
					dietaryCodes,
					guestNotes: guestNotes.trim() || null,
					internalNotes: internalNotes.trim() || null,
					serverLabel: serverLabel.trim() || null,
					overridePacing,
					overrideBlockedTable,
					overrideScheduleBlock,
					skipPayment: paymentPolicyMode === 'waive',
					paymentPolicyMode,
				},
				idempotencyKey,
			)
			onCreated(res.reservation, res.moveNotices ?? [])
			onOpenChange(false)
			// Reset guest fields for next booking
			setSelectedGuest(null)
			setGuestName('')
			setGuestPhone('')
			setGuestEmail('')
			setOccasion('')
			setDietaryCodes([])
			setGuestNotes('')
			setInternalNotes('')
			setServerLabel('')
		} catch (err) {
			setError(
				err instanceof Error ? err.message : t`Failed to create reservation.`,
			)
			setIdempotencyKey(generateIdempotencyKey('book'))
		} finally {
			setSubmitting(false)
		}
	}

	const activeTables = tables.filter(
		(tbl) => tbl.isActive && (!areaId || tbl.areaId === areaId),
	)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="w-full overflow-y-auto sm:max-w-xl"
				data-testid="booking-sheet"
			>
				<SheetHeader>
					<SheetTitle>
						<Trans>New Phone / Host Reservation</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>
							Search returning guests, check live slot availability, and book
							with optional operator overrides.
						</Trans>
					</SheetDescription>
				</SheetHeader>

				<form onSubmit={handleSubmit} className="flex flex-col gap-4 px-4 pb-4">
					{error ? (
						<Alert variant="destructive" data-testid="booking-sheet-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{/* Returning Guest Lookup */}
					<div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
						<Label htmlFor="booking-guest-search">
							<Trans>Lookup Returning Guest (Phone or Name)</Trans>
						</Label>
						<div className="relative">
							<Input
								id="booking-guest-search"
								value={guestQuery}
								onChange={(e) => setGuestQuery(e.target.value)}
								placeholder={t`Search by phone (+1...) or guest name...`}
								data-testid="booking-guest-search"
							/>
							{searchingGuests ? (
								<span className="text-muted-foreground absolute top-2 right-3 text-xs">
									<Trans>Searching...</Trans>
								</span>
							) : null}
						</div>

						{guestResults.length > 0 ? (
							<div
								className="bg-card divide-y rounded-md border"
								data-testid="booking-guest-results"
							>
								{guestResults.map((g) => (
									<button
										key={g.id}
										type="button"
										onClick={() => handleSelectReturningGuest(g)}
										className="hover:bg-muted flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-xs"
										data-testid={`booking-guest-result-${g.id}`}
									>
										<div>
											<div className="font-medium">{g.fullName}</div>
											<div className="text-muted-foreground">{g.phoneE164}</div>
										</div>
										<div className="flex flex-wrap items-center gap-1">
											{g.vipTier && g.vipTier !== 'none' ? (
												<Badge variant="default">{g.vipTier}</Badge>
											) : null}
											<Badge variant="secondary">
												{g.visitCount} <Trans>visits</Trans>
											</Badge>
											{g.noShowCount > 0 ? (
												<Badge variant="destructive">
													{g.noShowCount} <Trans>no-shows</Trans>
												</Badge>
											) : null}
										</div>
									</button>
								))}
							</div>
						) : null}

						{selectedGuest ? (
							<div
								className="bg-card flex flex-col gap-1 rounded-md border p-2.5 text-xs"
								data-testid="booking-returning-guest-card"
							>
								<div className="flex items-center justify-between">
									<span className="font-semibold">
										{selectedGuest.fullName} ({selectedGuest.phoneE164})
									</span>
									<div className="flex items-center gap-1">
										{selectedGuest.vipTier &&
										selectedGuest.vipTier !== 'none' ? (
											<Badge variant="default">{selectedGuest.vipTier}</Badge>
										) : null}
										<Badge variant="outline">
											{selectedGuest.visitCount} <Trans>visits</Trans>
										</Badge>
										{selectedGuest.noShowCount > 0 ? (
											<Badge variant="destructive">
												{selectedGuest.noShowCount} <Trans>no-shows</Trans>
											</Badge>
										) : null}
									</div>
								</div>
								{selectedGuest.allergiesText ? (
									<div className="text-red-600 dark:text-red-400">
										<Trans>Allergies:</Trans> {selectedGuest.allergiesText}
									</div>
								) : null}
								{selectedGuest.seatingPrefText ? (
									<div className="text-muted-foreground">
										<Trans>Preference:</Trans> {selectedGuest.seatingPrefText}
									</div>
								) : null}
							</div>
						) : null}
					</div>

					{/* Date, Party Size, Time, Duration */}
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-date-input">
								<Trans>Date</Trans>
							</Label>
							<Input
								id="booking-date-input"
								type="date"
								value={date}
								onChange={(e) => setDate(e.target.value)}
								data-testid="booking-date-input"
								required
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-party-size-input">
								<Trans>Party Size</Trans>
							</Label>
							<Input
								id="booking-party-size-input"
								type="number"
								min={1}
								max={40}
								value={partySize}
								onChange={(e) =>
									setPartySize(Math.max(1, Number(e.target.value) || 1))
								}
								data-testid="booking-party-size-input"
								required
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-time-input">
								<Trans>Time</Trans>
							</Label>
							<Input
								id="booking-time-input"
								type="time"
								step={900}
								value={timeInput}
								onChange={(e) => handleTimeChange(e.target.value)}
								data-testid="booking-time-input"
								required
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-duration-input">
								<Trans>Duration (min)</Trans>
							</Label>
							<Input
								id="booking-duration-input"
								type="number"
								min={15}
								max={360}
								step={15}
								placeholder={t`Auto`}
								value={durationMin}
								onChange={(e) => setDurationMin(e.target.value)}
								data-testid="booking-duration-input"
							/>
						</div>
					</div>

					{/* Service, Area, Table */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-service-select">
								<Trans>Service</Trans>
							</Label>
							<select
								id="booking-service-select"
								value={serviceId}
								onChange={(e) => setServiceId(e.target.value)}
								className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
								data-testid="booking-service-select"
							>
								<option value="">{t`Auto / Any`}</option>
								{services.map((svc) => (
									<option key={svc.id} value={svc.id}>
										{svc.name}
									</option>
								))}
							</select>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-area-select">
								<Trans>Dining Area</Trans>
							</Label>
							<select
								id="booking-area-select"
								value={areaId}
								onChange={(e) => setAreaId(e.target.value)}
								className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
								data-testid="booking-area-select"
							>
								<option value="">{t`Any Area`}</option>
								{areas.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
							</select>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-table-select">
								<Trans>Table Assignment</Trans>
							</Label>
							<select
								id="booking-table-select"
								value={tableId}
								onChange={(e) => setTableId(e.target.value)}
								className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
								data-testid="booking-table-select"
							>
								<option value="">{t`Auto-assign best table`}</option>
								{activeTables.map((tbl) => (
									<option key={tbl.id} value={tbl.id}>
										{tbl.label} ({tbl.minCovers}-{tbl.maxCovers})
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Available Slots Grid */}
					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<Label>
								<Trans>Available Slots</Trans>
							</Label>
							{loadingSlots ? (
								<span className="text-muted-foreground text-xs">
									<Trans>Checking slots...</Trans>
								</span>
							) : null}
						</div>
						{slots.length > 0 ? (
							<div
								className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border p-2"
								data-testid="booking-slots-grid"
							>
								{slots
									.filter(
										(s) =>
											s.status === 'available' ||
											(s.status === 'pacing_full' && s.canOverridePacing),
									)
									.slice(0, 32)
									.map((slot) => {
										const isSelected = slot.localStartMin === localStartMin
										const isPacingFull = slot.status === 'pacing_full'
										return (
											<Button
												key={`${slot.serviceId}-${slot.localStartMin}`}
												type="button"
												size="xs"
												variant={
													isSelected
														? 'default'
														: isPacingFull
															? 'secondary'
															: 'outline'
												}
												onClick={() => handleSelectSlot(slot)}
												data-testid={`booking-slot-${slot.localStartMin}`}
											>
												<span>{slot.hhmm}</span>
												{isPacingFull ? (
													<span className="text-amber-600 dark:text-amber-400">
														*
													</span>
												) : null}
											</Button>
										)
									})}
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								<Trans>
									Select a slot above or enter any time in the Time field.
								</Trans>
							</p>
						)}
					</div>

					{/* Guest Details */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-guest-name">
								<Trans>Guest Name</Trans> *
							</Label>
							<Input
								id="booking-guest-name"
								value={guestName}
								onChange={(e) => setGuestName(e.target.value)}
								placeholder={t`Full name`}
								data-testid="booking-guest-name"
								required
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-guest-phone">
								<Trans>Phone Number</Trans> *
							</Label>
							<Input
								id="booking-guest-phone"
								value={guestPhone}
								onChange={(e) => setGuestPhone(e.target.value)}
								placeholder="+14155550100"
								data-testid="booking-guest-phone"
								required
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-guest-email">
								<Trans>Email</Trans>
							</Label>
							<Input
								id="booking-guest-email"
								type="email"
								value={guestEmail}
								onChange={(e) => setGuestEmail(e.target.value)}
								placeholder="guest@example.com"
								data-testid="booking-guest-email"
							/>
						</div>
					</div>

					{/* Occasion & Server Label */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-occasion-select">
								<Trans>Occasion</Trans>
							</Label>
							<select
								id="booking-occasion-select"
								value={occasion}
								onChange={(e) => setOccasion(e.target.value)}
								className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
								data-testid="booking-occasion-select"
							>
								{OCCASION_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-server-input">
								<Trans>Server / Section Label</Trans>
							</Label>
							<Input
								id="booking-server-input"
								value={serverLabel}
								onChange={(e) => setServerLabel(e.target.value)}
								placeholder={t`Optional server name`}
								data-testid="booking-server-input"
							/>
						</div>
					</div>

					{/* Dietary Tags */}
					<div className="flex flex-col gap-1.5">
						<Label>
							<Trans>Dietary Tags</Trans>
						</Label>
						<div className="flex flex-wrap gap-1.5">
							{DIETARY_OPTIONS.map((opt) => {
								const active = dietaryCodes.includes(opt.code)
								return (
									<Button
										key={opt.code}
										type="button"
										size="xs"
										variant={active ? 'default' : 'outline'}
										onClick={() => toggleDietary(opt.code)}
										data-testid={`booking-dietary-${opt.code}`}
									>
										{opt.label}
									</Button>
								)
							})}
						</div>
					</div>

					{/* Guest & Internal Notes */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-guest-notes">
								<Trans>Guest Request / Notes</Trans>
							</Label>
							<Textarea
								id="booking-guest-notes"
								rows={2}
								value={guestNotes}
								onChange={(e) => setGuestNotes(e.target.value)}
								placeholder={t`Booth preferred, high chair...`}
								data-testid="booking-guest-notes"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="booking-internal-notes">
								<Trans>Internal Host Notes</Trans>
							</Label>
							<Textarea
								id="booking-internal-notes"
								rows={2}
								value={internalNotes}
								onChange={(e) => setInternalNotes(e.target.value)}
								placeholder={t`Friends of chef, comp welcome drink...`}
								data-testid="booking-internal-notes"
							/>
						</div>
					</div>

					{/* Operator Overrides & Deposit Policy */}
					<div className="bg-muted/30 flex flex-col gap-2 rounded-lg border p-3">
						<span className="text-xs font-semibold">
							<Trans>Operator Overrides & Deposit Policy</Trans>
						</span>
						<div className="flex flex-wrap gap-4 text-xs">
							<label className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={overridePacing}
									onChange={(e) => setOverridePacing(e.target.checked)}
									data-testid="booking-override-pacing"
								/>
								<span>
									<Trans>Override slot pacing cap</Trans>
								</span>
							</label>
							<label className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={overrideBlockedTable}
									onChange={(e) => setOverrideBlockedTable(e.target.checked)}
									data-testid="booking-override-blocked-table"
								/>
								<span>
									<Trans>Override blocked table</Trans>
								</span>
							</label>
							<label className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={overrideScheduleBlock}
									onChange={(e) => setOverrideScheduleBlock(e.target.checked)}
									data-testid="booking-override-schedule-block"
								/>
								<span>
									<Trans>Override schedule block</Trans>
								</span>
							</label>
						</div>

						<div className="flex items-center gap-2 pt-1">
							<Label htmlFor="booking-payment-policy" className="text-xs">
								<Trans>Deposit / Card Hold Policy:</Trans>
							</Label>
							<select
								id="booking-payment-policy"
								value={paymentPolicyMode}
								onChange={(e) =>
									setPaymentPolicyMode(
										e.target.value as 'none' | 'send_link' | 'waive',
									)
								}
								className="border-input bg-background h-8 rounded-md border px-2 text-xs"
								data-testid="booking-payment-policy"
							>
								<option value="none">{t`Standard policy`}</option>
								<option value="send_link">{t`Send SMS payment link`}</option>
								<option value="waive">{t`Waive deposit / card hold`}</option>
							</select>
						</div>
					</div>

					<SheetFooter className="px-0 pt-2">
						<div className="flex w-full items-center justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="submit"
								disabled={submitting}
								data-testid="booking-submit-btn"
							>
								<Icon name="check" className="size-4" />
								<span>
									{submitting ? (
										<Trans>Booking...</Trans>
									) : (
										<Trans>Create Reservation</Trans>
									)}
								</span>
							</Button>
						</div>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	)
}
