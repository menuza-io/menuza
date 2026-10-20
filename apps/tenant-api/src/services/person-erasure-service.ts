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
import { eq, inArray, sql } from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'

/**
 * ONE erasure flow for a person.
 *
 * A person is a `customers` row, the phone and email on it, and every row in
 * the regional tenant database that identifies the same human: sessions,
 * subscriptions, saved cards, journey runs and messages (all keyed by the
 * customer id), orders and voice calls linked to them, and the calls, call
 * requests and texts that carry their phone. Website form submissions are free
 * text, so they are matched on an exact occurrence of the phone or email.
 *
 * Everything in the database runs in one regional transaction. Voice data runs
 * first because call recordings live in object storage and must be deleted
 * before the rows that point at them; a failed recording deletion stops the
 * erasure before any row is touched, so it can be retried.
 *
 * Idempotent: a second run finds nothing left to match and changes nothing
 * (no extra log entry).
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

	// Phase 1 (outside the transaction): the identity as it is now, then voice
	// data, whose recordings are deleted before the rows that point at them.
	const preview = await resolveIdentity(db, target.customerId)
	const voice = { callsDeleted: 0, requestsDeleted: 0, smsLogsDeleted: 0 }
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

	// Phase 2: one regional transaction.
	return runTenantTransaction(db, async (tx) => {
		const { customerIds, phones, emails } = await resolveIdentity(
			tx,
			target.customerId,
		)

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
			await tx.delete(journeyRuns).where(inArray(journeyRuns.customerId, chunk))
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
			existing.length > 0 ||
			formSubmissionsRedacted > 0 ||
			voice.callsDeleted > 0 ||
			voice.requestsDeleted > 0 ||
			voice.smsLogsDeleted > 0
		if (changed) {
			// The record names the operator and the opaque id of the erased
			// customer (whose row is gone) and counts: no phone, email or name.
			await tx.insert(personErasureLog).values({
				at: new Date(now),
				actorId: opts.actorId,
				subjectId: target.customerId,
				counts: {
					customers: existing.length,
					ordersUnlinked: linkedOrders.length,
					formSubmissionsRedacted,
					voiceCalls: voice.callsDeleted,
					voiceRequests: voice.requestsDeleted,
					voiceTexts: voice.smsLogsDeleted,
				},
			})
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
}
