import { randomUUID } from 'node:crypto'
import { addDays, localToInstant } from '@repo/reservations'
import {
	getTenantDb,
	rsvAreas,
	rsvDayVersions,
	rsvGuests,
	rsvLocationSettings,
	rsvNotifyRequests,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { badRequest, conflict, notFound } from '../lib/http.ts'
import {
	deriveNotifyToken,
	parseNotifyTokenId,
	verifyNotifyToken,
} from '../lib/reservations-public-auth.ts'
import {
	hashIdempotencyPayload,
	withReservationWrite,
	type ReservationWriteTx,
} from '../lib/reservations-write.ts'
import { getLocationBusinessDate } from './rsv-business-date.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import { enqueueNotifyMessage } from './rsv-message-queue.ts'
import { normalizePublicPhone } from './rsv-public-booking-service.ts'
import {
	loadPublicEngineState,
	searchPublicDay,
	type PublicEngineState,
} from './rsv-public-engine.ts'

export type NotifyMatchResult = {
	notified: number
	expired: number
	needsFollowUp: boolean
	nextDueAt: number | null
}

const MINUTE = 60_000
export const NOTIFY_MAX_ACTIVE_PER_CONTACT = 5
export const NOTIFY_BATCH_SIZE = 3
export const NOTIFY_BATCH_WINDOW_MS = 15 * MINUTE
export const NOTIFY_REPEAT_SUPPRESSION_MS = 120 * MINUTE

const OPEN_STATUSES = ['active', 'notified'] as const

export type NotifyRequestRow = typeof rsvNotifyRequests.$inferSelect

// ---------------------------------------------------------------------------
// Create / cancel
// ---------------------------------------------------------------------------

export type NotifyRequestInput = {
	locationId: string
	businessDate: string
	partySize: number
	fromLocalMin: number
	toLocalMin: number
	areaPrefId?: string | null
	phone?: string | null
	email?: string | null
	locale?: string
}

export async function createNotifyRequest(params: {
	orgId: string
	idempotencyKey: string
	input: NotifyRequestInput
	ipHash?: string | null
}): Promise<{ requestId: string; cancelToken: string }> {
	const { input } = params
	if (input.toLocalMin < input.fromLocalMin) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'toLocalMin', code: 'invalid' }],
		})
	}
	const rawPhone = input.phone?.trim() || null
	const phone = rawPhone ? normalizePublicPhone(rawPhone) : null
	if (rawPhone && !phone) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'phone', code: 'invalid' }],
		})
	}
	const email = input.email?.trim().toLowerCase() || null
	if (!phone && !email) {
		throw badRequest('invalid', undefined, {
			issues: [{ path: 'contact', code: 'required' }],
		})
	}

	const db = await getTenantDb(params.orgId)
	const now = Date.now()
	return withReservationWrite<{ requestId: string; cancelToken: string }>(
		{
			orgId: params.orgId,
			locationId: input.locationId,
			dates: input.businessDate,
			now,
			scope: 'notify_me',
			idempotencyKey: params.idempotencyKey,
			requestHash: hashIdempotencyPayload({
				...input,
				phone,
				email,
				areaPrefId: input.areaPrefId ?? null,
			}),
		},
		async (tx, helpers) => {
			const settings = await tx
				.select()
				.from(rsvLocationSettings)
				.where(eq(rsvLocationSettings.locationId, input.locationId))
				.get()
			if (!settings) throw notFound('location_not_found')

			const today = await getLocationBusinessDate(
				db,
				input.locationId,
				helpers.now,
			)
			const lastDate = addDays(today, settings.horizonDays)
			if (input.businessDate < today || input.businessDate > lastDate) {
				throw badRequest('invalid', undefined, {
					issues: [{ path: 'date', code: 'out_of_range' }],
				})
			}
			const end = localToInstant(
				input.businessDate,
				input.toLocalMin,
				settings.timeZone,
			)
			if (!end || end.instantMs <= helpers.now) {
				throw badRequest('invalid', undefined, {
					issues: [{ path: 'toLocalMin', code: 'in_the_past' }],
				})
			}
			if (input.areaPrefId) {
				const area = await tx
					.select({ id: rsvAreas.id })
					.from(rsvAreas)
					.where(
						and(
							eq(rsvAreas.id, input.areaPrefId),
							eq(rsvAreas.locationId, input.locationId),
						),
					)
					.get()
				if (!area) {
					throw badRequest('invalid', undefined, {
						issues: [{ path: 'areaId', code: 'invalid' }],
					})
				}
			}

			const contactMatch = or(
				...(phone ? [eq(rsvNotifyRequests.contactPhoneE164, phone)] : []),
				...(email ? [eq(rsvNotifyRequests.contactEmailNorm, email)] : []),
			)
			const open = await tx
				.select({ n: sql<number>`count(*)` })
				.from(rsvNotifyRequests)
				.where(
					and(
						contactMatch,
						eq(rsvNotifyRequests.status, 'active'),
						sql`${rsvNotifyRequests.expiresAt} > ${helpers.now}`,
					),
				)
				.get()
			if ((open?.n ?? 0) >= NOTIFY_MAX_ACTIVE_PER_CONTACT) {
				throw conflict('too_many_active_requests')
			}

			const requestId = `nfy_${randomUUID()}`
			await tx.insert(rsvNotifyRequests).values({
				id: requestId,
				locationId: input.locationId,
				businessDate: input.businessDate,
				partySize: input.partySize,
				fromLocalMin: input.fromLocalMin,
				toLocalMin: input.toLocalMin,
				areaPrefId: input.areaPrefId ?? null,
				contactPhoneE164: phone,
				contactEmailNorm: email,
				locale: input.locale || 'en',
				status: 'active',
				expiresAt: end.instantMs,
				tokenVersion: 1,
				ipHash: params.ipHash ?? null,
				createdAt: helpers.now,
			})
			return {
				requestId,
				cancelToken: deriveNotifyToken(params.orgId, requestId, 1),
			}
		},
	)
}

