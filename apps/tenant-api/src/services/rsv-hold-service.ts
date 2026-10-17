import { randomUUID } from 'node:crypto'
import { type BookingChannel } from '@repo/reservations'
import {
	getTenantDb,
	rsvHolds,
	rsvTableOccupancies,
	type RsvHoldSource,
} from '@repo/tenant-db'
import { and, eq, gt, sql } from 'drizzle-orm'
import { HttpError } from '../lib/http.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	loadPublicEngineState,
	OTHER_DATE_LOOKAHEAD_DAYS,
	OTHER_DATE_LOOKBEHIND_DAYS,
	otherDateAlternatives,
	sameDayAlternatives,
	searchPublicDay,
	toPublicSlot,
	uniqueSlotsByTime,
	type PublicEngineState,
} from './rsv-public-engine.ts'
import {
	type AvailableSlot,
	addDays,
	type SearchAvailabilityResult,
} from '@repo/reservations'

export const MAX_ACTIVE_HOLDS_PER_ORG = 300

export type PublicSlotRequest = {
	date: string
	localMin: number
	partySize: number
	serviceId?: string | null
}

export type PublicAlternatives = {
	sameDay: ReturnType<typeof toPublicSlot>[]
	otherDates: Array<{ date: string; firstLocalMin: number }>
}

export function newOccupancyId(): string {
	return `occ_${randomUUID()}`
}

/** Load window that covers same-day and nearby-date alternatives. */
export function alternativesWindow(date: string) {
	return {
		fromDate: addDays(date, -OTHER_DATE_LOOKBEHIND_DAYS),
		toDate: addDays(date, OTHER_DATE_LOOKAHEAD_DAYS),
	}
}

export function buildAlternatives(
	state: PublicEngineState,
	result: SearchAvailabilityResult,
	params: { date: string; localMin: number; partySize: number; now: number },
): PublicAlternatives {
	return {
		sameDay: sameDayAlternatives(
			uniqueSlotsByTime(result.slots),
			params.localMin,
		).map(toPublicSlot),
		otherDates: otherDateAlternatives(state, {
			businessDate: params.date,
			partySize: params.partySize,
			now: params.now,
			preferredSlotMin: params.localMin,
		}),
	}
}

export function slotUnavailable(alternatives?: PublicAlternatives): HttpError {
	return new HttpError(
		409,
		'slot_unavailable',
		undefined,
		alternatives ? { alternatives } : undefined,
	)
}

export function channelFor(
	source: RsvHoldSource | 'web' | 'native',
): BookingChannel {
	return source === 'native' ? 'native' : 'online'
}

export async function insertOccupancyRows(
	tx: DbOrTx,
	params: {
		locationId: string
		kind: 'hold' | 'reservation'
		ownerId: string
		tableIds: readonly string[]
		startAt: number
		endAt: number
		resetBufferMin: (tableId: string) => number
		now: number
		overbook?: boolean
	},
) {
	for (const tableId of params.tableIds) {
		await tx.insert(rsvTableOccupancies).values({
			id: newOccupancyId(),
			locationId: params.locationId,
			tableId,
			kind: params.kind,
			reservationId: params.kind === 'reservation' ? params.ownerId : null,
			holdId: params.kind === 'hold' ? params.ownerId : null,
			startAt: params.startAt,
			endAt: params.endAt + params.resetBufferMin(tableId) * 60_000,
			active: true,
			overbook: params.overbook ?? false,
			createdAt: params.now,
		})
	}
}

export async function deactivateOccupancies(
	tx: DbOrTx,
	owner: { holdId?: string; reservationId?: string },
) {
	if (owner.holdId) {
		await tx
			.update(rsvTableOccupancies)
			.set({ active: false })
			.where(
				and(
					eq(rsvTableOccupancies.holdId, owner.holdId),
					eq(rsvTableOccupancies.active, true),
				),
			)
	}
	if (owner.reservationId) {
		await tx
			.update(rsvTableOccupancies)
			.set({ active: false })
			.where(
				and(
					eq(rsvTableOccupancies.reservationId, owner.reservationId),
					eq(rsvTableOccupancies.active, true),
				),
			)
	}
}

export type CreatedHold = {
	holdId: string
	expiresAt: number
	now: number
	locationId: string
	slot: {
		date: string
		localMin: number
		partySize: number
		serviceId: string | null
	}
}

/**
 * Takes a live capacity hold. The hold row and its table occupancy rows are
 * written in the same transaction that re-runs the engine, so two guests can
 * never hold the last table. `replaceHash` releases the caller's previous hold
 * in that transaction, which makes the old seat count when the new one is
 * evaluated, and keeps the old hold if the new slot is refused.
 */
