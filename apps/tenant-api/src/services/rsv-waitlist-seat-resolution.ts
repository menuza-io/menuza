import { randomUUID } from 'node:crypto'
import { assignTables, type AssignBookingRecord } from '@repo/reservations'
import {
	rsvAuditLog,
	rsvGuests,
	rsvReservations,
	type rsvTableOccupancies,
} from '@repo/tenant-db'
import { inArray } from 'drizzle-orm'
import { badRequest, conflict } from '../lib/http.ts'
import { type ReservationWriteTx } from '../lib/reservations-write.ts'
import {
	assignReservationTables,
	loadLocationSchedulingState,
	type ReservationMoveReport,
	type WalkInOccupiedInfo,
} from './rsv-booking-service.ts'

export const WAITLIST_SEAT_RESOLUTIONS = ['swap', 'move', 'overbook'] as const
export type WaitlistSeatResolution = (typeof WAITLIST_SEAT_RESOLUTIONS)[number]

const UNSWAPPABLE_STATUSES = new Set(['arrived', 'seated'])

type OccupancyRow = typeof rsvTableOccupancies.$inferSelect

export type SeatOccupant = {
	kind: 'reservation' | 'hold' | 'block'
	reservationId: string | null
	confirmationCode: string | null
	status: string | null
	partySize: number | null
	startAt: number
	endAt: number
	tableIds: string[]
	guestName: string | null
}

async function describeOccupants(
	tx: ReservationWriteTx,
	occupancies: readonly OccupancyRow[],
	canReadGuest: boolean,
) {
	const reservationIds = [
		...new Set(
			occupancies.flatMap((o) =>
				o.kind === 'reservation' && o.reservationId ? [o.reservationId] : [],
			),
		),
	]
	const reservations = reservationIds.length
		? await tx
				.select()
				.from(rsvReservations)
				.where(inArray(rsvReservations.id, reservationIds))
				.all()
		: []
	const guestIds = canReadGuest
		? [...new Set(reservations.map((r) => r.guestId))]
		: []
	const guests = guestIds.length
		? await tx
				.select({
					id: rsvGuests.id,
					firstName: rsvGuests.firstName,
					lastName: rsvGuests.lastName,
				})
				.from(rsvGuests)
				.where(inArray(rsvGuests.id, guestIds))
				.all()
		: []
	const guestById = new Map(guests.map((g) => [g.id, g]))
	const reservationById = new Map(reservations.map((r) => [r.id, r]))

	const occupants: SeatOccupant[] = []
	const seenReservations = new Set<string>()
	for (const occ of occupancies) {
		if (occ.kind === 'reservation' && occ.reservationId) {
			if (seenReservations.has(occ.reservationId)) continue
			seenReservations.add(occ.reservationId)
			const row = reservationById.get(occ.reservationId)
			const guest = row ? guestById.get(row.guestId) : undefined
			occupants.push({
				kind: 'reservation',
				reservationId: occ.reservationId,
				confirmationCode: row?.confirmationCode ?? null,
				status: row?.status ?? null,
				partySize: row?.partySize ?? null,
				startAt: row?.startAt ?? occ.startAt,
				endAt: row?.endAt ?? occ.endAt,
				tableIds: occupancies
					.filter((o) => o.reservationId === occ.reservationId)
					.map((o) => o.tableId),
				guestName: guest
					? `${guest.firstName} ${guest.lastName}`.trim() || null
					: null,
			})
		} else {
			occupants.push({
				kind: occ.kind === 'hold' ? 'hold' : 'block',
				reservationId: null,
				confirmationCode: null,
				status: null,
				partySize: null,
				startAt: occ.startAt,
				endAt: occ.endAt,
				tableIds: [occ.tableId],
				guestName: null,
			})
		}
	}
	return { occupants, reservations }
}

function availableResolutions(occupants: readonly SeatOccupant[]) {
	const reservationsOnly = occupants.every((o) => o.kind === 'reservation')
	const swappable =
		reservationsOnly &&
		occupants.every((o) => !UNSWAPPABLE_STATUSES.has(o.status ?? ''))
	return [
		...(swappable ? (['swap'] as const) : []),
		...(reservationsOnly ? (['move'] as const) : []),
		'overbook' as const,
	]
}

