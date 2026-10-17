import {
	rsvGuests,
	rsvReservations,
	rsvServices,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray } from 'drizzle-orm'
import { formatMinutesToHHMM } from './rsv-day-feed-service.ts'

/** Arrivals the dashboard block lists. */
export const TODAY_NEXT_ARRIVALS = 8

/** Statuses of a party that has not reached a table yet. */
const AWAITING = new Set(['booked', 'confirmed', 'arrived'])
const WAITLIST_ACTIVE = ['waiting', 'notified', 'on_the_way'] as const
/** A party this long past its time is still "next" before later ones. */
const OVERDUE_GRACE_MS = 30 * 60_000

/**
 * What the Home dashboard's "Bookings today" block shows for one location and
 * business date. Counts and first names only: no phone, email or notes.
 */
export async function getBookingsToday(
	db: TenantDatabase,
	input: { locationId: string; businessDate: string; now: number },
) {
	const [rows, services, waitlist] = await Promise.all([
		db
			.select({
				id: rsvReservations.id,
				localStartMin: rsvReservations.localStartMin,
				startAt: rsvReservations.startAt,
				serviceId: rsvReservations.serviceId,
				partySize: rsvReservations.partySize,
				coversActual: rsvReservations.coversActual,
				status: rsvReservations.status,
				firstName: rsvGuests.firstName,
			})
			.from(rsvReservations)
			.innerJoin(rsvGuests, eq(rsvGuests.id, rsvReservations.guestId))
			.where(
				and(
					eq(rsvReservations.locationId, input.locationId),
					eq(rsvReservations.businessDate, input.businessDate),
				),
			)
			.orderBy(rsvReservations.startAt),
		db
			.select({ id: rsvServices.id, name: rsvServices.name })
			.from(rsvServices)
			.where(eq(rsvServices.locationId, input.locationId)),
		db
			.select({ id: rsvWaitlistEntries.id })
			.from(rsvWaitlistEntries)
			.where(
				and(
					eq(rsvWaitlistEntries.locationId, input.locationId),
					eq(rsvWaitlistEntries.businessDate, input.businessDate),
					inArray(rsvWaitlistEntries.status, [...WAITLIST_ACTIVE]),
				),
			),
	])
	const names = new Map(services.map((s) => [s.id, s.name]))

	const counts: Record<string, number> = {}
	for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1

	const active = rows.filter(
		(row) => !['cancelled', 'declined', 'expired'].includes(row.status),
	)
	const byService = new Map<string, { parties: number; covers: number }>()
	for (const row of active) {
		const key = row.serviceId ?? ''
		const entry = byService.get(key) ?? { parties: 0, covers: 0 }
		entry.parties += 1
		entry.covers += row.coversActual ?? row.partySize
		byService.set(key, entry)
	}

	const awaiting = rows.filter((row) => AWAITING.has(row.status))
	const firstUpcoming = awaiting.findIndex(
		(row) => row.startAt >= input.now - OVERDUE_GRACE_MS,
	)
	const anchor = firstUpcoming === -1 ? awaiting.length : firstUpcoming
	const start = Math.max(
		0,
		Math.min(anchor, awaiting.length - TODAY_NEXT_ARRIVALS),
	)

	return {
		locationId: input.locationId,
		businessDate: input.businessDate,
		totalParties: active.length,
		totalCovers: active.reduce(
			(sum, row) => sum + (row.coversActual ?? row.partySize),
			0,
		),
		counts,
		coversByService: [...byService.entries()].map(([serviceId, value]) => ({
			serviceId: serviceId === '' ? null : serviceId,
			name: serviceId === '' ? null : (names.get(serviceId) ?? null),
			...value,
		})),
		waitlistCount: waitlist.length,
		nextArrivals: awaiting
			.slice(start, start + TODAY_NEXT_ARRIVALS)
			.map((row) => ({
				reservationId: row.id,
				time: formatMinutesToHHMM(row.localStartMin),
				partySize: row.partySize,
				firstName: row.firstName,
				status: row.status,
			})),
	}
}