/** Resolves a cancel token to its request; every failure is the same `null`. */
export async function findNotifyRequestByToken(
	orgId: string,
	token: string | null,
): Promise<NotifyRequestRow | null> {
	const id = parseNotifyTokenId(token)
	if (!token || !id) return null
	const db = await getTenantDb(orgId)
	const row = await db
		.select()
		.from(rsvNotifyRequests)
		.where(eq(rsvNotifyRequests.id, id))
		.get()
	if (!row) return null
	return verifyNotifyToken(orgId, row.id, row.tokenVersion, token) ? row : null
}

/**
 * Cancels the request the token names. Bumping `token_version` retires the
 * token, so a reuse is indistinguishable from a forged one.
 */
export async function cancelNotifyRequest(params: {
	orgId: string
	token: string
}): Promise<{ requestId: string } | null> {
	const found = await findNotifyRequestByToken(params.orgId, params.token)
	if (!found) return null
	return withReservationWrite<{ requestId: string } | null>(
		{ orgId: params.orgId, locationId: found.locationId },
		async (tx) => {
			const row = await tx
				.select()
				.from(rsvNotifyRequests)
				.where(eq(rsvNotifyRequests.id, found.id))
				.get()
			if (
				!row ||
				!verifyNotifyToken(params.orgId, row.id, row.tokenVersion, params.token)
			) {
				return null
			}
			if (row.status === 'active' || row.status === 'notified') {
				await tx
					.update(rsvNotifyRequests)
					.set({ status: 'cancelled', tokenVersion: row.tokenVersion + 1 })
					.where(eq(rsvNotifyRequests.id, row.id))
			} else {
				await tx
					.update(rsvNotifyRequests)
					.set({ tokenVersion: row.tokenVersion + 1 })
					.where(eq(rsvNotifyRequests.id, row.id))
			}
			return { requestId: row.id }
		},
	)
}

// ---------------------------------------------------------------------------
// Matching (runs inside the regional tick)
// ---------------------------------------------------------------------------

type DateKey = { locationId: string; businessDate: string }