/**
 * Builds the `onOccupied` hook for a waitlist seat. Without a resolution it
 * refuses with 409 and names the occupant; `swap` unseats a not-yet-arrived
 * occupant (a waitlist party has no table to trade) and `move` re-seats the
 * occupant on a free table. Both reuse `assignReservationTables` inside the
 * walk-in's transaction, so a failure anywhere rolls the whole seat back.
 */
export function waitlistOccupiedHandler(params: {
	orgId: string
	actorId: string
	resolution?: Exclude<WaitlistSeatResolution, 'overbook'>
	moveToTableIds?: string[]
	canReadGuest: boolean
	moves: ReservationMoveReport[]
}) {
	return async (tx: ReservationWriteTx, info: WalkInOccupiedInfo) => {
		const { occupants, reservations } = await describeOccupants(
			tx,
			info.occupancies,
			params.canReadGuest,
		)
		const resolutions = availableResolutions(occupants)
		const { resolution } = params
		if (!resolution) {
			throw conflict(
				'table_occupied',
				'The table is occupied for this party’s time',
				{ occupant: occupants[0], occupants, resolutions },
			)
		}
		if (!resolutions.includes(resolution)) {
			const blockedByHoldOrBlock = occupants.some(
				(o) => o.kind !== 'reservation',
			)
			throw conflict(
				blockedByHoldOrBlock ? 'table_blocked' : 'swap_target_seated',
				blockedByHoldOrBlock
					? 'The table is blocked or held during this window'
					: 'Cannot swap with an arrived or seated party',
				{ occupant: occupants[0], occupants, resolutions },
			)
		}
		if (params.moveToTableIds?.length && occupants.length !== 1) {
			throw badRequest(
				'move_target_ambiguous',
				'moveToTableIds needs exactly one occupant',
			)
		}

		for (const occupant of occupants) {
			const row = reservations.find((r) => r.id === occupant.reservationId)!
			let toTableIds: string[] = []
			let comboId: string | null = null
			if (resolution === 'move') {
				if (params.moveToTableIds?.length) {
					toTableIds = [...new Set(params.moveToTableIds)]
					if (toTableIds.some((id) => info.tableIds.includes(id))) {
						throw badRequest(
							'invalid_move_target',
							'The occupant cannot move onto the table being seated',
						)
					}
				} else {
					const state = await loadLocationSchedulingState(
						tx,
						info.locationId,
						info.businessDate,
					)
					const incoming: AssignBookingRecord = {
						id: 'waitlist-seat',
						partySize: info.partySize,
						localStartMin: row.localStartMin,
						startAt: info.startAt,
						endAt: info.endAt,
						tableIds: info.tableIds,
						combinationId: null,
						status: 'seated',
						tableLocked: true,
						overbook: false,
						channel: 'host',
						serviceId: null,
					}
					const found = assignTables({
						partySize: row.partySize,
						startAt: row.startAt,
						endAt: row.endAt,
						localStartMin: row.localStartMin,
						channel: 'host',
						serviceId: row.serviceId,
						areaId: row.areaPrefStrict ? row.areaPrefId : null,
						tables: state.engineTables,
						areas: state.engineAreas,
						combinations: state.engineCombos,
						serviceAvailability: state.engineServiceAvail,
						pacingRules: [],
						bookings: [
							...state.buildEngineBookings(new Set([row.id])),
							incoming,
						],
						holds: state.engineHolds,
						blocks: state.engineBlocks,
						nowMs: Date.now(),
						assignmentFreezeMin: 0,
						skipPacing: true,
					})
					if (!found.assigned) {
						throw conflict(
							'no_move_target',
							'No other table is free for the party on that table',
							{ occupant },
						)
					}
					toTableIds = [...found.tableIds]
					comboId = found.combinationId ?? null
				}
			}
			await assignReservationTables({
				orgId: params.orgId,
				reservationId: row.id,
				actorId: params.actorId,
				input: { tableIds: toTableIds, comboId },
			})
			params.moves.push({
				reservationId: row.id,
				bookingId: row.id,
				fromTableIds: occupant.tableIds,
				toTableIds,
				toCombinationId: comboId,
			})
			await tx.insert(rsvAuditLog).values({
				id: `aud_${randomUUID()}`,
				at: Date.now(),
				actorKind: 'operator',
				actorId: params.actorId,
				locationId: info.locationId,
				action: 'waitlist.seat_resolution',
				entityType: 'reservation',
				entityId: row.id,
				changes: {
					resolution,
					fromTableIds: occupant.tableIds,
					toTableIds,
					seatedTableIds: info.tableIds,
				},
			})
		}
	}
}
