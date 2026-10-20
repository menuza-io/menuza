import {
	customers,
	customerSubscriptions,
	type Customer,
	type CustomerSubscriptionChannel,
	type CustomerSubscriptionSource,
	type CustomerSubscriptionTopic,
	type TenantDatabase,
} from '@repo/tenant-db'
import { hmacHash } from '../lib/secrets.ts'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

export type BroadcastChannel = CustomerSubscriptionChannel
export type BroadcastAudience = 'all' | 'verified' | 'unverified'

/** Binds an email subscription to the address that was confirmed. */
export function emailConsentHash(email: string): string {
	return hmacHash(`email-consent:${email.trim().toLowerCase()}`)
}

/** The topic a broadcast campaign is sent under. */
export const BROADCAST_TOPIC: CustomerSubscriptionTopic = 'marketing'

/**
 * Who a broadcast campaign may be sent to.
 *
 * `customer_subscriptions` is the single marketing consent store: a customer
 * is in the audience only with an ACTIVE subscription (`unsubscribed_at IS
 * NULL`) for the campaign's channel and topic. Having a customer row, a
 * verified phone or an order is not consent. Texts additionally need a
 * verified phone (a number only counts once its owner proved control of it);
 * emails need an address the owner confirmed (`confirmed_email_hash` matches
 * the current address): a customer-typed address is only deliverable once its
 * owner followed the emailed confirmation link (double opt-in), and a changed
 * address must be confirmed again. The `audience` rule only narrows further.
 */
export async function loadBroadcastAudience(
	db: TenantDatabase,
	params: {
		channel: BroadcastChannel
		audience?: BroadcastAudience | string | null
		topics?: readonly CustomerSubscriptionTopic[] | null
	},
): Promise<Customer[]> {
	const topics = params.topics?.length ? [...params.topics] : [BROADCAST_TOPIC]
	const rows = await db
		.select({
			customer: customers,
			confirmedEmailHash: customerSubscriptions.confirmedEmailHash,
		})
		.from(customers)
		.innerJoin(
			customerSubscriptions,
			eq(customerSubscriptions.customerId, customers.id),
		)
		.where(
			and(
				eq(customerSubscriptions.channel, params.channel),
				isNull(customerSubscriptions.unsubscribedAt),
				// bounded: marketing topics are a small closed enum
				inArray(customerSubscriptions.topic, topics),
			),
		)
		.orderBy(asc(customers.id))
		.all()

	const byId = new Map<string, { customer: Customer; hashes: string[] }>()
	for (const row of rows) {
		const entry = byId.get(row.customer.id) ?? {
			customer: row.customer,
			hashes: [],
		}
		if (row.confirmedEmailHash) entry.hashes.push(row.confirmedEmailHash)
		byId.set(row.customer.id, entry)
	}
	let audience = [...byId.values()].map((entry) => entry.customer)
	if (params.channel === 'sms') {
		audience = audience.filter((c) => Boolean(c.phoneVerified) && c.phone)
	} else {
		audience = audience.filter((c) => {
			const email = c.email?.trim()
			return (
				Boolean(email) &&
				byId.get(c.id)!.hashes.includes(emailConsentHash(email!))
			)
		})
	}
	if (params.audience === 'verified') {
		audience = audience.filter((c) => Boolean(c.phoneVerified))
	} else if (params.audience === 'unverified') {
		audience = audience.filter((c) => !c.phoneVerified)
	}
	return audience
}

/**
 * Records a consent change for one customer, topic and channel. Opting out
 * keeps the row as the record; opting in again clears it. `source: 'import'`
 * is the path for backfilling consent a business already holds (for example
 * from a previous mailing list); only import addresses whose owners agreed.
 */
export async function setCustomerSubscription(
	db: TenantDatabase,
	params: {
		customerId: string
		topic: CustomerSubscriptionTopic
		channel: CustomerSubscriptionChannel
		subscribed: boolean
		source: CustomerSubscriptionSource
		now?: Date
		/**
		 * The address to bind an email subscription to as already confirmed.
		 * Default: the customer's current address for `operator` and `import`
		 * (someone vouching for it), none otherwise: a customer-made email
		 * subscription stays pending until the owner confirms (see
		 * `confirmCustomerSubscription`).
		 */
		confirmedEmail?: string | null
	},
): Promise<void> {
	const now = params.now ?? new Date()
	let confirmedEmail = params.confirmedEmail
	if (
		confirmedEmail === undefined &&
		params.channel === 'email' &&
		(params.source === 'operator' || params.source === 'import')
	) {
		const row = await db
			.select({ email: customers.email })
			.from(customers)
			.where(eq(customers.id, params.customerId))
			.get()
		confirmedEmail = row?.email
	}
	const confirmedEmailHash =
		params.channel === 'email' && confirmedEmail?.trim()
			? emailConsentHash(confirmedEmail)
			: null
	if (params.subscribed) {
		await db
			.insert(customerSubscriptions)
			.values({
				customerId: params.customerId,
				topic: params.topic,
				channel: params.channel,
				source: params.source,
				subscribedAt: now,
				unsubscribedAt: null,
				confirmedEmailHash,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					customerSubscriptions.customerId,
					customerSubscriptions.topic,
					customerSubscriptions.channel,
				],
				set: {
					source: params.source,
					subscribedAt: now,
					unsubscribedAt: null,
					confirmedEmailHash,
					// A fresh opt-in starts a fresh confirmation.
					confirmationSentAt: null,
					confirmationSentHash: null,
					updatedAt: now,
				},
			})
			.run()
		return
	}
	await db
		.update(customerSubscriptions)
		.set({ unsubscribedAt: now, updatedAt: now })
		.where(
			and(
				eq(customerSubscriptions.customerId, params.customerId),
				eq(customerSubscriptions.topic, params.topic),
				eq(customerSubscriptions.channel, params.channel),
			),
		)
		.run()
}

/**
 * Binds a pending email subscription to the address its owner confirmed.
 * Returns false when the subscription is gone or was opted out meanwhile.
 */
export async function confirmCustomerSubscription(
	db: TenantDatabase,
	params: {
		customerId: string
		topic: CustomerSubscriptionTopic
		email: string
		now?: Date
	},
): Promise<boolean> {
	const now = params.now ?? new Date()
	const rows = await db
		.update(customerSubscriptions)
		.set({ confirmedEmailHash: emailConsentHash(params.email), updatedAt: now })
		.where(
			and(
				eq(customerSubscriptions.customerId, params.customerId),
				eq(customerSubscriptions.topic, params.topic),
				eq(customerSubscriptions.channel, 'email'),
				isNull(customerSubscriptions.unsubscribedAt),
			),
		)
		.returning({ id: customerSubscriptions.id })
	return rows.length > 0
}
