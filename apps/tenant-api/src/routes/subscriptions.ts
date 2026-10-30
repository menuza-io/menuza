import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'

import {
	CUSTOMER_SUBSCRIPTION_CHANNELS,
	CUSTOMER_SUBSCRIPTION_TOPICS,
	customerSubscriptions,
	customers,
	getTenantDb,
} from '@repo/tenant-db'
import { verifyConsentToken } from '../lib/email-consent.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	confirmCustomerSubscription,
	emailConsentHash,
	setCustomerSubscription,
} from '../services/marketing-audience.ts'
import {
	RESEND_INTERVAL_MS,
	sendConfirmationEmail,
} from '../services/subscription-confirmation.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * Customer marketing consent. The signed-in customer reads and toggles their
 * own subscriptions; a text subscription needs a verified phone (the OTP
 * sign-in is the double opt-in). An email subscription needs an address on
 * file and stays pending until its owner follows the emailed confirmation
 * link (double opt-in), so nobody can subscribe an address they do not own.
 * Every broadcast email carries a signed unsubscribe link (`/unsubscribe`).
 */
export const subscriptionRoutes = new Hono()

export { RESEND_INTERVAL_MS }

const updateSchema = z.object({
	subscribed: z.boolean(),
	// Provenance a customer may claim for their own consent. `operator`,
	// `import` and `form` are written by trusted server paths only.
	source: z
		.enum([
			'profile',
			'signup',
			'checkout',
			// Fork drop-alert entry points (Sites menu, drops pages, order success).
			'menu',
			'drops_page',
			'drop_page',
			'order_success',
		])
		.default('profile'),
})

