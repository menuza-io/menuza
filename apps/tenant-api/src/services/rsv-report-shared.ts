import { maskIncludesWeekday } from '@repo/reservations'

/**
 * Reservation report math shared by the generic report loaders
 * (`rsv-report-records.ts`). One definition each, so a figure never differs
 * between two reports. Pure functions over plain rows: no database, no guest
 * columns.
 */

/** Statuses that never occupied a table, so they are not "bookings" in counts. */
export const NOT_BOOKED: ReadonlySet<string> = new Set([
	'cancelled',
	'declined',
	'expired',
])

export function isBookedStatus(status: string): boolean {
	return !NOT_BOOKED.has(status)
}

/**
 * Covers of one reservation, everywhere: the guests who actually came when
 * recorded, otherwise the booked party size. A finished party does not use the
 * seated count.
 */
export function bookingCovers(row: {
	partySize: number
	coversActual: number | null
}): number {
	return row.coversActual ?? row.partySize
}

export type TurnRule = {
	serviceId: string | null
	partyMin: number
	partyMax: number
	minutes: number
	daysMask: number | null
}

/** The configured turn time for a party size: a service rule beats a general one. */
export function configuredTurnMinutes(
	rules: readonly TurnRule[],
	partySize: number,
	serviceId: string | null,
	businessDate: string,
): number | null {
	const weekday = new Date(`${businessDate}T12:00:00Z`).getUTCDay()
	const fits = rules.filter(
		(rule) =>
			partySize >= rule.partyMin &&
			partySize <= rule.partyMax &&
			(rule.daysMask === null || maskIncludesWeekday(rule.daysMask, weekday)),
	)
	const pick =
		fits.find(
			(rule) => rule.serviceId !== null && rule.serviceId === serviceId,
		) ?? fits.find((rule) => rule.serviceId === null)
	return pick?.minutes ?? null
}

export type PacingRule = {
	serviceId: string
	channel: string
	fromMin: number | null
	toMin: number | null
	maxCovers: number | null
	maxParties: number | null
}

export type PacingInputRow = {
	businessDate: string
	localStartMin: number
	serviceId: string | null
	partySize: number
	coversActual: number | null
	status: string
	/** Slots are counted per location when the rows span several. */
	locationId?: string | null
	startAt?: number | null
	timeZone?: string | null
}

export type PacingSlot = {
	locationId: string | null
	businessDate: string
	serviceId: string | null
	localStartMin: number
	/** Start of the first booking in the slot, epoch milliseconds. */
	startAt: number | null
	timeZone: string | null
	bookings: number
	covers: number
	maxCovers: number | null
	maxParties: number | null
	overLimit: boolean
}

function pacingLimit(
	rules: readonly PacingRule[],
	serviceId: string | null,
	minute: number,
) {
	const matching = rules.filter(
		(rule) =>
			rule.serviceId === serviceId &&
			rule.channel === 'all' &&
			(rule.fromMin === null || minute >= rule.fromMin) &&
			(rule.toMin === null || minute < rule.toMin),
	)
	return {
		maxCovers:
			matching.find((rule) => rule.maxCovers !== null)?.maxCovers ?? null,
		maxParties:
			matching.find((rule) => rule.maxParties !== null)?.maxParties ?? null,
	}
}

/**
 * Bookings and covers per date, service and start minute (per location when the
 * rows carry one), against the pacing limits of the service. Cancelled,
 * declined and expired bookings do not count. Sorted by date, then minute.
 */
export function computePacingSlots(
	rows: readonly PacingInputRow[],
	rules: readonly PacingRule[],
): PacingSlot[] {
	const slots = new Map<string, PacingSlot>()
	for (const row of rows) {
		if (!isBookedStatus(row.status)) continue
		const key = `${row.locationId ?? ''}|${row.businessDate}|${row.serviceId ?? ''}|${row.localStartMin}`
		const slot = slots.get(key) ?? {
			locationId: row.locationId ?? null,
			businessDate: row.businessDate,
			serviceId: row.serviceId,
			localStartMin: row.localStartMin,
			startAt: row.startAt ?? null,
			timeZone: row.timeZone ?? null,
			bookings: 0,
			covers: 0,
			maxCovers: null,
			maxParties: null,
			overLimit: false,
		}
		slot.bookings += 1
		slot.covers += bookingCovers(row)
		slots.set(key, slot)
	}
	return [...slots.values()]
		.sort(
			(a, b) =>
				a.businessDate.localeCompare(b.businessDate) ||
				a.localStartMin - b.localStartMin,
		)
		.map((slot) => {
			const limit = pacingLimit(rules, slot.serviceId, slot.localStartMin)
			return {
				...slot,
				...limit,
				overLimit:
					(limit.maxCovers !== null && slot.covers > limit.maxCovers) ||
					(limit.maxParties !== null && slot.bookings > limit.maxParties),
			}
		})
}
