import { DEMAND_BUCKET_SECONDS, localDateOf, localParts } from '@repo/staffing'
import { type RsvReservationStatus, rsvReservations } from '@repo/tenant-db'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import {
	type DemandBucketRow,
	type DemandSource,
	registerDemandSource,
} from '../services/demand-sources.ts'

/**
 * The `visits` demand source: people seated and people booked, from the
 * Reservations module. A staffing scope is a location, so `scopeId` is the
 * reservation's `locationId`. It selects counts only: no guest column is ever
 * read, so nothing personal can reach the forecast.
 */

export const VISITS_SOURCE_ID = 'visits'

/** Parties that sat down: the history the typical hour is built from. */
const SEATED_STATUSES = [
	'partially_seated',
	'seated',
	'finished',
] as const satisfies readonly RsvReservationStatus[]

/**
 * Parties still to come that hold their place: confirmed bookings, and people
 * who are here but not yet seated. A booking that waits for its deposit counts
 * only while the payment window is open. Cancelled, declined, expired and
 * no-show bookings never count.
 */
const BOOKED_STATUSES = [
	'booked',
	'confirmed',
	'arrived',
] as const satisfies readonly RsvReservationStatus[]

export const reservationsDemandSource: DemandSource = {
	id: VISITS_SOURCE_ID,
	unit: 'visits',

	async loadBuckets(db, scopeId, window): Promise<DemandBucketRow[]> {
		const seatedSeconds = sql`(${rsvReservations.seatedAt} / 1000)`
		const bucket = sql<number>`cast((${seatedSeconds} - ${window.alignSeconds}) / ${DEMAND_BUCKET_SECONDS} as integer)`
		const rows = await db
			.select({
				bucket,
				// What the host recorded, else the party that was booked.
				units: sql<number>`coalesce(sum(coalesce(${rsvReservations.coversActual}, ${rsvReservations.seatedCovers}, ${rsvReservations.partySize})), 0)`,
			})
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, scopeId),
					inArray(rsvReservations.status, [...SEATED_STATUSES]),
					sql`${rsvReservations.seatedAt} is not null`,
					sql`${rsvReservations.seatedAt} >= ${window.fromSeconds * 1000}`,
					sql`${rsvReservations.seatedAt} < ${window.toSeconds * 1000}`,
				),
			)
			.groupBy(bucket)
		return rows.map((row) => ({
			bucket: Number(row.bucket),
			units: Number(row.units),
		}))
	},

	async loadBooked(db, scopeId, window) {
		const now = Date.now()
		const bucket = sql<number>`cast(${rsvReservations.startAt} / 1000 / ${DEMAND_BUCKET_SECONDS} as integer)`
		const rows = await db
			.select({
				bucket,
				units: sql<number>`coalesce(sum(${rsvReservations.partySize}), 0)`,
			})
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, scopeId),
					or(
						inArray(rsvReservations.status, [...BOOKED_STATUSES]),
						and(
							eq(rsvReservations.status, 'pending_payment'),
							or(
								isNull(rsvReservations.paymentExpiresAt),
								gt(rsvReservations.paymentExpiresAt, now),
							),
						),
					),
					sql`${rsvReservations.startAt} >= ${window.fromSeconds * 1000}`,
					sql`${rsvReservations.startAt} < ${window.toSeconds * 1000}`,
				),
			)
			.groupBy(bucket)
		return rows.map((row) => {
			const startMs = Number(row.bucket) * DEMAND_BUCKET_SECONDS * 1000
			return {
				date: localDateOf(startMs, window.timeZone),
				hour: localParts(startMs, window.timeZone).hour,
				units: Number(row.units),
			}
		})
	},
}

/** Registers the `visits` source; call once at startup (Node and Workers). */
export function registerReservationsDemandSource() {
	registerDemandSource(reservationsDemandSource)
}
