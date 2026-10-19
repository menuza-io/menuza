import { randomUUID } from 'node:crypto'
import {
	customerPaymentMethods,
	customerRefreshTokens,
	customers,
	customerSubscriptions,
	getTenantDbOrgId,
	journeyRuns,
	journeyStepExecutions,
	marketingMessages,
	restaurantOrders,
	rsvAuditLog,
	rsvDayVersions,
	rsvGuestNotes,
	rsvGuests,
	rsvGuestTags,
	rsvHolds,
	rsvMessages,
	rsvNotifyRequests,
	rsvPayments,
	rsvReservationEvents,
	rsvReservations,
	rsvTableOccupancies,
	rsvWaitlistEntries,
	shopOrders,
	websiteFormSubmissions,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	eq,
	inArray,
	or,
	sql,
	type AnyColumn,
	type SQL,
} from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { badRequest, HttpError, notFound } from '../lib/http.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import {
	CANCELLABLE_FUTURE_STATUSES,
	collectMergedGuestIds,
	notifyGuestBeforeErasure,
	OPEN_NOTIFY_STATUSES,
	OPEN_WAITLIST_STATUSES,
	serializeGuestRow,
	type DbOrTx,
} from './rsv-guest-service.ts'

/**
 * ONE erasure flow for a person (ADR 048, "Single erasure").
 *
 * A person is the set of rows that identify the same human in the regional
 * tenant DB: the `rsv_guests` row(s) (with every guest merged into it), the
 * `customers` row linked to them (`customer_id` or `marketing_customer_id`)
 * or owning their phone, and the orders, calls, messages, waitlist and
 * notify rows that carry the same phone, email or customer id. The identity
 * set is grown to a fixed point (a guest found by phone brings its customer
 * link, and so on), so erasing from either side finds the same set.
 *
 * Everything runs in one regional write transaction (`withSetupWrite`), except
 * two things that need I/O outside the database and so run first: the
 * cancellation notice to a guest with an upcoming booking, and voice recording
 * deletion. Both are idempotent, and a failed recording deletion stops the
 * erasure before any row is touched so it can be retried.
 *
 * Idempotent and safe to re-run: a second run finds nothing left to match and
 * changes nothing (no extra audit entry).
 */

type Identity = {
	guestIds: string[]
	customerIds: string[]
	phones: string[]
	emails: string[]
}

export type ErasePersonTarget = { guestId?: string; customerId?: string }

export type ErasePersonResult = {
	erased: true
	/** Nothing identified the person any more: the call changed nothing. */
	alreadyErased: boolean
	cancelledFutureReservations: number
	guestsErased: number
	customersErased: number
	ordersScrubbed: number
	waitlistEntriesScrubbed: number
	notifyRequestsScrubbed: number
	voice: {
		callsDeleted: number
		requestsDeleted: number
		smsLogsDeleted: number
	}
	/** The serialized, anonymized guest when the target was a guest. */
	guest: ReturnType<typeof serializeGuestRow> | null
}

const MAX_IDENTITY_ROUNDS = 8
/** Chunk size for updates that bind many values besides the id list. */
const HEAVY_SET_CHUNK = 50

function clean(values: Array<string | null | undefined>): string[] {
	return values.filter((v): v is string => typeof v === 'string' && v !== '')
}

