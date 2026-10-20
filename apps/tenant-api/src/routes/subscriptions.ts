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
import {
	confirmTokenExpiry,
	consentBaseUrl,
	signConsentToken,
	verifyConsentToken,
} from '../lib/email-consent.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	confirmCustomerSubscription,
	emailConsentHash,
	setCustomerSubscription,
} from '../services/marketing-audience.ts'
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

const updateSchema = z.object({
	subscribed: z.boolean(),
	// Provenance a customer may claim for their own consent. `operator`,
	// `import` and `form` are written by trusted server paths only.
	source: z.enum(['profile', 'signup', 'checkout']).default('profile'),
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
				{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
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
			await setCustomerSubscription(db, {
				customerId,
				topic,
				channel,
				subscribed,
				source,
				confirmedEmail: null,
			})
			await sendConfirmationEmail(c.req.url, {
				orgId: auth.orgId,
				customerId,
				topic,
				email,
				name: customer.name,
			})
			return c.json({ topic, channel, subscribed, pending: true })
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

async function sendConfirmationEmail(
	requestUrl: string,
	params: {
		orgId: string
		customerId: string
		topic: string
		email: string
		name: string
	},
) {
	const token = signConsentToken({
		k: 'confirm',
		o: params.orgId,
		c: params.customerId,
		t: params.topic,
		e: emailConsentHash(params.email),
		x: confirmTokenExpiry(),
	})
	const link = `${consentBaseUrl(new URL(requestUrl).origin)}/subscriptions/confirm?token=${encodeURIComponent(token)}`
	try {
		await sendTenantEmail({
			to: params.email,
			toName: params.name,
			subject: 'Confirm your email subscription',
			text: `Someone asked to send marketing email to this address. To confirm, open: ${link}\n\nIf this was not you, ignore this message and you will not receive anything.`,
			html: `<p>Someone asked to send marketing email to this address.</p><p><a href="${link}">Confirm my subscription</a></p><p>If this was not you, ignore this message and you will not receive anything.</p>`,
			capture: { orgId: params.orgId, messageKind: 'email-confirmation' },
		})
	} catch (error) {
		console.error('Failed to send the email confirmation:', error)
	}
}

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
