import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import {
	CUSTOMER_SUBSCRIPTION_CHANNELS,
	CUSTOMER_SUBSCRIPTION_SOURCES,
	CUSTOMER_SUBSCRIPTION_TOPICS,
	customerSubscriptions,
	customers,
} from '@repo/tenant-db'
import { rateLimit } from '../lib/rate-limit.ts'
import { setCustomerSubscription } from '../services/marketing-audience.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * Customer marketing consent. The signed-in customer reads and toggles their
 * own subscriptions; a text subscription needs a verified phone (the OTP
 * sign-in is the double opt-in), an email one needs an address on file.
 */
export const subscriptionRoutes = new Hono()

const updateSchema = z.object({
	subscribed: z.boolean(),
	source: z.enum(CUSTOMER_SUBSCRIPTION_SOURCES).default('profile'),
})

const paramsSchema = z.object({
	topic: z.enum(CUSTOMER_SUBSCRIPTION_TOPICS),
	channel: z.enum(CUSTOMER_SUBSCRIPTION_CHANNELS),
})

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

subscriptionRoutes.get('/', async (c) => {
	let auth: Auth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		return response as Response
	}
	const rows = await auth.db
		.select()
		.from(customerSubscriptions)
		.where(eq(customerSubscriptions.customerId, auth.customerId))
		.all()
	return c.json({
		subscriptions: rows.map((row) => ({
			topic: row.topic,
			channel: row.channel,
			subscribed: !row.unsubscribedAt,
		})),
	})
})

subscriptionRoutes.put(
	'/:topic/:channel',
	rateLimit('subscriptions-update', { windowMs: 60 * 1000, maxRequests: 20 }),
	async (c) => {
		let auth: Auth
		try {
			auth = await authenticateCustomer(c)
		} catch (response) {
			return response as Response
		}
		const params = paramsSchema.safeParse(c.req.param())
		if (!params.success) return c.json({ error: 'Unknown subscription' }, 404)
		const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})))
		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
				400,
			)
		}
		const { db, customerId } = auth
		const { topic, channel } = params.data
		const { subscribed, source } = parsed.data

		const customer = await db
			.select({
				email: customers.email,
				phone: customers.phone,
				phoneVerified: customers.phoneVerified,
			})
			.from(customers)
			.where(and(eq(customers.id, customerId)))
			.get()
		if (!customer) return c.json({ error: 'Customer not found' }, 404)
		if (subscribed && channel === 'sms') {
			if (!customer.phone || !customer.phoneVerified) {
				return c.json({ error: 'A verified phone number is required' }, 409)
			}
		}
		if (subscribed && channel === 'email' && !customer.email?.trim()) {
			return c.json({ error: 'An email address is required' }, 409)
		}

		await setCustomerSubscription(db, {
			customerId,
			topic,
			channel,
			subscribed,
			source,
		})
		return c.json({ topic, channel, subscribed })
	},
)