const paramsSchema = z.object({
	topic: z.enum(CUSTOMER_SUBSCRIPTION_TOPICS),
	channel: z.enum(CUSTOMER_SUBSCRIPTION_CHANNELS),
})

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function dropsSmsSubscribed(auth: Auth) {
	const row = await auth.db
		.select({ unsubscribedAt: customerSubscriptions.unsubscribedAt })
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, auth.customerId),
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
	const rows = await auth.db
		.select()
		.from(customerSubscriptions)
		.where(eq(customerSubscriptions.customerId, auth.customerId))
		.all()
	return c.json({
		// TODO(remove after the release that follows this one): the legacy shape
		// of this route, still read by cached Sites bundles and mobile clients.
		drops: { sms: await dropsSmsSubscribed(auth) },
		subscriptions: rows.map((row) => ({
			topic: row.topic,
			channel: row.channel,
			subscribed: !row.unsubscribedAt,
			// An email subscription is pending until its address is confirmed.
			...(row.channel === 'email' && !row.unsubscribedAt
				? { confirmed: Boolean(row.confirmedEmailHash) }
				: {}),
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
				{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
				400,
			)
		}
		const { db, customerId } = auth
		const { topic, channel } = params.data
		const { subscribed, source } = parsed.data

		const customer = await db
			.select({
				name: customers.name,
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

		if (subscribed && channel === 'email') {
			const email = customer.email!.trim()
			const existing = await db
				.select()
				.from(customerSubscriptions)
				.where(
					and(
						eq(customerSubscriptions.customerId, customerId),
						eq(customerSubscriptions.topic, topic),
						eq(customerSubscriptions.channel, 'email'),
					),
				)
				.get()
			if (
				existing &&
				!existing.unsubscribedAt &&
				existing.confirmedEmailHash === emailConsentHash(email)
			) {
				return c.json({ topic, channel, subscribed, pending: false })
			}
			const now = Date.now()
			const addressHash = emailConsentHash(email)
			const pending = existing && !existing.unsubscribedAt
			// A repeat request for the SAME address resends the link, at most once
			// per RESEND_INTERVAL_MS after the last link actually sent. A new
			// address (or one never sent to) is never throttled.
			if (
				pending &&
				existing.confirmationSentHash === addressHash &&
				existing.confirmationSentAt
			) {
				const sinceLast = now - existing.confirmationSentAt.getTime()
				if (sinceLast < RESEND_INTERVAL_MS) {
					return c.json({
						topic,
						channel,
						subscribed,
						pending: true,
						confirmationSent: false,
						retryAfter: Math.ceil((RESEND_INTERVAL_MS - sinceLast) / 1000),
					})
				}
			}
			if (!pending) {
				await setCustomerSubscription(db, {
					customerId,
					topic,
					channel,
					subscribed,
					source,
					confirmedEmail: null,
				})
			}
			const confirmationSent = await sendConfirmationEmail(
				new URL(c.req.url).origin,
				{
					orgId: auth.orgId,
					customerId,
					topic,
					email,
					name: customer.name,
				},
			)
			// Only a link that went out starts the wait; a failed send leaves the
			// clock alone so the next request can retry at once.
			if (confirmationSent) {
				await db
					.update(customerSubscriptions)
					.set({
						confirmationSentAt: new Date(now),
						confirmationSentHash: addressHash,
					})
					.where(
						and(
							eq(customerSubscriptions.customerId, customerId),
							eq(customerSubscriptions.topic, topic),
							eq(customerSubscriptions.channel, 'email'),
						),
					)
					.run()
			}
			return c.json({
				topic,
				channel,
				subscribed,
				pending: true,
				confirmationSent,
			})
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

// TODO(remove after the release that follows this one): temporary
// compatibility alias. Sites bundles and mobile clients cached before the
// per-topic routes still call `PUT /subscriptions/drops` and
// `GET /subscriptions/drops` and expect `{ drops: { sms } }`. The PUT is
// forwarded to `PUT /drops/sms` (same authentication, validation and rate
// limit) and its answer is reshaped; the GET reads the same row.
subscriptionRoutes.put('/drops', async (c) => {
	const res = await subscriptionRoutes.fetch(
		new Request(new URL('/drops/sms', c.req.url), c.req.raw),
		c.env,
	)
	if (!res.ok) return res
	const { subscribed } = (await res.json()) as { subscribed: boolean }
	return c.json({ drops: { sms: subscribed } })
})

subscriptionRoutes.get('/drops', async (c) => {
	let auth: Auth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		return response as Response
	}
	return c.json({ drops: { sms: await dropsSmsSubscribed(auth) } })
})

// Public, tokenised endpoints (no login): the link in an email. GET shows a
// button and changes nothing, so a mail scanner that opens links cannot
// confirm or unsubscribe anyone; POST acts, and is idempotent. POST is also
// what mail clients call for RFC 8058 one-click unsubscribe.
const publicLimit = rateLimit('subscriptions-public', {
	windowMs: 60 * 1000,
	maxRequests: 60,
})

function page(title: string, body: string, status: 200 | 400 | 410 = 200) {
	return new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`,
		{
			status,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				'X-Robots-Tag': 'noindex',
			},
		},
	)
}

async function tokenDb(orgId: string) {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
		return null
	}
	try {
		return await getTenantDb(orgId)
	} catch {
		return null
	}
}

async function readToken(c: Context) {
	const fromQuery = c.req.query('token')
	if (fromQuery) return fromQuery
	const form: Record<string, unknown> = await c.req
		.parseBody()
		.catch(() => ({}))
	return typeof form.token === 'string' ? form.token : ''
}

function actionPage(c: Context, path: string, title: string, button: string) {
	const token = encodeURIComponent(c.req.query('token') ?? '')
	return page(
		title,
		`<form method="post" action="/subscriptions/${path}?token=${token}"><button type="submit" style="font:inherit;padding:.5rem 1rem">${button}</button></form>`,
	)
}

subscriptionRoutes.get('/unsubscribe', publicLimit, (c) => {
	if (!verifyConsentToken(c.req.query('token') ?? '', 'unsubscribe')) {
		return page('This link is not valid', '<p>The link is invalid.</p>', 400)
	}
	return actionPage(c, 'unsubscribe', 'Unsubscribe from emails', 'Unsubscribe')
})

subscriptionRoutes.post('/unsubscribe', publicLimit, async (c) => {
	const payload = verifyConsentToken(await readToken(c), 'unsubscribe')
	if (!payload) {
		return page('This link is not valid', '<p>The link is invalid.</p>', 400)
	}
	const db = await tokenDb(payload.o)
	if (db) {
		await setCustomerSubscription(db, {
			customerId: payload.c,
			topic: payload.t as (typeof CUSTOMER_SUBSCRIPTION_TOPICS)[number],
			channel: 'email',
			subscribed: false,
			source: 'profile',
		})
	}
	return page(
		'You are unsubscribed',
		'<p>You will not receive these emails any more.</p>',
	)
})

subscriptionRoutes.get('/confirm', publicLimit, (c) => {
	if (!verifyConsentToken(c.req.query('token') ?? '', 'confirm')) {
		return page(
			'This link is not valid',
			'<p>The link is invalid or has expired.</p>',
			400,
		)
	}
	return actionPage(c, 'confirm', 'Confirm your subscription', 'Confirm')
})

subscriptionRoutes.post('/confirm', publicLimit, async (c) => {
	const payload = verifyConsentToken(await readToken(c), 'confirm')
	if (!payload) {
		return page(
			'This link is not valid',
			'<p>The link is invalid or has expired.</p>',
			400,
		)
	}
	const topic = payload.t
	if (!(CUSTOMER_SUBSCRIPTION_TOPICS as readonly string[]).includes(topic)) {
		return page('This link is not valid', '<p>The link is invalid.</p>', 400)
	}
	const db = await tokenDb(payload.o)
	const customer = db
		? await db
				.select({ email: customers.email })
				.from(customers)
				.where(eq(customers.id, payload.c))
				.get()
		: undefined
	const email = customer?.email?.trim()
	// The address on file must still be the one this link was sent to.
	if (!db || !email || emailConsentHash(email) !== payload.e) {
		return page(
			'This link is no longer valid',
			'<p>The address changed or the subscription no longer exists.</p>',
			410,
		)
	}
	const confirmed = await confirmCustomerSubscription(db, {
		customerId: payload.c,
		topic: topic as (typeof CUSTOMER_SUBSCRIPTION_TOPICS)[number],
		email,
	})
	if (!confirmed) {
		return page(
			'This link is no longer valid',
			'<p>The subscription was cancelled or no longer exists.</p>',
			410,
		)
	}
	return page('Subscription confirmed', '<p>Thank you. You are subscribed.</p>')
})