export async function runNotifyMeMatching(
	orgId: string,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<NotifyMatchResult> {
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	return withReservationWrite<NotifyMatchResult>(
		{ orgId, db, now },
		async (tx, helpers) => {
			const result: NotifyMatchResult = {
				notified: 0,
				expired: 0,
				needsFollowUp: false,
				nextDueAt: null,
			}
			const followUp = (at: number) => {
				result.needsFollowUp = true
				result.nextDueAt =
					result.nextDueAt === null ? at : Math.min(result.nextDueAt, at)
			}

			const expired = await tx
				.update(rsvNotifyRequests)
				.set({
					status: 'expired',
					tokenVersion: sql`${rsvNotifyRequests.tokenVersion} + 1`,
				})
				.where(
					and(
						inArray(rsvNotifyRequests.status, [...OPEN_STATUSES]),
						sql`${rsvNotifyRequests.expiresAt} <= ${now}`,
					),
				)
				.returning({ id: rsvNotifyRequests.id })
			result.expired = expired.length

			const flagged = await tx
				.select()
				.from(rsvDayVersions)
				.where(isNotNull(rsvDayVersions.availabilityIncreasedAt))
				.all()

			const settingsCache = new Map<
				string,
				typeof rsvLocationSettings.$inferSelect | undefined
			>()
			const engineCache = new Map<string, PublicEngineState | null>()

			for (const day of flagged) {
				const date: DateKey = {
					locationId: day.locationId,
					businessDate: day.businessDate,
				}
				if (!settingsCache.has(date.locationId)) {
					settingsCache.set(
						date.locationId,
						await tx
							.select()
							.from(rsvLocationSettings)
							.where(eq(rsvLocationSettings.locationId, date.locationId))
							.get(),
					)
				}
				const settings = settingsCache.get(date.locationId)
				const requests = await tx
					.select()
					.from(rsvNotifyRequests)
					.where(
						and(
							eq(rsvNotifyRequests.locationId, date.locationId),
							eq(rsvNotifyRequests.businessDate, date.businessDate),
							inArray(rsvNotifyRequests.status, [...OPEN_STATUSES]),
						),
					)
					.all()
				// A party told once is left alone for a while, then offered the next opening.
				const pending = requests.filter(
					(r) =>
						r.status === 'active' ||
						(r.lastNotifiedAt ?? 0) <= now - NOTIFY_REPEAT_SUPPRESSION_MS,
				)
				if (!settings?.notifyMeEnabled || pending.length === 0) {
					await clearFlag(tx, date, day.availabilityIncreasedAt)
					continue
				}

				const stateKey = `${date.locationId}|${date.businessDate}`
				if (!engineCache.has(stateKey)) {
					engineCache.set(
						stateKey,
						await loadPublicEngineState(tx, {
							locationId: date.locationId,
							fromDate: date.businessDate,
							toDate: date.businessDate,
							now,
						}),
					)
				}
				const state = engineCache.get(stateKey)
				if (!state) {
					await clearFlag(tx, date, day.availabilityIncreasedAt)
					continue
				}

				const slotsByParty = new Map<
					number,
					ReturnType<typeof searchPublicDay>['slots']
				>()
				const slotsFor = (partySize: number) => {
					if (!slotsByParty.has(partySize)) {
						slotsByParty.set(
							partySize,
							searchPublicDay(state, {
								businessDate: date.businessDate,
								partySize,
								now,
							}).slots,
						)
					}
					return slotsByParty.get(partySize) ?? []
				}

				const notifiedNow = new Set<string>()
				let deferred = false
				const fifo = [...pending].sort(
					(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
				)
				const recentlyNotified = requests.filter(
					(r) =>
						r.lastNotifiedAt !== null &&
						r.lastNotifiedAt > now - NOTIFY_BATCH_WINDOW_MS,
				)

				const covers = (
					r: NotifyRequestRow,
					slot: { slotMin: number; areaId: string },
				) =>
					slot.slotMin >= r.fromLocalMin &&
					slot.slotMin <= r.toLocalMin &&
					(!r.areaPrefId || r.areaPrefId === slot.areaId)

				// Slots are distinct (time, area) openings; two parties never get
				// offered the same opening in the same batch beyond the cap.
				const openings = new Map<string, { slotMin: number; areaId: string }>()
				for (const r of fifo) {
					for (const slot of slotsFor(r.partySize)) {
						if (!covers(r, slot)) continue
						const key = `${slot.slotMin}|${slot.areaId}`
						openings.set(key, { slotMin: slot.slotMin, areaId: slot.areaId })
					}
				}

				for (const opening of [...openings.values()].sort(
					(a, b) => a.slotMin - b.slotMin,
				)) {
					const candidates = fifo.filter(
						(r) =>
							!notifiedNow.has(r.id) &&
							covers(r, opening) &&
							slotsFor(r.partySize).some(
								(s) =>
									s.slotMin === opening.slotMin && s.areaId === opening.areaId,
							),
					)
					if (candidates.length === 0) continue
					const gate = recentlyNotified.filter((r) => covers(r, opening))
					if (gate.length > 0) {
						const reopensAt =
							Math.max(...gate.map((r) => r.lastNotifiedAt ?? 0)) +
							NOTIFY_BATCH_WINDOW_MS
						followUp(reopensAt)
						deferred = true
						continue
					}
					const batch = candidates.slice(0, NOTIFY_BATCH_SIZE)
					for (const request of batch) {
						notifiedNow.add(request.id)
						recentlyNotified.push({ ...request, lastNotifiedAt: now })
						await tx
							.update(rsvNotifyRequests)
							.set({
								status: 'notified',
								notifiedCount: request.notifiedCount + 1,
								lastNotifiedAt: now,
								lastNotifiedSlotMin: opening.slotMin,
							})
							.where(eq(rsvNotifyRequests.id, request.id))
						await enqueueNotifyMessage(
							tx,
							{ orgId, now, afterCommit: helpers.afterCommit },
							{ requestId: request.id, milestone: request.notifiedCount + 1 },
						)
						result.notified += 1
					}
					if (candidates.length > batch.length) {
						followUp(now + NOTIFY_BATCH_WINDOW_MS)
						deferred = true
					}
				}

				// A party left over after this batch is offered the opening again once
				// the window passes, so the day keeps its flag until nobody is waiting.
				const stillWaiting = pending.some((r) => !notifiedNow.has(r.id))
				if (deferred && stillWaiting) continue
				await clearFlag(tx, date, day.availabilityIncreasedAt)
			}

			return result
		},
	)
}

async function clearFlag(
	tx: DbOrTx,
	date: DateKey,
	seenAt: number | null,
): Promise<void> {
	if (seenAt === null) return
	await tx
		.update(rsvDayVersions)
		.set({ availabilityIncreasedAt: null })
		.where(
			and(
				eq(rsvDayVersions.locationId, date.locationId),
				eq(rsvDayVersions.businessDate, date.businessDate),
				eq(rsvDayVersions.availabilityIncreasedAt, seenAt),
			),
		)
}

// ---------------------------------------------------------------------------
// Booking closes the loop
// ---------------------------------------------------------------------------

/**
 * A guest who books a day they were watching no longer needs the nudge. The
 * match is on the booking guest's own phone or email, so someone else's request
 * for the same day stays open.
 */
export async function markNotifyRequestsBooked(
	tx: ReservationWriteTx | TenantDatabase,
	input: {
		locationId: string
		businessDate: string
		guestId: string
		now: number
	},
): Promise<number> {
	const guest = await tx
		.select({
			phone: rsvGuests.phoneE164,
			email: rsvGuests.emailNorm,
		})
		.from(rsvGuests)
		.where(eq(rsvGuests.id, input.guestId))
		.get()
	if (!guest) return 0
	const contact = or(
		...(guest.phone
			? [eq(rsvNotifyRequests.contactPhoneE164, guest.phone)]
			: []),
		...(guest.email
			? [eq(rsvNotifyRequests.contactEmailNorm, guest.email)]
			: []),
	)
	if (!contact) return 0
	const updated = await tx
		.update(rsvNotifyRequests)
		.set({
			status: 'booked',
			guestId: input.guestId,
			tokenVersion: sql`${rsvNotifyRequests.tokenVersion} + 1`,
		})
		.where(
			and(
				eq(rsvNotifyRequests.locationId, input.locationId),
				eq(rsvNotifyRequests.businessDate, input.businessDate),
				inArray(rsvNotifyRequests.status, [...OPEN_STATUSES]),
				contact,
			),
		)
		.returning({ id: rsvNotifyRequests.id })
	return updated.length
}
