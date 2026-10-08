import { type PickupSelection } from './types.ts'
import {
	formatDropDate,
	formatDropTime,
	formatTimeRange,
	zonedTimeToUtc,
} from '~/lib/drops/format.ts'

/**
 * Pickup locations, dates and slots for a drop, built from the pickup windows
 * of `/resources/sites/drop`. Every wall-clock value stays in the location's
 * timezone; instants (`Date`) are the UTC equivalents used for lead-time math
 * and calendar links.
 */

export type PickupLocationData = {
	id: string
	name: string
	phone: string | null
	address: unknown
	timezone?: string | null
}

export type PickupWindowData = {
	id: string
	locationId: string
	date: string
	startTime: string
	endTime: string
	slotIntervalMinutes: number
	maxOrdersPerSlot: number | null
	orderLeadTimeMinutes: number
	slots: Array<{ time: string; displayTime?: string }>
	location?: PickupLocationData | null
}

export type PickupSlotOption = {
	/** Wall-clock start `HH:MM` in the location timezone. */
	start: string
	/** Wall-clock end `HH:MM` (`start + interval`) in the location timezone. */
	end: string
	/** UTC instant of the slot start; `null` when the value is unparseable. */
	startInstant: Date | null
	/** False when the slot start is inside the order lead time. */
	available: boolean
}

export type PickupDateOption = {
	/** `YYYY-MM-DD` in the location timezone. */
	date: string
	slots: PickupSlotOption[]
}

export type PickupLocationOption = {
	locationId: string
	name: string
	phone: string | null
	address: unknown
	timezone: string
	dates: PickupDateOption[]
}

export type ResolvedPickup = {
	location: PickupLocationOption
	date: PickupDateOption
	slot: PickupSlotOption
	selection: PickupSelection
}

