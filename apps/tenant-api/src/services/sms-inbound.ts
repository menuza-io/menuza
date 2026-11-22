import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm'
import { type SmsKeyword, smsReplyText } from '@repo/common/sms-compliance'
import {
	customers,
	customerSubscriptions,
	getTenantDb,
	marketingMessages,
	runTenantTransaction,
	smsInboundEvents,
	type CustomerSubscriptionTopic,
} from '@repo/tenant-db'
import { forEachInChunks, queryInChunks } from '../lib/chunked-in.ts'
import { getOrgEmailSender } from '../lib/org-email-sender.ts'
import { isValidPhone, legacyPhoneForms, normalizePhone } from '../lib/phone.ts'
import { hmacHash } from '../lib/secrets.ts'
import { setCustomerSubscription } from './marketing-audience.ts'

/**
 * Inbound text replies (#75): STOP, START and HELP sent back to the shared
 * platform number. The webhook (`routes/sms-webhook.ts`) verifies the provider's
 * signature, then asks every organization on the node to apply the keyword to
 * its own region database. An organization acts only when it has texted that
 * phone in the last 90 days; the rest answer "no" and write nothing.
 *
 * This is the SAME consent write as the unsubscribe link and the profile
 * switch (`setCustomerSubscription`): one store, one writer.
 */

/** An organization that sent a marketing text to the phone within this window is matched. */
export const SMS_REPLY_MATCH_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
/** `sms_inbound_events` rows are pruned after this long. */
export const SMS_INBOUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** STOP ends every SMS topic: a text is a text, whatever it was about. */
const SMS_TOPICS: readonly CustomerSubscriptionTopic[] = [
	'marketing',
	'drops',
	'reservations',
]

export type InboundSmsInput = {
	providerMessageId: string
	/** The sender as the provider reports it. Never stored; only its HMAC. */
	from: string
	keyword: SmsKeyword
	now?: number
}

export type OrgSmsOutcome =
	| { status: 'no_match' }
	| { status: 'duplicate' }
	| {
			status: 'applied'
			organizationName: string | null
			/** Customers whose subscriptions changed. */
			customers: number
	  }

/** The customers of one organization that carry this phone. */
async function customersWithPhone(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	phone: string,
) {
	const forms = [phone, ...legacyPhoneForms(phone)]
	return queryInChunks(forms, (chunk) =>
		db
			.select({ id: customers.id })
			.from(customers)
			.where(inArray(customers.phone, chunk)),
	)
}

/** Which of these customers got a marketing text within the match window. */
async function messagedRecently(
	db: Awaited<ReturnType<typeof getTenantDb>>,
	customerIds: readonly string[],
	now: number,
) {
	if (customerIds.length === 0) return false
	const rows = await queryInChunks([...customerIds], (chunk) =>
		db
			.select({ id: marketingMessages.id })
			.from(marketingMessages)
			.where(
				and(
					eq(marketingMessages.channel, 'sms'),
					ne(marketingMessages.status, 'Failed'),
					gte(
						marketingMessages.sentAt,
						new Date(now - SMS_REPLY_MATCH_WINDOW_MS),
					),
					inArray(marketingMessages.customerId, chunk),
				),
			)
			.limit(1),
	)
	return rows.length > 0
}

/**
 * Applies one keyword to one organization. Idempotent per provider message id:
 * a retry finds its event row and does nothing. An organization that has not
 * texted the phone writes nothing at all (no event row either, so a flood of
 * replies from strangers leaves no trace in every database).
 */
export async function applyInboundSmsForOrg(
	orgId: string,
	input: InboundSmsInput,
): Promise<OrgSmsOutcome> {
	const now = input.now ?? Date.now()
	const phone = normalizePhone(input.from)
	if (!isValidPhone(phone)) return { status: 'no_match' }
	const db = await getTenantDb(orgId)

	const seen = await db
		.select({ id: smsInboundEvents.id })
		.from(smsInboundEvents)
		.where(eq(smsInboundEvents.providerMessageId, input.providerMessageId))
		.get()
	if (seen) return { status: 'duplicate' }

	const people = await customersWithPhone(db, phone)
	const ids = people.map((person) => person.id)
	if (ids.length === 0) return { status: 'no_match' }

	let changed = 0
	if (input.keyword === 'start') {
		// START brings back what a STOP reply took away, and nothing else: an
		// opt-out the guest or the restaurant made another way stays.
		const optedOut = await queryInChunks(ids, (chunk) =>
			db
				.select({
					customerId: customerSubscriptions.customerId,
					topic: customerSubscriptions.topic,
				})
				.from(customerSubscriptions)
				.where(
					and(
						inArray(customerSubscriptions.customerId, chunk),
						eq(customerSubscriptions.channel, 'sms'),
						eq(customerSubscriptions.unsubscribedSource, 'sms_reply'),
					),
				),
		)
		if (optedOut.length === 0) return { status: 'no_match' }
		await runTenantTransaction(db, async (tx) => {
			for (const row of optedOut) {
				await setCustomerSubscription(tx, {
					customerId: row.customerId,
					topic: row.topic,
					channel: 'sms',
					subscribed: true,
					source: 'sms_reply',
					now: new Date(now),
				})
			}
			await recordEvent(tx, input, phone, now)
		})
		changed = new Set(optedOut.map((row) => row.customerId)).size
	} else {
		// STOP and HELP need the organization to have texted this phone lately.
		if (!(await messagedRecently(db, ids, now))) return { status: 'no_match' }
		await runTenantTransaction(db, async (tx) => {
			if (input.keyword === 'stop') {
				// Every customer on a shared phone, every SMS topic.
				for (const customerId of ids) {
					for (const topic of SMS_TOPICS) {
						await setCustomerSubscription(tx, {
							customerId,
							topic,
							channel: 'sms',
							subscribed: false,
							source: 'sms_reply',
							unsubscribedSource: 'sms_reply',
							now: new Date(now),
						})
					}
				}
				changed = ids.length
			}
			await recordEvent(tx, input, phone, now)
		})
	}

	// Housekeeping: nothing older than the retention window is kept.
	await db
		.delete(smsInboundEvents)
		.where(
			lt(smsInboundEvents.receivedAt, new Date(now - SMS_INBOUND_RETENTION_MS)),
		)
		.run()

	const profile = await getOrgEmailSender(orgId).catch(() => null)
	return {
		status: 'applied',
		organizationName: profile?.organizationName ?? null,
		customers: changed,
	}
}

