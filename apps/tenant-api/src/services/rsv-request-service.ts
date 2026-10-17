import { randomUUID } from 'node:crypto'
import {
	getTenantDb,
	rsvReservationEvents,
	rsvReservations,
	rsvTableOccupancies,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import {
	deactivateOccupancies,
	insertOccupancyRows,
} from './rsv-hold-service.ts'
import { planRequestTables } from './rsv-public-booking-service.ts'
import { loadPublicEngineState } from './rsv-public-engine.ts'

async function loadPendingRequest(orgId: string, reservationId: string) {
	const db = await getTenantDb(orgId)
	const row = await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, reservationId))
		.get()
	if (!row) throw new HttpError(404, 'not_found')
	return row
}

/**
 * Approving a large-party request books it. When the request never held
 * tables (capacity holding off, or nothing fit then) a best-effort assignment
 * runs now; approval does not fail for lack of tables because the host can
 * still seat the party by hand.
 */
export async function approveReservationRequest(params: {
	orgId: string
	reservationId: string
	actorId: string
	now?: number
}) {
	const now = params.now ?? Date.now()
	const pre = await loadPendingRequest(params.orgId, params.reservationId)
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx) => {
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, pre.id))
				.get()
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status !== 'pending_approval') {
				throw new HttpError(409, 'invalid_status_transition')
			}

			const held = await tx
				.select({ id: rsvTableOccupancies.id })
				.from(rsvTableOccupancies)
				.where(
					and(
						eq(rsvTableOccupancies.reservationId, current.id),
						eq(rsvTableOccupancies.active, true),
					),
				)
				.all()
			let tableCount = held.length
			if (tableCount === 0) {
				const state = await loadPublicEngineState(tx, {
					locationId: current.locationId,
					fromDate: current.businessDate,
					toDate: current.businessDate,
					now,
					excludeReservationIds: new Set([current.id]),
				})
				if (state) {
					const tableIds = planRequestTables(state, {
						businessDate: current.businessDate,
						localMin: current.localStartMin,
						partySize: current.partySize,
						serviceId: current.serviceId,
						now,
						startAt: current.startAt,
						endAt: current.endAt,
					})
					await insertOccupancyRows(tx, {
						locationId: current.locationId,
						kind: 'reservation',
						ownerId: current.id,
						tableIds,
						startAt: current.startAt,
						endAt: current.endAt,
						resetBufferMin: (id) =>
							state.tableById.get(id)?.resetBufferMin ?? 0,
						now,
					})
					tableCount = tableIds.length
				}
			}

			await tx
				.update(rsvReservations)
				.set({
					status: 'booked',
					requestDeadlineAt: null,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'request_approved',
				fromStatus: 'pending_approval',
				toStatus: 'booked',
				data: { tablesAssigned: tableCount > 0 },
			})
			return { reservationId: current.id }
		},
	)
}

export async function declineReservationRequest(params: {
	orgId: string
	reservationId: string
	actorId: string
	reason?: string | null
	now?: number
}) {
	const now = params.now ?? Date.now()
	const pre = await loadPendingRequest(params.orgId, params.reservationId)
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: pre.locationId,
			dates: pre.businessDate,
			now,
		},
		async (tx) => {
			const current = await tx
				.select()
				.from(rsvReservations)
				.where(eq(rsvReservations.id, pre.id))
				.get()
			if (!current) throw new HttpError(404, 'not_found')
			if (current.status !== 'pending_approval') {
				throw new HttpError(409, 'invalid_status_transition')
			}
			await deactivateOccupancies(tx, { reservationId: current.id })
			await tx
				.update(rsvReservations)
				.set({
					status: 'declined',
					requestDeadlineAt: null,
					cancelReason: params.reason?.trim() || null,
					version: current.version + 1,
					updatedAt: now,
				})
				.where(eq(rsvReservations.id, current.id))
			await tx.insert(rsvReservationEvents).values({
				id: `rev_${randomUUID()}`,
				reservationId: current.id,
				at: now,
				actorKind: 'operator',
				actorId: params.actorId,
				type: 'request_declined',
				fromStatus: 'pending_approval',
				toStatus: 'declined',
				data: { reason: params.reason?.trim() || null },
			})
			return { reservationId: current.id }
		},
	)
}