/** Normalized `HH:MM` (24h) slot end: slot start + one interval. */
function addMinutes(time: string, minutes: number): string {
	const [h = 0, m = 0] = time.split(':').map(Number)
	const total = h * 60 + m + minutes
	const hours = Math.floor(total / 60) % 24
	const mins = total % 60
	return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

/**
 * Groups windows into locations → dates → slots. Windows without a location
 * (or a timezone) are skipped: their pickup times cannot be named or converted.
 * Slots whose start lies inside `orderLeadTimeMinutes` are kept but flagged
 * `available: false` so the picker can explain them ("No longer available").
 */
export function buildPickupOptions(
	windows: PickupWindowData[],
	now: Date = new Date(),
): PickupLocationOption[] {
	const nowMs = now.getTime()
	const locations: PickupLocationOption[] = []
	const byLocation = new Map<string, PickupLocationOption>()

	for (const window of windows) {
		const location = window.location
		const timezone = location?.timezone
		if (!location || !timezone) continue

		let option = byLocation.get(window.locationId)
		if (!option) {
			option = {
				locationId: window.locationId,
				name: location.name,
				phone: location.phone ?? null,
				address: location.address ?? null,
				timezone,
				dates: [],
			}
			byLocation.set(window.locationId, option)
			locations.push(option)
		}

		let date = option.dates.find((candidate) => candidate.date === window.date)
		if (!date) {
			date = { date: window.date, slots: [] }
			option.dates.push(date)
		}

		const interval =
			Number.isFinite(window.slotIntervalMinutes) &&
			window.slotIntervalMinutes > 0
				? window.slotIntervalMinutes
				: 30
		const leadMs = Math.max(0, window.orderLeadTimeMinutes) * 60_000

		for (const slot of window.slots ?? []) {
			if (!slot?.time || date.slots.some((s) => s.start === slot.time)) continue
			const startInstant = zonedTimeToUtc(window.date, slot.time, timezone)
			date.slots.push({
				start: slot.time,
				end: addMinutes(slot.time, interval),
				startInstant,
				available: startInstant
					? startInstant.getTime() - leadMs > nowMs
					: false,
			})
		}
	}

	for (const location of locations) {
		location.dates.sort((a, b) => a.date.localeCompare(b.date))
		for (const date of location.dates) {
			date.slots.sort((a, b) => a.start.localeCompare(b.start))
		}
	}
	// Soonest pickup first, so the picker reads chronologically even if the
	// windows arrive out of order.
	locations.sort(
		(a, b) =>
			a.dates[0]!.date.localeCompare(b.dates[0]!.date) ||
			a.name.localeCompare(b.name),
	)
	return locations
}

/**
 * Re-validates a persisted selection against the current options. Availability
 * is already baked into the slots by `buildPickupOptions`, so an unavailable
 * slot is rejected here too.
 */
export function resolvePickup(
	options: PickupLocationOption[],
	selection: PickupSelection | null | undefined,
): ResolvedPickup | null {
	if (!selection) return null
	const location = options.find((l) => l.locationId === selection.locationId)
	const date = location?.dates.find((d) => d.date === selection.date)
	const slot = date?.slots.find((s) => s.start === selection.slotStart)
	if (!location || !date || !slot) return null
	if (!slot.available) return null
	return { location, date, slot, selection }
}

/** "Fri, Oct 9 · 9:30 AM – 12:00 PM" for a window in its location timezone. */
export function formatWindow(
	window: Pick<PickupWindowData, 'date' | 'startTime' | 'endTime'> & {
		location?: { timezone?: string | null } | null
	},
	locale: string,
): string {
	const timezone = window.location?.timezone || 'UTC'
	const date = formatDropDate(window.date, locale, timezone)
	const range = formatTimeRange(
		window.startTime,
		window.endTime,
		locale,
		timezone,
		window.date,
	)
	return `${date} · ${range}`
}

/** "Fri, Oct 9 · 9:30 AM" for a chosen slot in the location timezone. */
export function formatSlot(
	date: string,
	slotStart: string,
	locale: string,
	timezone: string,
): string {
	const instant = zonedTimeToUtc(date, slotStart, timezone)
	const time = instant ? formatDropTime(instant, locale, timezone) : slotStart
	return `${formatDropDate(date, locale, timezone)} · ${time}`
}

/** "123 Market St, San Francisco, CA 94105" */
export function formatPickupAddress(address: unknown): string {
	if (!address || typeof address !== 'object') return ''
	const a = address as Record<string, unknown>
	const formatted = a.formattedAddress
	if (typeof formatted === 'string' && formatted.trim()) return formatted.trim()
	const street = [a.streetNumber, a.streetName]
		.filter((part) => typeof part === 'string' && part.trim())
		.map((part) => (part as string).trim())
		.join(' ')
	// State and postal read as one unit ("CA 94105"); either can be absent.
	const region = [a.state, a.postalCode]
		.filter((part) => typeof part === 'string' && part.trim())
		.map((part) => (part as string).trim())
		.join(' ')
	return [street, a.city, region]
		.filter((part) => typeof part === 'string' && part.trim())
		.map((part) => (part as string).trim())
		.join(', ')
}

/** External map link for a pickup location (address when present, else name). */
export function pickupMapHref(location: {
	name: string
	address: unknown
}): string {
	const query = formatPickupAddress(location.address) || location.name
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

/** `tel:` href with anything but digits and a leading `+` stripped. */
export function pickupPhoneHref(
	phone: string | null | undefined,
): string | null {
	if (!phone) return null
	const digits = phone.replace(/[^\d+]/g, '')
	return digits ? `tel:${digits}` : null
}

const SELECTION_PREFIX = 'menuza_drop_pickup_'

type SelectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function selectionStorage(): SelectionStorage | null {
	try {
		if (typeof sessionStorage !== 'undefined') return sessionStorage
	} catch {
		// Access can throw in sandboxed frames.
	}
	return null
}

function isPickupSelection(value: unknown): value is PickupSelection {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return (
		typeof v.locationId === 'string' &&
		typeof v.date === 'string' &&
		typeof v.slotStart === 'string' &&
		typeof v.slotEnd === 'string'
	)
}

/** Persists the chosen pickup per drop for the browser session. */
export function savePickupSelection(
	dropId: string,
	selection: PickupSelection,
	storage?: SelectionStorage | null,
): void {
	const store = storage ?? selectionStorage()
	if (!store) return
	try {
		store.setItem(`${SELECTION_PREFIX}${dropId}`, JSON.stringify(selection))
	} catch {
		// Quota or privacy mode: the in-memory selection still applies.
	}
}

/** Restores the pickup chosen this session, if any. */
export function loadPickupSelection(
	dropId: string,
	storage?: SelectionStorage | null,
): PickupSelection | null {
	const store = storage ?? selectionStorage()
	if (!store) return null
	try {
		const raw = store.getItem(`${SELECTION_PREFIX}${dropId}`)
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		return isPickupSelection(parsed) ? parsed : null
	} catch {
		return null
	}
}

/** Drops a stored selection (kept when the customer re-picks on purpose). */
export function clearPickupSelection(
	dropId: string,
	storage?: SelectionStorage | null,
): void {
	const store = storage ?? selectionStorage()
	if (!store) return
	try {
		store.removeItem(`${SELECTION_PREFIX}${dropId}`)
	} catch {
		// Nothing to clean up when storage is unavailable.
	}
}