async function recordEvent(
	tx: Parameters<Parameters<typeof runTenantTransaction>[1]>[0],
	input: InboundSmsInput,
	phone: string,
	now: number,
) {
	// The unique provider message id is the backstop for two deliveries of the
	// same reply racing each other: the loser rolls the whole write back.
	await tx.insert(smsInboundEvents).values({
		providerMessageId: input.providerMessageId,
		phoneHash: hmacHash(`sms-inbound:${phone}`),
		keyword: input.keyword,
		receivedAt: new Date(now),
	})
}

/** The HMAC an inbound event stores for a phone, so erasure can find it. */
export function inboundPhoneHash(phone: string): string {
	return hmacHash(`sms-inbound:${phone}`)
}

/** Erasure: deletes the inbound reply events of these phone numbers. */
export async function eraseSmsInboundEvents(
	db: Parameters<typeof runTenantTransaction>[0],
	phones: readonly string[],
) {
	if (phones.length === 0) return
	const hashes = new Set<string>()
	for (const phone of phones) {
		hashes.add(inboundPhoneHash(phone))
		try {
			hashes.add(inboundPhoneHash(normalizePhone(phone)))
		} catch {
			// A stored form that does not normalise is hashed as it is, above.
		}
	}
	await forEachInChunks([...hashes], async (chunk) => {
		await db
			.delete(smsInboundEvents)
			.where(inArray(smsInboundEvents.phoneHash, chunk))
			.run()
	})
}

export type InboundFanOut = {
	/** Every organization on this node. */
	orgIds: readonly string[]
	/** Runs the keyword in one organization (in process, or in its Durable Object). */
	applyToOrg: (orgId: string, input: InboundSmsInput) => Promise<OrgSmsOutcome>
}

export type InboundResult = {
	/** The one reply text to send back, or null when nothing was done. */
	reply: string | null
	matched: number
	duplicates: number
	failed: number
}

/** Names of the organizations in a sentence: up to three, then "and others". */
export function joinOrganizationNames(names: readonly string[]): string {
	const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
	if (unique.length === 0) return ''
	if (unique.length === 1) return unique[0]!
	const shown = unique.slice(0, 3)
	return unique.length > 3
		? `${shown.join(', ')} and others`
		: `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/**
 * Applies a keyword across the node and builds the single reply. The reply is
 * built only from organizations that acted just now: a retried webhook
 * (everything a duplicate) answers nothing, so the guest never gets two
 * confirmations. An organization that fails is counted and logged by id; the
 * rest still act, and the webhook answers 500 so the provider retries it.
 */
export async function applyInboundSms(
	fanOut: InboundFanOut,
	input: InboundSmsInput,
): Promise<InboundResult> {
	const result: InboundResult = {
		reply: null,
		matched: 0,
		duplicates: 0,
		failed: 0,
	}
	const names: string[] = []
	await forEachInChunks([...fanOut.orgIds], async (chunk) => {
		await Promise.all(
			chunk.map(async (orgId) => {
				try {
					const outcome = await fanOut.applyToOrg(orgId, input)
					if (outcome.status === 'applied') {
						result.matched++
						names.push(outcome.organizationName ?? '')
					} else if (outcome.status === 'duplicate') {
						result.duplicates++
					}
				} catch (error) {
					result.failed++
					console.error('Inbound text could not be applied', {
						orgId,
						reason: error instanceof Error ? error.name : 'unknown',
					})
				}
			}),
		)
	})
	if (result.matched > 0) {
		result.reply = smsReplyText(input.keyword, joinOrganizationNames(names))
	}
	return result
}
