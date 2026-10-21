import {
	customers,
	getTenantDb,
	isReservationJourneyTrigger,
	rsvGuests,
	rsvJourneyEmissions,
	rsvReservations,
	type ReservationJourneyTriggerType,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { evaluateAndSpawnTriggers } from '../services/journey-service.ts'
import { hasDeliverableSubscription } from '../services/marketing-audience.ts'

/**
 * Reservation journeys (`reservation_booked`, `_completed`, `_no_show`,
 * `_cancelled`). A guest starts a journey only when they are verified (their
 * login owns the phone) or explicitly agreed to marketing on the booking
 * form; steps then check the `reservations` subscription again. The
 * `rsv_journey_emissions` primary key makes each (booking, trigger) fire at
 * most once, whatever repeats a transition.
 */

/** The only keys a reservation journey run carries: ids and counts. */
export const RESERVATION_JOURNEY_CONTEXT_KEYS = [
	'reservationId',
	'locationId',
	'partySize',
	'businessDate',
	'serviceId',
	'channel',
	'experienceId',
	'visitNumber',
] as const

export type ReservationJourneyContext = {
	reservationId: string
	locationId: string
	partySize: number
	businessDate: string
	serviceId: string | null
	channel: string
	experienceId: string | null
	visitNumber: number
}

export type ReservationJourneyOutcome =
	| { emitted: true; customerId: string }
	| {
			emitted: false
			reason: 'not_found' | 'not_eligible' | 'already_emitted'
	  }

/** The booking path never waits longer than this for the workflow worker. */
export const JOURNEY_EMIT_BUDGET_MS = 3000

async function eligibleCustomerId(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	guest: {
		customerId: string | null
		marketingCustomerId: string | null
		erasedAt: number | null
		mergedIntoId: string | null
	},
): Promise<string | null> {
	if (guest.erasedAt !== null || guest.mergedIntoId !== null) return null
	// Verified: the signed-in customer owns the number.
	if (guest.customerId) {
		const verified = await db
			.select({ id: customers.id })
			.from(customers)
			.where(
				and(
					eq(customers.id, guest.customerId),
					eq(customers.phoneVerified, true),
				),
			)
			.get()
		if (verified) return verified.id
	}
	// Consenting: an active `reservations` subscription on the marketing row
	// (an email one also needs its address confirmed: double opt-in).
	if (guest.marketingCustomerId) {
		for (const channel of ['email', 'sms'] as const) {
			const consent = await hasDeliverableSubscription(db, {
				customerId: guest.marketingCustomerId,
				topic: 'reservations',
				channel,
			})
			if (consent) return guest.marketingCustomerId
		}
	}
	return null
}

export async function emitReservationJourney(params: {
	orgId: string
	reservationId: string
	trigger: ReservationJourneyTriggerType
	tenantApiUrl?: string
}): Promise<ReservationJourneyOutcome> {
	if (!isReservationJourneyTrigger(params.trigger)) {
		return { emitted: false, reason: 'not_eligible' }
	}
	const db = await getTenantDb(params.orgId)
	const row = await db
		.select({
			reservation: rsvReservations,
			guest: rsvGuests,
		})
		.from(rsvReservations)
		.innerJoin(rsvGuests, eq(rsvGuests.id, rsvReservations.guestId))
		.where(eq(rsvReservations.id, params.reservationId))
		.get()
	if (!row) return { emitted: false, reason: 'not_found' }

	const customerId = await eligibleCustomerId(db, row.guest)
	if (!customerId) return { emitted: false, reason: 'not_eligible' }

	// Inserted first: a conflict means this booking already fired this trigger.
	const inserted = await db
		.insert(rsvJourneyEmissions)
		.values({
			reservationId: row.reservation.id,
			eventType: params.trigger,
		})
		.onConflictDoNothing()
		.returning({ reservationId: rsvJourneyEmissions.reservationId })
	if (inserted.length === 0)
		return { emitted: false, reason: 'already_emitted' }

	const context: ReservationJourneyContext = {
		reservationId: row.reservation.id,
		locationId: row.reservation.locationId,
		partySize: row.reservation.partySize,
		businessDate: row.reservation.businessDate,
		serviceId: row.reservation.serviceId,
		channel: row.reservation.channel,
		experienceId: row.reservation.experienceId,
		// A finished visit is already counted on the profile; the others are
		// the guest's next visit.
		visitNumber:
			row.guest.visits + (params.trigger === 'reservation_completed' ? 0 : 1),
	}
	await evaluateAndSpawnTriggers(
		params.orgId,
		params.trigger,
		customerId,
		params.tenantApiUrl,
		context,
	)
	return { emitted: true, customerId }
}

/**
 * Runs after the write committed (pass `helpers.afterCommit`). It never throws
 * and never blocks the response for long; nothing personal is logged.
 */
export function queueReservationJourney(
	afterCommit: (hook: () => void | Promise<void>) => void,
	params: {
		orgId: string
		reservationId: string
		trigger: ReservationJourneyTriggerType
	},
) {
	afterCommit(async () => {
		const run = emitReservationJourney(params).catch((error: unknown) => {
			console.error(
				`Reservation journey ${params.trigger} failed`,
				error instanceof Error ? error.name : 'error',
			)
		})
		let timer: ReturnType<typeof setTimeout> | undefined
		await Promise.race([
			run,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, JOURNEY_EMIT_BUDGET_MS)
			}),
		])
		if (timer) clearTimeout(timer)
	})
}
