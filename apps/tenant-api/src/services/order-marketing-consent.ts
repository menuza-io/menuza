import { and, eq, isNull, or } from 'drizzle-orm'

import {
	type OrderMarketingConsent,
	type OrderMarketingConsentResult,
} from '@repo/common/marketing-consent'
import {
	customers,
	customerSubscriptions,
	getTenantDb,
	type TenantTransaction,
} from '@repo/tenant-db'
import { runInBackground } from '../lib/background.ts'
import {
	emailConsentHash,
	setCustomerSubscription,
} from './marketing-audience.ts'
import { requestSubscriptionConfirmation } from './subscription-confirmation.ts'

/** Checkout boxes subscribe to broadcasts, like the profile switch. */
export const ORDER_CONSENT_TOPIC = 'marketing' as const

/** The emailed double opt-in to send once the order has committed. */
export type OrderConsentConfirmation = {
	customerId: string
	email: string
	name: string
}

/**
 * Records the marketing boxes a signed-in customer ticked at checkout, inside
 * the order's own transaction, so a refused or rolled-back order records
 * nothing. The caller passes only a customer proven by a customer token.
 *
 * Only a ticked box acts: an unticked one never unsubscribes. Texts need a
 * verified phone on the customer (the OTP sign-in is the double opt-in) and
 * are active at once. Email uses the address on file; when there is none, the
 * address typed at checkout (`contactEmail`) is saved onto the customer in
 * this same transaction and used (an address on file is never overwritten
 * from checkout). Either way it is unverified: the subscription stays pending
 * until its owner follows the emailed link; a subscription already confirmed
 * for that address, or already pending, is left as it is (the same rules as
 * the customer's own `PUT /subscriptions`). Returns null when no box was
 * ticked.
 */
export async function recordOrderMarketingConsentInTx(
	tx: TenantTransaction,
	params: {
		customerId: string
		consent: OrderMarketingConsent
		now: Date
		/** The address typed at checkout (`contact.email`), already trimmed. */
		contactEmail?: string | null
	},
): Promise<{
	result: OrderMarketingConsentResult
	confirmation: OrderConsentConfirmation | null
} | null> {
	const { customerId, consent, now } = params
	if (!consent.email && !consent.sms) return null
	const customer = await tx
		.select({
			name: customers.name,
			email: customers.email,
			phone: customers.phone,
			phoneVerified: customers.phoneVerified,
		})
		.from(customers)
		.where(eq(customers.id, customerId))
		.get()
	const result: OrderMarketingConsentResult = {}
	let confirmation: OrderConsentConfirmation | null = null

	if (consent.sms) {
		if (customer?.phone && customer.phoneVerified) {
			await setCustomerSubscription(tx, {
				customerId,
				topic: ORDER_CONSENT_TOPIC,
				channel: 'sms',
				subscribed: true,
				source: 'checkout',
				now,
				consentTextVersion: consent.textVersion,
			})
			result.sms = 'subscribed'
		} else {
			result.sms = 'skipped'
		}
	}

	if (consent.email) {
		let email = customer?.email?.trim()
		const typed = params.contactEmail?.trim()
		if (customer && !email && typed) {
			// Only fills an empty address: a profile email is never replaced.
			await tx
				.update(customers)
				.set({ email: typed, updatedAt: now })
				.where(
					and(
						eq(customers.id, customerId),
						or(isNull(customers.email), eq(customers.email, '')),
					),
				)
				.run()
			email = typed
		}
		if (!customer || !email) {
			result.email = 'skipped'
		} else {
			const existing = await tx
				.select({
					unsubscribedAt: customerSubscriptions.unsubscribedAt,
					confirmedEmailHash: customerSubscriptions.confirmedEmailHash,
				})
				.from(customerSubscriptions)
				.where(
					and(
						eq(customerSubscriptions.customerId, customerId),
						eq(customerSubscriptions.topic, ORDER_CONSENT_TOPIC),
						eq(customerSubscriptions.channel, 'email'),
					),
				)
				.get()
			const active = existing && !existing.unsubscribedAt
			if (active && existing.confirmedEmailHash === emailConsentHash(email)) {
				result.email = 'subscribed'
			} else {
				if (!active) {
					await setCustomerSubscription(tx, {
						customerId,
						topic: ORDER_CONSENT_TOPIC,
						channel: 'email',
						subscribed: true,
						source: 'checkout',
						now,
						confirmedEmail: null,
						consentTextVersion: consent.textVersion,
					})
				}
				result.email = 'pending'
				confirmation = { customerId, email, name: customer.name }
			}
		}
	}
	return { result, confirmation }
}

const inFlight = new Set<Promise<void>>()

/**
 * After the order commits, emails the confirmation link for a pending
 * checkout opt-in (the shared double opt-in, throttled per address). Runs in
 * the background: the order response never waits for the mail, and a failed
 * send only logs ids (`requestSubscriptionConfirmation` never throws).
 */
export function queueOrderConsentConfirmation(
	orgId: string,
	confirmation: OrderConsentConfirmation,
): void {
	const work = (async () => {
		try {
			const db = await getTenantDb(orgId)
			await requestSubscriptionConfirmation(db, {
				orgId,
				customerId: confirmation.customerId,
				topic: ORDER_CONSENT_TOPIC,
				email: confirmation.email,
				name: confirmation.name,
			})
		} catch (error) {
			console.error('Checkout consent confirmation failed', {
				orgId,
				customerId: confirmation.customerId,
				error: error instanceof Error ? error.name : 'unknown',
			})
		}
	})().finally(() => {
		inFlight.delete(work)
	})
	inFlight.add(work)
	runInBackground(work)
}

/** Resolves once every queued confirmation email has finished (tests). */
export async function orderConsentConfirmationsIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}
