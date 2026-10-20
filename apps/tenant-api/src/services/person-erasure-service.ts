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
	runTenantTransaction,
	shopOrders,
	voiceCalls,
	websiteFormSubmissions,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'

/**
 * ONE erasure flow for a person.
 *
 * A person is a `customers` row, the phone and email on it, and every row in
 * the regional tenant database that identifies the same human: sessions,
 * subscriptions, saved cards, journey runs and messages (all keyed by the
 * customer id), orders and voice calls linked to them, and the calls, call
 * requests and texts that carry their phone. Website form submissions are
 * free-form, so a submission is redacted when a field of its parsed JSON holds
 * the phone or the email as a whole token (case-insensitive): "please call
 * +1555..." counts, but `sal@x.com` is not an occurrence of `al@x.com` and a
 * longer number is not an occurrence of a shorter one. A person who wrote
 * their details in another format (spaces, a different country form) is not
 * recognised: redaction is best effort.
 *
 * The identity (customer ids, phones, emails) is resolved ONCE, before
 * anything is deleted, and that same identity drives the voice phase and the
 * transaction. Everything in the database runs in one regional transaction.
 * Voice data runs first because call recordings live in object storage and
 * must be deleted before the rows that point at them; a failed recording
 * deletion stops the erasure before any row is touched.
 *
 * Recoverable: before anything is deleted an "erasure started" row (ids and
 * counts, no personal data) is committed with `incomplete: 1`. If a phase
 * fails the row stays, with the voice counts so far, so the partial erasure is
 * on record; retrying the same call is safe (the customer row still exists),
 * picks that row up again and adds its counts. On success the row is completed
 * in the same transaction as the deletes.
 *
 * Idempotent: a second run after success finds nothing left to match and
 * changes nothing (no extra log entry).
 *
 * `person-erasure-pii-columns.test.ts` fails when a tenant table gets a
 * personal-looking column that this flow neither erases nor explains.
 */

export class PersonErasureError extends Error {
	constructor(
		readonly status: 400 | 502,
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'PersonErasureError'
	}
}

export type ErasePersonResult = {
	erased: true
	/** Nothing identified the person any more: the call changed nothing. */
	alreadyErased: boolean
	customersErased: number
	ordersUnlinked: number
	formSubmissionsRedacted: number
	voice: {
		callsDeleted: number
		requestsDeleted: number
		smsLogsDeleted: number
	}
}

type Identity = { customerIds: string[]; phones: string[]; emails: string[] }

function clean(values: Array<string | null | undefined>): string[] {
	return values.filter((v): v is string => typeof v === 'string' && v !== '')
}

async function resolveIdentity(
	db: TenantDatabase | TenantTransaction,
	customerId: string,
): Promise<Identity> {
	const customerIds = new Set<string>([customerId])
	const phones = new Set<string>()
	const emails = new Set<string>()

	const [row] = await db
		.select({ phone: customers.phone, email: customers.email })
		.from(customers)
		.where(eq(customers.id, customerId))
		.limit(1)
	for (const phone of clean([row?.phone])) phones.add(phone)
	for (const email of clean([row?.email])) emails.add(email.toLowerCase())

	// `customers.phone` is unique, so another row with this phone is the same
	// person under an older id (a stale import, say): erase it as well.
	if (phones.size > 0) {
		const samePhone = await queryInChunks([...phones], (chunk) =>
			db
				.select({ id: customers.id, email: customers.email })
				.from(customers)
				.where(inArray(customers.phone, chunk)),
		)
		for (const match of samePhone) {
			customerIds.add(match.id)
			for (const email of clean([match.email])) emails.add(email.toLowerCase())
		}
	}

	return {
		customerIds: [...customerIds],
		phones: [...phones],
		emails: [...emails],
	}
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
	tx: TenantTransaction,
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
	target: { customerId: string },
	opts: { actorId: string; now?: number },
): Promise<ErasePersonResult> {
	if (!target.customerId) {
		throw new PersonErasureError(400, 'invalid_erase_call', 'customerId needed')
	}
	const now = opts.now ?? Date.now()
	const orgId = getTenantDbOrgId(db)

	// The identity as it is now, resolved once for every phase.
	const identity = await resolveIdentity(db, target.customerId)
	const present = await queryInChunks(identity.customerIds, (chunk) =>
		db
			.select({ id: customers.id })
			.from(customers)
			.where(inArray(customers.id, chunk)),
	)

	// "Erasure started": committed before anything is deleted, so a failure in
	// any later phase leaves a record. Skipped when there is no customer row
	// (a repeat run after success), which keeps repeats out of the log.
	let logId: string | null = null
	let carried: Record<string, number> = {}
	if (present.length > 0) {
		// A retry continues the row a failed attempt left behind.
		const [previous] = await db
			.select()
			.from(personErasureLog)
			.where(
				and(
					eq(personErasureLog.subjectId, target.customerId),
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
					subjectId: target.customerId,
					counts: { incomplete: 1 },
				})
				.returning({ id: personErasureLog.id })
			logId = started!.id
		}
	}
	const recordProgress = async (counts: Record<string, number>) => {
		if (!logId) return
		await db
			.update(personErasureLog)
			.set({ counts: { incomplete: 1, ...counts } })
			.where(eq(personErasureLog.id, logId))
			.catch(() => {})
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
				...identity.phones.map((phone) => ({ phone })),
				...identity.customerIds.map((customerId) => ({ customerId })),
			]
			for (const voiceTarget of voiceTargets) {
				const result = await eraseCallerVoiceData(db, orgId, voiceTarget)
				if ('error' in result) {
					throw new PersonErasureError(
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
	} catch (error) {
		await recordProgress(voiceCounts())
		throw error
	}

	// Phase 2: one regional transaction, with the identity from above.
	try {
		return await runTenantTransaction(db, async (tx) => {
			const { customerIds } = identity

			const existing = await queryInChunks(customerIds, (chunk) =>
				tx
					.select({ id: customers.id })
					.from(customers)
					.where(inArray(customers.id, chunk)),
			)

			// Orders keep their totals for the books; only the link to the person
			// goes (the FK would null it on delete, this does not rely on the
			// foreign-key pragma).
			const linkedOrders = await queryInChunks(customerIds, (chunk) =>
				tx
					.select({ id: shopOrders.id })
					.from(shopOrders)
					.where(inArray(shopOrders.customerId, chunk)),
			)

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

			// Best effort: only a field whose whole value is the stored phone or
			// the email can be recognised.
			const formSubmissionsRedacted = await redactFormSubmissions(tx, identity)

			const changed =
				existing.length > 0 ||
				formSubmissionsRedacted > 0 ||
				voice.callsDeleted > 0 ||
				voice.requestsDeleted > 0 ||
				voice.smsLogsDeleted > 0 ||
				logId !== null
			if (changed) {
				// The record names the operator and the opaque id of the erased
				// customer (whose row is gone) and counts: no phone, email or name.
				const counts = {
					customers: existing.length,
					ordersUnlinked: linkedOrders.length,
					formSubmissionsRedacted,
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
						subjectId: target.customerId,
						counts,
					})
				}
			}

			return {
				erased: true as const,
				alreadyErased: !changed,
				customersErased: existing.length,
				ordersUnlinked: linkedOrders.length,
				formSubmissionsRedacted,
				voice,
			}
		})
	} catch (error) {
		await recordProgress(voiceCounts())
		throw error
	}
}
