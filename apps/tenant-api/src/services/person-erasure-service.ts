import {
	customerPaymentMethods,
	customerRefreshTokens,
	customers,
	customerSubscriptions,
	getTenantDbOrgId,
	journeyRuns,
	journeyStepExecutions,
	marketingMessages,
	personErasureLog,
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
	voiceCalls,
	websiteFormSubmissions,
	type TenantDatabase,
} from '@repo/tenant-db'
import crypto from 'node:crypto'
import {
	and,
	eq,
	inArray,
	or,
	sql,
	type AnyColumn,
	type SQL,
	type SQLWrapper,
} from 'drizzle-orm'
import {
	forEachInChunks,
	inJsonList,
	queryInChunks,
} from '../lib/chunked-in.ts'
import { HttpError, notFound } from '../lib/http.ts'
import { legacyPhoneForms } from '../lib/phone.ts'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { handleCancellationPayments } from './rsv-payment-refunds.ts'
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
 * A person is the set of rows in the regional tenant database that identify the
 * same human: the `customers` row, the phone and email on it, the `rsv_guests`
 * row(s) (with every guest merged into it, linked by `customer_id` or
 * `marketing_customer_id` or carrying the same phone or email), sessions,
 * subscriptions, saved cards, journey runs and messages (all keyed by the
 * customer id), orders and voice calls linked to them, and the calls, call
 * requests, texts, bookings, waitlist and notify rows that carry their phone.
 * The identity set is grown to a fixed point (a guest found by phone brings
 * its customer link, and so on), so erasing from either side finds the same
 * set.
 *
 * Website form submissions are free-form, so a submission is redacted when a
 * field of its parsed JSON holds the phone or the email as a whole token
 * (case-insensitive): "please call +1555..." counts, but `sal@x.com` is not an
 * occurrence of `al@x.com` and a longer number is not an occurrence of a
 * shorter one. A person who wrote their details in another format (spaces, a
 * different country form) is not recognised: redaction is best effort.
 *
 * The identity (guest ids, customer ids, phones, emails) is resolved before
 * anything is deleted, and that same identity drives the notice, voice and
 * transaction phases. Everything in the database runs in one regional write
 * transaction (`withSetupWrite`, which is `runTenantTransaction` under the
 * organization's write lock). Two things need I/O outside the database and so
 * run first, both idempotent: the cancellation notice to a guest with an
 * upcoming booking (a failed send never blocks the erasure), and voice data
 * (call recordings live in object storage and must be deleted before the rows
 * that point at them; a failed recording deletion stops the erasure before any
 * row is touched).
 *
 * Recoverable: before anything is deleted an "erasure started" row (ids and
 * counts, no personal data) is committed with `incomplete: 1`. If a phase
 * fails the row stays, with the voice counts so far, so the partial erasure is
 * on record; retrying the same call is safe (the person's rows still exist),
 * picks that row up again and adds its counts. On success the row is
 * completed in the same transaction as the deletes.
 *
 * Idempotent: a second run after success finds nothing left to match and
 * changes nothing (no extra log entry, no extra audit entry).
 *
 * `person-erasure-pii-columns.test.ts` fails when a tenant table gets a
 * personal-looking column that this flow neither erases nor explains.
 */

export class PersonErasureError extends HttpError {
	constructor(
		status: 400 | 502,
		code: string,
		message: string,
		/** What was already erased when the call failed (counts only). */
		readonly erased?: Record<string, number>,
	) {
		super(status, code, message, erased ? { erased } : undefined)
		this.name = 'PersonErasureError'
	}
}

export type ErasePersonTarget = { guestId?: string; customerId?: string }

export type ErasePersonResult = {
	erased: true
	/** Nothing identified the person any more: the call changed nothing. */
	alreadyErased: boolean
	cancelledFutureReservations: number
	guestsErased: number
	customersErased: number
	ordersUnlinked: number
	formSubmissionsRedacted: number
	/** Present only when a restaurant order was scrubbed. */
	restaurantOrdersScrubbed?: number
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

type Identity = {
	guestIds: string[]
	customerIds: string[]
	phones: string[]
	emails: string[]
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
							// One parameter, so the statement stays under the 100 limit.
							inJsonList(rsvGuests.marketingCustomerId, chunk),
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
			// `customers.phone` is unique, so another row with this phone is the
			// same person under an older id (a stale import, say): erase it too.
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

/** SQL: a text column with the usual phone punctuation and spaces removed. */
function digitsOnly(column: SQLWrapper) {
	let expr: SQL = sql`${column}`
	for (const ch of [' ', '-', '(', ')', '+', '.', '/']) {
		expr = sql`replace(${expr}, ${ch}, '')`
	}
	return sql`replace(${expr}, char(160), '')`
}

/**
 * Every digits-only form a stored phone may be in: the E.164 digits, the
 * national forms numbers were stored in before region-aware normalisation
 * (`legacyPhoneForms`), and the `00` international prefix.
 */
function phoneMatchForms(phones: readonly string[]): string[] {
	const forms = new Set<string>()
	for (const phone of phones) {
		const digits = phone.replace(/\D/g, '')
		if (!digits) continue
		forms.add(digits)
		forms.add(`00${digits}`)
		for (const legacy of legacyPhoneForms(phone)) {
			const legacyDigits = legacy.replace(/\D/g, '')
			if (legacyDigits) forms.add(legacyDigits)
		}
	}
	return [...forms]
}

const EMAIL_CHAR = /[a-z0-9._%+\-@]/
const EMAIL_AFTER_CHAR = /[a-z0-9_\-@]/

/**
 * Whether `needle` occurs in `text` as a whole token: not glued to more of an
 * address (`sal@x.com` around `al@x.com`, `x.com.au` after `x.com`) or more
 * digits of a number. Both arguments are lower-case.
 */
export function containsAsToken(text: string, needle: string): boolean {
	if (!needle) return false
	const isEmail = needle.includes('@')
	for (
		let at = text.indexOf(needle);
		at !== -1;
		at = text.indexOf(needle, at + 1)
	) {
		const before = text[at - 1] ?? ''
		const after = text[at + needle.length] ?? ''
		const next = text[at + needle.length + 1] ?? ''
		const glued = isEmail
			? EMAIL_CHAR.test(before) ||
				EMAIL_AFTER_CHAR.test(after) ||
				(after === '.' && /[a-z0-9]/.test(next))
			: /\d/.test(before) || /\d/.test(after)
		if (!glued) return true
	}
	return false
}

/** Does a string anywhere in the parsed JSON hold `needle` as a token? */
function hasMatchingString(value: unknown, needle: string): boolean {
	if (typeof value === 'string')
		return containsAsToken(value.toLowerCase(), needle)
	if (Array.isArray(value))
		return value.some((v) => hasMatchingString(v, needle))
	if (value && typeof value === 'object') {
		return Object.values(value).some((v) => hasMatchingString(v, needle))
	}
	return false
}

async function redactFormSubmissions(
	tx: DbOrTx,
	identity: Identity,
): Promise<number> {
	const needles = new Set(
		[...identity.phones, ...identity.emails].map((n) => n.trim().toLowerCase()),
	)
	let redacted = 0
	for (const needle of needles) {
		// The substring test only narrows the candidates; the decision is the
		// token match on the parsed values below.
		const candidates = await tx
			.select({
				id: websiteFormSubmissions.id,
				values: websiteFormSubmissions.values,
			})
			.from(websiteFormSubmissions)
			.where(sql`instr(lower(${websiteFormSubmissions.values}), ${needle}) > 0`)
		const ids = candidates
			.filter((row) => hasMatchingString(row.values, needle))
			.map((row) => row.id)
		await forEachInChunks(ids, async (chunk) => {
			const rows = await tx
				.update(websiteFormSubmissions)
				.set({ values: { redacted: true } })
				.where(inArray(websiteFormSubmissions.id, chunk))
				.returning({ id: websiteFormSubmissions.id })
			redacted += rows.length
		})
	}
	return redacted
}

export async function erasePerson(
	db: TenantDatabase,
	target: ErasePersonTarget,
	opts: { actorId: string; now?: number },
): Promise<ErasePersonResult> {
	if (!target.guestId && !target.customerId) {
		throw new PersonErasureError(
			400,
			'invalid_erase_call',
			'guestId or customerId needed',
		)
	}
	const now = opts.now ?? Date.now()
	const orgId = getTenantDbOrgId(db)
	const subjectId = target.customerId ?? target.guestId!

	if (target.guestId) {
		const existing = await db
			.select({ id: rsvGuests.id })
			.from(rsvGuests)
			.where(eq(rsvGuests.id, target.guestId))
			.get()
		if (!existing) throw notFound('Guest not found')
	}

	// The identity as it is now, resolved before anything is changed.
	const preview = await resolveIdentity(db, target)
	const presentCustomers = await queryInChunks(preview.customerIds, (chunk) =>
		db
			.select({ id: customers.id })
			.from(customers)
			.where(inArray(customers.id, chunk))
			.all(),
	)
	const presentGuests = await queryInChunks(preview.guestIds, (chunk) =>
		db
			.select({ id: rsvGuests.id, erasedAt: rsvGuests.erasedAt })
			.from(rsvGuests)
			.where(inArray(rsvGuests.id, chunk))
			.all(),
	)

	// The cancellation notice needs the contact data, so it goes out first; a
	// failed send never blocks the erasure.
	await notifyGuestBeforeErasure(db, preview.guestIds, now)

	// "Erasure started": committed before anything is deleted, so a failure in
	// any later phase leaves a record. Skipped when nothing identifies the
	// person any more (a repeat run after success), which keeps repeats out of
	// the log.
	let logId: string | null = null
	let carried: Record<string, number> = {}
	if (
		presentCustomers.length > 0 ||
		presentGuests.some((guest) => guest.erasedAt === null)
	) {
		// A retry continues the row a failed attempt left behind.
		const [previous] = await db
			.select()
			.from(personErasureLog)
			.where(
				and(
					eq(personErasureLog.subjectId, subjectId),
					sql`json_extract(${personErasureLog.counts}, '$.incomplete') = 1`,
				),
			)
			.limit(1)
		if (previous) {
			logId = previous.id
			carried = previous.counts
		} else {
			const [started] = await db
				.insert(personErasureLog)
				.values({
					at: new Date(now),
					actorId: opts.actorId,
					subjectId,
					counts: { incomplete: 1 },
				})
				.returning({ id: personErasureLog.id })
			logId = started!.id
		}
	}
	const recordProgress = async (
		phase: 'voice' | 'transaction',
		counts: Record<string, number>,
	) => {
		if (!logId) return
		try {
			await db
				.update(personErasureLog)
				.set({ counts: { incomplete: 1, ...counts } })
				.where(eq(personErasureLog.id, logId))
		} catch (progressError) {
			// A failed progress write must not replace the error being thrown, but
			// it must leave a trace: the row still says only { incomplete: 1 }.
			// Ids and an error name and message only, never the person's data.
			console.error('Erasure progress not recorded', {
				logId,
				phase,
				error:
					progressError instanceof Error
						? { name: progressError.name, message: progressError.message }
						: { name: 'UnknownError', message: String(progressError) },
			})
		}
	}

	// Phase 1 (outside the transaction): voice data, whose recordings are
	// deleted before the rows that point at them.
	const voice = { callsDeleted: 0, requestsDeleted: 0, smsLogsDeleted: 0 }
	const voiceCounts = () => ({
		voiceCalls: voice.callsDeleted + (carried.voiceCalls ?? 0),
		voiceRequests: voice.requestsDeleted + (carried.voiceRequests ?? 0),
		voiceTexts: voice.smsLogsDeleted + (carried.voiceTexts ?? 0),
	})
	try {
		if (orgId) {
			// Imported lazily: the voice routes import the operator routes, which
			// import this service.
			const { eraseCallerVoiceData } = await import('../routes/voice.ts')
			const voiceTargets: Array<{ phone?: string; customerId?: string }> = [
				...preview.phones.map((phone) => ({ phone })),
				...preview.customerIds.map((customerId) => ({ customerId })),
			]
			for (const voiceTarget of voiceTargets) {
				const result = await eraseCallerVoiceData(db, orgId, voiceTarget)
				if ('error' in result) {
					// Earlier targets are already gone (and logged below); only the
					// person's other data is untouched. A retry continues from here.
					throw new PersonErasureError(
						502,
						'recording_delete_failed',
						'A call recording could not be deleted; earlier voice data may already be erased, retry to complete',
						voiceCounts(),
					)
				}
				voice.callsDeleted += result.callsDeleted
				voice.requestsDeleted += result.requestsDeleted
				voice.smsLogsDeleted += result.smsLogsDeleted
			}
		}
	} catch (error) {
		await recordProgress('voice', voiceCounts())
		throw error
	}

	// Phase 2: one serialized regional transaction, identity re-read inside it.
	try {
		return await withSetupWrite(
			db,
			async (tx) => {
				const identity = await resolveIdentity(tx, target)
				const { guestIds, customerIds, phones, emails } = identity

				const guestRows = await queryInChunks(guestIds, (chunk) =>
					tx.select().from(rsvGuests).where(inArray(rsvGuests.id, chunk)).all(),
				)
				const newlyErasedGuests = guestRows.filter((g) => g.erasedAt === null)
				const existing = await queryInChunks(customerIds, (chunk) =>
					tx
						.select({ id: customers.id })
						.from(customers)
						.where(inArray(customers.id, chunk))
						.all(),
				)

				// ---- Guest rows --------------------------------------------------
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

				// ---- Reservations ------------------------------------------------
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
							id: `rev_${crypto.randomUUID()}`,
							reservationId: r.id,
							at: now,
							actorKind: 'system',
							actorId: opts.actorId,
							type: 'cancelled',
							fromStatus: r.status,
							toStatus: 'cancelled',
							data: { redacted: true },
						})
						// The restaurant-side cancellation of a paid booking owes the
						// money back: same handling as an operator cancel (full refund
						// queued as a regional refund row + outbox command, unpaid
						// sessions closed, guarantees released). The provider is called
						// later through the outbox, never inside this write. Ids and
						// amounts only.
						if (!orgId) {
							// Never drop a refund silently: fail before anything commits.
							throw new Error('erasure cannot queue refunds without an org id')
						}
						await handleCancellationPayments(tx, {
							orgId,
							reservation: r,
							cancelledBy: 'restaurant',
							late: false,
							now,
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

				// ---- Waitlist and notify requests (by guest, phone or email) -------
				const waitlistIds = await idsMatching(identity, (kind, chunk) =>
					tx
						.select({ id: rsvWaitlistEntries.id })
						.from(rsvWaitlistEntries)
						.where(
							inArray(
								kind === 'guest'
									? rsvWaitlistEntries.guestId
									: kind === 'phone'
										? rsvWaitlistEntries.phoneE164
										: rsvWaitlistEntries.emailNorm,
								chunk,
							),
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
									inArray(rsvWaitlistEntries.status, [
										...OPEN_WAITLIST_STATUSES,
									]),
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
							inArray(
								kind === 'guest'
									? rsvNotifyRequests.guestId
									: kind === 'phone'
										? rsvNotifyRequests.contactPhoneE164
										: rsvNotifyRequests.contactEmailNorm,
								chunk,
							),
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

				// ---- Messages: nothing queued for this person is ever sent ----------
				// `rsv_messages` holds no contact fields (the address is read from the
				// guest at send time and is gone now), so the erasure is stopping
				// every message still waiting or being retried.
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

				// ---- Audit and event redaction --------------------------------------
				// Allowed by the rsv_audit_log_no_update trigger.
				const entityIdsToRedact = [...guestIds, ...resIds, ...customerIds]
				await forEachInChunks(entityIdsToRedact, (chunk) =>
					tx.run(
						sql`UPDATE rsv_audit_log SET changes = '{"redacted":true}' WHERE entity_id IN (${sqlList(chunk)})`,
					),
				)

				// ---- Orders ----------------------------------------------------------
				// Orders keep their totals for the books; only the link to the person
				// goes (the FK would null it on delete, this does not rely on the
				// foreign-key pragma).
				const linkedOrders = await queryInChunks(customerIds, (chunk) =>
					tx
						.select({ id: shopOrders.id })
						.from(shopOrders)
						.where(inArray(shopOrders.customerId, chunk)),
				)

				// Restaurant orders keep totals and lines for the books; everything
				// that identifies the person goes: contact, delivery address and
				// position, and the receipt and payment capability hashes (so an old
				// link stops working). Matched by customer id, and for guest orders
				// placed without an account by the stored phone or email, compared on
				// a normalised form: an email as typed ("Sal@Example.com") matches
				// case-insensitively, and a phone stored before region-aware
				// normalisation ("(555) 000-1111", a national form) matches on its
				// digits.
				const restaurantOrderIds = new Set<string>()
				const byCustomer = await queryInChunks(customerIds, (chunk) =>
					tx
						.select({ id: restaurantOrders.id })
						.from(restaurantOrders)
						.where(inArray(restaurantOrders.customerId, chunk)),
				)
				for (const row of byCustomer) restaurantOrderIds.add(row.id)
				// One bound parameter per list (a JSON array), whatever its size.
				const contactConditions = []
				const phoneForms = phoneMatchForms(phones)
				if (phoneForms.length > 0) {
					contactConditions.push(
						inJsonList(digitsOnly(restaurantOrders.contactPhone), phoneForms),
					)
				}
				const emailForms = emails
					.map((email) => email.trim().toLowerCase())
					.filter(Boolean)
				if (emailForms.length > 0) {
					contactConditions.push(
						inJsonList(
							sql`lower(trim(${restaurantOrders.contactEmail}))`,
							emailForms,
						),
					)
				}
				for (const condition of contactConditions) {
					const rows = await tx
						.select({ id: restaurantOrders.id })
						.from(restaurantOrders)
						.where(condition)
					for (const row of rows) restaurantOrderIds.add(row.id)
				}
				await forEachInChunks(
					[...restaurantOrderIds],
					(chunk) =>
						tx
							.update(restaurantOrders)
							.set({
								customerId: null,
								contactName: '',
								contactPhone: '',
								contactEmail: null,
								deliveryAddress: null,
								deliveryCity: null,
								deliveryUnit: null,
								deliveryNotes: null,
								deliveryPostalCode: null,
								deliveryLat: null,
								deliveryLng: null,
								receiptTokenHash: crypto.randomUUID(),
								paymentTokenHash: null,
							})
							.where(inArray(restaurantOrders.id, chunk)),
					HEAVY_SET_CHUNK,
				)
				const restaurantOrdersScrubbed = restaurantOrderIds.size

				// ---- Customer rows and everything keyed by them ----------------------
				// Deleted explicitly, not only by FK cascade, so a missing foreign-key
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
					await tx
						.update(voiceCalls)
						.set({ customerId: null })
						.where(inArray(voiceCalls.customerId, chunk))
					await tx.delete(customers).where(inArray(customers.id, chunk))
				})

				// Best effort: only a field holding the stored phone or the email as
				// a whole token can be recognised.
				const formSubmissionsRedacted = await redactFormSubmissions(
					tx,
					identity,
				)

				const changed =
					newlyErasedGuests.length > 0 ||
					existing.length > 0 ||
					restaurantOrdersScrubbed > 0 ||
					waitlistIds.length > 0 ||
					notifyIds.length > 0 ||
					formSubmissionsRedacted > 0 ||
					voice.callsDeleted > 0 ||
					voice.requestsDeleted > 0 ||
					voice.smsLogsDeleted > 0 ||
					logId !== null
				if (changed) {
					// The record names the operator and the opaque id of the erased
					// person (whose rows are gone) and counts: no phone, email or name.
					const counts = {
						customers: existing.length,
						guests: newlyErasedGuests.length,
						ordersUnlinked: linkedOrders.length,
						formSubmissionsRedacted,
						cancelledFutureReservations: cancelledFutureCount,
						waitlistEntriesScrubbed: waitlistIds.length,
						notifyRequestsScrubbed: notifyIds.length,
						...(restaurantOrdersScrubbed > 0
							? { restaurantOrdersScrubbed }
							: {}),
						...voiceCounts(),
					}
					if (logId) {
						await tx
							.update(personErasureLog)
							.set({ counts })
							.where(eq(personErasureLog.id, logId))
					} else {
						await tx.insert(personErasureLog).values({
							at: new Date(now),
							actorId: opts.actorId,
							subjectId,
							counts,
						})
					}
				}
				const guestsTouched =
					newlyErasedGuests.length > 0 ||
					waitlistIds.length > 0 ||
					notifyIds.length > 0 ||
					cancelledFutureCount > 0
				if (guestsTouched) {
					await tx.insert(rsvAuditLog).values({
						id: `aud_${crypto.randomUUID()}`,
						at: now,
						actorKind: 'operator',
						actorId: opts.actorId,
						locationId: guestReservations[0]?.locationId ?? null,
						action: 'guest.erase',
						entityType: 'guest',
						entityId: subjectId,
						changes: {
							erasedAt: now,
							cancelledFutureReservations: cancelledFutureCount,
							guestsErased: newlyErasedGuests.length,
							customersErased: existing.length,
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
					customersErased: existing.length,
					ordersUnlinked: linkedOrders.length,
					formSubmissionsRedacted,
					...(restaurantOrdersScrubbed > 0 ? { restaurantOrdersScrubbed } : {}),
					waitlistEntriesScrubbed: waitlistIds.length,
					notifyRequestsScrubbed: notifyIds.length,
					voice,
					guest: guest ? serializeGuestRow(guest, []) : null,
				}
			},
			orgId ?? undefined,
		)
	} catch (error) {
		await recordProgress('transaction', voiceCounts())
		throw error
	}
}