async function resolveIdentity(
	db: DbOrTx,
	target: ErasePersonTarget,
): Promise<Identity> {
	const guestIds = new Set<string>()
	const customerIds = new Set<string>()
	const phones = new Set<string>()
	const emails = new Set<string>()

	const addGuestChain = async (id: string) => {
		for (const merged of await collectMergedGuestIds(db, id)) {
			guestIds.add(merged)
		}
	}

	if (target.guestId) await addGuestChain(target.guestId)
	if (target.customerId) customerIds.add(target.customerId)

	for (let round = 0; round < MAX_IDENTITY_ROUNDS; round++) {
		const before = guestIds.size + customerIds.size + phones.size + emails.size

		if (guestIds.size > 0) {
			const rows = await queryInChunks([...guestIds], (chunk) =>
				db
					.select({
						customerId: rsvGuests.customerId,
						marketingCustomerId: rsvGuests.marketingCustomerId,
						phone: rsvGuests.phoneE164,
						email: rsvGuests.emailNorm,
						mergedIntoId: rsvGuests.mergedIntoId,
					})
					.from(rsvGuests)
					.where(inArray(rsvGuests.id, chunk))
					.all(),
			)
			for (const row of rows) {
				for (const id of clean([row.customerId, row.marketingCustomerId])) {
					customerIds.add(id)
				}
				for (const phone of clean([row.phone])) phones.add(phone)
				for (const email of clean([row.email])) emails.add(email)
				// The survivor of a merge holds this person's reservations now.
				if (row.mergedIntoId && !guestIds.has(row.mergedIntoId)) {
					await addGuestChain(row.mergedIntoId)
				}
			}
		}

		if (customerIds.size > 0) {
			const rows = await queryInChunks([...customerIds], (chunk) =>
				db
					.select({ phone: customers.phone, email: customers.email })
					.from(customers)
					.where(inArray(customers.id, chunk))
					.all(),
			)
			for (const row of rows) {
				for (const phone of clean([row.phone])) phones.add(phone)
				for (const email of clean([row.email])) emails.add(email.toLowerCase())
			}
			const linked = await queryInChunks([...customerIds], (chunk) =>
				db
					.select({ id: rsvGuests.id })
					.from(rsvGuests)
					.where(
						or(
							inArray(rsvGuests.customerId, chunk),
							inArray(rsvGuests.marketingCustomerId, chunk),
						),
					)
					.all(),
			)
			for (const row of linked) {
				if (!guestIds.has(row.id)) await addGuestChain(row.id)
			}
		}

		if (phones.size > 0) {
			const byPhone = await queryInChunks([...phones], (chunk) =>
				db
					.select({ id: rsvGuests.id })
					.from(rsvGuests)
					.where(inArray(rsvGuests.phoneE164, chunk))
					.all(),
			)
			for (const row of byPhone) {
				if (!guestIds.has(row.id)) await addGuestChain(row.id)
			}
			const customersByPhone = await queryInChunks([...phones], (chunk) =>
				db
					.select({ id: customers.id })
					.from(customers)
					.where(inArray(customers.phone, chunk))
					.all(),
			)
			for (const row of customersByPhone) customerIds.add(row.id)
		}

		const after = guestIds.size + customerIds.size + phones.size + emails.size
		if (after === before) break
	}

	return {
		guestIds: [...guestIds],
		customerIds: [...customerIds],
		phones: [...phones],
		emails: [...emails],
	}
}

function sqlList(values: readonly string[]) {
	return sql.join(
		values.map((v) => sql`${v}`),
		sql`, `,
	)
}

/** Ids of rows in a table matched by guest id, phone or email, in chunks. */
async function idsMatching(
	identity: Identity,
	run: (
		kind: 'guest' | 'phone' | 'email',
		chunk: string[],
	) => PromiseLike<Array<{ id: string }>>,
): Promise<string[]> {
	const ids = new Set<string>()
	const pairs: Array<['guest' | 'phone' | 'email', string[]]> = [
		['guest', identity.guestIds],
		['phone', identity.phones],
		['email', identity.emails],
	]
	for (const [kind, values] of pairs) {
		if (values.length === 0) continue
		const rows = await queryInChunks(values, (chunk) => run(kind, chunk))
		for (const row of rows) ids.add(row.id)
	}
	return [...ids]
}

