import { STAFF_CONSENT_COOLING_OFF_DAYS } from '@repo/common/marketing-consent'
import {
	customers,
	customerSubscriptions,
	type Customer,
	type CustomerConsentMethod,
	type CustomerSubscriptionChannel,
	type CustomerSubscriptionSource,
	type CustomerSubscriptionTopic,
	type CustomerUnsubscribeSource,
	type TenantDatabase,
	type TenantTransaction,
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
		/** Narrow to one customer (journeys check consent per send). */
		customerId?: string
		/**
		 * Narrow to these customers: a broadcast re-checks consent per batch so
		 * an unsubscribe during a long send is honoured. Keep it to one batch
		 * (the ids are bound parameters).
		 */
		customerIds?: readonly string[]
	},
): Promise<Customer[]> {
	if (params.customerIds && params.customerIds.length === 0) return []
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
				params.customerId ? eq(customers.id, params.customerId) : undefined,
				params.customerIds
					? // bounded: callers pass one broadcast batch (BROADCAST_BATCH_SIZE)
						inArray(customers.id, [...params.customerIds])
					: undefined,
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
 * Whether one customer may get a marketing message on this channel now, by
 * the same rules as a broadcast audience (active subscription, verified phone
 * for texts, confirmed address for email).
 */
export async function hasMarketingConsent(
	db: TenantDatabase,
	customerId: string,
	channel: BroadcastChannel,
): Promise<boolean> {
	const audience = await loadBroadcastAudience(db, { channel, customerId })
	return audience.length > 0
}

/** Who opted out when the caller does not say: staff paths are `operator`. */
function defaultUnsubscribedSource(
	source: CustomerSubscriptionSource,
): CustomerUnsubscribeSource {
	if (source === 'operator' || source === 'staff') return 'operator'
	if (source === 'import') return 'import'
	return 'self'
}

/**
 * Records a consent change for one customer, topic and channel. The ONLY
 * writer of `customer_subscriptions` consent state.
 *
 * Opting in writes the provenance (source, wording version, the staff member
 * and method for a staff-recorded consent) and clears any opt-out. Opting out
 * sets `unsubscribed_at` and who did it, and keeps the opt-in provenance on
 * the row as the record. `source: 'import'` is the path for backfilling
 * consent a business already holds (for example from a previous mailing
 * list); only import addresses whose owners agreed.
 */
export async function setCustomerSubscription(
	db: TenantDatabase | TenantTransaction,
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
		 * (someone vouching for it), none otherwise: a customer-made or
		 * staff-recorded (`staff`) email subscription stays pending until the
		 * owner confirms (see `confirmCustomerSubscription`).
		 */
		confirmedEmail?: string | null
		/** Opt-in only: version id of the consent wording shown. */
		consentTextVersion?: string | null
		/** Opt-in only: opaque operator user id that recorded a `staff` consent. */
		recordedBy?: string | null
		/** Opt-in only: how the guest gave a `staff` consent. */
		consentMethod?: CustomerConsentMethod | null
		/**
		 * Opt-out only: who opted out. Default: `operator` for the `operator`
		 * and `staff` sources, `import` for `import`, `self` (the guest) for
		 * every other source.
		 */
		unsubscribedSource?: CustomerUnsubscribeSource
	},
): Promise<void> {
	const now = params.now ?? new Date()
	if (!params.subscribed) {
		await db
			.update(customerSubscriptions)
			.set({
				unsubscribedAt: now,
				unsubscribedSource:
					params.unsubscribedSource ?? defaultUnsubscribedSource(params.source),
				updatedAt: now,
			})
			.where(
				and(
					eq(customerSubscriptions.customerId, params.customerId),
					eq(customerSubscriptions.topic, params.topic),
					eq(customerSubscriptions.channel, params.channel),
				),
			)
			.run()
		return
	}
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
	const provenance = {
		source: params.source,
		subscribedAt: now,
		unsubscribedAt: null,
		unsubscribedSource: null,
		consentTextVersion: params.consentTextVersion ?? null,
		recordedBy: params.recordedBy ?? null,
		consentMethod: params.consentMethod ?? null,
		confirmedEmailHash,
		updatedAt: now,
	}
	await db
		.insert(customerSubscriptions)
		.values({
			customerId: params.customerId,
			topic: params.topic,
			channel: params.channel,
			...provenance,
		})
		.onConflictDoUpdate({
			target: [
				customerSubscriptions.customerId,
				customerSubscriptions.topic,
				customerSubscriptions.channel,
			],
			// The confirmation send clock (confirmationSentAt/Hash) is kept: it
			// throttles resends to one address across opt-in cycles.
			set: provenance,
		})
		.run()
}

/**
 * Whether a guest's own opt-out still blocks a staff-recorded opt-in on this
 * topic and channel: the subscription is opted out, by the guest
 * (`unsubscribed_source = 'self'`), less than `STAFF_CONSENT_COOLING_OFF_DAYS`
 * ago. An opt-out from before the source was recorded (null) counts as the
 * guest's own, so the check fails closed. Opt-outs by staff or an import do
 * not block.
 */
export async function isInStaffConsentCoolingOff(
	db: TenantDatabase | TenantTransaction,
	params: {
		customerId: string
		topic: CustomerSubscriptionTopic
		channel: CustomerSubscriptionChannel
		now?: Date
	},
): Promise<boolean> {
	const row = await db
		.select({
			unsubscribedAt: customerSubscriptions.unsubscribedAt,
			unsubscribedSource: customerSubscriptions.unsubscribedSource,
		})
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, params.customerId),
				eq(customerSubscriptions.topic, params.topic),
				eq(customerSubscriptions.channel, params.channel),
			),
		)
		.get()
	if (!row?.unsubscribedAt) return false
	if (row.unsubscribedSource && row.unsubscribedSource !== 'self') return false
	const now = (params.now ?? new Date()).getTime()
	const coolingOffMs = STAFF_CONSENT_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000
	return now - row.unsubscribedAt.getTime() < coolingOffMs
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

/**
 * Whether one customer may be written to on one topic and channel right now:
 * an ACTIVE subscription, and for email an address its owner confirmed
 * (`confirmed_email_hash` matches the customer's current address; a customer-
 * typed address is deliverable only after the emailed double opt-in). Texts
 * are deliverable on the subscription alone: the caller decides whether the
 * phone must be verified. Used by reservation journeys, whose consent is the
 * `reservations` topic rather than a broadcast's `marketing`.
 */
export async function hasDeliverableSubscription(
	db: TenantDatabase | TenantTransaction,
	params: {
		customerId: string
		topic: CustomerSubscriptionTopic
		channel: CustomerSubscriptionChannel
	},
): Promise<boolean> {
	const row = await db
		.select({
			confirmedEmailHash: customerSubscriptions.confirmedEmailHash,
			email: customers.email,
		})
		.from(customerSubscriptions)
		.innerJoin(customers, eq(customers.id, customerSubscriptions.customerId))
		.where(
			and(
				eq(customerSubscriptions.customerId, params.customerId),
				eq(customerSubscriptions.topic, params.topic),
				eq(customerSubscriptions.channel, params.channel),
				isNull(customerSubscriptions.unsubscribedAt),
			),
		)
		.get()
	if (!row) return false
	if (params.channel === 'sms') return true
	const email = row.email?.trim()
	return Boolean(email && row.confirmedEmailHash === emailConsentHash(email))
}
