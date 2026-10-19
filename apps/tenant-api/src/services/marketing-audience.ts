import {
	customers,
	customerSubscriptions,
	type Customer,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, isNull, inArray } from 'drizzle-orm'

export type BroadcastChannel = 'email' | 'sms'
export type BroadcastAudience = 'all' | 'verified' | 'unverified'

/**
 * Who a broadcast campaign may be sent to.
 *
 * `customer_subscriptions` is the single marketing consent store: a customer
 * is in the audience only with an ACTIVE subscription (`unsubscribed_at IS
 * NULL`) for the campaign's channel, on any marketing topic (or only the
 * given ones). Having a customer row, a verified phone or an old booking is
 * not consent. Texts additionally need a verified phone (a number only counts
 * once its owner proved control of it); a row without the address for the
 * channel is dropped.
 *
 * The `audience` rule only narrows further (`verified` / `unverified` phone).
 */
export async function loadBroadcastAudience(
	db: TenantDatabase,
	params: {
		channel: BroadcastChannel
		audience?: BroadcastAudience | string | null
		topics?: readonly string[] | null
	},
): Promise<Customer[]> {
	const topics = params.topics?.length ? [...params.topics] : null
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
				topics
					? // bounded: marketing topics are a small closed enum
						inArray(customerSubscriptions.topic, topics as never[])
					: undefined,
			),
		)
		.orderBy(asc(customers.id))
		.all()

	let audience = rows.map((row) => row.customer)
	if (params.channel === 'sms') {
		audience = audience.filter((c) => Boolean(c.phoneVerified) && c.phone)
	} else {
		audience = audience.filter((c) => Boolean(c.email))
	}
	if (params.audience === 'verified') {
		audience = audience.filter((c) => Boolean(c.phoneVerified))
	} else if (params.audience === 'unverified') {
		audience = audience.filter((c) => !c.phoneVerified)
	}
	return audience
}
