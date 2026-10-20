import {
	customers,
	customerSubscriptions,
	type Customer,
	type CustomerSubscriptionChannel,
	type CustomerSubscriptionSource,
	type CustomerSubscriptionTopic,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

export type BroadcastChannel = CustomerSubscriptionChannel
export type BroadcastAudience = 'all' | 'verified' | 'unverified'

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
 * emails need an address. The `audience` rule only narrows further.
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
		.selectDistinct({ customer: customers })
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

	let audience = rows.map((row) => row.customer)
	if (params.channel === 'sms') {
		audience = audience.filter((c) => Boolean(c.phoneVerified) && c.phone)
	} else {
		audience = audience.filter((c) => Boolean(c.email?.trim()))
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
	},
): Promise<void> {
	const now = params.now ?? new Date()
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
