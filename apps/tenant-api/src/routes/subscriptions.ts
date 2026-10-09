import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import {
	CUSTOMER_SUBSCRIPTION_SOURCES,
	customerSubscriptions,
	customers,
} from '@repo/tenant-db'
import { rateLimit } from '../lib/rate-limit.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * Customer marketing consent (SMS drop alerts). The signed-in customer reads
 * and toggles their own subscription; operators read the list elsewhere.
 * Only a verified phone can be subscribed: the phone-code sign-in is the
 * double opt-in.
 */
export const subscriptionRoutes = new Hono()

const updateSchema = z.object({
	subscribed: z.boolean(),
	source: z.enum(CUSTOMER_SUBSCRIPTION_SOURCES),
})

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function readDropsSubscription(db: Auth['db'], customerId: string) {
	const row = await db
		.select({ unsubscribedAt: customerSubscriptions.unsubscribedAt })
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, customerId),
				eq(customerSubscriptions.topic, 'drops'),
				eq(customerSubscriptions.channel, 'sms'),
			),
		)
		.get()
	return Boolean(row && !row.unsubscribedAt)
}

subscriptionRoutes.get('/', async (c) => {
	let auth: Auth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		return response as Response
	}
	const subscribed = await readDropsSubscription(auth.db, auth.customerId)
	return c.json({ drops: { sms: subscribed } })
})

subscriptionRoutes.put(
	'/drops',
	rateLimit('subscriptions-update', { windowMs: 60 * 1000, maxRequests: 20 }),
	async (c) => {
		let auth: Auth
		try {
			auth = await authenticateCustomer(c)
		} catch (response) {
			return response as Response
		}
		const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
				400,
			)
		}
		const { db, customerId } = auth
		const { subscribed, source } = parsed.data

		const customer = await db
			.select({
				phone: customers.phone,
				phoneVerified: customers.phoneVerified,
			})
			.from(customers)
			.where(eq(customers.id, customerId))
			.get()
		if (!customer) return c.json({ error: 'Customer not found' }, 404)
		if (subscribed && (!customer.phone || !customer.phoneVerified)) {
			return c.json({ error: 'A verified phone number is required' }, 409)
		}

		const now = new Date()
		if (subscribed) {
			await db
				.insert(customerSubscriptions)
				.values({
					customerId,
					topic: 'drops',
					channel: 'sms',
					source,
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
						source,
						subscribedAt: now,
						unsubscribedAt: null,
						updatedAt: now,
					},
				})
				.run()
		} else {
			await db
				.update(customerSubscriptions)
				.set({ unsubscribedAt: now, updatedAt: now })
				.where(
					and(
						eq(customerSubscriptions.customerId, customerId),
						eq(customerSubscriptions.topic, 'drops'),
						eq(customerSubscriptions.channel, 'sms'),
					),
				)
				.run()
		}

		return c.json({ drops: { sms: subscribed } })
	},
)
