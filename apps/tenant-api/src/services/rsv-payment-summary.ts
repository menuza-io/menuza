import {
	rsvExperiences,
	rsvPayments,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, gt, inArray, ne, sql } from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'

type Db =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

/**
 * Reservation payment states that block a customer-data-region switch: money
 * is in flight, or a card on file can still be charged. Typed confirmation
 * never overrides these.
 */
export const UNSETTLED_RESERVATION_PAYMENT_STATUSES = [
	'pending',
	'guaranteed',
	'fee_pending',
	'refund_pending',
	'review',
	'disputed',
] as const

/** A card on file stops counting this long after the booking ended. */
const GUARANTEE_FEE_WINDOW_MS = 14 * 24 * 3_600_000

export async function getPaymentSummaryCounts(
	db: Db,
	locationIds: readonly string[] | undefined,
	now: number,
): Promise<{
	payments: number
	unsettledPayments: number
	experiences: number
}> {
	const locationFilter = (column: Parameters<typeof inArray>[0]) =>
		locationIds && locationIds.length > 0
			? inJsonList(column, locationIds)
			: undefined
	const [payments, unsettledReservations, chargingRows, experiences] =
		await Promise.all([
			db
				.select({ count: sql<number>`count(*)` })
				.from(rsvPayments)
				.where(locationFilter(rsvPayments.locationId))
				.get(),
			db
				.select({ count: sql<number>`count(*)` })
				.from(rsvReservations)
				.where(
					and(
						inArray(rsvReservations.paymentStatus, [
							...UNSETTLED_RESERVATION_PAYMENT_STATUSES,
						]),
						// An unpaid booking that lapsed already released its session.
						ne(rsvReservations.status, 'expired'),
						gt(rsvReservations.endAt, now - GUARANTEE_FEE_WINDOW_MS),
						locationFilter(rsvReservations.locationId),
					),
				)
				.get(),
			db
				.select({ count: sql<number>`count(*)` })
				.from(rsvPayments)
				.where(
					and(
						inArray(rsvPayments.status, ['charging', 'refund_pending']),
						locationFilter(rsvPayments.locationId),
					),
				)
				.get(),
			db
				.select({ count: sql<number>`count(*)` })
				.from(rsvExperiences)
				.where(
					and(
						ne(rsvExperiences.status, 'archived'),
						locationFilter(rsvExperiences.locationId),
					),
				)
				.get(),
		])
	return {
		payments: Number(payments?.count ?? 0),
		unsettledPayments:
			Number(unsettledReservations?.count ?? 0) +
			Number(chargingRows?.count ?? 0),
		experiences: Number(experiences?.count ?? 0),
	}
}