export async function erasePerson(
	db: TenantDatabase,
	target: ErasePersonTarget,
	opts: { actorId: string; now?: number },
): Promise<ErasePersonResult> {
	if (!target.guestId && !target.customerId) {
		throw badRequest('invalid_erase_call', 'guestId or customerId is required')
	}
	const now = opts.now ?? Date.now()
	const orgId = getTenantDbOrgId(db)

	if (target.guestId) {
		const existing = await db
			.select({ id: rsvGuests.id })
			.from(rsvGuests)
			.where(eq(rsvGuests.id, target.guestId))
			.get()
		if (!existing) throw notFound('Guest not found')
	}

	// Phase 1 (outside the transaction): the identity as it is now.
	const preview = await resolveIdentity(db, target)

	// The cancellation notice needs the contact data, so it goes out first; a
	// failed send never blocks the erasure.
	await notifyGuestBeforeErasure(db, preview.guestIds, now)

	// Voice calls: recordings live in object storage, so they are deleted before
	// the rows that point at them. Rows are kept if a deletion fails.
	const voice = { callsDeleted: 0, requestsDeleted: 0, smsLogsDeleted: 0 }
	if (orgId) {
		const { eraseCallerVoiceData } = await import('../routes/voice.ts')
		const voiceTargets: Array<{ phone?: string; customerId?: string }> = [
			...preview.phones.map((phone) => ({ phone })),
			...preview.customerIds.map((customerId) => ({ customerId })),
		]
		for (const voiceTarget of voiceTargets) {
			const result = await eraseCallerVoiceData(db, orgId, voiceTarget)
			if ('error' in result) {
				throw new HttpError(
					502,
					'recording_delete_failed',
					'A call recording could not be deleted; nothing else was erased',
				)
			}
			voice.callsDeleted += result.callsDeleted
			voice.requestsDeleted += result.requestsDeleted
			voice.smsLogsDeleted += result.smsLogsDeleted
		}
	}

	// Phase 2: one serialized regional transaction.
	return withSetupWrite(
		db,
		async (tx) => {
			const identity = await resolveIdentity(tx, target)
			const { guestIds, customerIds, phones, emails } = identity

			const guestRows = await queryInChunks(guestIds, (chunk) =>
				tx.select().from(rsvGuests).where(inArray(rsvGuests.id, chunk)).all(),
			)
			const newlyErasedGuests = guestRows.filter((g) => g.erasedAt === null)
			const customerRows = await queryInChunks(customerIds, (chunk) =>
				tx
					.select({ id: customers.id })
					.from(customers)
					.where(inArray(customers.id, chunk))
					.all(),
			)

			// ---- Guest rows ----------------------------------------------------
			await forEachInChunks(guestIds, async (chunk) => {
				await tx
					.delete(rsvGuestNotes)
					.where(inArray(rsvGuestNotes.guestId, chunk))
				await tx
					.delete(rsvGuestTags)
					.where(inArray(rsvGuestTags.guestId, chunk))
			})
			await forEachInChunks(
				newlyErasedGuests.map((g) => g.id),
				(chunk) =>
					tx
						.update(rsvGuests)
						.set({
							firstName: 'Erased',
							lastName: 'guest',
							phoneE164: null,
							emailNorm: null,
							allergyNotes: null,
							customerId: null,
							marketingCustomerId: null,
							erasedAt: now,
							updatedAt: now,
							version: sql`${rsvGuests.version} + 1`,
						})
						.where(inArray(rsvGuests.id, chunk)),
				HEAVY_SET_CHUNK,
			)
			// Already-erased rows keep their erasedAt; make sure no link or
			// contact survives on any row of the set (idempotent re-run).
			await forEachInChunks(
				guestRows.filter((g) => g.erasedAt !== null).map((g) => g.id),
				(chunk) =>
					tx
						.update(rsvGuests)
						.set({
							phoneE164: null,
							emailNorm: null,
							allergyNotes: null,
							customerId: null,
							marketingCustomerId: null,
						})
						.where(inArray(rsvGuests.id, chunk)),
				HEAVY_SET_CHUNK,
			)

			// ---- Reservations --------------------------------------------------
			const guestReservations = await queryInChunks(guestIds, (chunk) =>
				tx
					.select()
					.from(rsvReservations)
					.where(inArray(rsvReservations.guestId, chunk))
					.all(),
			)

			let cancelledFutureCount = 0
			const affectedDayKeys = new Set<string>()
			for (const r of guestReservations) {
				if (CANCELLABLE_FUTURE_STATUSES.has(r.status)) {
					await tx
						.update(rsvTableOccupancies)
						.set({ active: false })
						.where(
							and(
								eq(rsvTableOccupancies.reservationId, r.id),
								eq(rsvTableOccupancies.active, true),
							),
						)
					await tx
						.update(rsvReservations)
						.set({
							status: 'cancelled',
							cancelledAt: now,
							cancelledBy: 'restaurant',
							cancelReason: 'guest_erased',
							dietaryNotes: null,
							guestRequests: null,
							staffNotes: null,
							client: null,
							ipHash: null,
							customerId: null,
							manageTokenVersion: r.manageTokenVersion + 1,
							version: r.version + 1,
							updatedAt: now,
						})
						.where(eq(rsvReservations.id, r.id))
					await tx.insert(rsvReservationEvents).values({
						id: `rev_${randomUUID()}`,
						reservationId: r.id,
						at: now,
						actorKind: 'system',
						actorId: opts.actorId,
						type: 'cancelled',
						fromStatus: r.status,
						toStatus: 'cancelled',
						data: { redacted: true },
					})
					cancelledFutureCount += 1
					affectedDayKeys.add(`${r.locationId}::${r.businessDate}`)
				} else {
					await tx
						.update(rsvReservations)
						.set({
							dietaryNotes: null,
							guestRequests: null,
							staffNotes: null,
							client: null,
							ipHash: null,
							customerId: null,
							manageTokenVersion: r.manageTokenVersion + 1,
							updatedAt: now,
						})
						.where(eq(rsvReservations.id, r.id))
				}
			}
			// Reservations booked while signed in as the customer.
			await forEachInChunks(customerIds, (chunk) =>
				tx
					.update(rsvReservations)
					.set({ customerId: null })
					.where(inArray(rsvReservations.customerId, chunk)),
			)

			for (const key of affectedDayKeys) {
				const [locId, bDate] = key.split('::')
				if (!locId || !bDate) continue
				await tx
					.insert(rsvDayVersions)
					.values({
						locationId: locId,
						businessDate: bDate,
						version: 1,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [rsvDayVersions.locationId, rsvDayVersions.businessDate],
						set: {
							version: sql`${rsvDayVersions.version} + 1`,
							updatedAt: now,
						},
					})
			}

			const resIds = guestReservations.map((r) => r.id)
			const holdIds = clean(guestReservations.map((r) => r.holdId))
			if (resIds.length > 0) {
				// Allowed by the rsv_reservation_events_no_update trigger.
				await forEachInChunks(resIds, (chunk) =>
					tx.run(
						sql`UPDATE rsv_reservation_events SET data = '{"redacted":true}' WHERE reservation_id IN (${sqlList(chunk)})`,
					),
				)
				await forEachInChunks(
					resIds,
					(chunk) =>
						tx
							.update(rsvPayments)
							.set({
								customerRef: null,
								paymentMethodRef: null,
								cardBrand: null,
								cardLast4: null,
								updatedAt: now,
							})
							.where(inArray(rsvPayments.reservationId, chunk)),
					HEAVY_SET_CHUNK,
				)
			}

			// Holds that became these bookings.
			const holdsByReservation =
				resIds.length > 0
					? await queryInChunks(resIds, (chunk) =>
							tx
								.select({ id: rsvHolds.id })
								.from(rsvHolds)
								.where(inArray(rsvHolds.reservationId, chunk))
								.all(),
						)
					: []
			const allHoldIds = [
				...new Set([...holdIds, ...holdsByReservation.map((h) => h.id)]),
			]
			// A converted hold cannot be updated (rsv_holds_single_conversion), so
			// the hold row is deleted: its token and address hashes go with it, and
			// its occupancy rows cascade.
			await forEachInChunks(allHoldIds, (chunk) =>
				tx.delete(rsvHolds).where(inArray(rsvHolds.id, chunk)),
			)
			await forEachInChunks(resIds, (chunk) =>
				tx
					.update(rsvReservations)
					.set({ holdId: null })
					.where(inArray(rsvReservations.id, chunk)),
			)

			// ---- Waitlist and notify requests (by guest, phone or email) ---------
			const waitlistIds = await idsMatching(identity, (kind, chunk) =>
				tx
					.select({ id: rsvWaitlistEntries.id })
					.from(rsvWaitlistEntries)
					.where(
						kind === 'guest'
							? inArray(rsvWaitlistEntries.guestId, chunk)
							: kind === 'phone'
								? inArray(rsvWaitlistEntries.phoneE164, chunk)
								: inArray(rsvWaitlistEntries.emailNorm, chunk),
					)
					.all(),
			)
			await forEachInChunks(
				waitlistIds,
				async (chunk) => {
					await tx
						.update(rsvWaitlistEntries)
						.set({
							displayName: 'Removed Guest',
							phoneE164: null,
							emailNorm: null,
							notes: null,
							ipHash: null,
						})
						.where(inArray(rsvWaitlistEntries.id, chunk))
					await tx
						.update(rsvWaitlistEntries)
						.set({
							status: 'cancelled',
							statusTokenVersion: sql`${rsvWaitlistEntries.statusTokenVersion} + 1`,
							version: sql`${rsvWaitlistEntries.version} + 1`,
						})
						.where(
							and(
								inArray(rsvWaitlistEntries.id, chunk),
								inArray(rsvWaitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
							),
						)
				},
				HEAVY_SET_CHUNK,
			)

			const notifyIds = await idsMatching(identity, (kind, chunk) =>
				tx
					.select({ id: rsvNotifyRequests.id })
					.from(rsvNotifyRequests)
					.where(
						kind === 'guest'
							? inArray(rsvNotifyRequests.guestId, chunk)
							: kind === 'phone'
								? inArray(rsvNotifyRequests.contactPhoneE164, chunk)
								: inArray(rsvNotifyRequests.contactEmailNorm, chunk),
					)
					.all(),
			)
			await forEachInChunks(
				notifyIds,
				async (chunk) => {
					await tx
						.update(rsvNotifyRequests)
						.set({
							contactPhoneE164: null,
							contactEmailNorm: null,
							ipHash: null,
						})
						.where(inArray(rsvNotifyRequests.id, chunk))
					await tx
						.update(rsvNotifyRequests)
						.set({
							status: 'cancelled',
							tokenVersion: sql`${rsvNotifyRequests.tokenVersion} + 1`,
						})
						.where(
							and(
								inArray(rsvNotifyRequests.id, chunk),
								inArray(rsvNotifyRequests.status, [...OPEN_NOTIFY_STATUSES]),
							),
						)
				},
				HEAVY_SET_CHUNK,
			)

			// ---- Messages: nothing queued for this person is ever sent ------------
			// `rsv_messages` holds no contact fields (the address is read from the
			// guest at send time and is gone now), so the erasure is stopping every
			// message still waiting or being retried.
			const stopMessages = (column: AnyColumn, ids: string[]) =>
				forEachInChunks(ids, (chunk) =>
					tx
						.update(rsvMessages)
						.set({ status: 'cancelled' })
						.where(
							and(
								inArray(column, chunk),
								inArray(rsvMessages.status, ['pending', 'sending']),
							),
						),
				)
			await stopMessages(rsvMessages.reservationId, resIds)
			await stopMessages(rsvMessages.waitlistEntryId, waitlistIds)
			await stopMessages(rsvMessages.notifyRequestId, notifyIds)

			// ---- Audit and event redaction ----------------------------------------
			// Allowed by the rsv_audit_log_no_update trigger.
			const entityIdsToRedact = [...guestIds, ...resIds, ...customerIds]
			await forEachInChunks(entityIdsToRedact, (chunk) =>
				tx.run(
					sql`UPDATE rsv_audit_log SET changes = '{"redacted":true}' WHERE entity_id IN (${sqlList(chunk)})`,
				),
			)

			// ---- Orders: contact and delivery fields go, totals stay ---------------
			const orderIds = new Set<string>()
			const collectOrders = async (
				values: string[],
				where: (chunk: string[]) => SQL | undefined,
			) => {
				if (values.length === 0) return
				const rows = await queryInChunks(values, (chunk) =>
					tx
						.select({ id: restaurantOrders.id })
						.from(restaurantOrders)
						.where(where(chunk))
						.all(),
				)
				for (const row of rows) orderIds.add(row.id)
			}
			await collectOrders(customerIds, (chunk) =>
				inArray(restaurantOrders.customerId, chunk),
			)
			await collectOrders(phones, (chunk) =>
				inArray(restaurantOrders.contactPhone, chunk),
			)
			await collectOrders(
				emails,
				(chunk) =>
					sql`lower(${restaurantOrders.contactEmail}) IN (${sqlList(chunk)})`,
			)
			await forEachInChunks(
				[...orderIds],
				(chunk) =>
					tx
						.update(restaurantOrders)
						.set({
							customerId: null,
							contactName: 'Erased customer',
							contactPhone: '',
							contactEmail: null,
							deliveryAddress: null,
							deliveryCity: null,
							deliveryUnit: null,
							deliveryNotes: null,
							deliveryPostalCode: null,
							deliveryLat: null,
							deliveryLng: null,
							receiptTokenHash: sql`'erased_' || lower(hex(randomblob(16)))`,
							paymentTokenHash: null,
							updatedAt: new Date(now),
						})
						.where(inArray(restaurantOrders.id, chunk)),
				HEAVY_SET_CHUNK,
			)

			// ---- Customer rows and everything keyed by them ------------------------
			// Deleted explicitly (not only by FK cascade) so a missing foreign-key
			// pragma can never leave a token, subscription or journey behind.
			await forEachInChunks(customerIds, async (chunk) => {
				await tx
					.delete(marketingMessages)
					.where(inArray(marketingMessages.customerId, chunk))
				await tx
					.delete(journeyStepExecutions)
					.where(inArray(journeyStepExecutions.customerId, chunk))
				await tx
					.delete(journeyRuns)
					.where(inArray(journeyRuns.customerId, chunk))
				await tx
					.delete(customerSubscriptions)
					.where(inArray(customerSubscriptions.customerId, chunk))
				await tx
					.delete(customerRefreshTokens)
					.where(inArray(customerRefreshTokens.customerId, chunk))
				await tx
					.delete(customerPaymentMethods)
					.where(inArray(customerPaymentMethods.customerId, chunk))
				await tx
					.update(shopOrders)
					.set({ customerId: null })
					.where(inArray(shopOrders.customerId, chunk))
				await tx.delete(customers).where(inArray(customers.id, chunk))
			})

			// ---- Website form submissions that typed this person's phone or email ---
			// Best effort: a submission is free text, so only an exact occurrence of
			// the stored phone or the (lower-cased) email can be recognised.
			let formSubmissionsRedacted = 0
			for (const needle of [...phones, ...emails]) {
				const redacted = await tx
					.update(websiteFormSubmissions)
					.set({ values: { redacted: true } })
					.where(
						sql`instr(lower(${websiteFormSubmissions.values}), ${needle.toLowerCase()}) > 0`,
					)
					.returning({ id: websiteFormSubmissions.id })
				formSubmissionsRedacted += redacted.length
			}

			const changed =
				newlyErasedGuests.length > 0 ||
				customerRows.length > 0 ||
				orderIds.size > 0 ||
				waitlistIds.length > 0 ||
				notifyIds.length > 0 ||
				formSubmissionsRedacted > 0 ||
				voice.callsDeleted > 0 ||
				voice.requestsDeleted > 0 ||
				voice.smsLogsDeleted > 0
			if (changed) {
				await tx.insert(rsvAuditLog).values({
					id: `aud_${randomUUID()}`,
					at: now,
					actorKind: 'operator',
					actorId: opts.actorId,
					locationId: guestReservations[0]?.locationId ?? null,
					action: 'guest.erase',
					entityType: 'guest',
					entityId: target.guestId ?? target.customerId!,
					changes: {
						erasedAt: now,
						cancelledFutureReservations: cancelledFutureCount,
						guestsErased: newlyErasedGuests.length,
						customersErased: customerRows.length,
					},
				})
			}

			const guest = target.guestId
				? await tx
						.select()
						.from(rsvGuests)
						.where(eq(rsvGuests.id, target.guestId))
						.get()
				: null

			return {
				erased: true as const,
				alreadyErased: !changed && cancelledFutureCount === 0,
				cancelledFutureReservations: cancelledFutureCount,
				guestsErased: newlyErasedGuests.length,
				customersErased: customerRows.length,
				ordersScrubbed: orderIds.size,
				waitlistEntriesScrubbed: waitlistIds.length,
				notifyRequestsScrubbed: notifyIds.length,
				voice,
				guest: guest ? serializeGuestRow(guest, []) : null,
			}
		},
		orgId ?? undefined,
	)
}