export async function createHold(params: {
	orgId: string
	locationId: string
	slot: PublicSlotRequest
	tokenHash: string
	replaceTokenHash?: string | null
	source: 'web' | 'native'
	ipHash: string
	now?: number
}): Promise<CreatedHold> {
	const now = params.now ?? Date.now()
	const { slot } = params
	return withReservationWrite(
		{
			orgId: params.orgId,
			locationId: params.locationId,
			dates: slot.date,
			now,
		},
		async (tx, helpers) => {
			if (params.replaceTokenHash) {
				const previous = await tx
					.select()
					.from(rsvHolds)
					.where(
						and(
							eq(rsvHolds.tokenHash, params.replaceTokenHash),
							eq(rsvHolds.status, 'active'),
						),
					)
					.get()
				if (previous) {
					await deactivateOccupancies(tx, { holdId: previous.id })
					await tx
						.update(rsvHolds)
						.set({ status: 'released' })
						.where(eq(rsvHolds.id, previous.id))
					helpers.markAffectedDate(previous.locationId, previous.businessDate)
				}
			}

			const active = await tx
				.select({ n: sql<number>`count(*)` })
				.from(rsvHolds)
				.where(and(eq(rsvHolds.status, 'active'), gt(rsvHolds.expiresAt, now)))
				.get()
			if ((active?.n ?? 0) >= MAX_ACTIVE_HOLDS_PER_ORG) {
				throw new HttpError(429, 'rate_limited', undefined, {
					reason: 'holds_exhausted',
				})
			}

			const window = alternativesWindow(slot.date)
			const state = await loadPublicEngineState(tx, {
				locationId: params.locationId,
				...window,
				now,
			})
			if (!state) throw new HttpError(404, 'not_found')

			const result = searchPublicDay(state, {
				businessDate: slot.date,
				partySize: slot.partySize,
				now,
				preferredSlotMin: slot.localMin,
				channel: channelFor(params.source),
			})
			if (result.status === 'disabled') throw new HttpError(404, 'not_found')
			if (result.status === 'party_out_of_bounds') {
				throw new HttpError(400, 'party_size_invalid')
			}
			if (result.status === 'large_party') {
				throw new HttpError(409, 'large_party')
			}

			const match = result.slots.find(
				(s: AvailableSlot) =>
					s.slotMin === slot.localMin &&
					(!slot.serviceId || s.serviceId === slot.serviceId),
			)
			if (!match) {
				throw slotUnavailable(
					buildAlternatives(state, result, {
						date: slot.date,
						localMin: slot.localMin,
						partySize: slot.partySize,
						now,
					}),
				)
			}

			const endAt = match.startAt + match.turnMin * 60_000
			const expiresAt = now + state.settings.holdMinutes * 60_000
			const holdId = `hld_${randomUUID()}`
			await tx.insert(rsvHolds).values({
				id: holdId,
				locationId: params.locationId,
				tokenHash: params.tokenHash,
				businessDate: slot.date,
				localStartMin: match.slotMin,
				startAt: match.startAt,
				endAt,
				partySize: slot.partySize,
				serviceId: match.serviceId,
				comboId: match.combinationId,
				source: params.source,
				status: 'active',
				expiresAt,
				ipHash: params.ipHash,
				createdAt: now,
			})
			await insertOccupancyRows(tx, {
				locationId: params.locationId,
				kind: 'hold',
				ownerId: holdId,
				tableIds: match.tableIds,
				startAt: match.startAt,
				endAt,
				resetBufferMin: (id) => state.tableById.get(id)?.resetBufferMin ?? 0,
				now,
			})

			return {
				holdId,
				expiresAt,
				now,
				locationId: params.locationId,
				slot: {
					date: slot.date,
					localMin: match.slotMin,
					partySize: slot.partySize,
					serviceId: match.serviceId,
				},
			}
		},
	)
}

export async function findActiveHoldByTokenHash(
	orgId: string,
	tokenHash: string,
	now = Date.now(),
) {
	const db = await getTenantDb(orgId)
	return (
		(await db
			.select()
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.tokenHash, tokenHash),
					eq(rsvHolds.status, 'active'),
					gt(rsvHolds.expiresAt, now),
				),
			)
			.get()) ?? null
	)
}

export async function releaseHoldByTokenHash(
	orgId: string,
	tokenHash: string,
	now = Date.now(),
): Promise<boolean> {
	const db = await getTenantDb(orgId)
	const existing = await db
		.select()
		.from(rsvHolds)
		.where(
			and(eq(rsvHolds.tokenHash, tokenHash), eq(rsvHolds.status, 'active')),
		)
		.get()
	if (!existing) return false
	return withReservationWrite(
		{
			orgId,
			locationId: existing.locationId,
			dates: existing.businessDate,
			now,
		},
		async (tx) => {
			const current = await tx
				.select()
				.from(rsvHolds)
				.where(eq(rsvHolds.id, existing.id))
				.get()
			if (!current || current.status !== 'active') return false
			await deactivateOccupancies(tx, { holdId: current.id })
			await tx
				.update(rsvHolds)
				.set({ status: 'released' })
				.where(eq(rsvHolds.id, current.id))
			return true
		},
	)
}
